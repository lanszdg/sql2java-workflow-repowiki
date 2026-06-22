-- 金额值对象
-- 系统里多币种金额到处传，裸 number 容易漏带币种导致跨币种直接相加的事故
-- 把"金额 + 币种"绑成一个对象，加总走 plus() 强制同币种校验
-- map 方法让 t_money 能直接进 order by / 集合排序(只比金额，跨币种比较无意义，调用方自行折算)

create or replace type t_money force as object (
    amount         number(20,4),
    currency_code  varchar2(8),

    member function plus(p_other in t_money) return t_money,
    member function minus(p_other in t_money) return t_money,
    member function scale_by(p_factor in number) return t_money,
    member function is_zero return varchar2,
    member function abs_value return t_money,
    member function to_display return varchar2,

    -- 排序键：仅取金额，币种维度由业务层折算后再比
    map member function sort_key return number
);
/

create or replace type body t_money as

    member function plus(p_other in t_money) return t_money is
    begin
        if p_other is null then
            return self;
        end if;
        if self.currency_code <> p_other.currency_code then
            raise_application_error(-20900,
                '金额相加币种不一致: ' || self.currency_code || ' vs ' || p_other.currency_code);
        end if;
        return t_money(self.amount + p_other.amount, self.currency_code);
    end plus;

    member function minus(p_other in t_money) return t_money is
    begin
        return self.plus(t_money(-p_other.amount, p_other.currency_code));
    end minus;

    member function scale_by(p_factor in number) return t_money is
    begin
        return t_money(round(self.amount * nvl(p_factor, 0), 4), self.currency_code);
    end scale_by;

    member function is_zero return varchar2 is
    begin
        return case when nvl(self.amount, 0) = 0 then 'Y' else 'N' end;
    end is_zero;

    member function abs_value return t_money is
    begin
        return t_money(abs(self.amount), self.currency_code);
    end abs_value;

    member function to_display return varchar2 is
    begin
        return to_char(self.amount, 'FM999,999,999,990.0000') || ' ' || self.currency_code;
    end to_display;

    map member function sort_key return number is
    begin
        return nvl(self.amount, 0);
    end sort_key;

end;
/
