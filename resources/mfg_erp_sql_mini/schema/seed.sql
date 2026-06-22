-- 种子数据（精简版）
-- 3 层 BOM: 成品 -> 半成品(含虚拟件) -> 原材料
-- 本脚本在 trigger 创建之前装载，避免触发器对种子大批量空跑

-- 码表
insert into t_code_dict(dict_type, code, code_name, sort_no, attr1) values ('ITEM_TYPE','RAW', '原材料',  1, 'FIFO');
insert into t_code_dict(dict_type, code, code_name, sort_no, attr1) values ('ITEM_TYPE','SEMI','半成品',  2, 'STD');
insert into t_code_dict(dict_type, code, code_name, sort_no, attr1) values ('ITEM_TYPE','FG',  '成品',    3, 'STD');
insert into t_code_dict(dict_type, code, code_name, sort_no, attr1) values ('ITEM_TYPE','SVC', '服务',    4, 'NONE');
insert into t_code_dict(dict_type, code, code_name, sort_no) values ('INV_TXN','RECV','收货',1);
insert into t_code_dict(dict_type, code, code_name, sort_no) values ('INV_TXN','ISSUE','发料',2);
insert into t_code_dict(dict_type, code, code_name, sort_no) values ('INV_TXN','ADJ','库存调整',3);
insert into t_code_dict(dict_type, code, code_name, sort_no) values ('INV_TXN','XFER_OUT','调拨出',4);
insert into t_code_dict(dict_type, code, code_name, sort_no) values ('INV_TXN','XFER_IN','调拨入',5);
insert into t_code_dict(dict_type, code, code_name, sort_no) values ('INV_TXN','PROD_IN','完工入库',6);
insert into t_code_dict(dict_type, code, code_name, sort_no) values ('INV_TXN','PROD_OUT','生产领料',7);

-- 计量单位
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('EA', '个',  'EA',  0, 'Y');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('PCS','件',  'EA',  0, 'N');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('KG', '千克','WT',  3, 'Y');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('G',  '克',  'WT',  3, 'N');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('M',  '米',  'LEN', 2, 'Y');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('CM', '厘米','LEN', 2, 'N');

-- 单位换算
insert into t_uom_conversion(from_uom, to_uom, factor) values ('KG','G',  1000);
insert into t_uom_conversion(from_uom, to_uom, factor) values ('G', 'KG', 0.001);
insert into t_uom_conversion(from_uom, to_uom, factor) values ('M', 'CM', 100);
insert into t_uom_conversion(from_uom, to_uom, factor) values ('CM','M',  0.01);

-- 分类树
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (1, null, 'CAT-ROOT', '设备制造', 1, '/CAT-ROOT', 'N');
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (2, 1, 'CAT-FG',   '成品',   2, '/CAT-ROOT/CAT-FG',   'Y');
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (3, 1, 'CAT-SEMI', '半成品', 2, '/CAT-ROOT/CAT-SEMI', 'Y');
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (4, 1, 'CAT-RAW',  '原材料', 2, '/CAT-ROOT/CAT-RAW',  'N');
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (5, 4, 'CAT-ELEC', '电子元件', 3, '/CAT-ROOT/CAT-RAW/CAT-ELEC',   'Y');
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (6, 4, 'CAT-STRUCT','结构件',  3, '/CAT-ROOT/CAT-RAW/CAT-STRUCT', 'Y');

-- 仓库
insert into t_warehouse(warehouse_id, warehouse_code, warehouse_name, warehouse_type, region) values (1, 'WH-RAW', '原料库', 'RAW', '华东');
insert into t_warehouse(warehouse_id, warehouse_code, warehouse_name, warehouse_type, region) values (2, 'WH-FG',  '成品库', 'FG',  '华东');

-- 物料: 原材料 (3 个)
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (121, 'RAW-3000', 'PCB板 4层', 'RAW', 5, 'EA', 12.500000, 0, 'FIFO', 14, 200, 300, 1000, 'Y', t_dimension(10, 8, 0.16, 0.025), t_tag_varray('电子','板材'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (122, 'RAW-3001', 'MCU芯片 STM32', 'RAW', 5, 'EA', 18.000000, 0, 'FIFO', 21, 300, 500, 2000, 'Y', t_dimension(1, 1, 0.15, 0.001), t_tag_varray('电子','芯片'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (123, 'RAW-3002', '电容 0.1uF', 'RAW', 5, 'EA', 0.050000, 0, 'AVG', 7, 10000, 20000, 50000, 'N', t_dimension(0.2, 0.1, 0.1, 0.0001), t_tag_varray('电子','通用'));

-- 物料: 半成品 (2 个, SEMI-2001 为虚拟件)
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, safety_stock, reorder_point, is_phantom, is_lot_controlled, dim, tags) values (111, 'SEMI-2000', '主控板组件', 'SEMI', 3, 'EA', 0, 0, 'STD', 2, 50, 100, 'N', 'Y', t_dimension(10, 8, 1.2, 0.04), t_tag_varray('组件','PCBA'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, is_phantom, is_lot_controlled, dim, tags) values (112, 'SEMI-2001', '外壳组件', 'SEMI', 3, 'EA', 0, 0, 'STD', 1, 'Y', 'N', t_dimension(12, 9, 4, 0.08), t_tag_varray('组件','虚拟件'));

-- 物料: 成品 (2 个)
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, safety_stock, reorder_point, is_lot_controlled, dim, tags) values (101, 'FG-1000', '智能温控器', 'FG', 2, 'EA', 0, 199.0000, 'STD', 3, 20, 40, 'Y', t_dimension(12, 9, 4, 0.18), t_tag_varray('成品','智能家居'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, safety_stock, reorder_point, is_lot_controlled, dim, tags) values (102, 'FG-1001', '无线网关', 'FG', 2, 'EA', 0, 299.0000, 'STD', 4, 15, 30, 'Y', t_dimension(14, 10, 3, 0.22), t_tag_varray('成品','物联网'));

-- BOM 头 (3 个: FG-1000 V1 + V2, FG-1001 V1)
insert into t_bom_header(bom_id, item_id, bom_version, base_qty, base_uom, status, is_default, effective_from) values (1, 101, 'V1', 1, 'EA', 'ACTIVE', 'Y', date '2025-01-01');
insert into t_bom_header(bom_id, item_id, bom_version, base_qty, base_uom, status, is_default, effective_from) values (2, 102, 'V1', 1, 'EA', 'ACTIVE', 'Y', date '2025-01-01');
insert into t_bom_header(bom_id, item_id, bom_version, base_qty, base_uom, status, is_default, effective_from) values (3, 111, 'V1', 1, 'EA', 'ACTIVE', 'Y', date '2025-01-01');
-- FG-1000 V2 草稿(螺丝由 8 改 6)，供版本比对 multiset 演示
insert into t_bom_header(bom_id, item_id, bom_version, base_qty, base_uom, status, is_default, effective_from) values (4, 101, 'V2', 1, 'EA', 'DRAFT', 'N', date '2026-06-01');

-- BOM 行
-- FG-1000 V1: 主控板 + 外壳(虚拟) + 螺丝
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 1, 10, 111, 1, 'EA', 0);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate, is_phantom) values (seq_bom_line_id.nextval, 1, 20, 112, 1, 'EA', 0, 'Y');
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 1, 30, 123, 10, 'EA', 0.03);

-- FG-1001 V1: 主控板 + 电容
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 2, 10, 111, 1, 'EA', 0);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 2, 20, 123, 5, 'EA', 0.03);

-- SEMI-2000 主控板: PCB + MCU
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 3, 10, 121, 1, 'EA', 0.005);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 3, 20, 122, 1, 'EA', 0.005);

-- FG-1000 V2 草稿: 与 V1 相同结构但螺丝改为 6 个
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 4, 10, 111, 1, 'EA', 0);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate, is_phantom) values (seq_bom_line_id.nextval, 4, 20, 112, 1, 'EA', 0, 'Y');
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 4, 30, 123, 6, 'EA', 0.03);

-- 系统控制
insert into t_business_date(sys_code, curr_biz_date, last_biz_date, next_biz_date, period_status) values ('CORE', date '2026-05-27', date '2026-05-26', date '2026-05-28', 'OPEN');
insert into t_app_param(param_key, param_value, param_type, description) values ('DEFAULT_SCRAP', '0.02', 'NUMBER', '默认损耗率');
insert into t_app_param(param_key, param_value, param_type, description) values ('ABC_A_PCT', '0.80', 'NUMBER', 'A 类累计占比阈值');
insert into t_app_param(param_key, param_value, param_type, description) values ('ABC_B_PCT', '0.95', 'NUMBER', 'B 类累计占比阈值');

-- 期初库存批次(原料库)，不同入库日期供 FIFO 排队
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (1, 'LOT-PCB-01', 121, 1, 500,   12.500000, date '2026-03-01');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (2, 'LOT-PCB-02', 121, 1, 300,   13.000000, date '2026-04-15');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (3, 'LOT-MCU-01', 122, 1, 1000,  18.000000, date '2026-03-10');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (4, 'LOT-CAP-01', 123, 1, 50000, 0.050000,  date '2026-02-20');

-- 期初余额汇总
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (121, 1, 800,   12.687500, date '2026-04-15');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (122, 1, 1000,  18.000000, date '2026-03-10');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (123, 1, 50000, 0.050000,  date '2026-02-20');

commit;
