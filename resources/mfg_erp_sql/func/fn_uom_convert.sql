-- 单位换算(SQL 友好独立版)
-- 同 util_pkg.convert_qty，但暴露成独立 deterministic 函数便于报表里直接 select 调用:
--   select fn_uom_convert(1.5, 'KG', 'G') from dual
-- 跨类换算返回 null(不抛异常，报表场景更宽容)，命中不到换算系数也返回 null

create or replace function fn_uom_convert(
    p_qty      in number,
    p_from_uom in varchar2,
    p_to_uom   in varchar2
) return number deterministic is
    v_factor   number;
    v_from_cat varchar2(8);
    v_to_cat   varchar2(8);
begin
    if p_qty is null or p_from_uom is null or p_to_uom is null then
        return p_qty;
    end if;
    if p_from_uom = p_to_uom then
        return p_qty;
    end if;

    select max(case when uom_code = p_from_uom then uom_category end),
           max(case when uom_code = p_to_uom   then uom_category end)
      into v_from_cat, v_to_cat
      from t_uom
     where uom_code in (p_from_uom, p_to_uom);

    if v_from_cat is null or v_to_cat is null or v_from_cat <> v_to_cat then
        return null;
    end if;

    begin
        select factor into v_factor
          from t_uom_conversion
         where from_uom = p_from_uom and to_uom = p_to_uom;
    exception
        when no_data_found then
            return null;
    end;

    return p_qty * v_factor;
end fn_uom_convert;
/
