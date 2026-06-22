-- 序列（仅保留 mini 仓库涉及的表）
-- 主数据 nocache 保连续，高频写入给 cache

create sequence seq_category_id    start with 100    increment by 1 nocache nocycle;
create sequence seq_item_id        start with 10000  increment by 1 nocache nocycle;
create sequence seq_bom_id         start with 1000   increment by 1 nocache nocycle;
create sequence seq_bom_line_id    start with 1      increment by 1 cache 50  nocycle;
create sequence seq_warehouse_id   start with 10     increment by 1 nocache nocycle;
create sequence seq_lot_id         start with 700000 increment by 1 cache 100 nocycle;
create sequence seq_inv_txn_id     start with 800000 increment by 1 cache 100 nocycle;
create sequence seq_error_log_id   start with 1      increment by 1 cache 50  nocycle;
create sequence seq_audit_log_id   start with 1      increment by 1 cache 50  nocycle;
