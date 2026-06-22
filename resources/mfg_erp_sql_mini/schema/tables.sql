-- ============================================================
-- 表结构: 通用码表 + 计量单位 + 系统控制 + 仓库 + 物料 + BOM + 库存
-- 合并自原 dict.sql / sysctl.sql / warehouse.sql / item.sql / bom.sql / inventory.sql
-- 去掉 partner / orders / production / pricing / forecast 相关表
-- ============================================================

-- 通用码表，dict_type 区分枚举域
create table t_code_dict (
    dict_type    varchar2(32)   not null,
    code         varchar2(32)   not null,
    code_name    varchar2(100)  not null,
    sort_no      number(6)      default 0 not null,
    attr1        varchar2(100),
    attr2        varchar2(100),
    is_active    char(1)        default 'Y' not null,
    remark       varchar2(200),
    constraint pk_code_dict primary key (dict_type, code),
    constraint ck_code_dict_active check (is_active in ('Y','N'))
);

comment on table  t_code_dict is '通用码表，dict_type 区分枚举域';
comment on column t_code_dict.attr1 is '扩展属性，不同 dict_type 含义不同';


-- 计量单位
create table t_uom (
    uom_code        varchar2(8)    not null,
    uom_name        varchar2(40)   not null,
    uom_category    varchar2(8)    not null,
    decimal_digits  number(2)      default 2 not null,
    is_base         char(1)        default 'N' not null,
    constraint pk_uom primary key (uom_code),
    constraint ck_uom_category check (uom_category in ('EA','WT','VOL','LEN','TIME')),
    constraint ck_uom_base     check (is_base in ('Y','N'))
);

comment on table  t_uom is '计量单位';
comment on column t_uom.uom_category is 'EA 计数 / WT 重量 / VOL 体积 / LEN 长度 / TIME 时间';
comment on column t_uom.is_base is '每个 category 仅一个基本单位，换算以它为枢轴';


-- 单位换算系数
create table t_uom_conversion (
    from_uom    varchar2(8)    not null,
    to_uom      varchar2(8)    not null,
    factor      number(20,8)   not null,
    constraint pk_uom_conversion primary key (from_uom, to_uom),
    constraint fk_uomconv_from foreign key (from_uom) references t_uom(uom_code),
    constraint fk_uomconv_to   foreign key (to_uom)   references t_uom(uom_code),
    constraint ck_uomconv_factor check (factor > 0)
);

comment on column t_uom_conversion.factor is '1 个 from_uom = factor 个 to_uom';


-- 业务日期控制
create table t_business_date (
    sys_code        varchar2(16)   not null,
    curr_biz_date   date           not null,
    last_biz_date   date,
    next_biz_date   date,
    period_status   varchar2(16)   default 'OPEN' not null,
    updated_at      timestamp      default current_timestamp not null,
    constraint pk_business_date primary key (sys_code),
    constraint ck_bizdate_status check (period_status in ('OPEN','RUNNING','CLOSED'))
);

comment on column t_business_date.period_status is 'OPEN 可交易 / RUNNING 跑批占用 / CLOSED 日切中';


-- 运行参数
create table t_app_param (
    param_key     varchar2(64)   not null,
    param_value   varchar2(500),
    param_type    varchar2(16)   default 'STRING' not null,
    description   varchar2(200),
    updated_by    varchar2(32),
    updated_at    timestamp      default current_timestamp not null,
    constraint pk_app_param primary key (param_key),
    constraint ck_param_type check (param_type in ('STRING','NUMBER','BOOL','DATE','JSON'))
);


-- 错误日志，exc_pkg.log_error 自治事务写入
create table t_error_log (
    log_id          number(18)     not null,
    error_code      varchar2(16)   not null,
    error_level     varchar2(8)    default 'ERROR' not null,
    module_name     varchar2(64),
    procedure_name  varchar2(64),
    error_msg       varchar2(2000),
    error_stack     varchar2(4000),
    biz_key         varchar2(100),
    context_data    clob,
    operator        varchar2(32),
    occurred_at     timestamp      default current_timestamp not null,
    constraint pk_error_log primary key (log_id),
    constraint ck_error_level check (error_level in ('INFO','WARN','ERROR','FATAL'))
);


-- 审计日志
create table t_audit_log (
    audit_id      number(18)     not null,
    table_name    varchar2(64)   not null,
    action_type   varchar2(16)   not null,
    biz_key       varchar2(100),
    old_value     clob,
    new_value     clob,
    operator      varchar2(32),
    operated_at   timestamp      default current_timestamp not null,
    constraint pk_audit_log primary key (audit_id)
);


-- 仓库
create table t_warehouse (
    warehouse_id    number(18)     not null,
    warehouse_code  varchar2(16)   not null,
    warehouse_name  varchar2(100)  not null,
    warehouse_type  varchar2(8)    default 'FG' not null,
    region          varchar2(32),
    is_active       char(1)        default 'Y' not null,
    created_at      timestamp      default current_timestamp not null,
    constraint pk_warehouse primary key (warehouse_id),
    constraint uk_warehouse_code unique (warehouse_code),
    constraint ck_wh_type   check (warehouse_type in ('RAW','FG','WIP','RET')),
    constraint ck_wh_active  check (is_active in ('Y','N'))
);

comment on column t_warehouse.warehouse_type is 'RAW 原料 / FG 成品 / WIP 在制 / RET 退货';


-- 物料分类树，自引用 parent_category_id
create table t_item_category (
    category_id         number(18)     not null,
    parent_category_id  number(18),
    category_code       varchar2(32)   not null,
    category_name       varchar2(100)  not null,
    level_no            number(3)      default 1 not null,
    path                varchar2(500),
    is_leaf             char(1)        default 'Y' not null,
    constraint pk_item_category primary key (category_id),
    constraint uk_item_category_code unique (category_code),
    constraint fk_category_parent foreign key (parent_category_id) references t_item_category(category_id),
    constraint ck_category_leaf check (is_leaf in ('Y','N'))
);

comment on column t_item_category.path is '从根到本节点的 /code/code/code 路径，CONNECT BY sys_connect_by_path 维护';


-- 物料主表
-- dim / tags 用对象列与 varray 列内嵌存储
create table t_item (
    item_id              number(18)     not null,
    item_code            varchar2(40)   not null,
    item_name            varchar2(200)  not null,
    item_type            varchar2(8)    default 'RAW' not null,
    category_id          number(18),
    base_uom             varchar2(8)    not null,
    std_cost             number(20,6)   default 0 not null,
    list_price           number(20,4)   default 0 not null,
    currency_code        varchar2(8)    default 'CNY' not null,
    valuation_method     varchar2(8)    default 'FIFO' not null,
    lead_time_days       number(5)      default 0 not null,
    safety_stock         number(18,4)   default 0 not null,
    reorder_point        number(18,4)   default 0 not null,
    reorder_qty          number(18,4)   default 0 not null,
    shelf_life_days      number(6),
    abc_class            char(1),
    is_phantom           char(1)        default 'N' not null,
    is_lot_controlled    char(1)        default 'Y' not null,
    status               varchar2(8)    default 'ACTIVE' not null,
    dim                  t_dimension,
    tags                 t_tag_varray,
    created_by           varchar2(32)   default 'SYSTEM' not null,
    created_at           timestamp      default current_timestamp not null,
    updated_by           varchar2(32),
    updated_at           timestamp,
    constraint pk_item primary key (item_id),
    constraint uk_item_code unique (item_code),
    constraint fk_item_category foreign key (category_id) references t_item_category(category_id),
    constraint fk_item_uom      foreign key (base_uom)    references t_uom(uom_code),
    constraint ck_item_type      check (item_type in ('RAW','SEMI','FG','SVC')),
    constraint ck_item_valuation check (valuation_method in ('FIFO','STD','AVG','NONE')),
    constraint ck_item_abc       check (abc_class in ('A','B','C')),
    constraint ck_item_phantom   check (is_phantom in ('Y','N')),
    constraint ck_item_lot       check (is_lot_controlled in ('Y','N')),
    constraint ck_item_status    check (status in ('ACTIVE','HOLD','OBSOLETE'))
);

comment on column t_item.valuation_method is 'FIFO 先进先出 / STD 标准成本 / AVG 移动加权平均 / NONE 不估值';
comment on column t_item.abc_class is 'ABC 分类，由 fn_abc_class 按累计消耗占比定期重算';
comment on column t_item.is_phantom is 'Y 虚拟件，BOM 展开穿透不领料';


-- BOM 头(版本)
create table t_bom_header (
    bom_id          number(18)     not null,
    item_id         number(18)     not null,
    bom_version     varchar2(16)   default 'V1' not null,
    base_qty        number(18,6)   default 1 not null,
    base_uom        varchar2(8)    not null,
    status          varchar2(8)    default 'DRAFT' not null,
    is_default      char(1)        default 'N' not null,
    effective_from  date           default sysdate not null,
    effective_to    date,
    created_by      varchar2(32)   default 'SYSTEM' not null,
    created_at      timestamp      default current_timestamp not null,
    constraint pk_bom_header primary key (bom_id),
    constraint uk_bom_ver unique (item_id, bom_version),
    constraint fk_bom_item foreign key (item_id)  references t_item(item_id),
    constraint fk_bom_uom  foreign key (base_uom) references t_uom(uom_code),
    constraint ck_bom_status  check (status in ('DRAFT','ACTIVE','OBSOLETE')),
    constraint ck_bom_default check (is_default in ('Y','N')),
    constraint ck_bom_baseqty check (base_qty > 0)
);

comment on column t_bom_header.base_qty is '基准产出量，行用量 qty_per 是相对 base_qty 的';


-- BOM 行(组件)
create table t_bom_line (
    line_id            number(18)     not null,
    bom_id             number(18)     not null,
    line_no            number(6)      not null,
    component_item_id  number(18)     not null,
    qty_per            number(18,6)   not null,
    uom                varchar2(8)    not null,
    scrap_rate         number(8,4)    default 0 not null,
    is_phantom         char(1)        default 'N' not null,
    ref_designator     varchar2(100),
    effective_from     date           default sysdate not null,
    effective_to       date,
    constraint pk_bom_line primary key (line_id),
    constraint uk_bom_line unique (bom_id, line_no),
    constraint fk_bomline_header    foreign key (bom_id)            references t_bom_header(bom_id),
    constraint fk_bomline_component foreign key (component_item_id) references t_item(item_id),
    constraint fk_bomline_uom       foreign key (uom)               references t_uom(uom_code),
    constraint ck_bomline_qty   check (qty_per > 0),
    constraint ck_bomline_scrap check (scrap_rate >= 0 and scrap_rate < 1),
    constraint ck_bomline_phantom check (is_phantom in ('Y','N'))
);

comment on column t_bom_line.scrap_rate is '损耗率，实际投料 = qty_per / (1 - scrap_rate)';
comment on column t_bom_line.is_phantom is '行级虚拟标志，优先级高于组件物料自身的 is_phantom';


-- 库存批次明细
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

comment on column t_inventory_balance.avg_cost is '移动加权平均成本，AVG 估值物料用';


-- 库存流水，按季分区
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
    partition p_inv_2025q4 values less than (to_date('2026-01-01','YYYY-MM-DD')),
    partition p_inv_2026q1 values less than (to_date('2026-04-01','YYYY-MM-DD')),
    partition p_inv_2026q2 values less than (to_date('2026-07-01','YYYY-MM-DD')),
    partition p_inv_2026q3 values less than (to_date('2026-10-01','YYYY-MM-DD')),
    partition p_inv_max    values less than (maxvalue)
);

comment on column t_inventory_txn.direction is 'I 入库 / O 出库';
comment on column t_inventory_txn.txn_type  is 'RECV 收货/ISSUE 发料/ADJ 调整/XFER 调拨/PROD 生产入出/RETURN 退货';
