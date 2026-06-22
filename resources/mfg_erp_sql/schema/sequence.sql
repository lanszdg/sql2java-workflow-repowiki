-- 序列
-- cache 策略同 bank: 高频写入(流水/计划/日志)给 cache，主数据 nocache 保连续便于排查
-- 主数据起始值拉开数量级，dba 看 id 量级即知归属

create sequence seq_category_id    start with 100    increment by 1 nocache nocycle;
create sequence seq_item_id        start with 10000  increment by 1 nocache nocycle;
create sequence seq_bom_id         start with 1000   increment by 1 nocache nocycle;
create sequence seq_bom_line_id    start with 1      increment by 1 cache 50  nocycle;
create sequence seq_warehouse_id   start with 10     increment by 1 nocache nocycle;
create sequence seq_location_id    start with 1000   increment by 1 nocache nocycle;
create sequence seq_supplier_id    start with 5000   increment by 1 nocache nocycle;
create sequence seq_customer_id    start with 6000   increment by 1 nocache nocycle;
create sequence seq_lot_id         start with 700000 increment by 1 cache 100 nocycle;
create sequence seq_inv_txn_id     start with 800000 increment by 1 cache 100 nocycle;
create sequence seq_po_id          start with 200000 increment by 1 cache 20  nocycle;
create sequence seq_po_line_id     start with 1      increment by 1 cache 50  nocycle;
create sequence seq_so_id          start with 300000 increment by 1 cache 20  nocycle;
create sequence seq_so_line_id     start with 1      increment by 1 cache 50  nocycle;
create sequence seq_prod_id        start with 400000 increment by 1 cache 20  nocycle;
create sequence seq_mrp_run_id     start with 1      increment by 1 nocache nocycle;
create sequence seq_mrp_plan_id    start with 1      increment by 1 cache 200 nocycle;
create sequence seq_price_list_id  start with 1      increment by 1 nocache nocycle;
create sequence seq_price_rule_id  start with 1      increment by 1 cache 50  nocycle;
create sequence seq_forecast_id    start with 1      increment by 1 cache 200 nocycle;
create sequence seq_error_log_id   start with 1      increment by 1 cache 50  nocycle;
create sequence seq_audit_log_id   start with 1      increment by 1 cache 50  nocycle;
