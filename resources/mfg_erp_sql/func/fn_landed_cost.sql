-- 落地成本(单件)
-- 进口料的真实入库成本 = 采购单价 + 分摊运费 + 关税 + 报关杂费
-- 关税按 (采购价 + 运费) 为完税价乘税率，符合一般到岸价计税口径
-- 报表里按行直接 select 调用，故做成 deterministic 独立函数

create or replace function fn_landed_cost(
    p_unit_price    in number,
    p_freight_share in number default 0,
    p_duty_rate     in number default 0,
    p_misc_share    in number default 0
) return number deterministic is
    v_dutiable number;
    v_duty     number;
begin
    if p_unit_price is null then
        return null;
    end if;
    v_dutiable := p_unit_price + nvl(p_freight_share, 0);
    v_duty     := v_dutiable * nvl(p_duty_rate, 0);
    return round(v_dutiable + v_duty + nvl(p_misc_share, 0), 6);
end fn_landed_cost;
/
