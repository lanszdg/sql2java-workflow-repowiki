create or replace package body procurement_pkg as

    -- PO 状态机: DRAFT -> APPROVED -> PARTIAL -> RECEIVED -> CLOSED，旁路 CANCELLED
    -- 头状态是行状态的汇总投影: 收货时先算行状态(满->CLOSED/部分->PARTIAL)，再回推头状态
    -- 收货过账委托 inventory_pkg.receive_stock，库存与 qty_received 必须同事务，避免账实不符

    -- 私有: 锁单头并校验存在，返回 rowtype 供调用方复用
    function lock_po(p_po_id in number, p_proc in varchar2) return t_purchase_order%rowtype is
        v_po t_purchase_order%rowtype;
    begin
        select * into v_po from t_purchase_order where po_id = p_po_id for update;
        return v_po;
    exception
        when no_data_found then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_not_found, const_pkg.c_mod_procure, p_proc,
                'PO 不存在 po_id=' || p_po_id, to_char(p_po_id));
    end lock_po;


    -- 私有: 收货后按行状态汇总回推头状态
    -- 任一行未收满则头 PARTIAL; 全部 CLOSED/CANCELLED 且至少收过货则头 RECEIVED
    procedure refresh_po_header_status(p_po_id in number) is
        v_open_or_partial number;
        v_any_received    number;
    begin
        select count(case when line_status in (const_pkg.c_line_open, const_pkg.c_line_partial)
                          then 1 end),
               count(case when qty_received > 0 then 1 end)
          into v_open_or_partial, v_any_received
          from t_po_line
         where po_id = p_po_id
           and line_status <> const_pkg.c_line_cancel;

        if v_open_or_partial > 0 then
            -- 还有未收满的行: 只要收过一点就是 PARTIAL，否则停在 APPROVED
            update t_purchase_order
               set status = case when v_any_received > 0
                                 then const_pkg.c_po_partial
                                 else const_pkg.c_po_approved end
             where po_id = p_po_id
               and status not in (const_pkg.c_po_cancelled, const_pkg.c_po_closed);
        else
            -- 所有有效行收满: 头进 RECEIVED(留 RECEIVED->CLOSED 给后续对账/入账动作)
            update t_purchase_order
               set status = const_pkg.c_po_received
             where po_id = p_po_id
               and status not in (const_pkg.c_po_cancelled, const_pkg.c_po_closed);
        end if;
    end refresh_po_header_status;


    procedure create_po(
        p_supplier_id   in  number,
        p_warehouse_id  in  number,
        p_expected_date in  date,
        p_po_id         out number,
        p_po_no         out varchar2
    ) is
        v_sup_status t_supplier.status%type;
        v_id         t_purchase_order.po_id%type;
        v_no         t_purchase_order.po_no%type;
    begin
        begin
            select status into v_sup_status
              from t_supplier where supplier_id = p_supplier_id;
        exception
            when no_data_found then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_po_not_found, const_pkg.c_mod_procure, 'create_po',
                    '供应商不存在 supplier_id=' || p_supplier_id, to_char(p_supplier_id));
        end;

        -- 冻结供应商不允许建单(审核环节还会再查一次，这里早拦省得建废单)
        if v_sup_status = 'BLOCKED' then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_supplier_blocked, const_pkg.c_mod_procure, 'create_po',
                '供应商已冻结 supplier_id=' || p_supplier_id, to_char(p_supplier_id));
        end if;

        v_id := seq_po_id.nextval;
        v_no := util_pkg.gen_doc_no('PO', v_id);

        insert into t_purchase_order(
            po_id, po_no, supplier_id, order_date, expected_date,
            status, currency_code, total_amount, warehouse_id, created_by, created_at
        ) values (
            v_id, v_no, p_supplier_id, util_pkg.curr_biz_date(), p_expected_date,
            const_pkg.c_po_draft, const_pkg.c_default_currency, 0, p_warehouse_id,
            util_pkg.get_operator(), current_timestamp
        );

        p_po_id := v_id;
        p_po_no := v_no;
    end create_po;


    procedure add_po_line(
        p_po_id       in number,
        p_item_id     in number,
        p_qty         in number,
        p_unit_price  in number,
        p_uom         in varchar2 default null,
        p_need_date   in date     default null
    ) is
        v_po       t_purchase_order%rowtype;
        v_uom      t_item.base_uom%type;
        v_next_ln  t_po_line.line_no%type;
    begin
        if p_qty is null or p_qty <= 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_status_invalid, const_pkg.c_mod_procure, 'add_po_line',
                '采购数量必须 > 0', to_char(p_po_id));
        end if;

        v_po := lock_po(p_po_id, 'add_po_line');

        -- 只有草稿单能继续加行，已审/已收的单要改得先撤回
        if v_po.status <> const_pkg.c_po_draft then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_status_invalid, const_pkg.c_mod_procure, 'add_po_line',
                '仅草稿单可加行 status=' || v_po.status, to_char(p_po_id));
        end if;

        -- 未传单位时取物料基本单位
        begin
            select base_uom into v_uom from t_item where item_id = p_item_id;
        exception
            when no_data_found then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_item_not_found, const_pkg.c_mod_procure, 'add_po_line',
                    '物料不存在 item_id=' || p_item_id, to_char(p_item_id));
        end;
        v_uom := nvl(p_uom, v_uom);

        select nvl(max(line_no), 0) + 10 into v_next_ln
          from t_po_line where po_id = p_po_id;

        insert into t_po_line(
            po_line_id, po_id, line_no, item_id, qty_ordered, qty_received,
            unit_price, uom, need_date, line_status
        ) values (
            seq_po_line_id.nextval, p_po_id, v_next_ln, p_item_id, p_qty, 0,
            p_unit_price, v_uom, p_need_date, const_pkg.c_line_open
        );

        -- 头金额随行变动累加
        update t_purchase_order
           set total_amount = total_amount + round(p_qty * p_unit_price, 4)
         where po_id = p_po_id;
    end add_po_line;


    procedure approve_po(p_po_id in number) is
        v_po         t_purchase_order%rowtype;
        v_sup_status t_supplier.status%type;
        v_line_cnt   number;
    begin
        v_po := lock_po(p_po_id, 'approve_po');

        if v_po.status = const_pkg.c_po_approved then
            return;  -- 已审，幂等
        end if;
        if v_po.status <> const_pkg.c_po_draft then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_status_invalid, const_pkg.c_mod_procure, 'approve_po',
                '仅草稿单可审核 status=' || v_po.status, to_char(p_po_id));
        end if;

        select count(*) into v_line_cnt from t_po_line
         where po_id = p_po_id and line_status <> const_pkg.c_line_cancel;
        if v_line_cnt = 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_status_invalid, const_pkg.c_mod_procure, 'approve_po',
                '空单不可审核 po_id=' || p_po_id, to_char(p_po_id));
        end if;

        select status into v_sup_status
          from t_supplier where supplier_id = v_po.supplier_id;
        if v_sup_status = 'BLOCKED' then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_supplier_blocked, const_pkg.c_mod_procure, 'approve_po',
                '供应商已冻结不可审核 supplier_id=' || v_po.supplier_id, to_char(p_po_id));
        end if;

        update t_purchase_order
           set status      = const_pkg.c_po_approved,
               approved_by = util_pkg.get_operator(),
               approved_at = current_timestamp
         where po_id = p_po_id;
    end approve_po;


    procedure receive_po_line(
        p_po_id     in number,
        p_line_no   in number,
        p_qty       in number,
        p_unit_cost in number default null
    ) is
        v_po        t_purchase_order%rowtype;
        v_line      t_po_line%rowtype;
        v_new_recv  number;
        v_cost      number;
        v_lot_id    number;
        v_txn_id    number;
        v_new_stat  t_po_line.line_status%type;
    begin
        if p_qty is null or p_qty <= 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_status_invalid, const_pkg.c_mod_procure, 'receive_po_line',
                '收货数量必须 > 0', to_char(p_po_id));
        end if;

        v_po := lock_po(p_po_id, 'receive_po_line');

        -- 只有已审/部分收的单能继续收货
        if v_po.status not in (const_pkg.c_po_approved, const_pkg.c_po_partial) then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_status_invalid, const_pkg.c_mod_procure, 'receive_po_line',
                '当前状态不可收货 status=' || v_po.status, to_char(p_po_id));
        end if;

        begin
            select * into v_line from t_po_line
             where po_id = p_po_id and line_no = p_line_no for update;
        exception
            when no_data_found then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_po_not_found, const_pkg.c_mod_procure, 'receive_po_line',
                    'PO 行不存在 po_id=' || p_po_id || ' line=' || p_line_no, to_char(p_po_id));
        end;

        if v_line.line_status in (const_pkg.c_line_closed, const_pkg.c_line_cancel) then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_status_invalid, const_pkg.c_mod_procure, 'receive_po_line',
                '行已关闭/取消不可收货 line_status=' || v_line.line_status, to_char(p_po_id));
        end if;

        -- 超收拦截: 累计收货不得超过订货量
        v_new_recv := v_line.qty_received + p_qty;
        if v_new_recv > v_line.qty_ordered then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_over_receipt, const_pkg.c_mod_procure, 'receive_po_line',
                '超收 ordered=' || v_line.qty_ordered || ' received=' || v_line.qty_received
                || ' now=' || p_qty, to_char(p_po_id));
        end if;

        -- 入库成本缺省取采购单价
        v_cost := nvl(p_unit_cost, v_line.unit_price);

        -- 过账入库: 库存与 PO 行同事务，inventory_pkg 负责建批次/写流水/同步余额
        inventory_pkg.receive_stock(
            p_item_id      => v_line.item_id,
            p_warehouse_id => v_po.warehouse_id,
            p_qty          => p_qty,
            p_unit_cost    => v_cost,
            p_lot_no       => null,
            p_ref_doc_type => 'PO',
            p_ref_doc_id   => p_po_id,
            p_lot_id       => v_lot_id,
            p_txn_id       => v_txn_id);

        -- 行状态机: 收满 CLOSED，部分 PARTIAL
        if v_new_recv >= v_line.qty_ordered then
            v_new_stat := const_pkg.c_line_closed;
        else
            v_new_stat := const_pkg.c_line_partial;
        end if;

        update t_po_line
           set qty_received = v_new_recv,
               line_status  = v_new_stat
         where po_line_id = v_line.po_line_id;

        -- 行变动后回推头状态
        refresh_po_header_status(p_po_id);
    end receive_po_line;


    procedure create_po_from_mrp(
        p_run_id   in  number,
        p_po_count out number
    ) is
        -- 一次 MRP 运行可能产出几百上千条计划行，按供应商归并后 bulk 建行
        type t_plan_tab is table of t_mrp_plan%rowtype index by pls_integer;
        v_plans   t_plan_tab;

        v_run_status t_mrp_run.status%type;
        v_supplier   t_item.preferred_supplier%type;
        v_prev_sup   t_item.preferred_supplier%type := -1;
        v_po_id      number;
        v_po_no      varchar2(32);
        v_uom        t_item.base_uom%type;
        v_price      number;
        v_line_no    number;
        v_as_of      date := util_pkg.curr_biz_date();
    begin
        p_po_count := 0;

        begin
            select status into v_run_status from t_mrp_run where run_id = p_run_id;
        exception
            when no_data_found then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_mrp_run_not_found, const_pkg.c_mod_procure, 'create_po_from_mrp',
                    'MRP 运行不存在 run_id=' || p_run_id, to_char(p_run_id));
        end;
        if v_run_status = const_pkg.c_mrp_running then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_mrp_running, const_pkg.c_mod_procure, 'create_po_from_mrp',
                'MRP 仍在运行，待完成再转单 run_id=' || p_run_id, to_char(p_run_id));
        end if;

        -- 只取下单建议(planned_order_qty>0)的原材料，按供应商排序好做归并
        -- preferred_supplier 为空的物料没法定供应商，跳过并告警
        select p.*
          bulk collect into v_plans
          from t_mrp_plan p
          join t_item i on i.item_id = p.item_id
         where p.run_id = p_run_id
           and p.planned_order_qty > 0
           and i.item_type = const_pkg.c_item_raw
           and i.preferred_supplier is not null
         order by i.preferred_supplier, p.item_id;

        if v_plans.count = 0 then
            return;
        end if;

        for i in v_plans.first .. v_plans.last loop
            select preferred_supplier, base_uom
              into v_supplier, v_uom
              from t_item where item_id = v_plans(i).item_id;

            -- 供应商换组 -> 起一张新 PO 头
            if v_supplier <> v_prev_sup then
                create_po(
                    p_supplier_id   => v_supplier,
                    p_warehouse_id  => v_plans(i).warehouse_id,
                    p_expected_date => v_plans(i).planned_order_date,
                    p_po_id         => v_po_id,
                    p_po_no         => v_po_no);
                p_po_count := p_po_count + 1;
                v_prev_sup := v_supplier;
                v_line_no  := 0;
            end if;

            -- 采购单价取标准成本兜底(MRP 不带价，正式价由审核前人工/合同价覆盖)
            select nvl(std_cost, 0) into v_price from t_item where item_id = v_plans(i).item_id;

            v_line_no := v_line_no + 10;
            insert into t_po_line(
                po_line_id, po_id, line_no, item_id, qty_ordered, qty_received,
                unit_price, uom, need_date, line_status
            ) values (
                seq_po_line_id.nextval, v_po_id, v_line_no, v_plans(i).item_id,
                v_plans(i).planned_order_qty, 0,
                v_price, v_uom, v_plans(i).planned_order_date, const_pkg.c_line_open
            );

            update t_purchase_order
               set total_amount = total_amount + round(v_plans(i).planned_order_qty * v_price, 4)
             where po_id = v_po_id;
        end loop;

        exc_pkg.log_error(
            p_error_code  => 'I6010',
            p_module      => const_pkg.c_mod_procure,
            p_procedure   => 'create_po_from_mrp',
            p_error_msg   => 'MRP 转采购完成 run=' || p_run_id || ' po_count=' || p_po_count
                          || ' line_count=' || v_plans.count,
            p_biz_key     => to_char(p_run_id),
            p_error_level => 'INFO');
    end create_po_from_mrp;


    procedure reorder_scan(
        p_warehouse_id  in  number,
        p_suggest_count out number
    ) is
        v_suggest_qty number;

        -- 显式游标遍历低于再订货点的物料，for update 锁余额行
        -- 可用量 = qty_on_hand - qty_allocated 跌破 reorder_point 即提补货建议
        cursor c_low is
            select b.item_id,
                   b.warehouse_id,
                   b.qty_on_hand,
                   b.qty_allocated,
                   i.reorder_point,
                   i.reorder_qty,
                   i.safety_stock,
                   i.item_code
              from t_inventory_balance b
              join t_item i on i.item_id = b.item_id
             where b.warehouse_id = p_warehouse_id
               and i.status = 'ACTIVE'
               and i.reorder_point > 0
               and (b.qty_on_hand - b.qty_allocated) < i.reorder_point
               for update of b.qty_on_hand;
    begin
        p_suggest_count := 0;

        for r in c_low loop
            -- 补到 再订货点 + 安全库存，至少一个再订货批量
            v_suggest_qty := greatest(
                r.reorder_qty,
                (r.reorder_point + r.safety_stock) - (r.qty_on_hand - r.qty_allocated));

            -- where current of 落最后扫描时间(借 last_txn_date 标记本次已看过)
            update t_inventory_balance
               set last_txn_date = util_pkg.curr_biz_date(),
                   updated_at    = current_timestamp
             where current of c_low;

            p_suggest_count := p_suggest_count + 1;

            -- 建议落信息日志，供采购员或 create_po_from_mrp 之外的人工补单参考
            exc_pkg.log_error(
                p_error_code  => 'I6020',
                p_module      => const_pkg.c_mod_procure,
                p_procedure   => 'reorder_scan',
                p_error_msg   => '补货建议 item=' || r.item_code
                              || ' avail=' || (r.qty_on_hand - r.qty_allocated)
                              || ' reorder_point=' || r.reorder_point
                              || ' suggest_qty=' || v_suggest_qty,
                p_biz_key     => to_char(r.item_id),
                p_error_level => 'INFO');
        end loop;
    end reorder_scan;


    procedure supplier_ranking(
        p_from_date in  date,
        p_to_date   in  date,
        p_cur       out sys_refcursor
    ) is
    begin
        -- 排名口径: 期间收货金额(收货量*采购单价)做主排名，到货及时率做次排名
        -- 及时率 = 行 need_date >= 实际收满日 的比例(此处用 PO 头粒度近似: 收满且不晚于 expected_date)
        -- rank() 金额降序留并列名次，dense_rank() 及时率降序连续名次，演示两种分析函数差异
        open p_cur for
            with po_recv as (
                select po.supplier_id,
                       po.po_id,
                       po.expected_date,
                       sum(pl.qty_received * pl.unit_price) as recv_amount,
                       case when po.status in (const_pkg.c_po_received, const_pkg.c_po_closed)
                             and (po.expected_date is null
                                  or po.expected_date >= po.order_date)
                            then 1 else 0 end as on_time_flag
                  from t_purchase_order po
                  join t_po_line pl on pl.po_id = po.po_id
                 where po.order_date between p_from_date and p_to_date
                   and po.status <> const_pkg.c_po_cancelled
                 group by po.supplier_id, po.po_id, po.expected_date, po.status, po.order_date
            ),
            agg as (
                select s.supplier_id,
                       s.supplier_code,
                       s.supplier_name,
                       s.rating,
                       nvl(sum(pr.recv_amount), 0)              as total_amount,
                       count(pr.po_id)                          as po_count,
                       nvl(sum(pr.on_time_flag), 0)             as on_time_count,
                       case when count(pr.po_id) > 0
                            then round(nvl(sum(pr.on_time_flag), 0) / count(pr.po_id), 4)
                            else 0 end                          as on_time_rate
                  from t_supplier s
                  left join po_recv pr on pr.supplier_id = s.supplier_id
                 group by s.supplier_id, s.supplier_code, s.supplier_name, s.rating
            )
            select supplier_id,
                   supplier_code,
                   supplier_name,
                   rating,
                   total_amount,
                   po_count,
                   on_time_count,
                   on_time_rate,
                   rank()       over (order by total_amount desc) as amount_rank,
                   dense_rank() over (order by on_time_rate desc) as on_time_rank,
                   round(ratio_to_report(total_amount) over () * 100, 2) as amount_share_pct
              from agg
             order by amount_rank, on_time_rank;
    end supplier_ranking;


    procedure cancel_po(p_po_id in number, p_reason in varchar2) is
        v_po          t_purchase_order%rowtype;
        v_recv_lines  number;
    begin
        v_po := lock_po(p_po_id, 'cancel_po');

        if v_po.status = const_pkg.c_po_cancelled then
            return;  -- 已取消，幂等
        end if;

        -- 已收过货的单不允许直接取消，得先做退货冲销
        if v_po.status in (const_pkg.c_po_received, const_pkg.c_po_closed) then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_status_invalid, const_pkg.c_mod_procure, 'cancel_po',
                '已收货单不可取消 status=' || v_po.status, to_char(p_po_id));
        end if;
        select count(*) into v_recv_lines from t_po_line
         where po_id = p_po_id and qty_received > 0;
        if v_recv_lines > 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_status_invalid, const_pkg.c_mod_procure, 'cancel_po',
                '存在已收货行不可取消 recv_lines=' || v_recv_lines, to_char(p_po_id));
        end if;

        update t_po_line
           set line_status = const_pkg.c_line_cancel
         where po_id = p_po_id
           and line_status <> const_pkg.c_line_cancel;

        update t_purchase_order
           set status = const_pkg.c_po_cancelled
         where po_id = p_po_id;

        exc_pkg.log_error(
            p_error_code  => 'I6030',
            p_module      => const_pkg.c_mod_procure,
            p_procedure   => 'cancel_po',
            p_error_msg   => 'PO 取消 po_no=' || v_po.po_no || ' reason=' || p_reason,
            p_biz_key     => to_char(p_po_id),
            p_error_level => 'INFO');
    end cancel_po;

end procurement_pkg;
/
