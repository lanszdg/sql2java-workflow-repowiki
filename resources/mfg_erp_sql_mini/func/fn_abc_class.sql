-- 按累计占比定 ABC 等级
-- 阈值默认 80%/95%(帕累托经验值)，调用方可传入覆盖
-- 抽成独立函数是因为 report_pkg 帕累托报表与 item_pkg.reclassify_abc 两处都要同一套判级口径

create or replace function fn_abc_class(
    p_cum_pct in number,
    p_a_pct   in number default 0.80,
    p_b_pct   in number default 0.95
) return varchar2 deterministic is
begin
    if p_cum_pct is null then
        return null;
    end if;
    if p_cum_pct <= p_a_pct then
        return 'A';
    elsif p_cum_pct <= p_b_pct then
        return 'B';
    else
        return 'C';
    end if;
end fn_abc_class;
/
