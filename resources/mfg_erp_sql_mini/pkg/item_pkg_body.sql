create or replace package body item_pkg as

    function get_item_obj(p_item_id in number) return t_item_obj is
        v_item t_item%rowtype;
        v_bom  number;
    begin
        v_item := get_item(p_item_id);

        -- 多态构造: 按 item_type 落到不同子型，返回基类声明类型
        case v_item.item_type
            when c_item_raw then
                return t_raw_material_obj(
                    v_item.item_id, v_item.item_code, v_item.item_name,
                    v_item.base_uom, v_item.std_cost,
                    null, v_item.shelf_life_days, v_item.reorder_point);
            else
                -- FG / SEMI / SVC: 取默认 ACTIVE BOM 头作为对象的 bom_id
                begin
                    select bom_id into v_bom
                      from t_bom_header
                     where item_id    = v_item.item_id
                       and status     = 'ACTIVE'
                       and is_default  = 'Y'
                       and effective_from <= util_pkg.curr_biz_date()
                       and (effective_to is null or effective_to >= util_pkg.curr_biz_date())
                       and rownum = 1;
                exception
                    when no_data_found then
                        v_bom := null;
                end;
                return t_finished_good_obj(
                    v_item.item_id, v_item.item_code, v_item.item_name,
                    v_item.base_uom, v_item.std_cost,
                    v_bom, v_item.lead_time_days);
        end case;
    end get_item_obj;


    function get_item(p_item_id in number) return t_item%rowtype is
        v_item t_item%rowtype;
    begin
        select * into v_item from t_item where item_id = p_item_id;
        return v_item;
    exception
        when no_data_found then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_item_not_found, const_pkg.c_mod_item, 'get_item',
                '物料不存在 item_id=' || p_item_id, to_char(p_item_id));
            return v_item;
    end get_item;


    function find_item_id(p_item_code in varchar2) return number is
        v_id number;
    begin
        select item_id into v_id from t_item where item_code = p_item_code;
        return v_id;
    exception
        when no_data_found then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_item_not_found, const_pkg.c_mod_item, 'find_item_id',
                '物料编码不存在 code=' || p_item_code, p_item_code);
            return null;
    end find_item_id;


    procedure create_item(
        p_item_code      in  varchar2,
        p_item_name      in  varchar2,
        p_item_type      in  varchar2,
        p_category_id    in  number,
        p_base_uom       in  varchar2,
        p_std_cost       in  number   default 0,
        p_dim            in  t_dimension default null,
        p_tags           in  t_tag_varray default null,
        p_item_id        out number
    ) is
    begin
        if p_item_type not in (c_item_raw, c_item_semi, c_item_fg, c_item_svc) then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_item_not_found, const_pkg.c_mod_item, 'create_item',
                '非法物料类型 ' || p_item_type, p_item_code);
        end if;

        p_item_id := seq_item_id.nextval;

        insert into t_item (
            item_id, item_code, item_name, item_type, category_id, base_uom,
            std_cost, valuation_method, dim, tags,
            created_by, created_at
        ) values (
            p_item_id, p_item_code, p_item_name, p_item_type, p_category_id, p_base_uom,
            nvl(p_std_cost, 0),
            case p_item_type when c_item_raw then c_val_fifo
                             else c_val_std end,
            p_dim, p_tags,
            util_pkg.get_operator(), current_timestamp
        );
    end create_item;


    function get_category_path(p_category_id in number) return varchar2 is
        v_path varchar2(500);
    begin
        select sys_connect_by_path(category_code, '/')
          into v_path
          from t_item_category
         where category_id = p_category_id
        start with parent_category_id is null
        connect by prior category_id = parent_category_id;
        return v_path;
    exception
        when no_data_found then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_category_not_found, const_pkg.c_mod_item, 'get_category_path',
                '分类不存在或未挂到根 category_id=' || p_category_id, to_char(p_category_id));
            return null;
    end get_category_path;


    procedure list_category_subtree(
        p_root_category_id in  number,
        p_cur              out sys_refcursor
    ) is
    begin
        open p_cur for
            select category_id,
                   parent_category_id,
                   category_code,
                   category_name,
                   level                              as lvl,
                   connect_by_isleaf                  as is_leaf_calc,
                   connect_by_root category_code      as root_code,
                   sys_connect_by_path(category_code, '/') as path
              from t_item_category
            start with category_id = p_root_category_id
            connect by prior category_id = parent_category_id
             order siblings by category_code;
    end list_category_subtree;


    procedure rebuild_category_tree is
    begin
        merge into t_item_category tgt
        using (
            select category_id,
                   level                                   as level_no,
                   sys_connect_by_path(category_code, '/') as path,
                   case connect_by_isleaf when 1 then 'Y' else 'N' end as is_leaf
              from t_item_category
            start with parent_category_id is null
            connect by prior category_id = parent_category_id
        ) src
        on (tgt.category_id = src.category_id)
        when matched then
            update set tgt.level_no = src.level_no,
                       tgt.path     = src.path,
                       tgt.is_leaf  = src.is_leaf;
    end rebuild_category_tree;


    procedure reclassify_abc(p_from_date in date, p_to_date in date) is
        v_a_pct number := util_pkg.get_param('ABC_A_PCT', 0.80);
        v_b_pct number := util_pkg.get_param('ABC_B_PCT', 0.95);
    begin
        merge into t_item tgt
        using (
            select item_id,
                   case
                       when cum_pct <= v_a_pct then 'A'
                       when cum_pct <= v_b_pct then 'B'
                       else 'C'
                   end as abc_class
              from (
                    select item_id,
                           sum(consume_amt) over (order by consume_amt desc, item_id)
                               / nullif(sum(consume_amt) over (), 0) as cum_pct
                      from (
                            select item_id, sum(total_cost) as consume_amt
                              from t_inventory_txn
                             where direction = const_pkg.c_dir_out
                               and txn_date between p_from_date and p_to_date
                             group by item_id
                            having sum(total_cost) > 0
                           )
                   )
        ) src
        on (tgt.item_id = src.item_id)
        when matched then
            update set tgt.abc_class = src.abc_class,
                       tgt.updated_by = util_pkg.get_operator(),
                       tgt.updated_at = current_timestamp;
    end reclassify_abc;


    procedure apply_item_flat(
        p_item_id    in number,
        p_item_name  in varchar2,
        p_std_cost   in number,
        p_list_price in number,
        p_status     in varchar2,
        p_length_cm  in number,
        p_width_cm   in number,
        p_height_cm  in number,
        p_weight_kg  in number
    ) is
        v_dim t_dimension;
    begin
        if p_length_cm is null and p_width_cm is null
           and p_height_cm is null and p_weight_kg is null then
            v_dim := null;
        else
            v_dim := t_dimension(p_length_cm, p_width_cm, p_height_cm, p_weight_kg);
        end if;

        update t_item
           set item_name  = p_item_name,
               std_cost   = nvl(p_std_cost, std_cost),
               list_price = nvl(p_list_price, list_price),
               status     = nvl(p_status, status),
               dim        = v_dim,
               updated_by = util_pkg.get_operator(),
               updated_at = current_timestamp
         where item_id = p_item_id;

        if sql%rowcount = 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_item_not_found, const_pkg.c_mod_item, 'apply_item_flat',
                '物料不存在 item_id=' || p_item_id, to_char(p_item_id));
        end if;
    end apply_item_flat;

end item_pkg;
/
