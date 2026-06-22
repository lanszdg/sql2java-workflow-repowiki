-- BOM 单位成本卷算(递归独立函数)
-- 沿 BOM 树自底向上递归: 叶子(无生效 BOM 的原料/服务)取标准成本，装配件累加子件成本
-- 与 bom_pkg.rolled_cost 同口径，但做成独立递归函数便于 SQL 里逐料 select 调用:
--   select item_code, fn_bom_unit_cost(item_id) from t_item where item_type='FG'
-- install 时本函数在包之后加载，故包体不依赖它(包内自带等价递归)，避免编译顺序问题
-- 含损耗用量 = qty_per / (1 - scrap_rate)，与 t_bom_comp_obj.effective_qty 一致

create or replace function fn_bom_unit_cost(
    p_item_id in number,
    p_as_of   in date default null
) return number is
    v_dt       date := nvl(p_as_of, sysdate);
    v_bom_id   number;
    v_base_qty number;
    v_total    number := 0;
begin
    begin
        select bom_id, base_qty
          into v_bom_id, v_base_qty
          from (
                select bom_id, base_qty
                  from t_bom_header
                 where item_id = p_item_id
                   and status  = 'ACTIVE'
                   and is_default = 'Y'
                   and effective_from <= v_dt
                   and (effective_to is null or effective_to >= v_dt)
                 order by effective_from desc
               )
         where rownum = 1;
    exception
        when no_data_found then
            -- 叶子: 没有生效 BOM，单位成本就是它自己的标准成本
            select std_cost into v_total from t_item where item_id = p_item_id;
            return v_total;
    end;

    for c in (
        select component_item_id, qty_per, scrap_rate
          from t_bom_line
         where bom_id = v_bom_id
    ) loop
        v_total := v_total
                 + fn_bom_unit_cost(c.component_item_id, v_dt)
                   * (c.qty_per / (1 - nvl(c.scrap_rate, 0)));
    end loop;

    return round(v_total / nullif(v_base_qty, 0), 6);
end fn_bom_unit_cost;
/
