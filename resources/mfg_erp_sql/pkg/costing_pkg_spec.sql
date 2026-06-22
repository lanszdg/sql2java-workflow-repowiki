-- 成本: FIFO 分层 / 库存估值 / 移动加权平均 / 落地成本 / 标准成本卷算
-- 分析函数是本包主题: 累计求和、ratio_to_report、ntile 都用上
-- 落地成本报表用 with function(SQL 内联 PL/SQL 函数)，把分摊算法写在查询里

create or replace package costing_pkg as

    -- FIFO 成本分层: 窗口函数算每批的累计可用量与累计金额，定位"第几批起覆盖需求"
    procedure fifo_layers(
        p_item_id      in  number,
        p_warehouse_id in  number,
        p_cur          out sys_refcursor
    );

    -- 库存估值表: 按仓库逐物料算货值，sum() over() 给出仓库小计与占比
    procedure inventory_value(
        p_warehouse_id in  number   default null,
        p_cur          out sys_refcursor
    );

    -- 重算移动加权平均成本并回写 t_inventory_balance.avg_cost
    procedure recompute_avg_cost(p_item_id in number, p_warehouse_id in number);

    -- 落地成本报表: with function 内联 PL/SQL 把运费/关税按金额或重量分摊到行
    -- 演示 SQL 里直接定义并调用 PL/SQL 函数(WITH FUNCTION 子句)
    procedure landed_cost_report(
        p_po_id  in  number,
        p_cur    out sys_refcursor
    );

    -- 标准成本卷算回写: 对所有成品/半成品算 rolled cost 后 merge 回 t_item.std_cost
    procedure roll_standard_cost(p_as_of in date default null);

end costing_pkg;
/
