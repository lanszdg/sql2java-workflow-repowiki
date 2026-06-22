-- 报表: 静态透视 / 行转列聚合 / 多维小计 / 库龄分桶 / 排名 / 帕累托
-- 集中演示分析与集合类 SQL: pivot、listagg、rollup/cube/grouping sets、窗口函数、grouping()

create or replace package report_pkg as

    -- BOM 当层组件清单拼成一行字符串(listagg，按 line_no 排序)
    function bom_component_list(p_bom_id in number) return varchar2;

    -- 库存按仓库透视: 行=物料，列=各仓库在手量(静态 pivot)
    procedure inventory_by_warehouse(p_cur out sys_refcursor);

    -- 销售汇总(多维小计): 按 分类 x 客户 rollup/cube，grouping() 标小计行
    procedure sales_summary(
        p_from_date in  date,
        p_to_date   in  date,
        p_group_mode in varchar2 default 'ROLLUP',
        p_cur       out sys_refcursor
    );

    -- 库龄分析: 按入库距今天数分桶，ntile 四分位，窗口算占比
    procedure stock_aging(p_cur out sys_refcursor);

    -- 物料消耗 Top N: row_number/rank/dense_rank + fetch first n rows
    procedure top_consumed_items(
        p_from_date in  date,
        p_to_date   in  date,
        p_top_n     in  number default 10,
        p_cur       out sys_refcursor
    );

    -- 库存货值帕累托: 按货值降序累计占比(sum over order by + ratio_to_report)，给 ABC 决策
    procedure inventory_pareto(p_cur out sys_refcursor);

end report_pkg;
/
