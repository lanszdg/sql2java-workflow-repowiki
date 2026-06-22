-- BOM 展开结果行类型 + 嵌套表，给 bom_pkg 的 pipelined 函数用
-- pipelined 让递归展开能边算边吐行，调用方 select * from table(bom_pkg.explode(...)) 流式消费
-- path 用 sys_connect_by_path 风格的 /a/b/c，cum_qty 是从顶层累乘下来的总需用量

create or replace type t_explosion_row force as object (
    lvl                 number,
    parent_item_id      number(18),
    component_item_id   number(18),
    component_code      varchar2(40),
    component_name      varchar2(200),
    item_type           varchar2(8),
    qty_per             number(18,6),
    cum_qty             number(18,6),
    uom                 varchar2(8),
    path                varchar2(1000),
    is_leaf             varchar2(1),
    is_phantom          varchar2(1)
);
/

create or replace type t_explosion_tab force as table of t_explosion_row;
/
