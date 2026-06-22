-- 库存流水复合触发器
-- 用复合触发器(compound)而非普通行触发器，是为了把"本次 DML 语句内所有流水行"
-- 按 物料+仓库 聚合后只写一条净变动审计，而不是每行各写一条(批量收发时行数可能上万)
-- 余额维护由 inventory_pkg 自己 merge，触发器刻意不碰 t_inventory_balance，避免双重记账
-- after each row 里累加到包级关联数组，after statement 再统一落审计——这也是规避变异表的经典写法

create or replace trigger trg_inv_txn
for insert on t_inventory_txn
compound trigger

    type t_net_map is table of number index by varchar2(64);
    g_net      t_net_map;
    g_row_cnt  number;

    before statement is
    begin
        g_net.delete;
        g_row_cnt := 0;
    end before statement;

    after each row is
        v_key varchar2(64);
        v_signed number;
    begin
        v_key    := :new.item_id || '-' || :new.warehouse_id;
        v_signed := case :new.direction when 'I' then :new.quantity else -:new.quantity end;
        g_net(v_key) := nvl(g_net(v_key), 0) + v_signed;
        g_row_cnt    := g_row_cnt + 1;
    end after each row;

    after statement is
        v_key varchar2(64);
    begin
        v_key := g_net.first;
        while v_key is not null loop
            insert into t_audit_log(
                audit_id, table_name, action_type, biz_key,
                new_value, operator, operated_at
            ) values (
                seq_audit_log_id.nextval, 't_inventory_txn', 'BATCH_NET', v_key,
                '{"net_qty":' || g_net(v_key) || ',"rows_in_stmt":' || g_row_cnt || '}',
                nvl(sys_context('userenv','session_user'), 'SYSTEM'), current_timestamp
            );
            v_key := g_net.next(v_key);
        end loop;
    end after statement;

end trg_inv_txn;
/
