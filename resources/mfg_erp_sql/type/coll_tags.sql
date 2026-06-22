-- 物料标签集合，作为 t_item 的 varray 列
-- 用 varray 而非 nested table: 标签数量上限明确(20)、有序、整体读写，不需要单独增删某个元素
-- 20 这个上限是早期定的，目前最多的料号挂了 11 个标签，留足余量

create or replace type t_tag_varray force as varray(20) of varchar2(30);
/
