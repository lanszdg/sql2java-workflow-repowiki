create or replace package body bom_pkg as

    -- BOM 展开 / 反查 / 版本比对 / 成本卷算。
    -- 多层 BOM 是"行的组件本身又是另一物料的 BOM 头物料"形成的树，三种展开实现等价但机制不同:
    --   explode       connect by 一把查出整树结构，cum_qty 借深度优先前序遍历在 PL/SQL 端逐层累乘后 pipe 出
    --   explode_table 局部递归过程 walk 自调下钻，每层 extend 嵌套表，纯 PL/SQL 控制
    --   explode_cte   递归 with 让数据库自己迭代，cum_qty 在 CTE 里直接累乘
    -- 虚拟件(is_phantom，行级优先于物料级)不是领料点但要继续往下穿透；环路是脏数据，
    -- connect by nocycle 兜底不让查询挂死，walk 版靠 path 串里查重并抛 e_bom_cycle。

    function get_active_bom_id(p_item_id in number, p_as_of in date default null) return number is
        v_as_of date := nvl(p_as_of, util_pkg.curr_biz_date());
        v_bom   number;
    begin
        -- 同一时点最多一个默认 ACTIVE 版本，多个生效时取最晚生效那条兜底
        select bom_id into v_bom
          from (
                select bom_id
                  from t_bom_header
                 where item_id    = p_item_id
                   and status     = 'ACTIVE'
                   and is_default  = 'Y'
                   and effective_from <= v_as_of
                   and (effective_to is null or effective_to >= v_as_of)
                 order by effective_from desc
               )
         where rownum = 1;
        return v_bom;
    exception
        when no_data_found then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_bom_no_active, const_pkg.c_mod_bom, 'get_active_bom_id',
                '物料无生效 ACTIVE BOM item_id=' || p_item_id
                || ' as_of=' || to_char(v_as_of, 'YYYY-MM-DD'), to_char(p_item_id));
            return null;
    end get_active_bom_id;


    function get_components(p_bom_id in number) return t_bom_comp_tab is
        v_comps t_bom_comp_tab;
    begin
        -- 当层组件直接 bulk collect 进对象嵌套表，元素只放参与"是否同一组件用量"的字段
        -- (component_item_id/qty_per/uom/scrap_rate)，便于后面 compare_versions 做 multiset 比较
        select t_bom_comp_obj(l.component_item_id, i.item_code, l.qty_per, l.uom, l.scrap_rate)
          bulk collect into v_comps
          from t_bom_line l
          join t_item i on i.item_id = l.component_item_id
         where l.bom_id = p_bom_id
         order by l.line_no;
        return v_comps;
    end get_components;


    function explode(
        p_item_id in number,
        p_qty     in number   default 1,
        p_as_of   in date     default null
    ) return t_explosion_tab pipelined is
        v_as_of date := nvl(p_as_of, util_pkg.curr_biz_date());

        -- 深度优先前序遍历下，按层缓存累计需用量: cum(lvl) = cum(lvl-1) * 本行含损耗实际用量
        -- connect by 自身没有"沿路径累乘"算子，借遍历顺序在 PL/SQL 端补上最干净
        type t_cum_by_lvl is table of number index by pls_integer;
        v_cum t_cum_by_lvl;
        v_row t_explosion_row;
        v_eff number;
    begin
        v_cum(0) := nvl(p_qty, 1);

        for r in (
            select level                       as lvl,
                   h.item_id                   as parent_item_id,
                   l.component_item_id,
                   ci.item_code                as component_code,
                   ci.item_name                as component_name,
                   ci.item_type,
                   l.qty_per,
                   l.uom,
                   l.scrap_rate,
                   case when nvl(l.is_phantom, 'N') = 'Y' or nvl(ci.is_phantom, 'N') = 'Y'
                        then 'Y' else 'N' end   as is_phantom,
                   connect_by_isleaf           as leaf_flag,
                   sys_connect_by_path(ci.item_code, '/') as path
              from t_bom_line l
              join t_bom_header h on h.bom_id = l.bom_id
              join t_item       ci on ci.item_id = l.component_item_id
             where h.status = 'ACTIVE'
               and h.is_default = 'Y'
               and h.effective_from <= v_as_of
               and (h.effective_to is null or h.effective_to >= v_as_of)
            start with h.item_id = p_item_id
            connect by nocycle prior l.component_item_id = h.item_id
             order siblings by l.line_no
        ) loop
            -- 含损耗实际投料 = qty_per / (1 - scrap_rate)，scrap 已被 schema 约束在 [0,1)
            v_eff := r.qty_per / (1 - nvl(r.scrap_rate, 0));
            v_cum(r.lvl) := v_cum(r.lvl - 1) * v_eff;

            v_row := t_explosion_row(
                r.lvl, r.parent_item_id, r.component_item_id,
                r.component_code, r.component_name, r.item_type,
                r.qty_per,
                round(v_cum(r.lvl), 6),
                r.uom, r.path,
                case r.leaf_flag when 1 then 'Y' else 'N' end,
                r.is_phantom);
            pipe row(v_row);
        end loop;
        return;
    end explode;


    procedure explode_table(
        p_item_id in  number,
        p_qty     in  number   default 1,
        p_as_of   in  date     default null,
        p_result  out t_explosion_tab
    ) is
        v_as_of date := nvl(p_as_of, util_pkg.curr_biz_date());

        -- 局部递归过程: 进一层就 extend 一格写结果，再对每个组件自调下钻
        -- p_path 串既做展示路径也做环路检测(组件 id 已在路径里说明绕回来了)，配合层数上限双保险
        procedure walk(
            p_parent_item in number,
            p_cum_qty     in number,
            p_lvl         in number,
            p_path        in varchar2
        ) is
            v_node_path varchar2(1000);
        begin
            if p_lvl > const_pkg.c_max_bom_levels then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_bom_cycle, const_pkg.c_mod_bom, 'explode_table',
                    'BOM 层级超上限 ' || const_pkg.c_max_bom_levels
                    || '，疑似环路 path=' || p_path, to_char(p_parent_item));
            end if;

            for r in (
                select l.component_item_id,
                       ci.item_code,
                       ci.item_name,
                       ci.item_type,
                       l.qty_per,
                       l.uom,
                       l.scrap_rate,
                       case when nvl(l.is_phantom, 'N') = 'Y' or nvl(ci.is_phantom, 'N') = 'Y'
                            then 'Y' else 'N' end as is_phantom
                  from t_bom_line   l
                  join t_bom_header h  on h.bom_id   = l.bom_id
                  join t_item       ci on ci.item_id = l.component_item_id
                 where h.item_id    = p_parent_item
                   and h.status     = 'ACTIVE'
                   and h.is_default  = 'Y'
                   and h.effective_from <= v_as_of
                   and (h.effective_to is null or h.effective_to >= v_as_of)
                 order by l.line_no
            ) loop
                -- 环路检测: 同一组件已经在当前下钻路径上，再出现就是 A->B->A 这类脏数据
                if instr(p_path, '/' || r.component_item_id || '/') > 0 then
                    exc_pkg.raise_biz_error(
                        const_pkg.c_err_bom_cycle, const_pkg.c_mod_bom, 'explode_table',
                        'BOM 环路 component_id=' || r.component_item_id
                        || ' path=' || p_path, to_char(r.component_item_id));
                end if;

                v_node_path := p_path || r.component_item_id || '/';

                p_result.extend;
                p_result(p_result.count) := t_explosion_row(
                    p_lvl,
                    p_parent_item,
                    r.component_item_id,
                    r.item_code,
                    r.item_name,
                    r.item_type,
                    r.qty_per,
                    round(p_cum_qty * (r.qty_per / (1 - nvl(r.scrap_rate, 0))), 6),
                    r.uom,
                    v_node_path,
                    'N',   -- 是否叶先置 N，下钻后无子行的回填见下
                    r.is_phantom);

                walk(
                    p_parent_item => r.component_item_id,
                    p_cum_qty     => p_cum_qty * (r.qty_per / (1 - nvl(r.scrap_rate, 0))),
                    p_lvl         => p_lvl + 1,
                    p_path        => v_node_path);

                -- 下钻没产生新行说明本组件是叶子(无下层 BOM)，回填叶标志
                if p_result(p_result.count).component_item_id = r.component_item_id then
                    p_result(p_result.count).is_leaf := 'Y';
                end if;
            end loop;
        end walk;
    begin
        p_result := t_explosion_tab();
        -- 根的路径用 /item_id/ 起头，方便子层 instr 查重
        walk(p_item_id, nvl(p_qty, 1), 1, '/' || p_item_id || '/');
    end explode_table;


    procedure explode_cte(
        p_item_id in  number,
        p_qty     in  number   default 1,
        p_cur     out sys_refcursor
    ) is
        v_as_of date := util_pkg.curr_biz_date();
    begin
        -- 递归 with: 锚成员是顶层物料的当层组件，递归成员把上一层组件当作下一层 BOM 的头物料续接
        -- cum_qty 在递归里直接累乘(上层 cum * 本行含损耗用量)，路径与层级一并在 CTE 内维护
        open p_cur for
            with bom_tree (
                lvl, parent_item_id, component_item_id, component_code,
                component_name, item_type, qty_per, cum_qty, uom, path, is_phantom
            ) as (
                select 1,
                       h.item_id,
                       l.component_item_id,
                       ci.item_code,
                       ci.item_name,
                       ci.item_type,
                       l.qty_per,
                       round(nvl(p_qty, 1) * (l.qty_per / (1 - nvl(l.scrap_rate, 0))), 6),
                       l.uom,
                       '/' || ci.item_code,
                       case when nvl(l.is_phantom, 'N') = 'Y' or nvl(ci.is_phantom, 'N') = 'Y'
                            then 'Y' else 'N' end
                  from t_bom_line   l
                  join t_bom_header h  on h.bom_id   = l.bom_id
                  join t_item       ci on ci.item_id = l.component_item_id
                 where h.item_id    = p_item_id
                   and h.status     = 'ACTIVE'
                   and h.is_default  = 'Y'
                   and h.effective_from <= v_as_of
                   and (h.effective_to is null or h.effective_to >= v_as_of)
                union all
                select t.lvl + 1,
                       h.item_id,
                       l.component_item_id,
                       ci.item_code,
                       ci.item_name,
                       ci.item_type,
                       l.qty_per,
                       round(t.cum_qty * (l.qty_per / (1 - nvl(l.scrap_rate, 0))), 6),
                       l.uom,
                       t.path || '/' || ci.item_code,
                       case when nvl(l.is_phantom, 'N') = 'Y' or nvl(ci.is_phantom, 'N') = 'Y'
                            then 'Y' else 'N' end
                  from bom_tree     t
                  join t_bom_header h  on h.item_id   = t.component_item_id
                  join t_bom_line   l  on l.bom_id    = h.bom_id
                  join t_item       ci on ci.item_id  = l.component_item_id
                 where h.status     = 'ACTIVE'
                   and h.is_default  = 'Y'
                   and h.effective_from <= v_as_of
                   and (h.effective_to is null or h.effective_to >= v_as_of)
                   and t.lvl < const_pkg.c_max_bom_levels
            )
            select lvl,
                   parent_item_id,
                   component_item_id,
                   component_code,
                   component_name,
                   item_type,
                   qty_per,
                   cum_qty,
                   uom,
                   path,
                   is_phantom
              from bom_tree
             order by path;
    end explode_cte;


    procedure where_used(
        p_component_id in  number,
        p_max_levels   in  number default null,
        p_cur          out sys_refcursor
    ) is
        v_as_of date := util_pkg.curr_biz_date();
    begin
        -- 反查("用在哪"): 从用到本组件的 BOM 行起步，沿 prior 向上爬父项，直到无人再用它
        -- 与正向展开方向相反: 这里 prior 把"子(本层头物料)"连到"父(上层组件)"
        open p_cur for
            select level                          as lvl,
                   h.item_id                      as parent_item_id,
                   pi.item_code                   as parent_code,
                   pi.item_name                   as parent_name,
                   l.component_item_id,
                   l.qty_per,
                   l.uom,
                   connect_by_isleaf              as is_top,
                   sys_connect_by_path(pi.item_code, '<-') as use_path
              from t_bom_line   l
              join t_bom_header h  on h.bom_id   = l.bom_id
              join t_item       pi on pi.item_id = h.item_id
             where h.status     = 'ACTIVE'
               and h.effective_from <= v_as_of
               and (h.effective_to is null or h.effective_to >= v_as_of)
               and (p_max_levels is null or level <= p_max_levels)
            start with l.component_item_id = p_component_id
            connect by nocycle prior h.item_id = l.component_item_id
             order siblings by h.item_id;
    end where_used;


    procedure compare_versions(
        p_bom_id_old in  number,
        p_bom_id_new in  number,
        p_cur        out sys_refcursor
    ) is
        v_old t_bom_comp_tab;
        v_new t_bom_comp_tab;
    begin
        v_old := get_components(p_bom_id_old);
        v_new := get_components(p_bom_id_new);

        -- 对象相等性按全属性逐一比，qty_per 改过的组件会同时落进两个差集，所以分类不能只看差集:
        --   ADDED   组件 id 在 new 的差集里、且整个 old 里都没这个 id  -> 真新增
        --   REMOVED 组件 id 在 old 的差集里、且整个 new 里都没这个 id  -> 真删除
        --   QTY_CHANGED 两版都有该 id(multiset intersect 取按 id 配得上的交集)但 qty_per 不同
        -- multiset except 求两向差集、multiset intersect 求交集，table(...) 把集合拆成行后再配对
        open p_cur for
            with old_set as (
                select component_item_id, component_code, qty_per, uom, scrap_rate
                  from table(v_old)
            ),
            new_set as (
                select component_item_id, component_code, qty_per, uom, scrap_rate
                  from table(v_new)
            ),
            added as (
                select component_item_id, component_code, qty_per, uom
                  from table(v_new multiset except v_old)
            ),
            removed as (
                select component_item_id, component_code, qty_per, uom
                  from table(v_old multiset except v_new)
            ),
            unchanged as (
                -- multiset intersect 取两版逐属性全等的行，这些是没动过的组件
                -- 用它把"用量变了的"从"两版都有该 id"里反向择出来: 在两版都有但不在全等交集里
                select s.component_item_id
                  from table(v_old multiset intersect v_new) s
            )
            select 'ADDED'  as change_type,
                   a.component_item_id,
                   a.component_code,
                   to_number(null)  as old_qty_per,
                   a.qty_per         as new_qty_per,
                   a.uom
              from added a
             where not exists (select 1 from old_set o where o.component_item_id = a.component_item_id)
            union all
            select 'REMOVED',
                   r.component_item_id,
                   r.component_code,
                   r.qty_per,
                   to_number(null),
                   r.uom
              from removed r
             where not exists (select 1 from new_set n where n.component_item_id = r.component_item_id)
            union all
            select 'QTY_CHANGED',
                   o.component_item_id,
                   o.component_code,
                   o.qty_per,
                   n.qty_per,
                   n.uom
              from old_set o
              join new_set n on n.component_item_id = o.component_item_id
             where o.qty_per <> n.qty_per
               and o.component_item_id not in (select component_item_id from unchanged)
             order by change_type, component_item_id;
    end compare_versions;


    -- 私有递归: 自底向上卷算单位成本。叶子(无下层 BOM 或服务/原料)用 t_item.std_cost，
    -- 中间件(有 BOM)= sum(每个组件单位成本 * 含损耗用量) / base_qty。
    -- 刻意做成包内私有函数而非独立 standalone function: install 时独立函数在包之后才加载，
    -- rolled_cost 编译期就要能引用到它，放包内最稳。
    function unit_cost(p_item_id in number, p_as_of in date, p_depth in number) return number is
        v_bom   number;
        v_base  number;
        v_total number := 0;
    begin
        if p_depth > const_pkg.c_max_bom_levels then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_bom_cycle, const_pkg.c_mod_bom, 'rolled_cost',
                '卷算层级超上限，疑似环路 item_id=' || p_item_id, to_char(p_item_id));
        end if;

        begin
            select bom_id, base_qty into v_bom, v_base
              from (
                    select bom_id, base_qty
                      from t_bom_header
                     where item_id    = p_item_id
                       and status     = 'ACTIVE'
                       and is_default  = 'Y'
                       and effective_from <= p_as_of
                       and (effective_to is null or effective_to >= p_as_of)
                     order by effective_from desc
                   )
             where rownum = 1;
        exception
            when no_data_found then
                -- 没有可制造的 BOM，就是采购/服务的叶子件，成本取标准成本
                select std_cost into v_total from t_item where item_id = p_item_id;
                return v_total;
        end;

        for r in (select component_item_id, qty_per, scrap_rate
                    from t_bom_line where bom_id = v_bom) loop
            v_total := v_total
                + unit_cost(r.component_item_id, p_as_of, p_depth + 1)
                  * (r.qty_per / (1 - nvl(r.scrap_rate, 0)));
        end loop;

        -- 行用量是相对 base_qty 的产出，折回单位产出成本
        return round(v_total / nvl(nullif(v_base, 0), 1), 6);
    end unit_cost;


    function rolled_cost(p_item_id in number, p_as_of in date default null) return number is
    begin
        return unit_cost(p_item_id, nvl(p_as_of, util_pkg.curr_biz_date()), 1);
    end rolled_cost;

end bom_pkg;
/
