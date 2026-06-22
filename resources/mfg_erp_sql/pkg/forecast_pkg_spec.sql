-- 需求预测 + 动态透视
-- generate_forecast 用 MODEL 子句做滚动预测: 把历史按期排成"行=物料,列=期"的单元格
-- 用 rule 递推未来期 = 前 N 期移动平均 / 线性趋势，cv()/迭代体现电子表格式计算
-- pivot_demand_dynamic 列(期数)在编译期未知，走 DBMS_SQL 动态拼列再转 ref cursor 返回

create or replace package forecast_pkg as

    -- 生成/刷新预测: MODEL 子句滚动外推，结果 merge 进 t_demand_forecast
    -- p_method: MA3/MA6 移动平均 或 TREND 线性趋势
    procedure generate_forecast(
        p_run_date      in date     default null,
        p_method        in varchar2 default 'MA3',
        p_periods_ahead in number   default 3
    );

    -- 预测准确率: 对已有 actual 的期算 MAPE / 偏差，分析函数给滚动准确率
    procedure forecast_accuracy(
        p_item_id in  number   default null,
        p_cur     out sys_refcursor
    );

    -- 动态透视: 把需求按"物料 x 期"透视成宽表，列数随期数动态变化
    -- 编译期不知有多少列，用 DBMS_SQL 拼 select ... pivot(...) 后 dbms_sql.to_refcursor 返回
    procedure pivot_demand_dynamic(
        p_from_period in  date,
        p_to_period   in  date,
        p_cur         out sys_refcursor
    );

end forecast_pkg;
/
