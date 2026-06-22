-- 物料对象类型层级，刻意做成继承体系压测 sql2java 的 OOP 映射
-- 基类 t_item_obj 抽象(not instantiable)，两类子型各自覆写估值方法与可库存标志:
--   原材料 RAW  -> FIFO 估值、可库存、按供应商提前期补货
--   成品   FG   -> 标准成本估值、可库存、有 BOM
-- valuation_method / is_stockable / lead_time_days 三个方法是上层(costing/mrp)的多态入口

create or replace type t_item_obj force as object (
    item_id     number(18),
    item_code   varchar2(40),
    item_name   varchar2(200),
    base_uom    varchar2(8),
    std_cost    number(20,6),

    not instantiable member function valuation_method return varchar2,
    not instantiable member function is_stockable return varchar2,
    member function lead_time_days return number,
    member function describe return varchar2
) not instantiable not final;
/

create or replace type body t_item_obj as

    member function lead_time_days return number is
    begin
        return 0;
    end lead_time_days;

    member function describe return varchar2 is
    begin
        return self.item_code || ' ' || self.item_name
            || ' [' || self.valuation_method || '/'
            || case self.is_stockable when 'Y' then '可库存' else '不可库存' end || ']';
    end describe;

end;
/


create or replace type t_raw_material_obj force under t_item_obj (
    supplier_id      number(18),
    shelf_life_days  number,
    reorder_point    number(18,4),

    overriding member function valuation_method return varchar2,
    overriding member function is_stockable return varchar2,
    overriding member function lead_time_days return number,
    member function needs_reorder(p_on_hand in number) return varchar2
);
/

create or replace type body t_raw_material_obj as

    overriding member function valuation_method return varchar2 is
    begin
        return 'FIFO';
    end valuation_method;

    overriding member function is_stockable return varchar2 is
    begin
        return 'Y';
    end is_stockable;

    overriding member function lead_time_days return number is
    begin
        return 7;
    end lead_time_days;

    member function needs_reorder(p_on_hand in number) return varchar2 is
    begin
        return case when nvl(p_on_hand, 0) <= nvl(self.reorder_point, 0) then 'Y' else 'N' end;
    end needs_reorder;

end;
/


create or replace type t_finished_good_obj force under t_item_obj (
    bom_id           number(18),
    make_lead_days   number,

    overriding member function valuation_method return varchar2,
    overriding member function is_stockable return varchar2,
    overriding member function lead_time_days return number
);
/

create or replace type body t_finished_good_obj as

    overriding member function valuation_method return varchar2 is
    begin
        return 'STD';
    end valuation_method;

    overriding member function is_stockable return varchar2 is
    begin
        return 'Y';
    end is_stockable;

    overriding member function lead_time_days return number is
    begin
        return nvl(self.make_lead_days, 1);
    end lead_time_days;

end;
/
