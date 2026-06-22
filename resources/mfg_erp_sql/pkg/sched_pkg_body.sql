-- sched_pkg 包体: 把跑批入口注册成 DBMS_SCHEDULER 作业
-- 作业名集中前缀 MFG_ 便于 list_jobs 按 like 过滤本应用作业，不误删别人的
-- run_mrp 带 out 参数不能直接做 stored_procedure 类型，统一用 plsql_block 包一层局部变量接 out
-- 真实生产调度多在 ops 平台，sql2java 侧一般落 @Scheduled / Quartz / XXL-JOB，这里是库内自调度样本

create or replace package body sched_pkg as

    c_job_prefix      constant varchar2(8)  := 'MFG_';
    c_job_nightly_mrp constant varchar2(32) := 'MFG_NIGHTLY_MRP';
    c_job_monthly_fc  constant varchar2(32) := 'MFG_MONTHLY_FORECAST';


    -- 私有: 重建作业前先吞掉同名旧作业，保证 schedule_* 可重复执行(幂等)
    procedure drop_if_exists(p_job_name in varchar2) is
    begin
        dbms_scheduler.drop_job(job_name => p_job_name, force => true);
    exception
        when others then
            -- -27475 作业不存在 / -27476 对象不存在，幂等场景下忽略，其余照抛
            if sqlcode in (-27475, -27476) then
                null;
            else
                raise;
            end if;
    end drop_if_exists;


    procedure schedule_nightly_mrp is
    begin
        drop_if_exists(c_job_nightly_mrp);

        -- 每天 02:00 跑 MRP。run_mrp 的 p_run_id 是 out，匿名块里用局部变量接住即可
        dbms_scheduler.create_job(
            job_name        => c_job_nightly_mrp,
            job_type        => 'PLSQL_BLOCK',
            job_action      => 'declare v_run_id number; begin mrp_pkg.run_mrp(p_run_id => v_run_id); end;',
            start_date      => trunc(sysdate) + 1 + 2 / 24,
            repeat_interval => 'FREQ=DAILY;BYHOUR=2',
            enabled         => true,
            auto_drop       => false,
            comments        => '每日 02:00 物料需求计划 MRP 跑批');

        exc_pkg.log_error(
            p_error_code  => 'I9001',
            p_module      => const_pkg.c_mod_sched,
            p_procedure   => 'schedule_nightly_mrp',
            p_error_msg   => '已注册作业 ' || c_job_nightly_mrp || ' FREQ=DAILY;BYHOUR=2',
            p_biz_key     => c_job_nightly_mrp,
            p_error_level => 'INFO');
    end schedule_nightly_mrp;


    procedure schedule_monthly_forecast is
    begin
        drop_if_exists(c_job_monthly_fc);

        -- 每月 1 号 01:00 刷预测，赶在当晚 MRP 之前。generate_forecast 全是带默认值的 in 参数
        dbms_scheduler.create_job(
            job_name        => c_job_monthly_fc,
            job_type        => 'PLSQL_BLOCK',
            job_action      => 'begin forecast_pkg.generate_forecast; end;',
            start_date      => trunc(sysdate, 'MM') + 1 / 24,
            repeat_interval => 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=1',
            enabled         => true,
            auto_drop       => false,
            comments        => '每月 1 号 01:00 需求预测刷新');

        exc_pkg.log_error(
            p_error_code  => 'I9002',
            p_module      => const_pkg.c_mod_sched,
            p_procedure   => 'schedule_monthly_forecast',
            p_error_msg   => '已注册作业 ' || c_job_monthly_fc || ' FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=1',
            p_biz_key     => c_job_monthly_fc,
            p_error_level => 'INFO');
    end schedule_monthly_forecast;


    procedure run_job_now(p_job_name in varchar2) is
    begin
        -- use_current_session=>false 走调度器后台跑，不卡当前会话
        dbms_scheduler.run_job(job_name => p_job_name, use_current_session => false);

        exc_pkg.log_error(
            p_error_code  => 'I9003',
            p_module      => const_pkg.c_mod_sched,
            p_procedure   => 'run_job_now',
            p_error_msg   => '手工触发作业 ' || p_job_name,
            p_biz_key     => p_job_name,
            p_error_level => 'INFO');
    exception
        when others then
            -- -27475 作业不存在时给业务错误，比裸 ORA 更可读
            if sqlcode = -27475 then
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_system, const_pkg.c_mod_sched, 'run_job_now',
                    '作业不存在 ' || p_job_name, p_job_name);
            else
                raise;
            end if;
    end run_job_now;


    procedure drop_job(p_job_name in varchar2) is
    begin
        -- force=>true: 即便作业正在运行也强制停掉再删
        dbms_scheduler.drop_job(job_name => p_job_name, force => true);

        exc_pkg.log_error(
            p_error_code  => 'I9004',
            p_module      => const_pkg.c_mod_sched,
            p_procedure   => 'drop_job',
            p_error_msg   => '删除作业 ' || p_job_name,
            p_biz_key     => p_job_name,
            p_error_level => 'INFO');
    exception
        when others then
            -- 作业本就不存在(已删/未建)按成功处理，调用方不必先判存在
            if sqlcode in (-27475, -27476) then
                null;
            else
                raise;
            end if;
    end drop_job;


    procedure list_jobs(p_cur out sys_refcursor) is
    begin
        -- 只看本应用前缀的作业，左连最近一次运行明细取上次结果
        -- 同一作业 job_run_details 会有多条历史，用 row_number 取每作业最新一条
        open p_cur for
            select j.job_name,
                   j.enabled,
                   j.state,
                   j.repeat_interval,
                   j.last_start_date,
                   j.next_run_date,
                   j.run_count,
                   j.failure_count,
                   d.status      as last_status,
                   d.error#      as last_error_code,
                   d.actual_start_date as last_run_start,
                   d.run_duration      as last_run_duration
              from user_scheduler_jobs j
              left join (
                    select log_id, job_name, status, error#,
                           actual_start_date, run_duration,
                           row_number() over (
                               partition by job_name
                               order by actual_start_date desc) as rn
                      from user_scheduler_job_run_details
                   ) d on d.job_name = j.job_name and d.rn = 1
             where j.job_name like c_job_prefix || '%'
             order by j.job_name;
    end list_jobs;

end sched_pkg;
/
