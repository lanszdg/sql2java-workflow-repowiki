-- BOM 物料清单: 头(版本) + 行(组件)
-- 一个成品/半成品可有多个版本，同一时点只有一个 ACTIVE 默认版本
-- 多层 BOM 通过"行的组件本身又是另一个 BOM 的头物料"形成树，展开见 bom_pkg
-- 自引用环路(A 用到 B、B 又用到 A)是脏数据，bom_pkg 展开时用 connect by nocycle 兜底并告警

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

comment on column t_bom_header.base_qty is '基准产出量，行用量 qty_per 是相对 base_qty 的，比如配 100kg 浆料用 3kg 颜料';


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

comment on column t_bom_line.scrap_rate is '损耗率，实际投料 = qty_per / (1 - scrap_rate)，见 t_bom_comp_obj.effective_qty';
comment on column t_bom_line.is_phantom is '行级虚拟标志，优先级高于组件物料自身的 is_phantom';
