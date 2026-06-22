-- 采购: PO 状态机 / 收货过账 / MRP 转采购单 / 补货扫描 / 供应商排名
-- PO 状态机: DRAFT -> APPROVED -> PARTIAL -> RECEIVED -> CLOSED，行状态汇总驱动头状态
-- 收货过账委托 inventory_pkg.receive_stock，同事务更新 PO 行 qty_received 与状态
-- 补货扫描用游标 + where current of；供应商排名用 rank/分析函数

create or replace package procurement_pkg as

    procedure create_po(
        p_supplier_id  in  number,
        p_warehouse_id in  number,
        p_expected_date in date,
        p_po_id        out number,
        p_po_no        out varchar2
    );

    procedure add_po_line(
        p_po_id       in number,
        p_item_id     in number,
        p_qty         in number,
        p_unit_price  in number,
        p_uom         in varchar2 default null,
        p_need_date   in date     default null
    );

    -- 审核: DRAFT -> APPROVED，校验供应商未被冻结
    procedure approve_po(p_po_id in number);

    -- 收货过账: 对某 PO 行收货，调库存收货 + 累加 qty_received + 重算行/头状态(状态机)
    -- 超收抛 e_po_over_receipt
    procedure receive_po_line(
        p_po_id     in number,
        p_line_no   in number,
        p_qty       in number,
        p_unit_cost in number default null
    );

    -- 把一次 MRP 运行的计划下单建议批量转成采购单(按供应商归并)，bulk + 集合
    procedure create_po_from_mrp(
        p_run_id     in  number,
        p_po_count   out number
    );

    -- 补货扫描: 游标遍历低于再订货点的物料，where current of 标记并产生补货建议
    procedure reorder_scan(
        p_warehouse_id in  number,
        p_suggest_count out number
    );

    -- 供应商排名: 按采购金额/到货及时率排名(rank/dense_rank/分析函数)
    procedure supplier_ranking(
        p_from_date in  date,
        p_to_date   in  date,
        p_cur       out sys_refcursor
    );

    procedure cancel_po(p_po_id in number, p_reason in varchar2);

end procurement_pkg;
/
