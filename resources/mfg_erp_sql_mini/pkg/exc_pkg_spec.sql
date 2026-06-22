-- 业务异常 + 错误日志
-- 异常 -> SQLCODE 区间: -20101.. 与 const_pkg 错误码一一对应

create or replace package exc_pkg as

    e_item_not_found       exception;
    e_item_obsolete        exception;
    e_category_not_found   exception;
    e_category_cycle       exception;
    e_uom_not_found        exception;
    e_uom_incompatible     exception;
    e_bom_not_found        exception;
    e_bom_cycle            exception;
    e_bom_no_active        exception;
    e_bom_line_invalid     exception;
    e_stock_insufficient   exception;
    e_lot_not_found        exception;
    e_lot_expired          exception;
    e_balance_not_found    exception;
    e_stock_negative       exception;

    pragma exception_init(e_item_not_found,       -20101);
    pragma exception_init(e_item_obsolete,        -20102);
    pragma exception_init(e_category_not_found,   -20103);
    pragma exception_init(e_category_cycle,       -20104);
    pragma exception_init(e_uom_not_found,        -20111);
    pragma exception_init(e_uom_incompatible,     -20112);
    pragma exception_init(e_bom_not_found,        -20201);
    pragma exception_init(e_bom_cycle,            -20202);
    pragma exception_init(e_bom_no_active,        -20203);
    pragma exception_init(e_bom_line_invalid,     -20204);
    pragma exception_init(e_stock_insufficient,   -20301);
    pragma exception_init(e_lot_not_found,        -20302);
    pragma exception_init(e_lot_expired,          -20303);
    pragma exception_init(e_balance_not_found,    -20304);
    pragma exception_init(e_stock_negative,       -20305);

    -- 写错误日志(自治事务)
    procedure log_error(
        p_error_code   in varchar2,
        p_module       in varchar2,
        p_procedure    in varchar2,
        p_error_msg    in varchar2,
        p_biz_key      in varchar2 default null,
        p_context      in clob     default null,
        p_error_level  in varchar2 default 'ERROR'
    );

    -- 抛业务异常并落日志，统一入口
    procedure raise_biz_error(
        p_error_code  in varchar2,
        p_module      in varchar2,
        p_procedure   in varchar2,
        p_error_msg   in varchar2,
        p_biz_key     in varchar2 default null
    );

    procedure debug(p_module in varchar2, p_msg in varchar2);

    function format_error_stack return varchar2;

    g_debug_on boolean := false;

end exc_pkg;
/
