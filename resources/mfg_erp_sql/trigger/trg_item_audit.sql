-- 物料关键字段变更审计
-- 只在 状态/标准成本/售价 实际变化时记录，改个名字、改尺寸不进审计，减噪音
-- when 子句在行级过滤掉"值没变"的伪更新(update 全列时这三列可能被原值覆盖)

create or replace trigger trg_item_audit
after update of status, std_cost, list_price on t_item
for each row
when (old.status   <> new.status
   or old.std_cost <> new.std_cost
   or old.list_price <> new.list_price)
begin
    insert into t_audit_log(
        audit_id, table_name, action_type, biz_key,
        old_value, new_value, operator, operated_at
    ) values (
        seq_audit_log_id.nextval,
        't_item',
        'UPDATE',
        :new.item_code,
        '{"status":"' || :old.status || '","std_cost":' || :old.std_cost
            || ',"list_price":' || :old.list_price || '}',
        '{"status":"' || :new.status || '","std_cost":' || :new.std_cost
            || ',"list_price":' || :new.list_price || '}',
        nvl(sys_context('userenv','session_user'), 'SYSTEM'),
        current_timestamp
    );
end;
/
