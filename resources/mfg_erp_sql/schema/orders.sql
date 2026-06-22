-- 采购订单 + 销售订单(各自头/行)
-- 状态机由 procurement_pkg / 销售侧维护，行状态汇总驱动头状态:
--   PO: DRAFT -> APPROVED -> PARTIAL -> RECEIVED -> CLOSED (可 CANCELLED)
--   行 qty_received 累加到等于 qty_ordered 时行 CLOSED，全行 CLOSED 头 RECEIVED
-- 收货过账走 inventory_pkg.receive_po，库存与 PO 行的 qty_received 在同一事务更新

create table t_purchase_order (
    po_id           number(18)     not null,
    po_no           varchar2(32)   not null,
    supplier_id     number(18)     not null,
    order_date      date           default sysdate not null,
    expected_date   date,
    status          varchar2(12)   default 'DRAFT' not null,
    currency_code   varchar2(8)    default 'CNY' not null,
    total_amount    number(20,4)   default 0 not null,
    warehouse_id    number(18),
    created_by      varchar2(32)   default 'SYSTEM' not null,
    approved_by     varchar2(32),
    approved_at     timestamp,
    created_at      timestamp      default current_timestamp not null,
    constraint pk_purchase_order primary key (po_id),
    constraint uk_po_no unique (po_no),
    constraint fk_po_supplier foreign key (supplier_id)  references t_supplier(supplier_id),
    constraint fk_po_wh       foreign key (warehouse_id) references t_warehouse(warehouse_id),
    constraint ck_po_status check (status in ('DRAFT','APPROVED','PARTIAL','RECEIVED','CLOSED','CANCELLED'))
);


create table t_po_line (
    po_line_id     number(18)     not null,
    po_id          number(18)     not null,
    line_no        number(6)      not null,
    item_id        number(18)     not null,
    qty_ordered    number(18,4)   not null,
    qty_received   number(18,4)   default 0 not null,
    unit_price     number(20,6)   not null,
    uom            varchar2(8)    not null,
    need_date      date,
    line_status    varchar2(12)   default 'OPEN' not null,
    constraint pk_po_line primary key (po_line_id),
    constraint uk_po_line unique (po_id, line_no),
    constraint fk_poline_po   foreign key (po_id)   references t_purchase_order(po_id),
    constraint fk_poline_item foreign key (item_id) references t_item(item_id),
    constraint fk_poline_uom  foreign key (uom)     references t_uom(uom_code),
    constraint ck_poline_status check (line_status in ('OPEN','PARTIAL','CLOSED','CANCELLED')),
    constraint ck_poline_qty    check (qty_ordered > 0 and qty_received >= 0)
);


create table t_sales_order (
    so_id           number(18)     not null,
    so_no           varchar2(32)   not null,
    customer_id     number(18)     not null,
    order_date      date           default sysdate not null,
    required_date   date,
    status          varchar2(12)   default 'DRAFT' not null,
    currency_code   varchar2(8)    default 'CNY' not null,
    price_list_id   number(18),
    total_amount    number(20,4)   default 0 not null,
    warehouse_id    number(18),
    created_by      varchar2(32)   default 'SYSTEM' not null,
    created_at      timestamp      default current_timestamp not null,
    constraint pk_sales_order primary key (so_id),
    constraint uk_so_no unique (so_no),
    constraint fk_so_customer foreign key (customer_id)  references t_customer(customer_id),
    constraint fk_so_wh       foreign key (warehouse_id) references t_warehouse(warehouse_id),
    constraint ck_so_status check (status in ('DRAFT','CONFIRMED','PARTIAL','SHIPPED','CLOSED','CANCELLED'))
);


create table t_so_line (
    so_line_id     number(18)     not null,
    so_id          number(18)     not null,
    line_no        number(6)      not null,
    item_id        number(18)     not null,
    qty_ordered    number(18,4)   not null,
    qty_shipped    number(18,4)   default 0 not null,
    unit_price     number(20,6)   not null,
    discount_pct   number(8,4)    default 0 not null,
    uom            varchar2(8)    not null,
    line_status    varchar2(12)   default 'OPEN' not null,
    constraint pk_so_line primary key (so_line_id),
    constraint uk_so_line unique (so_id, line_no),
    constraint fk_soline_so   foreign key (so_id)   references t_sales_order(so_id),
    constraint fk_soline_item foreign key (item_id) references t_item(item_id),
    constraint fk_soline_uom  foreign key (uom)     references t_uom(uom_code),
    constraint ck_soline_status check (line_status in ('OPEN','PARTIAL','CLOSED','CANCELLED')),
    constraint ck_soline_disc   check (discount_pct >= 0 and discount_pct < 1)
);
