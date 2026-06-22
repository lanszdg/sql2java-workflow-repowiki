create or replace package body exc_pkg as

    procedure log_error(
        p_error_code   in varchar2,
        p_module       in varchar2,
        p_procedure    in varchar2,
        p_error_msg    in varchar2,
        p_biz_key      in varchar2 default null,
        p_context      in clob     default null,
        p_error_level  in varchar2 default 'ERROR'
    ) is
        -- 自治事务: 日志独立提交，主流程 rollback 不带走日志
        pragma autonomous_transaction;
    begin
        insert into t_error_log (
            log_id, error_code, error_level,
            module_name, procedure_name,
            error_msg, error_stack,
            biz_key, context_data,
            operator, occurred_at
        ) values (
            seq_error_log_id.nextval, p_error_code, p_error_level,
            p_module, p_procedure,
            substr(p_error_msg, 1, 2000), format_error_stack(),
            p_biz_key, p_context,
            nvl(sys_context('userenv','session_user'), 'SYSTEM'), current_timestamp
        );
        commit;

        if g_debug_on then
            dbms_output.put_line('[' || p_error_level || '] ' || p_module
                || '.' || p_procedure || ' ' || p_error_code || ': ' || p_error_msg);
        end if;
    exception
        when others then
            rollback;
            dbms_output.put_line('[FATAL] exc_pkg.log_error self-failed: ' || sqlerrm);
    end log_error;


    procedure raise_biz_error(
        p_error_code  in varchar2,
        p_module      in varchar2,
        p_procedure   in varchar2,
        p_error_msg   in varchar2,
        p_biz_key     in varchar2 default null
    ) is
        v_sqlcode number;
    begin
        log_error(
            p_error_code  => p_error_code,
            p_module      => p_module,
            p_procedure   => p_procedure,
            p_error_msg   => p_error_msg,
            p_biz_key     => p_biz_key,
            p_error_level => 'ERROR'
        );

        -- 错误码到 SQLCODE 的映射，与 spec 的 pragma exception_init 严格对应
        v_sqlcode := case p_error_code
            when 'M1001' then -20101
            when 'M1002' then -20102
            when 'M1003' then -20103
            when 'M1004' then -20104
            when 'M1101' then -20111
            when 'M1102' then -20112
            when 'M2001' then -20201
            when 'M2002' then -20202
            when 'M2003' then -20203
            when 'M2004' then -20204
            when 'M3001' then -20301
            when 'M3002' then -20302
            when 'M3003' then -20303
            when 'M3004' then -20304
            when 'M3005' then -20305
            when 'M4001' then -20401
            when 'M4002' then -20402
            when 'M4003' then -20403
            when 'M4004' then -20404
            when 'M5001' then -20501
            when 'M5002' then -20502
            when 'M5003' then -20503
            when 'M6001' then -20601
            when 'M6002' then -20602
            else -20999
        end;

        raise_application_error(v_sqlcode, p_error_code || ': ' || p_error_msg);
    end raise_biz_error;


    procedure debug(p_module in varchar2, p_msg in varchar2) is
    begin
        if g_debug_on then
            dbms_output.put_line('[DEBUG] ' || to_char(systimestamp, 'HH24:MI:SS.FF3')
                || ' ' || p_module || ' ' || p_msg);
        end if;
    end debug;


    function format_error_stack return varchar2 is
    begin
        return 'SQLCODE=' || sqlcode || chr(10)
            || 'SQLERRM=' || sqlerrm || chr(10)
            || 'BACKTRACE=' || dbms_utility.format_error_backtrace || chr(10)
            || 'CALL_STACK=' || dbms_utility.format_call_stack;
    exception
        when others then
            return 'SQLCODE=' || sqlcode || ', SQLERRM=' || sqlerrm;
    end format_error_stack;

end exc_pkg;
/
