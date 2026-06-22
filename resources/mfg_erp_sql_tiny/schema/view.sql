CREATE OR REPLACE VIEW v_item_full AS
SELECT i.item_id, i.item_code, i.item_name, i.item_type, i.base_uom,
       i.std_cost, i.list_price, i.status,
       i.dim.length_cm  AS length_cm,
       i.dim.width_cm   AS width_cm,
       i.dim.height_cm  AS height_cm,
       i.dim.weight_kg  AS weight_kg,
       i.dim.volume_cm3() AS volume_cm3
  FROM t_item i;
