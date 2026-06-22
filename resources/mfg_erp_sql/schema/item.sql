-- 物料分类树 + 物料主表
-- 分类树 t_item_category 自引用 parent_category_id，根节点 parent 为 null
-- level_no / path 是冗余的展开缓存(由 CONNECT BY 维护)，查询时不必每次递归
-- 留这两列是因为分类层级深(最多 5 层)，报表按某节点取整棵子树非常频繁

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
-- item_type 决定走哪类业务逻辑，与对象层 t_item_obj 子型一一对应:
--   RAW 原材料 / SEMI 半成品 / FG 成品 / SVC 服务(委外/运费,不可库存)
-- is_phantom: 虚拟件(幻影件)，自身不入库，BOM 展开时直接穿透到其下层组件
--   常见于"包装组件""通用支架"这类只为整理 BOM 结构、不单独领料的层级
-- dim / tags 用对象列与 varray 列内嵌存储，刻意让 sql2java 处理对象/集合列映射
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
    preferred_supplier   number(18),
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
    constraint fk_item_supplier foreign key (preferred_supplier) references t_supplier(supplier_id),
    constraint ck_item_type      check (item_type in ('RAW','SEMI','FG','SVC')),
    constraint ck_item_valuation check (valuation_method in ('FIFO','STD','AVG','NONE')),
    constraint ck_item_abc       check (abc_class in ('A','B','C')),
    constraint ck_item_phantom   check (is_phantom in ('Y','N')),
    constraint ck_item_lot       check (is_lot_controlled in ('Y','N')),
    constraint ck_item_status    check (status in ('ACTIVE','HOLD','OBSOLETE'))
);

comment on column t_item.valuation_method is 'FIFO 先进先出 / STD 标准成本 / AVG 移动加权平均 / NONE 不估值(服务类)';
comment on column t_item.abc_class is 'ABC 分类，由 fn_abc_class 按累计消耗占比定期重算，A 类管控最严';
comment on column t_item.is_phantom is 'Y 虚拟件，BOM 展开穿透不领料；与 item_type=SEMI 可叠加';
