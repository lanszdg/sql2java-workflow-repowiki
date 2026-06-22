-- 成本计算实现
-- 本包以分析函数为主线: FIFO 分层与估值占比靠窗口函数,落地成本分摊靠 SQL 内联 PL/SQL(with function)
-- 标准成本卷算把 BOM 递归交给 bom_pkg.rolled_cost,本包只负责挑成品/半成品并 merge 回写
-- 多数子程序 open ref cursor 返回,让应用层流式取,不在库内物化大结果集

create or replace package body costing_pkg as

    procedure fifo_layers(
        p_item_id      in  number,
        p_warehouse_id in  number,
        p_cur          out sys_refcursor
    ) is
    begin
        -- 按 FIFO 排队键累计可用量与累计金额,is_covering 标出"排到这批需求已被覆盖"
        -- 需求量取余额可用量做参照,layer_no 用 row_number 给批次排序号
        open p_cur for
            select lot_id,
                   lot_no,
                   receipt_date,
                   row_number() over (order by receipt_date, lot_id) as layer_no,
                   qty_on_hand - qty_allocated as avail_qty,
                   unit_cost,
                   round((qty_on_hand - qty_allocated) * unit_cost, 4) as layer_amount,
                   sum(qty_on_hand - qty_allocated)
                       over (order by receipt_date, lot_id) as cum_qty,
                   sum(round((qty_on_hand - qty_allocated) * unit_cost, 4))
                       over (order by receipt_date, lot_id) as cum_amount,
                   case
                       when sum(qty_on_hand - qty_allocated)
                                over (order by receipt_date, lot_id)
                            >= (select nvl(qty_on_hand - qty_allocated, 0)
                                  from t_inventory_balance
                                 where item_id = p_item_id
                                   and warehouse_id = p_warehouse_id)
                       then 'Y' else 'N'
                   end as is_covering
              from t_inventory_lot
             where item_id = p_item_id
               and warehouse_id = p_warehouse_id
               and status = const_pkg.c_lot_available
               and qty_on_hand - qty_allocated > 0
             order by receipt_date, lot_id;
    end fifo_layers;


    procedure inventory_value(
        p_warehouse_id in  number   default null,
        p_cur          out sys_refcursor
    ) is
    begin
        -- 货值 = qty * 估值单价。估值单价按物料估值方法取: STD 标准成本, 其余用余额均价
        -- sum() over(partition by warehouse) 给仓库小计, ratio_to_report 给物料占本仓比重
        open p_cur for
            select b.warehouse_id,
                   w.warehouse_code,
                   b.item_id,
                   it.item_code,
                   it.item_name,
                   it.valuation_method,
                   b.qty_on_hand,
                   case when it.valuation_method = const_pkg.c_val_std
                        then it.std_cost else b.avg_cost end as val_unit_cost,
                   round(b.qty_on_hand *
                         case when it.valuation_method = const_pkg.c_val_std
                              then it.std_cost else b.avg_cost end, 4) as stock_value,
                   sum(round(b.qty_on_hand *
                         case when it.valuation_method = const_pkg.c_val_std
                              then it.std_cost else b.avg_cost end, 4))
                       over (partition by b.warehouse_id) as wh_total_value,
                   round(ratio_to_report(
                         b.qty_on_hand *
                         case when it.valuation_method = const_pkg.c_val_std
                              then it.std_cost else b.avg_cost end)
                       over (partition by b.warehouse_id), 6) as value_ratio
              from t_inventory_balance b
              join t_item      it on it.item_id      = b.item_id
              join t_warehouse w  on w.warehouse_id  = b.warehouse_id
             where b.qty_on_hand > 0
               and (p_warehouse_id is null or b.warehouse_id = p_warehouse_id)
             order by b.warehouse_id, stock_value desc;
    end inventory_value;


    procedure recompute_avg_cost(p_item_id in number, p_warehouse_id in number) is
        v_avg number;
        v_qty number;
    begin
        -- 移动加权平均: 拿当前在库批次按数量加权算单价,回写 balance.avg_cost
        -- 只算 AVAILABLE 批次,隔离/过期批不计入活动估值
        select case when nvl(sum(qty_on_hand), 0) > 0
                    then round(sum(qty_on_hand * unit_cost) / sum(qty_on_hand), 6)
                    else 0 end,
               nvl(sum(qty_on_hand), 0)
          into v_avg, v_qty
          from t_inventory_lot
         where item_id = p_item_id
           and warehouse_id = p_warehouse_id
           and status = const_pkg.c_lot_available;

        update t_inventory_balance
           set avg_cost   = v_avg,
               version    = version + 1,
               updated_at = current_timestamp
         where item_id = p_item_id
           and warehouse_id = p_warehouse_id;

        if sql%rowcount = 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_balance_not_found, const_pkg.c_mod_cost, 'recompute_avg_cost',
                '余额行不存在,无法回写均价', to_char(p_item_id) || '/' || to_char(p_warehouse_id));
        end if;
    end recompute_avg_cost;


    procedure landed_cost_report(
        p_po_id  in  number,
        p_cur    out sys_refcursor
    ) is
        v_freight number := util_pkg.get_param('LANDED_FREIGHT', to_number(0));
        v_duty    number := util_pkg.get_param('LANDED_DUTY',    to_number(0));
        -- 分摊基准: AMT 按金额, WGT 按重量(取物料重量*数量),默认按金额
        v_basis   varchar2(8) := util_pkg.get_param('LANDED_BASIS', 'AMT');
        v_exists  number;
    begin
        select count(*) into v_exists from t_purchase_order where po_id = p_po_id;
        if v_exists = 0 then
            exc_pkg.raise_biz_error(
                const_pkg.c_err_po_not_found, const_pkg.c_mod_cost, 'landed_cost_report',
                'PO 不存在 po_id=' || p_po_id, to_char(p_po_id));
        end if;

        -- with function: 在 SQL 里内联定义分摊函数,把某项费用按行占比摊到 PO 行
        -- p_total_charge 为该项费用总额, p_line_base/p_sum_base 为本行/全单的分摊基准量
        open p_cur for
            with function alloc_charge(
                     p_total_charge in number,
                     p_line_base    in number,
                     p_sum_base     in number
                 ) return number is
                 begin
                     if nvl(p_sum_base, 0) = 0 then
                         return 0;
                     end if;
                     return round(p_total_charge * p_line_base / p_sum_base, 4);
                 end;
            base as (
                select pl.po_line_id,
                       pl.line_no,
                       pl.item_id,
                       it.item_code,
                       it.item_name,
                       pl.qty_ordered,
                       pl.unit_price,
                       round(pl.qty_ordered * pl.unit_price, 4) as line_amount,
                       round(pl.qty_ordered * nvl(it.dim.weight_kg, 0), 4) as line_weight,
                       case when v_basis = 'WGT'
                            then round(pl.qty_ordered * nvl(it.dim.weight_kg, 0), 4)
                            else round(pl.qty_ordered * pl.unit_price, 4)
                       end as alloc_base
                  from t_po_line pl
                  join t_item it on it.item_id = pl.item_id
                 where pl.po_id = p_po_id
            )
            select po_line_id,
                   line_no,
                   item_id,
                   item_code,
                   item_name,
                   qty_ordered,
                   unit_price,
                   line_amount,
                   line_weight,
                   alloc_charge(v_freight, alloc_base, sum(alloc_base) over ()) as freight_alloc,
                   alloc_charge(v_duty,    alloc_base, sum(alloc_base) over ()) as duty_alloc,
                   line_amount
                   + alloc_charge(v_freight, alloc_base, sum(alloc_base) over ())
                   + alloc_charge(v_duty,    alloc_base, sum(alloc_base) over ()) as landed_total,
                   round((line_amount
                          + alloc_charge(v_freight, alloc_base, sum(alloc_base) over ())
                          + alloc_charge(v_duty,    alloc_base, sum(alloc_base) over ()))
                         / nullif(qty_ordered, 0), 6) as landed_unit_cost
              from base
             order by line_no;
    end landed_cost_report;


    procedure roll_standard_cost(p_as_of in date default null) is
        v_as_of   date := nvl(p_as_of, util_pkg.curr_biz_date());
        v_rolled  number;
        v_cnt     number := 0;
        v_fail    number := 0;
    begin
        -- 只对成品/半成品卷算(原料/服务无 BOM,标准成本由采购或人工维护)
        -- 逐料调 bom_pkg.rolled_cost 沿 BOM 自底向上累加;单料失败不阻断整批
        for r in (
            select item_id, item_code
              from t_item
             where item_type in (const_pkg.c_item_fg, const_pkg.c_item_semi)
               and status = 'ACTIVE'
        ) loop
            begin
                v_rolled := bom_pkg.rolled_cost(r.item_id, v_as_of);

                merge into t_item t
                using (select r.item_id as item_id from dual) s
                on (t.item_id = s.item_id)
                when matched then
                    update set t.std_cost   = round(v_rolled, 6),
                               t.updated_by  = util_pkg.get_operator(),
                               t.updated_at  = current_timestamp;

                v_cnt := v_cnt + 1;
            exception
                when others then
                    -- 缺 ACTIVE BOM、环路等单料异常记 WARN 继续,跑批不因一个料崩
                    v_fail := v_fail + 1;
                    exc_pkg.log_error(
                        p_error_code  => const_pkg.c_err_bom_no_active,
                        p_module      => const_pkg.c_mod_cost,
                        p_procedure   => 'roll_standard_cost',
                        p_error_msg   => '卷算失败 item=' || r.item_code || ' err=' || sqlerrm,
                        p_biz_key     => to_char(r.item_id),
                        p_error_level => 'WARN');
            end;
        end loop;

        exc_pkg.log_error(
            p_error_code  => 'I3010',
            p_module      => const_pkg.c_mod_cost,
            p_procedure   => 'roll_standard_cost',
            p_error_msg   => '标准成本卷算完成 as_of=' || to_char(v_as_of, 'YYYY-MM-DD')
                          || ' ok=' || v_cnt || ' fail=' || v_fail,
            p_error_level => 'INFO');
    end roll_standard_cost;

end costing_pkg;
/
