-- 通用工具: 业务日期、参数读取(重载)、单据号、单位换算
-- 包级全局变量缓存业务日期，包初始化块首次引用时加载
-- get_param 用参数默认值的类型做重载: 同名三个，分别返回 varchar2/number/date

create or replace package util_pkg as

    -- 包级全局(刻意暴露在 spec)
    g_curr_biz_date  date;
    g_last_biz_date  date;
    g_next_biz_date  date;
    g_curr_operator  varchar2(32);
    g_session_id     varchar2(64);

    -- 条件编译开关
    c_trace_compile  constant boolean := false;

    procedure refresh_biz_date;
    function  curr_biz_date return date;
    function  last_biz_date return date;
    function  next_biz_date return date;

    procedure set_operator(p_operator in varchar2);
    function  get_operator return varchar2;

    -- 参数读取重载
    function get_param(p_key in varchar2, p_default in varchar2) return varchar2;
    function get_param(p_key in varchar2, p_default in number)   return number;
    function get_param(p_key in varchar2, p_default in date)     return date;

    -- 单据号
    function gen_doc_no(p_prefix in varchar2, p_seq in number, p_date in date default null) return varchar2;

    -- 单位换算
    function convert_qty(p_qty in number, p_from_uom in varchar2, p_to_uom in varchar2) return number;

    -- 数量按物料基本单位小数位规整
    function round_qty(p_qty in number, p_uom in varchar2) return number;

end util_pkg;
/
