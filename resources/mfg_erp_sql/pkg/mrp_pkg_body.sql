-- MRP 物料需求计划 包体
-- 低层码决定净算顺序: 同一物料若被多层 BOM 用到,必须等它在所有上层的毛需求都汇齐
-- 才能净算,所以先算每个物料在 BOM 树中的最大深度(低层码),再按低层码升序逐层推进
-- 顶层独立需求(成品/半成品)在 level 0/低层码起点,相关需求靠 bom_pkg.explode 下放到子件
-- 净算公式: 净需求 = 毛需求 - 在手可用 - 在途(未收 PO),净需求>0 才产计划行

create or replace package body mrp_pkg as

    -- 逐层净算时手里攥的"按物料汇总的毛需求",key=item_id
    -- 走联合数组而非临时表: 一次运行物料数有限(几千内),纯内存滚动更省往返
    type t_qty_map is table of number index by pls_integer;

    -- 低层码缓存: item_id -> low-level code,run_mrp 内一次算好供排序
    type t_llc_map is table of pls_integer index by pls_integer;

    -- 计划行批量缓冲(供 forall merge)
    type t_plan_rec is record (
        item_id            number,
        warehouse_id       number,
        bucket_date        date,
        level_no           number,
        gross_req          number,
        scheduled_receipt  number,
        proj_on_hand       number,
        net_req            number,
        planned_order_qty  number,
        planned_order_date date,
        action_msg         varchar2(40)
    );
    type t_plan_list is table of t_plan_rec index by pls_integer;


    -- 取物料默认仓库: MRP 不区分多仓时落到余额里在手最多的仓,没库存就给 null(留待采购/生产指定)
    function pick_warehouse(p_item_id in number) return number is
        v_wh number;
    begin
        select warehouse_id into v_wh
          from (
                select warehouse_id
                  from t_inventory_balance
                 where item_id = p_item_id
                 order by qty_on_hand desc, warehouse_id
               )
         where rownum = 1;
        return v_wh;
    exception
        when no_data_found then
            return null;
    end pick_warehouse;


    procedure compute_low_level_codes is
        -- 这里只演示低层码的算法本身(沿 BOM 全树下钻取每个组件出现过的最大 level)
        -- t_item 没有持久低层码列,真正净算用的低层码在 run_mrp 里就地算;此过程供运维核对/将来落列
        v_cnt number := 0;
    begin
        -- 以每个有 BOM 的物料为根全展开,connect by level 即该组件相对此根的深度
        -- 跨多个根取 max,就是该物料在整个产品结构里能下沉到的最深层 = 低层码
        for r in (
            select component_item_id as item_id, max(lvl) as llc
              from (
                    select bl.component_item_id, level as lvl
                      from t_bom_line bl
                      join t_bom_header bh on bh.bom_id = bl.bom_id
                     where bh.status = 'ACTIVE'
                     start with bh.item_id in (select item_id from t_item where item_type in ('FG','SEMI'))
                    connect by nocycle prior bl.component_item_id = bh.item_id
                                   and bh.status = 'ACTIVE'
                   )
             group by component_item_id
        ) loop
            v_cnt := v_cnt + 1;
            null;  -- 无持久列可回写时此处为占位;落库版本会 update t_item set low_level_code = r.llc
        end loop;

        if util_pkg.c_trace_compile then
            exc_pkg.debug(const_pkg.c_mod_mrp, 'compute_low_level_codes touched ' || v_cnt || ' items');
        end if;
    end compute_low_level_codes;


    procedure run_mrp(
        p_run_date     in  date    default null,
        p_horizon_days in  number  default null,
        p_run_id       out number
    ) is
        v_run_date date := nvl(p_run_date, util_pkg.curr_biz_date());
        v_horizon  number := nvl(p_horizon_days, 90);
        v_run_no   varchar2(32);
        v_horizon_end date;

        v_gross    t_qty_map;   -- 当前层各物料累计毛需求
        v_llc      t_llc_map;   -- 各物料低层码
        v_plans    t_plan_list;
        v_pidx     pls_integer := 0;

        v_item_set sys.odcinumberlist := sys.odcinumberlist();  -- 出现过需求的物料集
        v_max_llc  pls_integer := 0;

        v_avail    number;
        v_intransit number;
        v_net      number;
        v_lead     number;
        v_wh       number;
        v_item_cnt number := 0;
        v_plan_cnt number := 0;

        -- 把一个物料的毛需求登记进 v_gross,并记入物料集与低层码
        procedure add_demand(p_item_id in number, p_qty in number) is
        begin
            if not v_gross.exists(p_item_id) then
                v_gross(p_item_id) := 0;
                v_item_set.extend;
                v_item_set(v_item_set.count) := p_item_id;
            end if;
            v_gross(p_item_id) := v_gross(p_item_id) + nvl(p_qty, 0);
        end add_demand;
    begin
        v_run_no := util_pkg.gen_doc_no('MRP', seq_mrp_run_id.nextval, v_run_date);
        v_run_id := seq_mrp_run_id.currval;
        p_run_id := v_run_id;
        v_horizon_end := v_run_date + v_horizon;

        insert into t_mrp_run(
            run_id, run_no, run_date, horizon_days, bucket_type,
            status, item_count, plan_count, started_at, created_by
        ) values (
            v_run_id, v_run_no, v_run_date, v_horizon, 'WEEK',
            const_pkg.c_mrp_running, 0, 0, current_timestamp, util_pkg.get_operator()
        );

        -- 1) 顶层独立需求: 预测未来期 + 销售订单未发货行
        --    预测取窗口内、按物料汇总;销售订单取 qty_ordered - qty_shipped 的缺口
        for d in (
            select item_id, sum(qty) as qty
              from (
                    select f.item_id, f.forecast_qty as qty
                      from t_demand_forecast f
                     where f.period_date between v_run_date and v_horizon_end
                       and f.forecast_qty > 0
                    union all
                    select sl.item_id, (sl.qty_ordered - sl.qty_shipped) as qty
                      from t_so_line sl
                      join t_sales_order so on so.so_id = sl.so_id
                     where sl.line_status in ('OPEN','PARTIAL')
                       and so.status      in ('CONFIRMED','PARTIAL')
                       and sl.qty_ordered > sl.qty_shipped
                       and nvl(so.required_date, v_run_date) <= v_horizon_end
                   )
             group by item_id
        ) loop
            add_demand(d.item_id, d.qty);
        end loop;

        -- 2) 给本批所有物料定低层码(供逐层推进的排序键)
        --    顶层独立需求物料先各自记 0,展开过程中遇到更深的会被覆盖成更大值
        compute_low_level_codes;
        for i in 1 .. v_item_set.count loop
            v_llc(v_item_set(i)) := 0;
        end loop;

        -- 把整张产品结构的低层码合进来(独立需求物料若是别人的子件也要取深值)
        for r in (
            select component_item_id as item_id, max(lvl) as llc
              from (
                    select bl.component_item_id, level as lvl
                      from t_bom_line bl
                      join t_bom_header bh on bh.bom_id = bl.bom_id
                     where bh.status = 'ACTIVE'
                     start with bh.item_id in (select item_id from t_item where item_type in ('FG','SEMI'))
                    connect by nocycle prior bl.component_item_id = bh.item_id
                                   and bh.status = 'ACTIVE'
                   )
             group by component_item_id
        ) loop
            v_llc(r.item_id) := greatest(nvl(v_llc(r.item_id), 0), r.llc);
            if v_llc(r.item_id) > v_max_llc then
                v_max_llc := v_llc(r.item_id);
            end if;
        end loop;

        -- 3) 按低层码升序逐层净算: 第 L 层处理所有低层码=L 且有毛需求的物料
        --    本层算出净需求 -> 沿其 ACTIVE BOM 展开把相关需求加到子件(子件低层码必然 > L)
        for lvl in 0 .. v_max_llc loop
            for i in 1 .. v_item_set.count loop
                declare
                    v_item number := v_item_set(i);
                begin
                    -- 只在物料所属层处理一次,且本层确有正毛需求
                    if nvl(v_llc(v_item), 0) <> lvl or nvl(v_gross(v_item), 0) <= 0 then
                        goto next_item;
                    end if;

                    v_item_cnt := v_item_cnt + 1;
                    v_wh := pick_warehouse(v_item);

                    -- 在手可用: 有默认仓走该仓,否则跨仓汇总余额
                    if v_wh is not null then
                        v_avail := nvl(inventory_pkg.get_available(v_item, v_wh), 0);
                    else
                        select nvl(sum(qty_on_hand - qty_allocated), 0)
                          into v_avail
                          from t_inventory_balance
                         where item_id = v_item;
                    end if;

                    -- 在途: 窗口内未收完的采购订单行(qty_ordered - qty_received)
                    select nvl(sum(pl.qty_ordered - pl.qty_received), 0)
                      into v_intransit
                      from t_po_line pl
                      join t_purchase_order po on po.po_id = pl.po_id
                     where pl.item_id = v_item
                       and pl.line_status in ('OPEN','PARTIAL')
                       and po.status      in ('APPROVED','PARTIAL')
                       and nvl(pl.need_date, v_run_date) <= v_horizon_end;

                    v_net := v_gross(v_item) - v_avail - v_intransit;

                    -- 提前期倒排: 计划下单日 = 需求日 - 提前期(简化用窗口末当需求日)
                    select lead_time_days into v_lead from t_item where item_id = v_item;

                    v_pidx := v_pidx + 1;
                    v_plans(v_pidx).item_id           := v_item;
                    v_plans(v_pidx).warehouse_id      := v_wh;
                    v_plans(v_pidx).bucket_date       := v_horizon_end;
                    v_plans(v_pidx).level_no          := lvl;
                    v_plans(v_pidx).gross_req         := util_pkg.round_qty(v_gross(v_item), null);
                    v_plans(v_pidx).scheduled_receipt := v_intransit;
                    v_plans(v_pidx).proj_on_hand      := v_avail;

                    if v_net > 0 then
                        v_plans(v_pidx).net_req            := util_pkg.round_qty(v_net, null);
                        v_plans(v_pidx).planned_order_qty  := util_pkg.round_qty(v_net, null);
                        v_plans(v_pidx).planned_order_date := v_horizon_end - nvl(v_lead, 0);
                        v_plans(v_pidx).action_msg         := '建议下单 提前期' || nvl(v_lead, 0) || '天';

                        -- 相关需求下放: 用净需求展开 ACTIVE BOM,把每个组件的累计用量加进毛需求
                        -- explode 的 cum_qty 已是自顶向下累乘(含损耗),按净需求传 p_qty 即得各子件总用量
                        -- 虚拟件(is_phantom='Y')只是 BOM 结构层,不单独领料,跳过不计需求
                        begin
                            for c in (
                                select component_item_id, cum_qty, is_phantom
                                  from table(bom_pkg.explode(v_item, v_net, v_run_date))
                                 where lvl = 1
                            ) loop
                                if nvl(c.is_phantom, 'N') <> 'Y' then
                                    add_demand(c.component_item_id, c.cum_qty);
                                    -- 新出现的子件补登低层码,确保后续层能处理到
                                    if not v_llc.exists(c.component_item_id) then
                                        v_llc(c.component_item_id) := lvl + 1;
                                        if lvl + 1 > v_max_llc then
                                            v_max_llc := lvl + 1;
                                        end if;
                                    end if;
                                end if;
                            end loop;
                        exception
                            when others then
                                -- 无 ACTIVE BOM(纯采购件)或环路: 该物料就停在采购建议,不再下放
                                if sqlcode not in (-20203, -20202) then
                                    raise;
                                end if;
                        end;
                    else
                        v_plans(v_pidx).net_req            := 0;
                        v_plans(v_pidx).planned_order_qty  := 0;
                        v_plans(v_pidx).planned_order_date := null;
                        v_plans(v_pidx).action_msg         := '需求已被在手/在途覆盖';
                    end if;

                    <<next_item>>
                    null;
                end;
            end loop;
        end loop;

        -- 4) 计划行 merge 进 t_mrp_plan(同一运行+物料+时段+层 视作同一计划行,重跑覆盖)
        if v_plans.count > 0 then
            forall p in v_plans.first .. v_plans.last
                merge into t_mrp_plan tp
                using (
                    select v_run_id              as run_id,
                           v_plans(p).item_id    as item_id,
                           v_plans(p).bucket_date as bucket_date,
                           v_plans(p).level_no   as level_no
                      from dual
                ) src
                on (tp.run_id = src.run_id
                    and tp.item_id = src.item_id
                    and tp.bucket_date = src.bucket_date
                    and tp.level_no = src.level_no)
                when matched then update set
                    tp.warehouse_id       = v_plans(p).warehouse_id,
                    tp.gross_req          = v_plans(p).gross_req,
                    tp.scheduled_receipt  = v_plans(p).scheduled_receipt,
                    tp.proj_on_hand       = v_plans(p).proj_on_hand,
                    tp.net_req            = v_plans(p).net_req,
                    tp.planned_order_qty  = v_plans(p).planned_order_qty,
                    tp.planned_order_date = v_plans(p).planned_order_date,
                    tp.action_msg         = v_plans(p).action_msg
                when not matched then insert (
                    plan_id, run_id, item_id, warehouse_id, bucket_date, level_no,
                    gross_req, scheduled_receipt, proj_on_hand, net_req,
                    planned_order_qty, planned_order_date, action_msg
                ) values (
                    seq_mrp_plan_id.nextval, v_run_id, v_plans(p).item_id, v_plans(p).warehouse_id,
                    v_plans(p).bucket_date, v_plans(p).level_no,
                    v_plans(p).gross_req, v_plans(p).scheduled_receipt, v_plans(p).proj_on_hand,
                    v_plans(p).net_req, v_plans(p).planned_order_qty,
                    v_plans(p).planned_order_date, v_plans(p).action_msg
                );
            v_plan_cnt := v_plans.count;
        end if;

        -- 5) 回写运行头统计
        update t_mrp_run
           set status      = const_pkg.c_mrp_success,
               item_count  = v_item_cnt,
               plan_count  = v_plan_cnt,
               finished_at = current_timestamp
         where run_id = v_run_id;

        exc_pkg.log_error(
            p_error_code  => 'I5010',
            p_module      => const_pkg.c_mod_mrp,
            p_procedure   => 'run_mrp',
            p_error_msg   => 'MRP 完成 run=' || v_run_no || ' items=' || v_item_cnt
                          || ' plans=' || v_plan_cnt || ' max_llc=' || v_max_llc,
            p_biz_key     => to_char(v_run_id),
            p_error_level => 'INFO');
    exception
        when others then
            -- 主流程失败: 头置 FAILED 留痕后抛出(参 bank settle_pkg.run_day_end)
            update t_mrp_run
               set status = const_pkg.c_mrp_failed, finished_at = current_timestamp
             where run_id = v_run_id;
            exc_pkg.log_error(
                p_error_code => const_pkg.c_err_system,
                p_module     => const_pkg.c_mod_mrp,
                p_procedure  => 'run_mrp',
                p_error_msg  => 'MRP 失败: ' || sqlerrm,
                p_biz_key    => to_char(v_run_id));
            raise;
    end run_mrp;


    procedure netting_detail(
        p_run_id  in  number,
        p_item_id in  number,
        p_cur     out sys_refcursor
    ) is
        v_exists number;
    begin
        select count(*) into v_exists from t_mrp_run where run_id = p_run_id;
        if v_exists = 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_mrp_run_not_found, const_pkg.c_mod_mrp, 'netting_detail',
                'MRP 运行不存在 run_id=' || p_run_id, to_char(p_run_id));
        end if;

        -- 单物料沿时段桶滚动投影在手量: 期初在手 + 累计计划到货 - 累计毛需求
        -- analytic sum over (order by bucket_date) 给出每桶的滚动结余,负值即缺口
        open p_cur for
            select mp.run_id,
                   mp.item_id,
                   mp.bucket_date,
                   mp.level_no,
                   mp.gross_req,
                   mp.scheduled_receipt,
                   mp.planned_order_qty,
                   mp.proj_on_hand as opening_on_hand,
                   mp.proj_on_hand
                     + sum(mp.scheduled_receipt + mp.planned_order_qty - mp.gross_req)
                         over (order by mp.bucket_date, mp.level_no
                               rows between unbounded preceding and current row)
                     as projected_balance,
                   mp.net_req,
                   mp.planned_order_date,
                   mp.action_msg
              from t_mrp_plan mp
             where mp.run_id  = p_run_id
               and mp.item_id = p_item_id
             order by mp.bucket_date, mp.level_no;
    end netting_detail;


    procedure release_planned_orders(
        p_run_id      in  number,
        p_prod_count  out number
    ) is
        v_exists number;
        v_prod_no varchar2(32);
        v_bom_id  number;
        v_cnt     number := 0;
    begin
        p_prod_count := 0;

        select count(*) into v_exists from t_mrp_run where run_id = p_run_id;
        if v_exists = 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_mrp_run_not_found, const_pkg.c_mod_mrp, 'release_planned_orders',
                'MRP 运行不存在 run_id=' || p_run_id, to_char(p_run_id));
        end if;

        -- 只处理有正净需求的计划行: 成品/半成品转生产工单,原材料/服务留给采购(不在此建单)
        for r in (
            select mp.plan_id, mp.item_id, mp.warehouse_id, mp.planned_order_qty,
                   mp.planned_order_date, i.item_type, i.lead_time_days
              from t_mrp_plan mp
              join t_item i on i.item_id = mp.item_id
             where mp.run_id = p_run_id
               and mp.planned_order_qty > 0
               and i.item_type in (const_pkg.c_item_fg, const_pkg.c_item_semi)
             order by mp.level_no, mp.item_id
        ) loop
            -- 自制件取其 ACTIVE BOM 挂到工单;无 ACTIVE BOM 则记 null(后续补维护)
            begin
                v_bom_id := bom_pkg.get_active_bom_id(r.item_id, sysdate);
            exception
                when others then
                    v_bom_id := null;
            end;

            v_prod_no := util_pkg.gen_doc_no('PRD', seq_prod_id.nextval, nvl(r.planned_order_date, sysdate));

            insert into t_production_order(
                prod_id, prod_no, item_id, bom_id, qty_planned,
                qty_completed, qty_scrapped, status, warehouse_id,
                start_date, due_date, source_mrp_id, created_by, created_at
            ) values (
                seq_prod_id.currval, v_prod_no, r.item_id, v_bom_id, r.planned_order_qty,
                0, 0, const_pkg.c_prod_planned, r.warehouse_id,
                nvl(r.planned_order_date, sysdate) - nvl(r.lead_time_days, 0),
                r.planned_order_date, p_run_id, util_pkg.get_operator(), current_timestamp
            );

            -- 工单建好后,把计划行动作改成已转工单,留单号便于追溯
            update t_mrp_plan
               set action_msg = '已转工单 ' || v_prod_no
             where plan_id = r.plan_id;

            v_cnt := v_cnt + 1;
        end loop;

        p_prod_count := v_cnt;

        exc_pkg.log_error(
            p_error_code  => 'I5020',
            p_module      => const_pkg.c_mod_mrp,
            p_procedure   => 'release_planned_orders',
            p_error_msg   => '计划下达完成 run=' || p_run_id || ' prod_orders=' || v_cnt,
            p_biz_key     => to_char(p_run_id),
            p_error_level => 'INFO');
    end release_planned_orders;

end mrp_pkg;
/
