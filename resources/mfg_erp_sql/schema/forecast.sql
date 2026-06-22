-- 需求预测
-- 同一物料+仓库+时段一行，forecast_pkg 用 MODEL 子句做滚动预测(移动平均/趋势外推)
-- actual_qty 是事后回填的实际出货，与 forecast_qty 比对算预测准确率
-- period_date 统一取月度首日(每月 1 号)，时间桶按月

create table t_demand_forecast (
    forecast_id     number(18)     not null,
    item_id         number(18)     not null,
    warehouse_id    number(18),
    period_date     date           not null,
    forecast_qty    number(18,4)   default 0 not null,
    actual_qty      number(18,4),
    method          varchar2(16)   default 'MA3' not null,
    run_id          number(18),
    created_at      timestamp      default current_timestamp not null,
    constraint pk_demand_forecast primary key (forecast_id),
    constraint uk_forecast unique (item_id, warehouse_id, period_date, method),
    constraint fk_forecast_item foreign key (item_id)      references t_item(item_id),
    constraint fk_forecast_wh   foreign key (warehouse_id) references t_warehouse(warehouse_id),
    constraint ck_forecast_method check (method in ('MA3','MA6','TREND','MANUAL'))
);

comment on column t_demand_forecast.method is 'MA3/MA6 三/六期移动平均 / TREND 线性趋势 / MANUAL 人工录入';
