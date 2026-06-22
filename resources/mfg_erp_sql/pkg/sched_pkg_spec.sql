-- 调度作业封装: 把跑批入口注册成 DBMS_SCHEDULER 作业
-- 真实生产由 ops 的调度平台拉起，这里用 DBMS_SCHEDULER 演示库内自调度
-- sql2java 侧一般映射成 @Scheduled / Quartz / XXL-JOB，本包是这类映射的样本

create or replace package sched_pkg as

    -- 注册每日 MRP 作业: 每天 02:00 调 mrp_pkg.run_mrp
    procedure schedule_nightly_mrp;

    -- 注册每月预测刷新作业: 每月 1 号 01:00 调 forecast_pkg.generate_forecast
    procedure schedule_monthly_forecast;

    -- 立即跑一次指定作业(排障/补跑)
    procedure run_job_now(p_job_name in varchar2);

    -- 删除作业
    procedure drop_job(p_job_name in varchar2);

    -- 列出本应用注册的作业及上次运行结果
    procedure list_jobs(p_cur out sys_refcursor);

end sched_pkg;
/
