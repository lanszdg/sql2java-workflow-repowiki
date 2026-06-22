-- 全局常量
-- 错误码分域: M1 物料/分类 / M2 BOM / M3 库存 / M9 系统
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

    -- BOM 状态
    c_bom_draft    constant varchar2(12) := 'DRAFT';
    c_bom_active   constant varchar2(12) := 'ACTIVE';
    c_bom_obsolete constant varchar2(12) := 'OBSOLETE';

    -- 业务参数
    c_default_currency   constant varchar2(8) := 'CNY';
    c_max_bom_levels     constant number := 20;
    c_bulk_limit         constant number := 1000;

    -- 模块名
    c_mod_item     constant varchar2(64) := 'ITEM';
    c_mod_bom      constant varchar2(64) := 'BOM';
    c_mod_inv      constant varchar2(64) := 'INVENTORY';
    c_mod_util     constant varchar2(64) := 'UTIL';

end const_pkg;
/
