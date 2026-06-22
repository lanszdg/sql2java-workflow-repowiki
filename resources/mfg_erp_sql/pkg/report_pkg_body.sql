-- report_pkg 包体: 只读分析报表，全部走 ref cursor / 标量返回，不改数据
-- 这里集中演示分析类 SQL，sql2java 侧多半映射成只读 Mapper + VO，列别名即字段名
-- 库存口径: 余额表 t_inventory_balance 是物料+仓库快照，批次表 t_inventory_lot 带 receipt_date 可算库龄
-- 消耗口径: 流水表 t_inventory_txn 的出库方向(ISSUE/PROD_OUT)累计，比从订单推更准

create or replace package body report_pkg as

    function bom_component_list(p_bom_id in number) return varchar2 is
        v_result varchar2(4000);
        v_exists number;
    begin
        select count(*) into v_exists
          from t_bom_header where bom_id = p_bom_id;
        if v_exists = 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_bom_not_found, const_pkg.c_mod_report, 'bom_component_list',
                'BOM 头不存在 bom_id=' || p_bom_id, to_char(p_bom_id));
        end if;

        -- listagg 把当层组件拼成一行: "10:RAW-001 钢板 x2.5KG; 20:..."
        -- 排序键放进 listagg 的 within group，保证拼出来按工艺行号
        select listagg(
                   l.line_no || ':' || i.item_code || ' ' || i.item_name
                       || ' x' || util_pkg.format_qty(l.qty_per, l.uom),
                   '; ') within group (order by l.line_no)
          into v_result
          from t_bom_line l
          join t_item     i on i.item_id = l.component_item_id
         where l.bom_id = p_bom_id;

        return v_result;
    end bom_component_list;


    procedure inventory_by_warehouse(p_cur out sys_refcursor) is
    begin
        -- 静态 pivot: 仓库就那三个(WH-RAW/WH-FG/WH-WIP)，列写死
        -- 新增仓库要改这里，动态列数的场景见 forecast_pkg.pivot_demand_dynamic 走 DBMS_SQL
        open p_cur for
            select item_id,
                   item_code,
                   item_name,
                   nvl(wh_raw, 0) as qty_wh_raw,
                   nvl(wh_fg,  0) as qty_wh_fg,
                   nvl(wh_wip, 0) as qty_wh_wip,
                   nvl(wh_raw, 0) + nvl(wh_fg, 0) + nvl(wh_wip, 0) as qty_total
              from (
                    select i.item_id,
                           i.item_code,
                           i.item_name,
                           b.warehouse_id,
                           b.qty_on_hand
                      from t_inventory_balance b
                      join t_item i on i.item_id = b.item_id
                     where b.qty_on_hand > 0
                   )
              pivot (
                    sum(qty_on_hand)
                    for warehouse_id in (1 as wh_raw, 2 as wh_fg, 3 as wh_wip)
              )
             order by item_code;
    end inventory_by_warehouse;


    procedure sales_summary(
        p_from_date  in  date,
        p_to_date    in  date,
        p_group_mode in  varchar2 default 'ROLLUP',
        p_cur        out sys_refcursor
    ) is
        v_mode varchar2(8);
    begin
        v_mode := upper(nvl(p_group_mode, 'ROLLUP'));
        if v_mode not in ('ROLLUP', 'CUBE') then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_system, const_pkg.c_mod_report, 'sales_summary',
                'p_group_mode 只支持 ROLLUP / CUBE，传入=' || p_group_mode);
        end if;

        -- 口径取销售订单行 t_so_line join t_sales_order，按订单日期落区间
        -- 没有独立的发货事实表，已发量用 qty_shipped 体现，未发也计入(分析销售订单而非出库)
        -- 维度: 物料分类 x 客户。grouping_id 标识汇总层级:
        --   0 = 明细(分类+客户) / 1 = 按分类小计 / 2 = 按客户小计(仅 cube) / 3 = 总计
        -- rollup 与 cube 在编译期就要定，故拆两支 open，避免拼动态 SQL
        if v_mode = 'CUBE' then
            open p_cur for
                select cat.category_id,
                       cat.category_name,
                       so.customer_id,
                       cu.customer_name,
                       grouping(cat.category_id)  as g_category,
                       grouping(so.customer_id)   as g_customer,
                       grouping_id(cat.category_id, so.customer_id) as gid,
                       count(distinct so.so_id)   as order_count,
                       sum(sl.qty_ordered)        as qty_ordered,
                       sum(sl.qty_shipped)        as qty_shipped,
                       sum(sl.qty_ordered * sl.unit_price * (1 - sl.discount_pct)) as amount
                  from t_so_line      sl
                  join t_sales_order  so  on so.so_id      = sl.so_id
                  join t_item         it  on it.item_id    = sl.item_id
                  left join t_item_category cat on cat.category_id = it.category_id
                  join t_customer     cu  on cu.customer_id = so.customer_id
                 where so.order_date between p_from_date and p_to_date
                   and so.status <> const_pkg.c_line_cancel
                 group by cube(cat.category_id, so.customer_id),
                          cat.category_name, cu.customer_name
                 order by grouping_id(cat.category_id, so.customer_id),
                          cat.category_id, so.customer_id;
        else
            open p_cur for
                select cat.category_id,
                       cat.category_name,
                       so.customer_id,
                       cu.customer_name,
                       grouping(cat.category_id)  as g_category,
                       grouping(so.customer_id)   as g_customer,
                       grouping_id(cat.category_id, so.customer_id) as gid,
                       count(distinct so.so_id)   as order_count,
                       sum(sl.qty_ordered)        as qty_ordered,
                       sum(sl.qty_shipped)        as qty_shipped,
                       sum(sl.qty_ordered * sl.unit_price * (1 - sl.discount_pct)) as amount
                  from t_so_line      sl
                  join t_sales_order  so  on so.so_id      = sl.so_id
                  join t_item         it  on it.item_id    = sl.item_id
                  left join t_item_category cat on cat.category_id = it.category_id
                  join t_customer     cu  on cu.customer_id = so.customer_id
                 where so.order_date between p_from_date and p_to_date
                   and so.status <> const_pkg.c_line_cancel
                 group by rollup(cat.category_id, so.customer_id),
                          cat.category_name, cu.customer_name
                 order by grouping_id(cat.category_id, so.customer_id),
                          cat.category_id, so.customer_id;
        end if;
    end sales_summary;


    procedure stock_aging(p_cur out sys_refcursor) is
    begin
        -- 库龄按批次算: 余额表没有入库时间，只有 t_inventory_lot.receipt_date 能定库龄
        -- 分桶 0-30/31-60/61-90/90+，ntile(4) 给全体批次按库龄四分位
        -- 占比窗口: 各桶在手量 / 全部在手量，over() 空窗即全集
        open p_cur for
            with lot_age as (
                select l.lot_id,
                       l.lot_no,
                       l.item_id,
                       i.item_code,
                       i.item_name,
                       l.warehouse_id,
                       l.qty_on_hand,
                       l.receipt_date,
                       trunc(sysdate) - trunc(l.receipt_date) as age_days
                  from t_inventory_lot l
                  join t_item i on i.item_id = l.item_id
                 where l.status = const_pkg.c_lot_available
                   and l.qty_on_hand > 0
            )
            select lot_id,
                   lot_no,
                   item_code,
                   item_name,
                   warehouse_id,
                   qty_on_hand,
                   receipt_date,
                   age_days,
                   case
                       when age_days <= 30 then '0-30'
                       when age_days <= 60 then '31-60'
                       when age_days <= 90 then '61-90'
                       else '90+'
                   end as age_bucket,
                   ntile(4) over (order by age_days) as age_quartile,
                   round(qty_on_hand
                         / sum(qty_on_hand) over () * 100, 2) as qty_pct
              from lot_age
             order by age_days desc, item_code;
    end stock_aging;


    procedure top_consumed_items(
        p_from_date in  date,
        p_to_date   in  date,
        p_top_n     in  number default 10,
        p_cur       out sys_refcursor
    ) is
    begin
        -- 消耗只算出库方向且属领料/生产投料口径(ISSUE/PROD_OUT)，调拨与退货不算消耗
        -- 三种排名都给: row_number 唯一序、rank 同分跳号、dense_rank 同分连号
        -- fetch first n: 取前 N，并列时 row_number 仍只返回 N 行(要含并列改 with ties)
        open p_cur for
            with consumption as (
                select t.item_id,
                       sum(t.quantity)   as consumed_qty,
                       sum(t.total_cost) as consumed_cost,
                       count(*)          as txn_count
                  from t_inventory_txn t
                 where t.direction = const_pkg.c_dir_out
                   and t.txn_type in (const_pkg.c_txn_issue, const_pkg.c_txn_prod_out)
                   and t.txn_date between p_from_date and p_to_date
                 group by t.item_id
            )
            select i.item_code,
                   i.item_name,
                   i.item_type,
                   c.consumed_qty,
                   c.consumed_cost,
                   c.txn_count,
                   row_number() over (order by c.consumed_qty desc) as rn,
                   rank()       over (order by c.consumed_qty desc) as rnk,
                   dense_rank() over (order by c.consumed_qty desc) as dense_rnk
              from consumption c
              join t_item i on i.item_id = c.item_id
             order by c.consumed_qty desc
             fetch first p_top_n rows only;
    end top_consumed_items;


    procedure inventory_pareto(p_cur out sys_refcursor) is
    begin
        -- 帕累托/ABC: 按货值降序累计占比，给采购做库存重点管控的依据
        -- 货值口径: 余额在手量 * 移动加权平均成本(avg_cost)，FIFO 物料 avg_cost 仅参考但量级可用
        -- sum over(order by desc) 给累计货值，ratio_to_report over() 给单项占比
        -- ABC 阈值: 累计占比 <=80% A 类, <=95% B 类, 其余 C 类(经典 80/15/5)
        open p_cur for
            with item_value as (
                select i.item_id,
                       i.item_code,
                       i.item_name,
                       i.abc_class as abc_class_current,
                       sum(b.qty_on_hand)                  as qty_on_hand,
                       sum(b.qty_on_hand * b.avg_cost)     as stock_value
                  from t_inventory_balance b
                  join t_item i on i.item_id = b.item_id
                 group by i.item_id, i.item_code, i.item_name, i.abc_class
                having sum(b.qty_on_hand * b.avg_cost) > 0
            ),
            ranked as (
                select item_id,
                       item_code,
                       item_name,
                       abc_class_current,
                       qty_on_hand,
                       stock_value,
                       round(ratio_to_report(stock_value) over () * 100, 4) as value_pct,
                       round(sum(stock_value) over (order by stock_value desc)
                             / sum(stock_value) over () * 100, 4)           as cum_pct,
                       row_number() over (order by stock_value desc)        as value_rank
                  from item_value
            )
            select item_id,
                   item_code,
                   item_name,
                   abc_class_current,
                   qty_on_hand,
                   stock_value,
                   value_pct,
                   cum_pct,
                   value_rank,
                   case
                       when cum_pct <= 80 then 'A'
                       when cum_pct <= 95 then 'B'
                       else 'C'
                   end as abc_class_calc
              from ranked
             order by stock_value desc;
    end inventory_pareto;

end report_pkg;
/
