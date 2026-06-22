-- 完整安装脚本
-- 安装顺序: 对象类型 -> 表结构 -> 序列/索引/视图/种子 -> 包规格 -> 包体 -> 函数 -> 触发器
-- 规格先于包体(跨包 body 调用只依赖对方 spec)
-- 触发器最后(依赖包且避免种子装载时触发空跑)

prompt ================================
prompt = Mini MFG ERP 安装开始
prompt ================================

-- 1. 对象类型(表列引用对象类型，必须先建)
prompt === [1/7] 安装对象类型 ===
@@type/obj_money.sql
@@type/obj_dimension.sql
@@type/coll_tags.sql
@@type/obj_item.sql
@@type/obj_bom_comp.sql
@@type/obj_explosion.sql
@@type/obj_allocation.sql

-- 2. 表结构
prompt === [2/7] 安装表结构 ===
@@schema/tables.sql

-- 3. 序列 + 索引 + 视图
prompt === [3/7] 安装序列/索引/视图 ===
@@schema/sequence.sql
@@schema/index.sql
@@schema/view.sql

-- 4. 种子数据(触发器尚未创建，不会空跑)
prompt === [4/7] 装载种子数据 ===
@@schema/seed.sql

-- 5. 包规格(全部 spec 先于 body)
prompt === [5/7] 安装包规格 ===
@@pkg/const_pkg_spec.sql
@@pkg/exc_pkg_spec.sql
@@pkg/util_pkg_spec.sql
@@pkg/item_pkg_spec.sql
@@pkg/bom_pkg_spec.sql
@@pkg/inventory_pkg_spec.sql

-- 6. 包体 + 独立函数
prompt === [6/7] 安装包体和函数 ===
@@pkg/exc_pkg_body.sql
@@pkg/util_pkg_body.sql
@@pkg/item_pkg_body.sql
@@pkg/bom_pkg_body.sql
@@pkg/inventory_pkg_body.sql
@@func/fn_uom_convert.sql
@@func/fn_abc_class.sql

-- 7. 触发器(最后，依赖包)
prompt === [7/7] 安装触发器 ===
@@trigger/trg_item_audit.sql
@@trigger/trg_inv_txn.sql
@@trigger/trg_v_item_full.sql

prompt ================================
prompt = 安装完成，验证对象数量:
prompt ================================

select object_type, count(*) as cnt
  from user_objects
 where object_name not like 'SYS%'
   and object_type in ('TYPE','TABLE','SEQUENCE','VIEW','PACKAGE','FUNCTION','TRIGGER')
 group by object_type
 order by object_type;

prompt === Mini MFG ERP 安装完毕 ===
