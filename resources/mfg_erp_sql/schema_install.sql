-- 仅 schema 的轻量入口(对象类型 + 表 + 序列 + 索引 + 视图 + 种子)
-- 用于只需要表结构与样例数据、不装 PL/SQL 包的场景(如先跑 sql2java 的表->DO 映射)

@@type/obj_money.sql
@@type/obj_dimension.sql
@@type/coll_tags.sql
@@type/obj_item.sql
@@type/obj_bom_comp.sql
@@type/obj_allocation.sql
@@type/obj_explosion.sql

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
@@schema/sequence.sql
@@schema/index.sql
@@schema/seed.sql
