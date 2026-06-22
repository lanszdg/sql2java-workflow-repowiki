create or replace package body util_pkg as

    -- 单位小数位缓存，按 uom_code 索引，首次用到时懒加载
    type t_uom_digits is table of number index by varchar2(8);
    g_uom_digits t_uom_digits;

    -- 单位所属 category 缓存，convert_qty 用来判同类
    type t_uom_cat is table of varchar2(8) index by varchar2(8);
    g_uom_cat t_uom_cat;


    procedure load_uom_cache is
    begin
        g_uom_digits.delete;
        g_uom_cat.delete;
        for r in (select uom_code, uom_category, decimal_digits from t_uom) loop
            g_uom_digits(r.uom_code) := r.decimal_digits;
            g_uom_cat(r.uom_code)    := r.uom_category;
        end loop;
    end load_uom_cache;


    procedure refresh_biz_date is
    begin
        select curr_biz_date, last_biz_date, next_biz_date
          into g_curr_biz_date, g_last_biz_date, g_next_biz_date
          from t_business_date
         where sys_code = 'CORE';
    exception
        when no_data_found then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_system, const_pkg.c_mod_util, 'refresh_biz_date',
                '业务日期表 t_business_date(sys_code=CORE) 未初始化');
    end refresh_biz_date;


    function curr_biz_date return date is
    begin
        if g_curr_biz_date is null then
            refresh_biz_date;
        end if;
        return g_curr_biz_date;
    end curr_biz_date;


    function last_biz_date return date is
    begin
        if g_last_biz_date is null then
            refresh_biz_date;
        end if;
        return g_last_biz_date;
    end last_biz_date;


    function next_biz_date return date is
    begin
        if g_next_biz_date is null then
            refresh_biz_date;
        end if;
        return g_next_biz_date;
    end next_biz_date;


    procedure set_operator(p_operator in varchar2) is
    begin
        g_curr_operator := nvl(p_operator, 'SYSTEM');
    end set_operator;


    function get_operator return varchar2 is
    begin
        return nvl(g_curr_operator, nvl(sys_context('userenv','session_user'), 'SYSTEM'));
    end get_operator;


    function get_param(p_key in varchar2, p_default in varchar2) return varchar2 is
        v_val t_app_param.param_value%type;
    begin
        select param_value into v_val from t_app_param where param_key = p_key;
        return nvl(v_val, p_default);
    exception
        when no_data_found then
            return p_default;
    end get_param;


    function get_param(p_key in varchar2, p_default in number) return number is
        v_val t_app_param.param_value%type;
    begin
        select param_value into v_val from t_app_param where param_key = p_key;
        return nvl(to_number(v_val), p_default);
    exception
        when no_data_found then
            return p_default;
        when value_error then
            -- 配错成非数字时退回默认值并告警，不让跑批因一个脏参数崩掉
            exc_pkg.log_error(
                const_pkg.c_err_system, const_pkg.c_mod_util, 'get_param',
                '参数非数字 key=' || p_key || ' val=' || v_val, p_key, null, 'WARN');
            return p_default;
    end get_param;


    function get_param(p_key in varchar2, p_default in date) return date is
        v_val t_app_param.param_value%type;
    begin
        select param_value into v_val from t_app_param where param_key = p_key;
        return nvl(to_date(v_val, 'YYYY-MM-DD'), p_default);
    exception
        when no_data_found then
            return p_default;
    end get_param;


    function gen_doc_no(p_prefix in varchar2, p_seq in number, p_date in date default null) return varchar2 is
    begin
        return p_prefix || to_char(nvl(p_date, curr_biz_date), 'YYYYMMDD')
            || lpad(mod(p_seq, 1000000), 6, '0');
    end gen_doc_no;


    function convert_qty(p_qty in number, p_from_uom in varchar2, p_to_uom in varchar2) return number is
        v_factor number;
    begin
        if p_from_uom = p_to_uom or p_qty is null then
            return p_qty;
        end if;

        if g_uom_cat.count = 0 then
            load_uom_cache;
        end if;

        -- 跨类换算无意义(重量换不成长度)，直接拦
        if not (g_uom_cat.exists(p_from_uom) and g_uom_cat.exists(p_to_uom)) then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_uom_not_found, const_pkg.c_mod_util, 'convert_qty',
                '单位未定义 from=' || p_from_uom || ' to=' || p_to_uom, p_from_uom);
        end if;
        if g_uom_cat(p_from_uom) <> g_uom_cat(p_to_uom) then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_uom_incompatible, const_pkg.c_mod_util, 'convert_qty',
                '单位不同类不可换算 ' || p_from_uom || '(' || g_uom_cat(p_from_uom) || ') -> '
                || p_to_uom || '(' || g_uom_cat(p_to_uom) || ')', p_from_uom);
        end if;

        $if util_pkg.c_trace_compile $then
            dbms_output.put_line('[TRACE] convert_qty ' || p_qty || ' ' || p_from_uom || '->' || p_to_uom);
        $end

        begin
            select factor into v_factor
              from t_uom_conversion
             where from_uom = p_from_uom and to_uom = p_to_uom;
        exception
            when no_data_found then
                -- 同类但缺直接换算系数，回退按基本单位枢轴折算
                select f.factor / t.factor
                  into v_factor
                  from t_uom_conversion f
                  join t_uom_conversion t on t.from_uom = p_to_uom and t.to_uom = f.to_uom
                 where f.from_uom = p_from_uom
                   and rownum = 1;
        end;

        return round_qty(p_qty * v_factor, p_to_uom);
    end convert_qty;


    function round_qty(p_qty in number, p_uom in varchar2) return number is
        v_digits number;
    begin
        if p_qty is null then
            return null;
        end if;
        if g_uom_digits.count = 0 then
            load_uom_cache;
        end if;
        v_digits := case when g_uom_digits.exists(p_uom) then g_uom_digits(p_uom) else 4 end;
        return round(p_qty, v_digits);
    end round_qty;


    function format_qty(p_qty in number, p_uom in varchar2 default null) return varchar2 is
        v_digits number;
        v_fmt    varchar2(40);
    begin
        if p_qty is null then
            return null;
        end if;
        if g_uom_digits.count = 0 then
            load_uom_cache;
        end if;
        v_digits := case when p_uom is not null and g_uom_digits.exists(p_uom)
                         then g_uom_digits(p_uom) else 2 end;
        v_fmt := 'FM999,999,999,990'
              || case when v_digits > 0 then '.' || rpad('0', v_digits, '0') end;
        return trim(to_char(round(p_qty, v_digits), v_fmt))
            || case when p_uom is not null then ' ' || p_uom end;
    end format_qty;


    procedure clear_cache is
    begin
        g_curr_biz_date := null;
        g_last_biz_date := null;
        g_next_biz_date := null;
        g_uom_digits.delete;
        g_uom_cat.delete;
    end clear_cache;


-- 包初始化块: session 首次引用本包时跑一次，失败不炸 session
begin
    g_session_id    := sys_context('userenv','sessionid');
    g_curr_operator := nvl(sys_context('userenv','session_user'), 'SYSTEM');
    begin
        refresh_biz_date;
        load_uom_cache;
    exception
        when others then
            dbms_output.put_line('[WARN] util_pkg init partially failed: ' || sqlerrm);
    end;
end util_pkg;
/
