-- 库存批次分配对象 + 嵌套表
-- FIFO 发料时一次出库可能跨多个批次，结果是"每批扣多少、单价多少"的列表
-- inventory_pkg.issue_stock 返回 t_alloc_tab，上层据此生成多条库存流水与成本分摊

create or replace type t_alloc_obj force as object (
    lot_id       number(18),
    lot_no       varchar2(40),
    alloc_qty    number(18,4),
    unit_cost    number(20,6),

    member function alloc_cost return number
);
/

create or replace type body t_alloc_obj as

    member function alloc_cost return number is
    begin
        return round(nvl(self.alloc_qty, 0) * nvl(self.unit_cost, 0), 4);
    end alloc_cost;

end;
/

create or replace type t_alloc_tab force as table of t_alloc_obj;
/
