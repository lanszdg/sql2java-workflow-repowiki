-- BOM 单层组件对象 + 嵌套表
-- bom_pkg 比较两个 BOM 版本差异时用 multiset except/intersect，需要可比较的元素类型
-- 元素相等性由 oracle 按对象所有属性逐一比较，这里刻意只放参与"是否同一组件用量"的字段
-- (不含 line_id 这类代理键，否则 multiset 比较永远全不等)

create or replace type t_bom_comp_obj force as object (
    component_item_id   number(18),
    component_code      varchar2(40),
    qty_per             number(18,6),
    uom                 varchar2(8),
    scrap_rate          number(8,4),

    -- 含损耗的实际投料量: qty_per / (1 - scrap_rate)
    member function effective_qty return number
);
/

create or replace type body t_bom_comp_obj as

    member function effective_qty return number is
    begin
        if nvl(self.scrap_rate, 0) >= 1 then
            raise_application_error(-20901,
                '损耗率不能 >= 1: ' || self.component_code || ' scrap=' || self.scrap_rate);
        end if;
        return round(self.qty_per / (1 - nvl(self.scrap_rate, 0)), 6);
    end effective_qty;

end;
/

create or replace type t_bom_comp_tab force as table of t_bom_comp_obj;
/
