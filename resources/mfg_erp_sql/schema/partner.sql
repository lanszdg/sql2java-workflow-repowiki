-- 供应商 + 客户
-- 供应商提前期 lead_time_days 是 MRP 倒排计划的关键输入，rating 影响优选供应商
-- 客户挂 price_list_id，定价引擎优先取客户专属价目表，无则落默认表

create table t_supplier (
    supplier_id     number(18)     not null,
    supplier_code   varchar2(32)   not null,
    supplier_name   varchar2(200)  not null,
    lead_time_days  number(5)      default 7 not null,
    rating          number(2)      default 3,
    currency_code   varchar2(8)    default 'CNY' not null,
    tax_no          varchar2(40),
    contact         varchar2(100),
    status          varchar2(8)    default 'ACTIVE' not null,
    created_at      timestamp      default current_timestamp not null,
    constraint pk_supplier primary key (supplier_id),
    constraint uk_supplier_code unique (supplier_code),
    constraint ck_supplier_status check (status in ('ACTIVE','HOLD','BLOCKED')),
    constraint ck_supplier_rating check (rating between 1 and 5)
);

comment on column t_supplier.rating is '供应商评级 1-5，5 最优，影响 mrp 优选与对账容忍度';


create table t_customer (
    customer_id     number(18)     not null,
    customer_code   varchar2(32)   not null,
    customer_name   varchar2(200)  not null,
    price_list_id   number(18),
    credit_limit    number(20,4)   default 0 not null,
    currency_code   varchar2(8)    default 'CNY' not null,
    region          varchar2(32),
    status          varchar2(8)    default 'ACTIVE' not null,
    created_at      timestamp      default current_timestamp not null,
    constraint pk_customer primary key (customer_id),
    constraint uk_customer_code unique (customer_code),
    constraint ck_customer_status check (status in ('ACTIVE','HOLD','BLOCKED')),
    constraint ck_customer_credit check (credit_limit >= 0)
);
