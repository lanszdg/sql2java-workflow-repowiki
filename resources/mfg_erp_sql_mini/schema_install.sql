-- Schema-only 安装: 对象类型 + 表结构 + 序列 + 索引 + 视图 + 种子数据
-- 不含 PL/SQL 包/函数/触发器

prompt === 安装对象类型 ===
@@type/obj_money.sql
@@type/obj_dimension.sql
@@type/coll_tags.sql
@@type/obj_item.sql
@@type/obj_bom_comp.sql
@@type/obj_explosion.sql
@@type/obj_allocation.sql

prompt === 安装表结构 ===
@@schema/tables.sql

prompt === 安装序列 ===
@@schema/sequence.sql

prompt === 安装索引 ===
@@schema/index.sql

prompt === 安装视图 ===
@@schema/view.sql

prompt === 装载种子数据 ===
@@schema/seed.sql

prompt === Schema 安装完成 ===
