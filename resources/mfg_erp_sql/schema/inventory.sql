-- 库存: 批次明细 + 余额汇总 + 流水
-- 三层结构的原因:
--   批次 t_inventory_lot   -> FIFO 估值要按批次入库时间排队扣减，必须保留批次粒度
--   余额 t_inventory_balance-> 物料+仓库维度的快照，可用量校验走它，避免每次 sum 批次
--   流水 t_inventory_txn    -> 不可变的事件流，余额与批次都是流水的投影，对账以流水为准
-- 批次余额一致性由 inventory_pkg 维护，复合触发器 trg_inv_txn 在流水落库时同步余额

create table t_inventory_lot (
    lot_id          number(18)     not null,
    lot_no          varchar2(40)   not null,
    item_id         number(18)     not null,
    warehouse_id    number(18)     not null,
    qty_on_hand     number(18,4)   default 0 not null,
    qty_allocated   number(18,4)   default 0 not null,
    unit_cost       number(20,6)   default 0 not null,
    currency_code   varchar2(8)    default 'CNY' not null,
    receipt_date    date           not null,
    expiry_date     date,
    status          varchar2(12)   default 'AVAILABLE' not null,
    source_doc_type varchar2(16),
    source_doc_id   number(18),
    created_at      timestamp      default current_timestamp not null,
    constraint pk_inventory_lot primary key (lot_id),
    constraint uk_inv_lot_no unique (lot_no),
    constraint fk_lot_item foreign key (item_id)      references t_item(item_id),
    constraint fk_lot_wh   foreign key (warehouse_id) references t_warehouse(warehouse_id),
    constraint ck_lot_status check (status in ('AVAILABLE','QUARANTINE','EXPIRED','CONSUMED')),
    constraint ck_lot_qty    check (qty_on_hand >= 0 and qty_allocated >= 0)
);

comment on column t_inventory_lot.qty_allocated is '已分配未发出量，可用 = qty_on_hand - qty_allocated';
comment on column t_inventory_lot.receipt_date is 'FIFO 排队键，同日按 lot_id 升序';


-- 余额汇总，物料+仓库唯一，乐观锁 version
create table t_inventory_balance (
    item_id         number(18)     not null,
    warehouse_id    number(18)     not null,
    qty_on_hand     number(18,4)   default 0 not null,
    qty_allocated   number(18,4)   default 0 not null,
    avg_cost        number(20,6)   default 0 not null,
    last_txn_date   date,
    version         number(10)     default 0 not null,
    updated_at      timestamp      default current_timestamp not null,
    constraint pk_inventory_balance primary key (item_id, warehouse_id),
    constraint fk_invbal_item foreign key (item_id)      references t_item(item_id),
    constraint fk_invbal_wh   foreign key (warehouse_id) references t_warehouse(warehouse_id),
    constraint ck_invbal_qty  check (qty_on_hand >= 0)
);

comment on column t_inventory_balance.avg_cost is '移动加权平均成本，AVG 估值物料用；FIFO 物料此列仅作参考';


-- 库存流水，按季分区(与 bank 的 txn 同策略)，分区键 txn_date 入主键
create table t_inventory_txn (
    txn_id          number(18)     not null,
    txn_no          varchar2(40)   not null,
    item_id         number(18)     not null,
    warehouse_id    number(18)     not null,
    lot_id          number(18),
    txn_type        varchar2(12)   not null,
    direction       char(1)        not null,
    quantity        number(18,4)   not null,
    unit_cost       number(20,6)   default 0 not null,
    total_cost      number(20,4)   default 0 not null,
    qty_before      number(18,4),
    qty_after       number(18,4),
    txn_date        date           not null,
    txn_time        timestamp      default current_timestamp not null,
    ref_doc_type    varchar2(16),
    ref_doc_id      number(18),
    operator        varchar2(32)   default 'SYSTEM' not null,
    remark          varchar2(200),
    created_at      timestamp      default current_timestamp not null,
    constraint pk_inventory_txn primary key (txn_id, txn_date),
    constraint uk_inv_txn_no unique (txn_no, txn_date),
    constraint ck_invtxn_dir   check (direction in ('I','O')),
    constraint ck_invtxn_type  check (txn_type in ('RECV','ISSUE','ADJ','XFER_IN','XFER_OUT','PROD_IN','PROD_OUT','RETURN')),
    constraint ck_invtxn_qty   check (quantity > 0)
)
partition by range (txn_date)
(
    partition p_inv_2025q1 values less than (to_date('2025-04-01','YYYY-MM-DD')),
    partition p_inv_2025q2 values less than (to_date('2025-07-01','YYYY-MM-DD')),
    partition p_inv_2025q3 values less than (to_date('2025-10-01','YYYY-MM-DD')),
    partition p_inv_2025q4 values less than (to_date('2026-01-01','YYYY-MM-DD')),
    partition p_inv_2026q1 values less than (to_date('2026-04-01','YYYY-MM-DD')),
    partition p_inv_2026q2 values less than (to_date('2026-07-01','YYYY-MM-DD')),
    partition p_inv_2026q3 values less than (to_date('2026-10-01','YYYY-MM-DD')),
    partition p_inv_2026q4 values less than (to_date('2027-01-01','YYYY-MM-DD')),
    partition p_inv_max    values less than (maxvalue)
);

comment on column t_inventory_txn.direction is 'I 入库(数量增) / O 出库(数量减)，与 txn_type 配合';
comment on column t_inventory_txn.txn_type  is 'RECV 收货/ISSUE 发料/ADJ 调整/XFER 调拨/PROD 生产入出/RETURN 退货';
