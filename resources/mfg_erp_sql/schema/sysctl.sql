-- 系统控制表: 业务日期、运行参数、错误日志、审计日志
-- 业务日期与 bank_core_sql 同构: 日终(日切)推进 curr_biz_date，期间闸门防并发跑批

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


-- 运行参数，键值对，应用层与包内 util 都读
-- param_type 决定取值时如何转型，sql2java 需注意 value 列是 varchar 但语义可能是数字/布尔
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


-- 错误日志，exc_pkg.log_error 自治事务写入，主事务回滚不影响
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


-- 审计日志，old/new 用 JSON 串，由触发器与业务包共同写入
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
