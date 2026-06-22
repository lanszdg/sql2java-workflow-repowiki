create or replace package body inventory_pkg as

    -- 私有: 写一条库存流水
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


    -- 私有: 余额行 merge
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
        v_lot_id     number := seq_lot_id.nextval;
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


    -- 编码版: 查出 id 后委托给 id 版
    procedure receive_stock(
        p_item_code       in  varchar2,
        p_warehouse_code  in  varchar2,
        p_qty             in  number,
        p_unit_cost       in  number,
        p_lot_no          in  varchar2 default null,
        p_lot_id          out number,
        p_txn_id          out number
    ) is
        v_item_id  number;
        v_wh_id    number;
    begin
        begin
            select item_id into v_item_id
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
            p_unit_cost    => p_unit_cost,
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

        upsert_balance(p_item_id, p_warehouse_id, -p_qty);
    end issue_stock;


    procedure bulk_receive(
        p_lines      in  t_recv_tab,
        p_ok_count   out number,
        p_fail_count out number
    ) is
        type t_lot_id_tab is table of number  index by pls_integer;
        type t_flag_tab   is table of boolean index by pls_integer;
        v_lot_ids t_lot_id_tab;
        v_failed  t_flag_tab;
        v_dml_err number;
        v_dummy   number;
    begin
        p_ok_count   := 0;
        p_fail_count := 0;

        if p_lines.count = 0 then
            return;
        end if;

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
                if sqlcode = -24381 then
                    v_dml_err    := sql%bulk_exceptions.count;
                    p_fail_count := v_dml_err;
                    p_ok_count   := p_lines.count - v_dml_err;
                    for j in 1 .. v_dml_err loop
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


    procedure sync_balance(p_item_id in number, p_warehouse_id in number) is
        v_qty   number;
        v_alloc number;
        v_avg   number;
    begin
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

        select count(*) into v_cnt from user_tables where table_name = upper(v_tab);
        if v_cnt = 0 then
            execute immediate 'create table ' || v_tab
                || ' as select * from t_inventory_txn where 1 = 0';
        end if;

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
