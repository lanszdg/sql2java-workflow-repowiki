-- 需求预测 包体
-- generate_forecast 是本库 MODEL 子句的唯一落点: 把历史按 (物料, 期序号) 排成单元格,
--   partition by item_id, dimension by 期序号 n, measures(qty),用 rules 递推未来期
--   MA3/MA6 = 前 N 期移动平均(引用 cv()-1..cv()-N 的相对偏移),TREND = 末期 + 平均环比增量
-- pivot_demand_dynamic 是本库 DBMS_SQL 的唯一落点: 透视的列(期数)编译期未知,
--   先查出区间内有哪些 period 动态拼 select ... pivot(...),再 dbms_sql.to_refcursor 转出参

create or replace package body forecast_pkg as

    -- 期序号: 把 period_date 折成"距锚点的月数",MODEL 用整数维度比日期维度好递推
    -- 锚点统一取 2000-01,任意月度首日 -> 唯一整数,且单调(SQL 里同款算式直接内联,见 MODEL)
    function period_seq(p_period in date) return number is
    begin
        return months_between(trunc(p_period, 'MM'), date '2000-01-01');
    end period_seq;


    procedure generate_forecast(
        p_run_date      in date     default null,
        p_method        in varchar2 default 'MA3',
        p_periods_ahead in number   default 3
    ) is
        v_run_date date := nvl(p_run_date, util_pkg.curr_biz_date());
        v_method   varchar2(16) := upper(nvl(p_method, 'MA3'));
        v_ahead    pls_integer := nvl(p_periods_ahead, 3);
        v_anchor   number := period_seq(v_run_date);  -- 最后一个有实绩的期序号(含当期)
        v_window   pls_integer := case when v_method = 'MA6' then 6 else 3 end;
        v_run_id   number := seq_forecast_id.nextval;
        v_merged   number := 0;
    begin
        if v_method not in ('MA3','MA6','TREND') then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_system, const_pkg.c_mod_forecast, 'generate_forecast',
                '不支持的预测方法: ' || v_method, v_method);
        end if;

        -- MODEL 子句滚动外推
        -- 思路: (item_id, warehouse_id) 一个 partition,维度 n=月序号(距 2000-01 的月数),
        --   measure qty 装历史实绩(无 actual 退 forecast_qty),未来期由 rules 递推
        -- rules iterate(v_ahead): 迭代号 0..v_ahead-1 各算一个未来期,目标 n=v_anchor+iter+1
        --   cv() 引用相对偏移取前 N 期(可能含上一轮刚外推出的未来期),实现链式滚动
        -- MA3/MA6 = 前 v_window 期算术平均;TREND = 末期 + 平均环比增量((末期-window期前)/window)
        -- 月序号用 months_between/add_months 直接在 SQL 里算,不引用包内私有函数(SQL 不可见)
        merge into t_demand_forecast tgt
        using (
            select item_id,
                   warehouse_id,
                   add_months(date '2000-01-01', n) as period_date,
                   round(qty, 4)                    as forecast_qty
              from (
                    -- 基础单元格: 历史实绩按 (item, warehouse, 月序号) 聚合
                    select f.item_id,
                           f.warehouse_id,
                           months_between(trunc(f.period_date, 'MM'), date '2000-01-01') as n,
                           sum(nvl(f.actual_qty, f.forecast_qty))                        as qty
                      from t_demand_forecast f
                     where f.period_date < add_months(date '2000-01-01', v_anchor + 1)
                     group by f.item_id, f.warehouse_id,
                              months_between(trunc(f.period_date, 'MM'), date '2000-01-01')
                     model
                       partition by (item_id, warehouse_id)
                       dimension by (n)
                       measures (qty)
                       rules upsert all iterate (1000) until (iteration_number + 1 >= v_ahead)
                       (
                           -- 目标期 = v_anchor + 当前迭代号 + 1
                           qty[v_anchor + iteration_number + 1] =
                               case
                                   when v_method = 'TREND' then
                                       greatest(
                                         nvl(qty[v_anchor + iteration_number], 0)
                                           + (nvl(qty[v_anchor + iteration_number], 0)
                                              - nvl(qty[v_anchor + iteration_number - v_window], 0)) / v_window,
                                         0)
                                   else
                                       -- 移动平均: 前 v_window 期(含已外推的未来期)算术平均
                                       greatest(
                                         ( nvl(qty[v_anchor + iteration_number],     0)
                                         + nvl(qty[v_anchor + iteration_number - 1], 0)
                                         + nvl(qty[v_anchor + iteration_number - 2], 0)
                                         + case when v_window >= 6 then
                                               nvl(qty[v_anchor + iteration_number - 3], 0)
                                             + nvl(qty[v_anchor + iteration_number - 4], 0)
                                             + nvl(qty[v_anchor + iteration_number - 5], 0)
                                           else 0 end
                                         ) / v_window,
                                         0)
                               end
                       )
                   )
             -- 只取算出来的未来期回写,历史期不动
             where n > v_anchor
        ) src
        on (    tgt.item_id      = src.item_id
            and nvl(tgt.warehouse_id, -1) = nvl(src.warehouse_id, -1)
            and tgt.period_date  = src.period_date
            and tgt.method       = v_method)
        when matched then update set
            tgt.forecast_qty = src.forecast_qty,
            tgt.run_id       = v_run_id
        when not matched then insert (
            forecast_id, item_id, warehouse_id, period_date,
            forecast_qty, method, run_id, created_at
        ) values (
            seq_forecast_id.nextval, src.item_id, src.warehouse_id, src.period_date,
            src.forecast_qty, v_method, v_run_id, current_timestamp
        );

        v_merged := sql%rowcount;

        exc_pkg.log_error(
            p_error_code  => 'I6010',
            p_module      => const_pkg.c_mod_forecast,
            p_procedure   => 'generate_forecast',
            p_error_msg   => '预测生成 method=' || v_method || ' ahead=' || v_ahead
                          || ' anchor=' || to_char(v_run_date, 'YYYY-MM') || ' rows=' || v_merged,
            p_biz_key     => to_char(v_run_id),
            p_error_level => 'INFO');
    exception
        when others then
            exc_pkg.log_error(
                p_error_code => const_pkg.c_err_system,
                p_module     => const_pkg.c_mod_forecast,
                p_procedure  => 'generate_forecast',
                p_error_msg  => '预测生成失败 method=' || v_method || ': ' || sqlerrm,
                p_biz_key    => to_char(v_run_id));
            raise;
    end generate_forecast;


    procedure forecast_accuracy(
        p_item_id in  number   default null,
        p_cur     out sys_refcursor
    ) is
    begin
        -- 只对既有预测又有实绩的期算准确率: 绝对百分比误差 MAPE = |actual-forecast|/actual
        -- 偏差 bias = forecast-actual(正=高估);滚动准确率用 3 期移动平均的 (1-MAPE)
        -- 分析函数 avg over rows 给每个物料的滚动窗口,体现"近期预测准不准"的趋势
        -- lag/lead 取上一期/下一期实绩,算需求环比(mom_growth),给"预测该不该跟着趋势走"做参照
        open p_cur for
            select item_id,
                   period_date,
                   method,
                   forecast_qty,
                   actual_qty,
                   abs_pct_err,
                   bias,
                   lag(actual_qty) over (
                             partition by item_id order by period_date)  as prev_actual,
                   lead(actual_qty) over (
                             partition by item_id order by period_date)  as next_actual,
                   round((actual_qty - lag(actual_qty) over (
                               partition by item_id order by period_date))
                         / nullif(lag(actual_qty) over (
                               partition by item_id order by period_date), 0), 4) as mom_growth,
                   round(avg(abs_pct_err) over (
                             partition by item_id
                             order by period_date
                             rows between 2 preceding and current row), 4) as mape_3m,
                   round(1 - avg(abs_pct_err) over (
                             partition by item_id
                             order by period_date
                             rows between 2 preceding and current row), 4) as rolling_accuracy
              from (
                    select f.item_id,
                           f.period_date,
                           f.method,
                           f.forecast_qty,
                           f.actual_qty,
                           round(abs(f.actual_qty - f.forecast_qty)
                                 / nullif(f.actual_qty, 0), 4) as abs_pct_err,
                           round(f.forecast_qty - f.actual_qty, 4) as bias
                      from t_demand_forecast f
                     where f.actual_qty is not null
                       and f.method <> 'MANUAL'
                       and (p_item_id is null or f.item_id = p_item_id)
                   )
             order by item_id, period_date;
    end forecast_accuracy;


    procedure pivot_demand_dynamic(
        p_from_period in  date,
        p_to_period   in  date,
        p_cur         out sys_refcursor
    ) is
        v_cur_id   integer;
        v_sql      clob;
        v_cols     clob;
        v_dummy    integer;
        v_from     date := trunc(p_from_period, 'MM');
        v_to       date := trunc(p_to_period, 'MM');
    begin
        -- 透视列 = 区间内出现过的各月,编译期未知,先查出来拼成 pivot 的 in 列表
        -- 每月一列,列名形如 "M_202601",值为该物料该月的需求量(取实绩否则预测)
        for r in (
            select distinct trunc(period_date, 'MM') as pm
              from t_demand_forecast
             where period_date between v_from and v_to
             order by 1
        ) loop
            v_cols := v_cols
                || case when v_cols is null then '' else ', ' end
                || '''' || to_char(r.pm, 'YYYY-MM-DD') || ''' as "M_'
                || to_char(r.pm, 'YYYYMM') || '"';
        end loop;

        -- 区间内没有任何数据: 拼一个空 in 列表会语法错,退化成只返回 item_id 的空透视
        if v_cols is null then
            v_cols := '''__none__'' as "M_NONE"';
        end if;

        v_sql := 'select * from ('
              || '  select item_id,'
              || '         to_char(trunc(period_date, ''MM''), ''YYYY-MM-DD'') as pm,'
              || '         nvl(actual_qty, forecast_qty) as qty'
              || '    from t_demand_forecast'
              || '   where period_date between :b_from and :b_to'
              || ') pivot ( sum(qty) for pm in (' || v_cols || ') )'
              || ' order by item_id';

        -- 真用 DBMS_SQL: parse 动态串 -> 绑定区间 -> to_refcursor 转成 sys_refcursor 出参
        -- to_refcursor 会接管游标句柄,转换后不能再对 v_cur_id 做 dbms_sql 操作
        v_cur_id := dbms_sql.open_cursor;
        dbms_sql.parse(v_cur_id, v_sql, dbms_sql.native);
        dbms_sql.bind_variable(v_cur_id, ':b_from', v_from);
        dbms_sql.bind_variable(v_cur_id, ':b_to',   v_to);
        v_dummy := dbms_sql.execute(v_cur_id);
        p_cur := dbms_sql.to_refcursor(v_cur_id);
    exception
        when others then
            if dbms_sql.is_open(v_cur_id) then
                dbms_sql.close_cursor(v_cur_id);
            end if;
            exc_pkg.log_error(
                p_error_code => const_pkg.c_err_system,
                p_module     => const_pkg.c_mod_forecast,
                p_procedure  => 'pivot_demand_dynamic',
                p_error_msg  => '动态透视失败: ' || sqlerrm,
                p_biz_key    => to_char(v_from, 'YYYY-MM') || '..' || to_char(v_to, 'YYYY-MM'));
            raise;
    end pivot_demand_dynamic;

end forecast_pkg;
/
