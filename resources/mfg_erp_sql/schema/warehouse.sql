-- 仓库 + 库位
-- 库位 t_location 自带父子(库区->货架->货位)，用 parent_location_id 自引用
-- 目前业务只用到两层，但表结构留了任意层级，盘点/拣货路径将来按树遍历

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


create table t_location (
    location_id         number(18)     not null,
    warehouse_id        number(18)     not null,
    parent_location_id  number(18),
    location_code       varchar2(32)   not null,
    zone                varchar2(16),
    is_pickable         char(1)        default 'Y' not null,
    constraint pk_location primary key (location_id),
    constraint uk_location_code unique (warehouse_id, location_code),
    constraint fk_location_wh     foreign key (warehouse_id)       references t_warehouse(warehouse_id),
    constraint fk_location_parent foreign key (parent_location_id) references t_location(location_id),
    constraint ck_location_pick   check (is_pickable in ('Y','N'))
);
