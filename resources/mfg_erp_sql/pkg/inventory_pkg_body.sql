-- 库存收发实现
-- 三层落地原则: 流水是事实(append-only)，批次是 FIFO 排队的明细，余额是物料+仓库的快照
-- 每个动作都按 流水 -> 批次 -> 余额 的顺序写，余额走 merge 自愈，避免余额行缺失时整笔失败
-- 发料的 FIFO 定位用窗口函数算累计可用量,再用 for update 游标逐批扣,锁粒度落到批次行

create or replace package body inventory_pkg as

    -- 私有: 写一条库存流水，txn_id/txn_no 同源派生，返回 txn_id
    -- qty_before/qty_after 取余额快照口径(物料+仓库维度)，批次粒度的明细看批次表
    function post_txn(
        p_item_id      in number,
        p_warehouse_id in number,
        p_lot_id       in number,
        p_txn_type     in varchar2,
        p_direction    in varchar2,
        p_qty          in number,
        p_unit_cost    in number,
        p_qty_before   in number,
        p_qty_after    in number,
        p_ref_doc_type in varchar2,
        p_ref_doc_id   in number,
        p_remark       in varchar2 default null
    ) return number is
        v_txn_id number;
    begin
        v_txn_id := seq_inv_txn_id.nextval;

        insert into t_inventory_txn(
            txn_id, txn_no, item_id, warehouse_id, lot_id,
            txn_type, direction, quantity, unit_cost, total_cost,
            qty_before, qty_after, txn_date, txn_time,
            ref_doc_type, ref_doc_id, operator, remark
        ) values (
            v_txn_id,
            util_pkg.gen_doc_no('IT', v_txn_id, util_pkg.curr_biz_date()),
            p_item_id, p_warehouse_id, p_lot_id,
            p_txn_type, p_direction, p_qty, p_unit_cost,
            round(p_qty * nvl(p_unit_cost, 0), 4),
            p_qty_before, p_qty_after, util_pkg.curr_biz_date(), current_timestamp,
            p_ref_doc_type, p_ref_doc_id, util_pkg.get_operator(), p_remark
        );
        return v_txn_id;
    end post_txn;


    -- 私有: 余额行 merge。入库带成本时按移动加权重算 avg_cost，纯出库 p_in_cost 传 null 不动均价
    -- version+1 给上层乐观锁;余额由本包独占维护,触发器不碰这张表
    procedure upsert_balance(
        p_item_id      in number,
        p_warehouse_id in number,
        p_delta_qty    in number,
        p_in_qty       in number default 0,
        p_in_cost      in number default null
    ) is
    begin
        merge into t_inventory_balance b
        using (select p_item_id as item_id, p_warehouse_id as warehouse_id from dual) s
        on (b.item_id = s.item_id and b.warehouse_id = s.warehouse_id)
        when matched then
            update set
                b.avg_cost = case
                    when p_in_cost is not null and (b.qty_on_hand + p_in_qty) > 0
                    then round((b.qty_on_hand * b.avg_cost + p_in_qty * p_in_cost)
                               / (b.qty_on_hand + p_in_qty), 6)
                    else b.avg_cost
                end,
                b.qty_on_hand   = b.qty_on_hand + p_delta_qty,
                b.last_txn_date = util_pkg.curr_biz_date(),
                b.version       = b.version + 1,
                b.updated_at    = current_timestamp
        when not matched then
            insert (item_id, warehouse_id, qty_on_hand, qty_allocated,
                    avg_cost, last_txn_date, version, updated_at)
            values (s.item_id, s.warehouse_id, p_delta_qty, 0,
                    nvl(p_in_cost, 0), util_pkg.curr_biz_date(), 0, current_timestamp);
    end upsert_balance;


    procedure receive_stock(
        p_item_id       in  number,
        p_warehouse_id  in  number,
        p_qty           in  number,
        p_unit_cost     in  number,
        p_lot_no        in  varchar2 default null,
        p_ref_doc_type  in  varchar2 default null,
        p_ref_doc_id    in  number   default null,
        p_lot_id        out number,
        p_txn_id        out number
    ) is
        v_qty_before number;
        v_lot_id     number := seq_lot_id.nextval;   -- 一次取号,id 与缺省 lot_no 同源,避免序列被拉两次
        v_lot_no     varchar2(40);
    begin
        if p_qty is null or p_qty <= 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_stock_negative, const_pkg.c_mod_inv, 'receive_stock',
                '收货数量必须 > 0', to_char(p_item_id));
        end if;

        select nvl(max(qty_on_hand), 0) into v_qty_before
          from t_inventory_balance
         where item_id = p_item_id and warehouse_id = p_warehouse_id;

        -- 批次号缺省自动生成确保唯一; returning into 取回入库后的 lot_id 作为出参
        v_lot_no := nvl(p_lot_no, util_pkg.gen_doc_no('LOT', v_lot_id, util_pkg.curr_biz_date()));

        insert into t_inventory_lot(
            lot_id, lot_no, item_id, warehouse_id,
            qty_on_hand, qty_allocated, unit_cost, currency_code,
            receipt_date, status, source_doc_type, source_doc_id
        ) values (
            v_lot_id, v_lot_no, p_item_id, p_warehouse_id,
            p_qty, 0, nvl(p_unit_cost, 0), const_pkg.c_default_currency,
            util_pkg.curr_biz_date(), const_pkg.c_lot_available, p_ref_doc_type, p_ref_doc_id
        )
        returning lot_id into p_lot_id;

        p_txn_id := post_txn(
            p_item_id      => p_item_id,
            p_warehouse_id => p_warehouse_id,
            p_lot_id       => p_lot_id,
            p_txn_type     => const_pkg.c_txn_recv,
            p_direction    => const_pkg.c_dir_in,
            p_qty          => p_qty,
            p_unit_cost    => nvl(p_unit_cost, 0),
            p_qty_before   => v_qty_before,
            p_qty_after    => v_qty_before + p_qty,
            p_ref_doc_type => p_ref_doc_type,
            p_ref_doc_id   => p_ref_doc_id,
            p_remark       => '收货 lot=' || v_lot_no);

        upsert_balance(p_item_id, p_warehouse_id, p_qty, p_qty, nvl(p_unit_cost, 0));
    end receive_stock;


    -- 编码版: 查出 id 后委托给 id 版，缺省单位成本取物料标准成本
    procedure receive_stock(
        p_item_code       in  varchar2,
        p_warehouse_code  in  varchar2,
        p_qty             in  number,
        p_lot_no          in  varchar2 default null,
        p_lot_id          out number,
        p_txn_id          out number
    ) is
        v_item_id  number;
        v_wh_id    number;
        v_std_cost number;
    begin
        begin
            select item_id, std_cost into v_item_id, v_std_cost
              from t_item where item_code = p_item_code;
        exception
            when no_data_found then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_item_not_found, const_pkg.c_mod_inv, 'receive_stock',
                    '物料编码不存在 ' || p_item_code, p_item_code);
        end;

        begin
            select warehouse_id into v_wh_id
              from t_warehouse where warehouse_code = p_warehouse_code;
        exception
            when no_data_found then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_balance_not_found, const_pkg.c_mod_inv, 'receive_stock',
                    '仓库编码不存在 ' || p_warehouse_code, p_warehouse_code);
        end;

        receive_stock(
            p_item_id      => v_item_id,
            p_warehouse_id => v_wh_id,
            p_qty          => p_qty,
            p_unit_cost    => v_std_cost,
            p_lot_no       => p_lot_no,
            p_ref_doc_type => null,
            p_ref_doc_id   => null,
            p_lot_id       => p_lot_id,
            p_txn_id       => p_txn_id);
    end receive_stock;


    procedure issue_stock(
        p_item_id       in  number,
        p_warehouse_id  in  number,
        p_qty           in  number,
        p_ref_doc_type  in  varchar2 default null,
        p_ref_doc_id    in  number   default null,
        p_alloc         out nocopy t_alloc_tab
    ) is
        -- FIFO: 按 receipt_date、lot_id 升序排队;窗口函数算到本批为止的累计可用量
        -- cum_before 是"扣到本批之前已能满足的量",据此算本批要扣多少
        cursor cur_fifo is
            select lot_id, lot_no, unit_cost,
                   (qty_on_hand - qty_allocated) as avail,
                   sum(qty_on_hand - qty_allocated)
                       over (order by receipt_date, lot_id) as cum_avail
              from t_inventory_lot
             where item_id = p_item_id
               and warehouse_id = p_warehouse_id
               and status = const_pkg.c_lot_available
               and qty_on_hand - qty_allocated > 0
             order by receipt_date, lot_id
             for update of qty_on_hand;

        v_total_avail number;
        v_remaining   number;
        v_take        number;
        v_qty_before  number;
        v_qty_run     number;
        v_idx         pls_integer := 0;
    begin
        if p_qty is null or p_qty <= 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_stock_negative, const_pkg.c_mod_inv, 'issue_stock',
                '发料数量必须 > 0', to_char(p_item_id));
        end if;

        -- 先用余额快照挡一道,不足直接抛,省去无谓的逐批锁
        v_total_avail := get_available(p_item_id, p_warehouse_id);
        if v_total_avail < p_qty then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_stock_insufficient, const_pkg.c_mod_inv, 'issue_stock',
                '可用量不足 avail=' || v_total_avail || ' need=' || p_qty,
                to_char(p_item_id) || '/' || to_char(p_warehouse_id));
        end if;

        p_alloc     := t_alloc_tab();
        v_remaining := p_qty;
        v_qty_before := v_total_avail;
        v_qty_run    := v_total_avail;

        for r in cur_fifo loop
            exit when v_remaining <= 0;

            -- 本批最多扣 avail,扣到需求填满为止;cum_avail 用来确认排到第几批已覆盖需求
            v_take := least(r.avail, v_remaining);

            update t_inventory_lot
               set qty_on_hand = qty_on_hand - v_take,
                   status = case when qty_on_hand - v_take = 0
                                 then const_pkg.c_lot_consumed
                                 else status end
             where current of cur_fifo;

            v_idx := v_idx + 1;
            p_alloc.extend;
            p_alloc(v_idx) := t_alloc_obj(r.lot_id, r.lot_no, v_take, r.unit_cost);

            v_qty_run := v_qty_run - v_take;
            -- 每扣一批写一条 ISSUE 流水,批次成本带上供上层做成本分摊
            declare
                v_dummy number;
            begin
                v_dummy := post_txn(
                    p_item_id      => p_item_id,
                    p_warehouse_id => p_warehouse_id,
                    p_lot_id       => r.lot_id,
                    p_txn_type     => const_pkg.c_txn_issue,
                    p_direction    => const_pkg.c_dir_out,
                    p_qty          => v_take,
                    p_unit_cost    => r.unit_cost,
                    p_qty_before   => v_qty_run + v_take,
                    p_qty_after    => v_qty_run,
                    p_ref_doc_type => p_ref_doc_type,
                    p_ref_doc_id   => p_ref_doc_id,
                    p_remark       => 'FIFO 发料 lot=' || r.lot_no);
            end;

            v_remaining := v_remaining - v_take;
        end loop;

        -- 出库不改均价(p_in_cost 默认 null),仅减 qty
        upsert_balance(p_item_id, p_warehouse_id, -p_qty);
    end issue_stock;


    procedure bulk_receive(
        p_lines      in  t_recv_tab,
        p_ok_count   out number,
        p_fail_count out number
    ) is
        -- forall save exceptions: 批量插批次,单行违约(如负数/外键)不阻断整批
        -- 失败后遍历 sql%bulk_exceptions 统计失败行数并落日志
        type t_lot_id_tab is table of number  index by pls_integer;
        type t_flag_tab   is table of boolean index by pls_integer;
        v_lot_ids t_lot_id_tab;
        v_failed  t_flag_tab;        -- 标记哪几行插批次失败,后续流水/余额跳过它们
        v_dml_err number;
        v_dummy   number;
    begin
        p_ok_count   := 0;
        p_fail_count := 0;

        if p_lines.count = 0 then
            return;
        end if;

        -- 先给每行预分配 lot_id,后面流水/余额沿用同一组 id
        for i in p_lines.first .. p_lines.last loop
            v_lot_ids(i) := seq_lot_id.nextval;
        end loop;

        begin
            forall i in p_lines.first .. p_lines.last save exceptions
                insert into t_inventory_lot(
                    lot_id, lot_no, item_id, warehouse_id,
                    qty_on_hand, qty_allocated, unit_cost, currency_code,
                    receipt_date, status, source_doc_type, source_doc_id
                ) values (
                    v_lot_ids(i),
                    nvl(p_lines(i).lot_no,
                        util_pkg.gen_doc_no('LOT', v_lot_ids(i), util_pkg.curr_biz_date())),
                    p_lines(i).item_id, p_lines(i).warehouse_id,
                    p_lines(i).qty, 0, nvl(p_lines(i).unit_cost, 0), const_pkg.c_default_currency,
                    util_pkg.curr_biz_date(), const_pkg.c_lot_available,
                    p_lines(i).ref_doc_type, p_lines(i).ref_doc_id
                );
            p_ok_count := p_lines.count;
        exception
            when others then
                -- -24381: forall 累积了至少一行错误,逐条取 bulk_exceptions 标失败行
                if sqlcode = -24381 then
                    v_dml_err    := sql%bulk_exceptions.count;
                    p_fail_count := v_dml_err;
                    p_ok_count   := p_lines.count - v_dml_err;
                    for j in 1 .. v_dml_err loop
                        -- error_index 是 forall 迭代序号,需折算回 p_lines 的实际下标
                        v_failed(p_lines.first + sql%bulk_exceptions(j).error_index - 1) := true;
                        exc_pkg.log_error(
                            p_error_code  => const_pkg.c_err_stock_negative,
                            p_module      => const_pkg.c_mod_inv,
                            p_procedure   => 'bulk_receive',
                            p_error_msg   => '批量收货行失败 idx='
                                          || sql%bulk_exceptions(j).error_index
                                          || ' err=' || sqlerrm(-sql%bulk_exceptions(j).error_code),
                            p_error_level => 'WARN');
                    end loop;
                else
                    raise;
                end if;
        end;

        -- 成功落库的行补流水与余额,失败行(v_failed 标记)跳过
        for i in p_lines.first .. p_lines.last loop
            if v_failed.exists(i) then
                continue;
            end if;
            v_dummy := post_txn(
                p_item_id      => p_lines(i).item_id,
                p_warehouse_id => p_lines(i).warehouse_id,
                p_lot_id       => v_lot_ids(i),
                p_txn_type     => const_pkg.c_txn_recv,
                p_direction    => const_pkg.c_dir_in,
                p_qty          => p_lines(i).qty,
                p_unit_cost    => nvl(p_lines(i).unit_cost, 0),
                p_qty_before   => null,
                p_qty_after    => null,
                p_ref_doc_type => p_lines(i).ref_doc_type,
                p_ref_doc_id   => p_lines(i).ref_doc_id,
                p_remark       => '批量收货 lot=' || v_lot_ids(i));
            upsert_balance(p_lines(i).item_id, p_lines(i).warehouse_id,
                           p_lines(i).qty, p_lines(i).qty, nvl(p_lines(i).unit_cost, 0));
        end loop;

        exc_pkg.log_error(
            p_error_code  => 'I3001',
            p_module      => const_pkg.c_mod_inv,
            p_procedure   => 'bulk_receive',
            p_error_msg   => '批量收货 total=' || p_lines.count
                          || ' ok=' || p_ok_count || ' fail=' || p_fail_count,
            p_error_level => 'INFO');
    end bulk_receive;


    procedure adjust_stock(
        p_item_id      in number,
        p_warehouse_id in number,
        p_new_qty      in number,
        p_reason       in varchar2
    ) is
        v_cur_qty  number;
        v_diff     number;
        v_avg_cost number;
        v_dummy    number;
        v_lot_id   number;
    begin
        if p_new_qty is null or p_new_qty < 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_stock_negative, const_pkg.c_mod_inv, 'adjust_stock',
                '盘点数量不能为负', to_char(p_item_id));
        end if;

        v_cur_qty := get_available(p_item_id, p_warehouse_id);
        v_diff    := p_new_qty - v_cur_qty;

        if v_diff = 0 then
            return;
        end if;

        if v_diff > 0 then
            -- 盘盈: 新建盈余批次承接,成本沿用当前均价(余额行没有则按 0)
            begin
                select avg_cost into v_avg_cost
                  from t_inventory_balance
                 where item_id = p_item_id and warehouse_id = p_warehouse_id;
            exception
                when no_data_found then
                    v_avg_cost := 0;
            end;

            receive_stock(
                p_item_id      => p_item_id,
                p_warehouse_id => p_warehouse_id,
                p_qty          => v_diff,
                p_unit_cost    => v_avg_cost,
                p_lot_no       => null,
                p_ref_doc_type => const_pkg.c_txn_adj,
                p_ref_doc_id   => null,
                p_lot_id       => v_lot_id,
                p_txn_id       => v_dummy);

            -- 把 RECV 流水改记成 ADJ 口径(同事务,语义更准)
            update t_inventory_txn
               set txn_type = const_pkg.c_txn_adj,
                   remark   = '盘盈 ' || p_reason
             where txn_id = v_dummy;
        else
            -- 盘亏: 走 FIFO 扣减,但流水类型记 ADJ
            declare
                v_alloc t_alloc_tab;
            begin
                issue_stock(
                    p_item_id      => p_item_id,
                    p_warehouse_id => p_warehouse_id,
                    p_qty          => -v_diff,
                    p_ref_doc_type => const_pkg.c_txn_adj,
                    p_ref_doc_id   => null,
                    p_alloc        => v_alloc);
            end;

            update t_inventory_txn
               set txn_type = const_pkg.c_txn_adj,
                   remark   = '盘亏 ' || p_reason
             where item_id = p_item_id
               and warehouse_id = p_warehouse_id
               and txn_type = const_pkg.c_txn_issue
               and txn_date = util_pkg.curr_biz_date()
               and ref_doc_type = const_pkg.c_txn_adj;
        end if;

        sync_balance(p_item_id, p_warehouse_id);
    end adjust_stock;


    procedure transfer_stock(
        p_item_id      in number,
        p_from_wh      in number,
        p_to_wh        in number,
        p_qty          in number
    ) is
        v_alloc      t_alloc_tab;
        v_total_cost number := 0;
        v_xfer_cost  number;
        v_lot_id     number;
        v_dummy      number;
    begin
        if p_from_wh = p_to_wh then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_balance_not_found, const_pkg.c_mod_inv, 'transfer_stock',
                '调出调入仓库不能相同', to_char(p_from_wh));
        end if;
        if p_qty is null or p_qty <= 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_stock_negative, const_pkg.c_mod_inv, 'transfer_stock',
                '调拨数量必须 > 0', to_char(p_item_id));
        end if;

        -- 出库走 FIFO,拿到每批成本;调入按出库的加权成本入,保证成本随货走
        issue_stock(
            p_item_id      => p_item_id,
            p_warehouse_id => p_from_wh,
            p_qty          => p_qty,
            p_ref_doc_type => const_pkg.c_txn_xfer_out,
            p_ref_doc_id   => p_to_wh,
            p_alloc        => v_alloc);

        if v_alloc is not null then
            for i in 1 .. v_alloc.count loop
                v_total_cost := v_total_cost + v_alloc(i).alloc_cost();
            end loop;
        end if;
        v_xfer_cost := round(v_total_cost / p_qty, 6);

        -- 把出库流水类型从 ISSUE 改记 XFER_OUT(同事务)
        update t_inventory_txn
           set txn_type = const_pkg.c_txn_xfer_out
         where item_id = p_item_id
           and warehouse_id = p_from_wh
           and txn_type = const_pkg.c_txn_issue
           and txn_date = util_pkg.curr_biz_date()
           and ref_doc_type = const_pkg.c_txn_xfer_out
           and ref_doc_id = p_to_wh;

        -- 调入新建批次(入库 XFER_IN),与出库同一事务
        receive_stock(
            p_item_id      => p_item_id,
            p_warehouse_id => p_to_wh,
            p_qty          => p_qty,
            p_unit_cost    => v_xfer_cost,
            p_lot_no       => null,
            p_ref_doc_type => const_pkg.c_txn_xfer_in,
            p_ref_doc_id   => p_from_wh,
            p_lot_id       => v_lot_id,
            p_txn_id       => v_dummy);

        update t_inventory_txn
           set txn_type = const_pkg.c_txn_xfer_in
         where txn_id = v_dummy;
    end transfer_stock;


    procedure sync_balance(p_item_id in number, p_warehouse_id in number) is
        v_qty   number;
        v_alloc number;
        v_avg   number;
    begin
        -- 按批次实时重算: 可用批次的 qty/已分配/加权成本,然后 merge 覆盖余额行
        select nvl(sum(qty_on_hand), 0),
               nvl(sum(qty_allocated), 0),
               case when nvl(sum(qty_on_hand), 0) > 0
                    then round(sum(qty_on_hand * unit_cost) / sum(qty_on_hand), 6)
                    else 0 end
          into v_qty, v_alloc, v_avg
          from t_inventory_lot
         where item_id = p_item_id
           and warehouse_id = p_warehouse_id
           and status in (const_pkg.c_lot_available, const_pkg.c_lot_quarantine);

        merge into t_inventory_balance b
        using (select p_item_id as item_id, p_warehouse_id as warehouse_id from dual) s
        on (b.item_id = s.item_id and b.warehouse_id = s.warehouse_id)
        when matched then
            update set
                b.qty_on_hand   = v_qty,
                b.qty_allocated = v_alloc,
                b.avg_cost      = v_avg,
                b.last_txn_date = util_pkg.curr_biz_date(),
                b.version       = b.version + 1,
                b.updated_at    = current_timestamp
        when not matched then
            insert (item_id, warehouse_id, qty_on_hand, qty_allocated,
                    avg_cost, last_txn_date, version, updated_at)
            values (s.item_id, s.warehouse_id, v_qty, v_alloc,
                    v_avg, util_pkg.curr_biz_date(), 0, current_timestamp);
    end sync_balance;


    function get_available(p_item_id in number, p_warehouse_id in number) return number is
        v_avail number;
    begin
        select nvl(qty_on_hand - qty_allocated, 0)
          into v_avail
          from t_inventory_balance
         where item_id = p_item_id and warehouse_id = p_warehouse_id;
        return v_avail;
    exception
        when no_data_found then
            -- 余额行还没建(没收过货),可用量按 0,不报错
            return 0;
    end get_available;


    procedure archive_txns_before(
        p_before_date in  date,
        p_archived    out number
    ) is
        v_tab varchar2(64);
        v_cnt number;
    begin
        p_archived := 0;
        v_tab := 't_inv_txn_arch_' || to_char(p_before_date, 'YYYYMM');

        -- 归档表按月命名，不存在则照流水表结构动态建一张空表(create as select 1=0)
        select count(*) into v_cnt from user_tables where table_name = upper(v_tab);
        if v_cnt = 0 then
            execute immediate 'create table ' || v_tab
                || ' as select * from t_inventory_txn where 1 = 0';
        end if;

        -- 搬数与清理用绑定变量传日期，避免拼日期字面量(硬解析 + 注入风险)
        execute immediate 'insert into ' || v_tab
            || ' select * from t_inventory_txn where txn_date < :1'
            using p_before_date;
        p_archived := sql%rowcount;

        execute immediate 'delete from t_inventory_txn where txn_date < :1'
            using p_before_date;

        exc_pkg.log_error(
            p_error_code  => 'I3090',
            p_module      => const_pkg.c_mod_inv,
            p_procedure   => 'archive_txns_before',
            p_error_msg   => '流水归档 tab=' || v_tab || ' before='
                          || to_char(p_before_date, 'YYYY-MM-DD') || ' rows=' || p_archived,
            p_biz_key     => v_tab,
            p_error_level => 'INFO');
    exception
        when others then
            -- 归档动了真数据，失败必须抛出去让外层回滚，不能像普通日志那样吞掉
            exc_pkg.log_error(
                p_error_code => const_pkg.c_err_system,
                p_module     => const_pkg.c_mod_inv,
                p_procedure  => 'archive_txns_before',
                p_error_msg  => '归档失败 tab=' || v_tab || ': ' || sqlerrm,
                p_biz_key    => v_tab);
            raise;
    end archive_txns_before;

end inventory_pkg;
/
