-- 价目表 + 定价规则(阶梯)
-- 定价引擎 pricing_pkg 的取价优先级: 客户专属表 > 默认表，同表内 priority 小者先命中
-- 规则可按 物料 / 分类 / 客户 任意组合限定，min_qty/max_qty 划分数量阶梯
-- 与 bank 的 fee_rate 同思路，但叠了多维匹配 + 折扣类型，命中逻辑更绕

create table t_price_list (
    price_list_id   number(18)     not null,
    list_code       varchar2(32)   not null,
    list_name       varchar2(100)  not null,
    currency_code   varchar2(8)    default 'CNY' not null,
    is_default      char(1)        default 'N' not null,
    valid_from      date           default sysdate not null,
    valid_to        date,
    is_active       char(1)        default 'Y' not null,
    constraint pk_price_list primary key (price_list_id),
    constraint uk_price_list_code unique (list_code),
    constraint ck_pricelist_default check (is_default in ('Y','N')),
    constraint ck_pricelist_active  check (is_active in ('Y','N'))
);


create table t_price_rule (
    rule_id         number(18)     not null,
    price_list_id   number(18)     not null,
    item_id         number(18),
    category_id     number(18),
    customer_id     number(18),
    min_qty         number(18,4)   default 0 not null,
    max_qty         number(18,4),
    rule_type       varchar2(16)   default 'LIST' not null,
    price_value     number(20,6)   not null,
    priority        number(6)      default 100 not null,
    valid_from      date           default sysdate not null,
    valid_to        date,
    is_active       char(1)        default 'Y' not null,
    constraint pk_price_rule primary key (rule_id),
    constraint fk_pricerule_list     foreign key (price_list_id) references t_price_list(price_list_id),
    constraint fk_pricerule_item     foreign key (item_id)       references t_item(item_id),
    constraint fk_pricerule_category foreign key (category_id)   references t_item_category(category_id),
    constraint fk_pricerule_customer foreign key (customer_id)   references t_customer(customer_id),
    constraint ck_pricerule_type   check (rule_type in ('LIST','DISCOUNT_PCT','DISCOUNT_AMT','OVERRIDE')),
    constraint ck_pricerule_active check (is_active in ('Y','N')),
    constraint ck_pricerule_qty    check (max_qty is null or max_qty > min_qty)
);

comment on column t_price_rule.rule_type is 'LIST 标准价 / DISCOUNT_PCT 折扣率 / DISCOUNT_AMT 减额 / OVERRIDE 一口价';
comment on column t_price_rule.priority is '命中优先级，越小越先；物料级一般小于分类级，确保细粒度优先';
