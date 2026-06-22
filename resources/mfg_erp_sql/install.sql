-- 制造/供应链 ERP - 完整部署入口
-- 数据库: GaussDB (Oracle 兼容模式 / sql_compatibility = 'A')，对象类型/MODEL/DBMS_SQL/复合触发器均按 Oracle 语义
-- 用法:   gsql -d <db> -U <user> -W <pwd> -f install.sql
-- 重新部署前需 drop 全部对象；本脚本不含 drop，避免误删
--
-- 部署顺序依赖:
--   对象类型先于 schema(t_item 有 t_dimension/t_tag_varray 对象列、v_item_full 调对象方法)
--   schema 内按 FK: dict -> sysctl -> warehouse -> partner -> item(含分类) -> bom
--                  -> inventory -> orders -> production -> pricing -> forecast -> view
--   seq/index 在表之后，seed 在其后(用到序列)，且 seed 先于 trigger(否则种子触发大量审计)
--   包: const/exc/util 在前，业务包"先全部 spec 后全部 body"(跨包 body 调用只依赖对方 spec)
--   独立函数(SQL 直调)放包之后，触发器放最后(trg_v_item_full 依赖 item_pkg)


-- 对象类型
@@type/obj_money.sql
@@type/obj_dimension.sql
@@type/coll_tags.sql
@@type/obj_item.sql
@@type/obj_bom_comp.sql
@@type/obj_allocation.sql
@@type/obj_explosion.sql

-- schema: 表(按 FK 依赖)
@@schema/dict.sql
@@schema/sysctl.sql
@@schema/warehouse.sql
@@schema/partner.sql
@@schema/item.sql
@@schema/bom.sql
@@schema/inventory.sql
@@schema/orders.sql
@@schema/production.sql
@@schema/pricing.sql
@@schema/forecast.sql
@@schema/view.sql

-- 序列 / 索引 / 种子
@@schema/sequence.sql
@@schema/index.sql
@@schema/seed.sql

-- 基础包
@@pkg/const_pkg_spec.sql
@@pkg/exc_pkg_spec.sql
@@pkg/util_pkg_spec.sql

-- 业务包 spec(先全部声明，body 之间的跨包调用只依赖 spec)
@@pkg/item_pkg_spec.sql
@@pkg/bom_pkg_spec.sql
@@pkg/inventory_pkg_spec.sql
@@pkg/costing_pkg_spec.sql
@@pkg/pricing_pkg_spec.sql
@@pkg/procurement_pkg_spec.sql
@@pkg/mrp_pkg_spec.sql
@@pkg/forecast_pkg_spec.sql
@@pkg/report_pkg_spec.sql
@@pkg/sched_pkg_spec.sql

-- 包体
@@pkg/exc_pkg_body.sql
@@pkg/util_pkg_body.sql
@@pkg/item_pkg_body.sql
@@pkg/bom_pkg_body.sql
@@pkg/inventory_pkg_body.sql
@@pkg/costing_pkg_body.sql
@@pkg/pricing_pkg_body.sql
@@pkg/procurement_pkg_body.sql
@@pkg/mrp_pkg_body.sql
@@pkg/forecast_pkg_body.sql
@@pkg/report_pkg_body.sql
@@pkg/sched_pkg_body.sql

-- 独立函数(SQL 直接调用，递归卷算函数也在此)
@@func/fn_uom_convert.sql
@@func/fn_abc_class.sql
@@func/fn_landed_cost.sql
@@func/fn_bom_unit_cost.sql

-- 触发器: 放最后，避免种子装载时大量触发；trg_v_item_full 依赖 item_pkg 已就位
@@trigger/trg_inv_txn.sql
@@trigger/trg_item_audit.sql
@@trigger/trg_v_item_full.sql


prompt
prompt === Deployment check ===
select 'tables'     as item, count(*) as cnt from user_tables    where table_name like 'T_%'
union all select 'object_types', count(*) from user_types     where type_name like 'T_%'
union all select 'sequences',    count(*) from user_sequences  where sequence_name like 'SEQ_%'
union all select 'packages',     count(*) from user_objects    where object_type = 'PACKAGE'
union all select 'pkg_bodies',   count(*) from user_objects    where object_type = 'PACKAGE BODY'
union all select 'functions',    count(*) from user_objects    where object_type = 'FUNCTION' and object_name like 'FN_%'
union all select 'triggers',     count(*) from user_objects    where object_type = 'TRIGGER'
union all select 'views',        count(*) from user_views      where view_name like 'V_%'
union all select 'invalid_obj',  count(*) from user_objects    where status = 'INVALID';
