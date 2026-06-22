-- 二级索引（仅保留 mini 仓库涉及的表）

create index idx_item_category   on t_item(category_id);
create index idx_item_type       on t_item(item_type, status);

create index idx_category_parent on t_item_category(parent_category_id);

create index idx_bomhdr_item     on t_bom_header(item_id, status);
create index idx_bomline_comp    on t_bom_line(component_item_id);

create index idx_lot_item_wh     on t_inventory_lot(item_id, warehouse_id, status);
create index idx_lot_fifo        on t_inventory_lot(item_id, warehouse_id, receipt_date, lot_id);

create index idx_invtxn_item     on t_inventory_txn(item_id, warehouse_id, txn_date) local;

create index idx_errlog_occurred on t_error_log(occurred_at);
create index idx_auditlog_key    on t_audit_log(table_name, biz_key);
