-- 通用码表 + 计量单位 + 单位换算
-- 码表 t_code_dict 一表多类: dict_type 区分枚举域，避免每个枚举单开一张表
-- 物料类型/订单状态/库存事务类型等下拉值都落这里，应用层缓存，变更走配置发布

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
comment on column t_code_dict.attr1 is '扩展属性，不同 dict_type 含义不同，如物料类型这里放默认估值方法';


-- 计量单位
-- uom_category 决定哪些单位之间可换算: 同类(都是重量)才允许，跨类(重量->长度)直接报错
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


-- 单位换算系数，存到基本单位的折算率
-- 不存所有两两组合，只存 from -> 基本单位；任意两单位换算 = from->base / to->base
-- fn_uom_convert 据此计算，跨 category 抛异常
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
