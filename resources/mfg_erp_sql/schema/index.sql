-- 二级索引
-- 只建被高频查询/外键关联且非主键覆盖的列；主键/唯一键自带索引不重复建
-- 分区表 t_inventory_txn 上建本地索引(local)，随分区滚动

create index idx_item_category   on t_item(category_id);
create index idx_item_type       on t_item(item_type, status);
create index idx_item_supplier   on t_item(preferred_supplier);

create index idx_category_parent on t_item_category(parent_category_id);

create index idx_bomhdr_item     on t_bom_header(item_id, status);
create index idx_bomline_comp    on t_bom_line(component_item_id);

create index idx_lot_item_wh     on t_inventory_lot(item_id, warehouse_id, status);
create index idx_lot_fifo        on t_inventory_lot(item_id, warehouse_id, receipt_date, lot_id);

create index idx_invtxn_item     on t_inventory_txn(item_id, warehouse_id, txn_date) local;
create index idx_invtxn_ref      on t_inventory_txn(ref_doc_type, ref_doc_id) local;

create index idx_poline_item     on t_po_line(item_id, line_status);
create index idx_soline_item     on t_so_line(item_id, line_status);

create index idx_prod_item       on t_production_order(item_id, status);
create index idx_mrpplan_run     on t_mrp_plan(run_id, item_id, bucket_date);

create index idx_pricerule_match on t_price_rule(price_list_id, item_id, category_id, is_active);

create index idx_forecast_item   on t_demand_forecast(item_id, period_date);

create index idx_errlog_occurred on t_error_log(occurred_at);
create index idx_auditlog_key    on t_audit_log(table_name, biz_key);
