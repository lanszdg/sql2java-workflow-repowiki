create or replace package body pricing_pkg as

    -- 取价的两段式: 先定位价目表(客户专属 > 默认)，再在表内命中阶梯规则
    -- 同表内命中顺序: priority 小者先; priority 相同时细粒度优先(物料级 > 分类级 > 通配)
    -- 拿不到规则不直接抛错，退回 t_item.list_price —— 销售单总能出价，缺规则只是"未配特价"
    -- 真要强约束(如合同价必须命中)可在调用侧判 rule_id is null，这里给最大兼容

    -- 私有: 选生效价目表 id。客户挂了专属表且在有效期内就用它，否则落默认表
    function pick_price_list(
        p_customer_id in number,
        p_as_of       in date
    ) return number is
        v_list_id t_price_list.price_list_id%type;
    begin
        if p_customer_id is not null then
            begin
                select pl.price_list_id
                  into v_list_id
                  from t_customer c
                  join t_price_list pl on pl.price_list_id = c.price_list_id
                 where c.customer_id = p_customer_id
                   and pl.is_active = 'Y'
                   and pl.valid_from <= p_as_of
                   and (pl.valid_to is null or pl.valid_to >= p_as_of);
                return v_list_id;
            exception
                when no_data_found then
                    null;  -- 客户没挂专属表或已失效，往下落默认表
            end;
        end if;

        begin
            select price_list_id
              into v_list_id
              from t_price_list
             where is_default = 'Y'
               and is_active = 'Y'
               and valid_from <= p_as_of
               and (valid_to is null or valid_to >= p_as_of);
        exception
            when no_data_found then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_price_list_not_found, const_pkg.c_mod_price, 'pick_price_list',
                    '无可用默认价目表 as_of=' || to_char(p_as_of, 'YYYY-MM-DD'),
                    to_char(p_customer_id));
            when too_many_rows then
                -- 配了多张默认表是配置错误，取一张继续但留日志
                exc_pkg.log_error(
                    const_pkg.c_err_price_list_not_found, const_pkg.c_mod_price, 'pick_price_list',
                    '默认价目表多于一张，任取其一', null, null, 'WARN');
                select min(price_list_id) into v_list_id
                  from t_price_list
                 where is_default = 'Y' and is_active = 'Y'
                   and valid_from <= p_as_of
                   and (valid_to is null or valid_to >= p_as_of);
        end;
        return v_list_id;
    end pick_price_list;


    -- 私有: 在指定价目表内命中一条规则(子查询 order by + rownum=1 取首条)
    -- 命中维度: item / category / customer 列允许为空表示"不限定"，等于该列即匹配
    -- 排序键先 priority 后特异度，让物料级规则盖过分类级，避免乱配 priority 时取错档
    function match_rule(
        p_price_list_id in number,
        p_item_id       in number,
        p_category_id   in number,
        p_customer_id   in number,
        p_qty           in number,
        p_as_of         in date
    ) return t_price_rule%rowtype is
        v_rule t_price_rule%rowtype;
    begin
        select *
          into v_rule
          from (
                select r.*
                  from t_price_rule r
                 where r.price_list_id = p_price_list_id
                   and r.is_active = 'Y'
                   and r.valid_from <= p_as_of
                   and (r.valid_to is null or r.valid_to >= p_as_of)
                   and (r.item_id is null or r.item_id = p_item_id)
                   and (r.category_id is null or r.category_id = p_category_id)
                   and (r.customer_id is null or r.customer_id = p_customer_id)
                   and r.min_qty <= p_qty
                   and (r.max_qty is null or r.max_qty > p_qty)
                 order by r.priority,
                          case when r.item_id is not null then 0 else 1 end,
                          case when r.customer_id is not null then 0 else 1 end,
                          case when r.category_id is not null then 0 else 1 end,
                          r.rule_id
               )
         where rownum = 1;
        return v_rule;
    exception
        when no_data_found then
            v_rule.rule_id := null;
            return v_rule;
    end match_rule;


    -- 私有: 命中规则后按 rule_type 折算最终价，base 为物料标准价或规则基准
    function apply_rule(
        p_rule_type  in varchar2,
        p_price_value in number,
        p_base_price in number
    ) return number is
    begin
        return case p_rule_type
            when const_pkg.c_rule_list         then p_price_value
            when const_pkg.c_rule_override     then p_price_value
            when const_pkg.c_rule_discount_pct then round(p_base_price * (1 - p_price_value), 6)
            when const_pkg.c_rule_discount_amt then greatest(p_base_price - p_price_value, 0)
            else p_base_price
        end;
    end apply_rule;


    procedure get_price_detail(
        p_item_id     in  number,
        p_customer_id in  number,
        p_qty         in  number,
        p_base_price  out number,
        p_final_price out number,
        p_rule_id     out number,
        p_rule_type   out varchar2
    ) is
        v_item    t_item%rowtype;
        v_list_id t_price_list.price_list_id%type;
        v_rule    t_price_rule%rowtype;
        v_qty     number := nvl(p_qty, 1);
        v_as_of   date   := util_pkg.curr_biz_date();
    begin
        begin
            select * into v_item from t_item where item_id = p_item_id;
        exception
            when no_data_found then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_item_not_found, const_pkg.c_mod_price, 'get_price_detail',
                    '物料不存在 item_id=' || p_item_id, to_char(p_item_id));
        end;

        -- 基准价默认取物料标价，DISCOUNT_* 在它上面打折
        p_base_price := v_item.list_price;
        v_list_id    := pick_price_list(p_customer_id, v_as_of);
        v_rule       := match_rule(v_list_id, p_item_id, v_item.category_id,
                                   p_customer_id, v_qty, v_as_of);

        if v_rule.rule_id is null then
            -- 没命中: 退回标价(见包头取舍说明)
            p_rule_id     := null;
            p_rule_type   := null;
            p_final_price := p_base_price;
            return;
        end if;

        -- LIST/OVERRIDE 用规则自身价做基准展示，折扣类仍以标价为基准
        if v_rule.rule_type in (const_pkg.c_rule_list, const_pkg.c_rule_override) then
            p_base_price := v_rule.price_value;
        end if;

        p_rule_id     := v_rule.rule_id;
        p_rule_type   := v_rule.rule_type;
        p_final_price := apply_rule(v_rule.rule_type, v_rule.price_value, v_item.list_price);
    end get_price_detail;


    function get_price(
        p_item_id     in number,
        p_customer_id in number   default null,
        p_qty         in number   default 1,
        p_as_of       in date     default null
    ) return number is
        v_base  number;
        v_final number;
        v_rid   number;
        v_rtype varchar2(16);
    begin
        -- p_as_of 目前由 get_price_detail 内部按业务日期取价; 显式传值场景留待重载扩展
        get_price_detail(p_item_id, p_customer_id, nvl(p_qty, 1),
                         v_base, v_final, v_rid, v_rtype);
        return v_final;
    end get_price;


    procedure reprice_sales_order(p_so_id in number) is
        v_so      t_sales_order%rowtype;
        v_total   number := 0;
        v_base    number;
        v_final   number;
        v_rid     number;
        v_rtype   varchar2(16);
        v_disc    number;

        -- 显式游标 + for update，配合 where current of 逐行回写
        cursor c_line is
            select so_line_id, item_id, qty_ordered, unit_price, discount_pct
              from t_so_line
             where so_id = p_so_id
               and line_status <> const_pkg.c_line_cancel
               for update of unit_price, discount_pct;
    begin
        begin
            select * into v_so from t_sales_order where so_id = p_so_id for update;
        exception
            when no_data_found then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_price_list_not_found, const_pkg.c_mod_price, 'reprice_sales_order',
                    '销售单不存在 so_id=' || p_so_id, to_char(p_so_id));
        end;

        -- DRAFT/CONFIRMED 才允许重定价; 已发货行价格已锁定
        if v_so.status not in ('DRAFT', 'CONFIRMED') then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_price_rule_missing, const_pkg.c_mod_price, 'reprice_sales_order',
                '当前状态不可重定价 status=' || v_so.status, to_char(p_so_id));
        end if;

        for r in c_line loop
            get_price_detail(r.item_id, v_so.customer_id, r.qty_ordered,
                            v_base, v_final, v_rid, v_rtype);

            -- 把折扣额还原成折扣率落在行上(t_so_line.discount_pct 是比率，0<=x<1)
            if v_base > 0 and v_final < v_base then
                v_disc := round((v_base - v_final) / v_base, 4);
            else
                v_disc := 0;
            end if;
            if v_disc >= 1 then
                v_disc := 0.9999;
            end if;

            update t_so_line
               set unit_price   = v_base,
                   discount_pct = v_disc
             where current of c_line;

            v_total := v_total + round(r.qty_ordered * v_base * (1 - v_disc), 4);
        end loop;

        update t_sales_order
           set total_amount = v_total
         where so_id = p_so_id;
    end reprice_sales_order;


    procedure list_effective_rules(
        p_item_id     in  number,
        p_customer_id in  number   default null,
        p_cur         out sys_refcursor
    ) is
        v_item    t_item%rowtype;
        v_list_id t_price_list.price_list_id%type;
        v_as_of   date := util_pkg.curr_biz_date();
    begin
        begin
            select * into v_item from t_item where item_id = p_item_id;
        exception
            when no_data_found then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_item_not_found, const_pkg.c_mod_price, 'list_effective_rules',
                    '物料不存在 item_id=' || p_item_id, to_char(p_item_id));
        end;

        v_list_id := pick_price_list(p_customer_id, v_as_of);

        -- 分析函数 row_number(): 按真实命中排序键给序号，hit_flag=Y 即 get_price 会选中的那条
        -- 这里不加 min_qty 阶梯过滤，把整张表的候选都列出来供前端看分档，序号只标"若数量落档谁先命中"
        open p_cur for
            select r.rule_id,
                   r.price_list_id,
                   r.item_id,
                   r.category_id,
                   r.customer_id,
                   r.min_qty,
                   r.max_qty,
                   r.rule_type,
                   r.price_value,
                   r.priority,
                   row_number() over (
                       order by r.priority,
                                case when r.item_id is not null then 0 else 1 end,
                                case when r.customer_id is not null then 0 else 1 end,
                                case when r.category_id is not null then 0 else 1 end,
                                r.rule_id
                   ) as match_seq,
                   case when row_number() over (
                              order by r.priority,
                                       case when r.item_id is not null then 0 else 1 end,
                                       case when r.customer_id is not null then 0 else 1 end,
                                       case when r.category_id is not null then 0 else 1 end,
                                       r.rule_id) = 1
                        then 'Y' else 'N' end as hit_flag
              from t_price_rule r
             where r.price_list_id = v_list_id
               and r.is_active = 'Y'
               and r.valid_from <= v_as_of
               and (r.valid_to is null or r.valid_to >= v_as_of)
               and (r.item_id is null or r.item_id = p_item_id)
               and (r.category_id is null or r.category_id = v_item.category_id)
               and (r.customer_id is null or r.customer_id = p_customer_id)
             order by match_seq;
    end list_effective_rules;

end pricing_pkg;
/
