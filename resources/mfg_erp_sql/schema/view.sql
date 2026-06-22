-- 物料宽视图，给前台维护界面用: 主表 + 分类名 + 单位名 + 对象列拍平
-- INSTEAD OF 触发器 trg_v_item_full 让界面能直接对视图 insert/update，由触发器拆回 t_item
-- 拍平对象列(dim.* / tags)是因为前端表单不认对象类型，只收平铺字段

create or replace view v_item_full as
select i.item_id,
       i.item_code,
       i.item_name,
       i.item_type,
       i.category_id,
       c.category_code,
       c.category_name,
       i.base_uom,
       u.uom_name        as base_uom_name,
       i.std_cost,
       i.list_price,
       i.currency_code,
       i.valuation_method,
       i.status,
       i.abc_class,
       i.is_phantom,
       i.dim.length_cm   as length_cm,
       i.dim.width_cm    as width_cm,
       i.dim.height_cm   as height_cm,
       i.dim.weight_kg   as weight_kg,
       i.dim.volume_cm3() as volume_cm3,
       i.created_at,
       i.updated_at
  from t_item          i
  left join t_item_category c on c.category_id = i.category_id
  left join t_uom            u on u.uom_code   = i.base_uom;

comment on column v_item_full.volume_cm3 is '调用对象方法 dim.volume_cm3() 算出，视图层只读';
