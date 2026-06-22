-- 全局常量
-- 错误码分域: M1 物料/分类 / M2 BOM / M3 库存 / M4 采购订单 / M5 MRP生产 / M6 定价 / M9 系统
-- 错误码与 exc_pkg 的 pragma exception_init、raise_biz_error 里的 SQLCODE 映射三处必须同步

create or replace package const_pkg as

    -- 错误码: 物料/分类
    c_err_item_not_found       constant varchar2(16) := 'M1001';
    c_err_item_obsolete        constant varchar2(16) := 'M1002';
    c_err_category_not_found   constant varchar2(16) := 'M1003';
    c_err_category_cycle       constant varchar2(16) := 'M1004';
    c_err_uom_not_found        constant varchar2(16) := 'M1101';
    c_err_uom_incompatible     constant varchar2(16) := 'M1102';

    -- 错误码: BOM
    c_err_bom_not_found        constant varchar2(16) := 'M2001';
    c_err_bom_cycle            constant varchar2(16) := 'M2002';
    c_err_bom_no_active        constant varchar2(16) := 'M2003';
    c_err_bom_line_invalid     constant varchar2(16) := 'M2004';

    -- 错误码: 库存
    c_err_stock_insufficient   constant varchar2(16) := 'M3001';
    c_err_lot_not_found        constant varchar2(16) := 'M3002';
    c_err_lot_expired          constant varchar2(16) := 'M3003';
    c_err_balance_not_found    constant varchar2(16) := 'M3004';
    c_err_stock_negative       constant varchar2(16) := 'M3005';

    -- 错误码: 采购订单
    c_err_po_not_found         constant varchar2(16) := 'M4001';
    c_err_po_status_invalid    constant varchar2(16) := 'M4002';
    c_err_po_over_receipt      constant varchar2(16) := 'M4003';
    c_err_supplier_blocked     constant varchar2(16) := 'M4004';

    -- 错误码: MRP / 生产
    c_err_mrp_running          constant varchar2(16) := 'M5001';
    c_err_mrp_run_not_found    constant varchar2(16) := 'M5002';
    c_err_prod_not_found       constant varchar2(16) := 'M5003';

    -- 错误码: 定价
    c_err_price_rule_missing   constant varchar2(16) := 'M6001';
    c_err_price_list_not_found constant varchar2(16) := 'M6002';

    c_err_system               constant varchar2(16) := 'M9999';

    -- 物料类型
    c_item_raw   constant varchar2(8) := 'RAW';
    c_item_semi  constant varchar2(8) := 'SEMI';
    c_item_fg    constant varchar2(8) := 'FG';
    c_item_svc   constant varchar2(8) := 'SVC';

    -- 估值方法
    c_val_fifo   constant varchar2(8) := 'FIFO';
    c_val_std    constant varchar2(8) := 'STD';
    c_val_avg    constant varchar2(8) := 'AVG';
    c_val_none   constant varchar2(8) := 'NONE';

    -- 库存事务类型
    c_txn_recv      constant varchar2(12) := 'RECV';
    c_txn_issue     constant varchar2(12) := 'ISSUE';
    c_txn_adj       constant varchar2(12) := 'ADJ';
    c_txn_xfer_out  constant varchar2(12) := 'XFER_OUT';
    c_txn_xfer_in   constant varchar2(12) := 'XFER_IN';
    c_txn_prod_in   constant varchar2(12) := 'PROD_IN';
    c_txn_prod_out  constant varchar2(12) := 'PROD_OUT';
    c_txn_return    constant varchar2(12) := 'RETURN';

    -- 库存方向
    c_dir_in    constant char(1) := 'I';
    c_dir_out   constant char(1) := 'O';

    -- 批次状态
    c_lot_available  constant varchar2(12) := 'AVAILABLE';
    c_lot_quarantine constant varchar2(12) := 'QUARANTINE';
    c_lot_expired    constant varchar2(12) := 'EXPIRED';
    c_lot_consumed   constant varchar2(12) := 'CONSUMED';

    -- 采购订单状态
    c_po_draft     constant varchar2(12) := 'DRAFT';
    c_po_approved  constant varchar2(12) := 'APPROVED';
    c_po_partial   constant varchar2(12) := 'PARTIAL';
    c_po_received  constant varchar2(12) := 'RECEIVED';
    c_po_closed    constant varchar2(12) := 'CLOSED';
    c_po_cancelled constant varchar2(12) := 'CANCELLED';

    -- 订单行状态
    c_line_open    constant varchar2(12) := 'OPEN';
    c_line_partial constant varchar2(12) := 'PARTIAL';
    c_line_closed  constant varchar2(12) := 'CLOSED';
    c_line_cancel  constant varchar2(12) := 'CANCELLED';

    -- 生产工单状态
    c_prod_planned    constant varchar2(12) := 'PLANNED';
    c_prod_released   constant varchar2(12) := 'RELEASED';
    c_prod_inprogress constant varchar2(12) := 'IN_PROGRESS';
    c_prod_completed  constant varchar2(12) := 'COMPLETED';
    c_prod_closed     constant varchar2(12) := 'CLOSED';

    -- MRP 运行状态
    c_mrp_running constant varchar2(12) := 'RUNNING';
    c_mrp_success constant varchar2(12) := 'SUCCESS';
    c_mrp_failed  constant varchar2(12) := 'FAILED';
    c_mrp_partial constant varchar2(12) := 'PARTIAL';

    -- 定价规则类型
    c_rule_list         constant varchar2(16) := 'LIST';
    c_rule_discount_pct constant varchar2(16) := 'DISCOUNT_PCT';
    c_rule_discount_amt constant varchar2(16) := 'DISCOUNT_AMT';
    c_rule_override     constant varchar2(16) := 'OVERRIDE';

    -- 业务参数(高频读，做成包常量；可配的放 t_app_param)
    c_default_currency   constant varchar2(8) := 'CNY';
    c_max_bom_levels     constant number := 20;
    c_year_days          constant number := 365;
    c_bulk_limit         constant number := 1000;

    -- 模块名(错误日志/审计)
    c_mod_item     constant varchar2(64) := 'ITEM';
    c_mod_bom      constant varchar2(64) := 'BOM';
    c_mod_inv      constant varchar2(64) := 'INVENTORY';
    c_mod_cost     constant varchar2(64) := 'COSTING';
    c_mod_price    constant varchar2(64) := 'PRICING';
    c_mod_procure  constant varchar2(64) := 'PROCUREMENT';
    c_mod_mrp      constant varchar2(64) := 'MRP';
    c_mod_forecast constant varchar2(64) := 'FORECAST';
    c_mod_report   constant varchar2(64) := 'REPORT';
    c_mod_util     constant varchar2(64) := 'UTIL';
    c_mod_sched    constant varchar2(64) := 'SCHED';

end const_pkg;
/
