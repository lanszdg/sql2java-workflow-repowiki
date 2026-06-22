-- 生产工单 + MRP 运行 + MRP 计划明细
-- 工单领料按 BOM 展开当层组件，完工入成品；领料/入库都走 inventory_pkg 产生 PROD_OUT/PROD_IN 流水
-- MRP 一次运行(t_mrp_run)产出一批计划行(t_mrp_plan)，按物料+时段滚动净算需求

create table t_production_order (
    prod_id         number(18)     not null,
    prod_no         varchar2(32)   not null,
    item_id         number(18)     not null,
    bom_id          number(18),
    qty_planned     number(18,4)   not null,
    qty_completed   number(18,4)   default 0 not null,
    qty_scrapped    number(18,4)   default 0 not null,
    status          varchar2(12)   default 'PLANNED' not null,
    warehouse_id    number(18),
    start_date      date,
    due_date        date,
    source_mrp_id   number(18),
    created_by      varchar2(32)   default 'SYSTEM' not null,
    created_at      timestamp      default current_timestamp not null,
    constraint pk_production_order primary key (prod_id),
    constraint uk_prod_no unique (prod_no),
    constraint fk_prod_item foreign key (item_id) references t_item(item_id),
    constraint fk_prod_bom  foreign key (bom_id)  references t_bom_header(bom_id),
    constraint fk_prod_wh   foreign key (warehouse_id) references t_warehouse(warehouse_id),
    constraint ck_prod_status check (status in ('PLANNED','RELEASED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED')),
    constraint ck_prod_qty    check (qty_planned > 0)
);


create table t_mrp_run (
    run_id          number(18)     not null,
    run_no          varchar2(32)   not null,
    run_date        date           not null,
    horizon_days    number(5)      default 90 not null,
    bucket_type     varchar2(8)    default 'WEEK' not null,
    status          varchar2(12)   default 'RUNNING' not null,
    item_count      number(10)     default 0,
    plan_count      number(10)     default 0,
    started_at      timestamp      default current_timestamp not null,
    finished_at     timestamp,
    created_by      varchar2(32)   default 'SYSTEM' not null,
    constraint pk_mrp_run primary key (run_id),
    constraint uk_mrp_run_no unique (run_no),
    constraint ck_mrp_status check (status in ('RUNNING','SUCCESS','FAILED','PARTIAL')),
    constraint ck_mrp_bucket check (bucket_type in ('DAY','WEEK','MONTH'))
);

comment on column t_mrp_run.bucket_type is '时段粒度，需求/供给按桶滚动净算';


create table t_mrp_plan (
    plan_id            number(18)     not null,
    run_id             number(18)     not null,
    item_id            number(18)     not null,
    warehouse_id       number(18),
    bucket_date        date           not null,
    level_no           number(3)      default 0 not null,
    gross_req          number(18,4)   default 0 not null,
    scheduled_receipt  number(18,4)   default 0 not null,
    proj_on_hand       number(18,4)   default 0 not null,
    net_req            number(18,4)   default 0 not null,
    planned_order_qty  number(18,4)   default 0 not null,
    planned_order_date date,
    action_msg         varchar2(40),
    constraint pk_mrp_plan primary key (plan_id),
    constraint fk_mrpplan_run  foreign key (run_id)  references t_mrp_run(run_id),
    constraint fk_mrpplan_item foreign key (item_id) references t_item(item_id)
);

comment on column t_mrp_plan.level_no is 'BOM 低层码(low-level code)，展开层级越深越大，净算必须自顶向下逐层';
comment on column t_mrp_plan.action_msg is '计划建议: 下单/催料/延迟/取消，由净算结果生成';
