-- 种子数据
-- 主数据用显式 id(低区间)便于串 FK 与肉眼追踪，序列起始值都在种子区间之上不冲突
-- 物料结构刻意搭成 3 层 BOM(成品->半成品->原材料)，含共用件(电容/螺丝跨多个组件)
-- 与虚拟件(SEMI-2001 外壳组件 is_phantom=Y)，专门给 bom_pkg 展开/反查/版本比对喂料
-- 预测历史用 connect by 批量生成 17 个月，供 forecast_pkg 的 MODEL 滚动预测
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
insert into t_code_dict(dict_type, code, code_name, sort_no) values ('PO_STATUS','DRAFT','草稿',1);
insert into t_code_dict(dict_type, code, code_name, sort_no) values ('PO_STATUS','APPROVED','已审',2);
insert into t_code_dict(dict_type, code, code_name, sort_no) values ('PO_STATUS','RECEIVED','已收',3);

-- 计量单位
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('EA', '个',  'EA',  0, 'Y');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('PCS','件',  'EA',  0, 'N');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('BOX','盒',  'EA',  0, 'N');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('SET','套',  'EA',  0, 'N');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('KG', '千克','WT',  3, 'Y');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('G',  '克',  'WT',  3, 'N');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('M',  '米',  'LEN', 2, 'Y');
insert into t_uom(uom_code, uom_name, uom_category, decimal_digits, is_base) values ('CM', '厘米','LEN', 2, 'N');

-- 单位换算(到本类基本单位)
insert into t_uom_conversion(from_uom, to_uom, factor) values ('KG','G',  1000);
insert into t_uom_conversion(from_uom, to_uom, factor) values ('G', 'KG', 0.001);
insert into t_uom_conversion(from_uom, to_uom, factor) values ('BOX','EA',12);
insert into t_uom_conversion(from_uom, to_uom, factor) values ('PCS','EA',1);
insert into t_uom_conversion(from_uom, to_uom, factor) values ('SET','EA',1);
insert into t_uom_conversion(from_uom, to_uom, factor) values ('M', 'CM', 100);
insert into t_uom_conversion(from_uom, to_uom, factor) values ('CM','M',  0.01);

-- 分类树
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (1, null, 'CAT-ROOT', '设备制造', 1, '/CAT-ROOT', 'N');
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (2, 1, 'CAT-FG',   '成品',   2, '/CAT-ROOT/CAT-FG',   'Y');
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (3, 1, 'CAT-SEMI', '半成品', 2, '/CAT-ROOT/CAT-SEMI', 'Y');
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (4, 1, 'CAT-RAW',  '原材料', 2, '/CAT-ROOT/CAT-RAW',  'N');
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (5, 4, 'CAT-ELEC', '电子元件', 3, '/CAT-ROOT/CAT-RAW/CAT-ELEC',   'Y');
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (6, 4, 'CAT-STRUCT','结构件',  3, '/CAT-ROOT/CAT-RAW/CAT-STRUCT', 'Y');
insert into t_item_category(category_id, parent_category_id, category_code, category_name, level_no, path, is_leaf) values (7, 1, 'CAT-SVC',  '服务',   2, '/CAT-ROOT/CAT-SVC',  'Y');

-- 仓库
insert into t_warehouse(warehouse_id, warehouse_code, warehouse_name, warehouse_type, region) values (1, 'WH-RAW', '原料库', 'RAW', '华东');
insert into t_warehouse(warehouse_id, warehouse_code, warehouse_name, warehouse_type, region) values (2, 'WH-FG',  '成品库', 'FG',  '华东');
insert into t_warehouse(warehouse_id, warehouse_code, warehouse_name, warehouse_type, region) values (3, 'WH-WIP', '在制库', 'WIP', '华东');
insert into t_location(location_id, warehouse_id, parent_location_id, location_code, zone) values (1001, 1, null, 'A',    'A区');
insert into t_location(location_id, warehouse_id, parent_location_id, location_code, zone) values (1002, 1, 1001, 'A-01', 'A区');
insert into t_location(location_id, warehouse_id, parent_location_id, location_code, zone) values (1003, 1, 1001, 'A-02', 'A区');

-- 供应商
insert into t_supplier(supplier_id, supplier_code, supplier_name, lead_time_days, rating, currency_code) values (1, 'SUP-EAST', '华东电子', 14, 5, 'CNY');
insert into t_supplier(supplier_id, supplier_code, supplier_name, lead_time_days, rating, currency_code) values (2, 'SUP-PLAST','南方塑胶', 10, 4, 'CNY');
insert into t_supplier(supplier_id, supplier_code, supplier_name, lead_time_days, rating, currency_code) values (3, 'SUP-METAL','精密五金', 7,  3, 'CNY');

-- 客户
insert into t_customer(customer_id, customer_code, customer_name, price_list_id, credit_limit, region) values (1, 'CUST-A', '甲电器集团', 2, 5000000, '华北');
insert into t_customer(customer_id, customer_code, customer_name, price_list_id, credit_limit, region) values (2, 'CUST-B', '乙物联科技', null, 2000000, '华南');

-- 物料: 原材料
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, preferred_supplier, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (121, 'RAW-3000', 'PCB板 4层', 'RAW', 5, 'EA', 12.500000, 0, 'FIFO', 1, 14, 200, 300, 1000, 'Y', t_dimension(10, 8, 0.16, 0.025), t_tag_varray('电子','板材','4层'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, preferred_supplier, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (122, 'RAW-3001', 'MCU芯片 STM32', 'RAW', 5, 'EA', 18.000000, 0, 'FIFO', 1, 21, 300, 500, 2000, 'Y', t_dimension(1, 1, 0.15, 0.001), t_tag_varray('电子','芯片','贴片'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, preferred_supplier, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (123, 'RAW-3002', '电容 0.1uF', 'RAW', 5, 'EA', 0.050000, 0, 'AVG', 1, 7, 10000, 20000, 50000, 'N', t_dimension(0.2, 0.1, 0.1, 0.0001), t_tag_varray('电子','贴片','通用'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, preferred_supplier, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (124, 'RAW-3003', '电阻 10k', 'RAW', 5, 'EA', 0.020000, 0, 'AVG', 1, 7, 20000, 40000, 100000, 'N', t_dimension(0.2, 0.1, 0.1, 0.0001), t_tag_varray('电子','贴片','通用'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, preferred_supplier, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (125, 'RAW-3010', '螺丝 M3x8', 'RAW', 6, 'EA', 0.080000, 0, 'FIFO', 3, 7, 5000, 10000, 50000, 'N', t_dimension(0.3, 0.3, 0.8, 0.0005), t_tag_varray('五金','紧固件'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, preferred_supplier, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (126, 'RAW-3020', '天线 2.4G', 'RAW', 5, 'EA', 1.200000, 0, 'FIFO', 1, 14, 500, 800, 3000, 'Y', t_dimension(3, 0.5, 0.2, 0.002), t_tag_varray('电子','射频'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, preferred_supplier, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (127, 'RAW-3030', 'ABS塑料粒', 'RAW', 6, 'KG', 8.000000, 0, 'AVG', 2, 10, 100, 200, 1000, 'Y', t_dimension(0, 0, 0, 1), t_tag_varray('塑胶','原料'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, preferred_supplier, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (128, 'RAW-3040', '变压器 EE16', 'RAW', 5, 'EA', 3.500000, 0, 'FIFO', 1, 14, 300, 500, 2000, 'Y', t_dimension(2, 2, 1.6, 0.02), t_tag_varray('电子','磁性'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, preferred_supplier, lead_time_days, safety_stock, reorder_point, reorder_qty, is_lot_controlled, dim, tags) values (129, 'RAW-3050', '整流桥 DB107', 'RAW', 5, 'EA', 0.600000, 0, 'FIFO', 1, 14, 800, 1500, 5000, 'N', t_dimension(0.7, 0.5, 0.3, 0.0008), t_tag_varray('电子','贴片'));

-- 物料: 半成品(SEMI-2001 外壳组件为虚拟件)
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, safety_stock, reorder_point, is_phantom, is_lot_controlled, dim, tags) values (111, 'SEMI-2000', '主控板组件', 'SEMI', 3, 'EA', 0, 0, 'STD', 2, 50, 100, 'N', 'Y', t_dimension(10, 8, 1.2, 0.04), t_tag_varray('组件','PCBA'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, is_phantom, is_lot_controlled, dim, tags) values (112, 'SEMI-2001', '外壳组件', 'SEMI', 3, 'EA', 0, 0, 'STD', 1, 'Y', 'N', t_dimension(12, 9, 4, 0.08), t_tag_varray('组件','结构','虚拟件'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, safety_stock, reorder_point, is_phantom, is_lot_controlled, dim, tags) values (113, 'SEMI-2002', '电源模块', 'SEMI', 3, 'EA', 0, 0, 'STD', 2, 30, 60, 'N', 'Y', t_dimension(4, 3, 1.6, 0.03), t_tag_varray('组件','电源'));

-- 物料: 成品
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, safety_stock, reorder_point, is_lot_controlled, dim, tags) values (101, 'FG-1000', '智能温控器', 'FG', 2, 'EA', 0, 199.0000, 'STD', 3, 20, 40, 'Y', t_dimension(12, 9, 4, 0.18), t_tag_varray('成品','智能家居','畅销'));
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, lead_time_days, safety_stock, reorder_point, is_lot_controlled, dim, tags) values (102, 'FG-1001', '无线网关', 'FG', 2, 'EA', 0, 299.0000, 'STD', 4, 15, 30, 'Y', t_dimension(14, 10, 3, 0.22), t_tag_varray('成品','物联网'));

-- 物料: 服务(不可库存)
insert into t_item(item_id, item_code, item_name, item_type, category_id, base_uom, std_cost, list_price, valuation_method, is_lot_controlled, status) values (141, 'SVC-9000', '组装服务', 'SVC', 7, 'EA', 5.000000, 0, 'NONE', 'N', 'ACTIVE');

-- BOM 头
insert into t_bom_header(bom_id, item_id, bom_version, base_qty, base_uom, status, is_default, effective_from) values (1, 101, 'V1', 1, 'EA', 'ACTIVE', 'Y', date '2025-01-01');
insert into t_bom_header(bom_id, item_id, bom_version, base_qty, base_uom, status, is_default, effective_from) values (2, 102, 'V1', 1, 'EA', 'ACTIVE', 'Y', date '2025-01-01');
insert into t_bom_header(bom_id, item_id, bom_version, base_qty, base_uom, status, is_default, effective_from) values (3, 111, 'V1', 1, 'EA', 'ACTIVE', 'Y', date '2025-01-01');
insert into t_bom_header(bom_id, item_id, bom_version, base_qty, base_uom, status, is_default, effective_from) values (4, 112, 'V1', 1, 'EA', 'ACTIVE', 'Y', date '2025-01-01');
insert into t_bom_header(bom_id, item_id, bom_version, base_qty, base_uom, status, is_default, effective_from) values (5, 113, 'V1', 1, 'EA', 'ACTIVE', 'Y', date '2025-01-01');
-- FG-1000 的 V2 草稿(螺丝由 8 改 6)，供版本比对 multiset 演示
insert into t_bom_header(bom_id, item_id, bom_version, base_qty, base_uom, status, is_default, effective_from) values (6, 101, 'V2', 1, 'EA', 'DRAFT', 'N', date '2026-06-01');

-- BOM 行(line_id 走序列)
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 1, 10, 111, 1, 'EA', 0);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate, is_phantom) values (seq_bom_line_id.nextval, 1, 20, 112, 1, 'EA', 0, 'Y');
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 1, 30, 125, 8, 'EA', 0.01);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 1, 40, 141, 1, 'EA', 0);

insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 2, 10, 111, 1, 'EA', 0);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 2, 20, 126, 2, 'EA', 0.02);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 2, 30, 113, 1, 'EA', 0);

insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 3, 10, 121, 1, 'EA', 0.005);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 3, 20, 122, 1, 'EA', 0.005);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 3, 30, 123, 10, 'EA', 0.03);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 3, 40, 124, 20, 'EA', 0.03);

insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 4, 10, 127, 0.05, 'KG', 0.05);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 4, 20, 125, 4, 'EA', 0.01);

insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 5, 10, 128, 1, 'EA', 0);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 5, 20, 123, 5, 'EA', 0.03);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 5, 30, 129, 1, 'EA', 0.01);

insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 6, 10, 111, 1, 'EA', 0);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate, is_phantom) values (seq_bom_line_id.nextval, 6, 20, 112, 1, 'EA', 0, 'Y');
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 6, 30, 125, 6, 'EA', 0.01);
insert into t_bom_line(line_id, bom_id, line_no, component_item_id, qty_per, uom, scrap_rate) values (seq_bom_line_id.nextval, 6, 40, 141, 1, 'EA', 0);

-- 价目表 + 规则
insert into t_price_list(price_list_id, list_code, list_name, currency_code, is_default, valid_from) values (1, 'PL-STD', '标准价目表', 'CNY', 'Y', date '2025-01-01');
insert into t_price_list(price_list_id, list_code, list_name, currency_code, is_default, valid_from) values (2, 'PL-VIP', 'VIP客户价目表', 'CNY', 'N', date '2025-01-01');

insert into t_price_rule(rule_id, price_list_id, item_id, min_qty, rule_type, price_value, priority) values (seq_price_rule_id.nextval, 1, 101, 0,   'LIST', 199.00, 10);
insert into t_price_rule(rule_id, price_list_id, item_id, min_qty, rule_type, price_value, priority) values (seq_price_rule_id.nextval, 1, 101, 100, 'DISCOUNT_PCT', 0.05, 5);
insert into t_price_rule(rule_id, price_list_id, item_id, min_qty, rule_type, price_value, priority) values (seq_price_rule_id.nextval, 1, 101, 500, 'DISCOUNT_PCT', 0.10, 4);
insert into t_price_rule(rule_id, price_list_id, item_id, min_qty, rule_type, price_value, priority) values (seq_price_rule_id.nextval, 1, 102, 0,   'LIST', 299.00, 10);
insert into t_price_rule(rule_id, price_list_id, category_id, min_qty, rule_type, price_value, priority) values (seq_price_rule_id.nextval, 1, 2, 0, 'DISCOUNT_PCT', 0.02, 50);
insert into t_price_rule(rule_id, price_list_id, item_id, customer_id, min_qty, rule_type, price_value, priority) values (seq_price_rule_id.nextval, 2, 101, 1, 0, 'OVERRIDE', 175.00, 1);

-- 系统控制
insert into t_business_date(sys_code, curr_biz_date, last_biz_date, next_biz_date, period_status) values ('CORE', date '2026-05-27', date '2026-05-26', date '2026-05-28', 'OPEN');
insert into t_app_param(param_key, param_value, param_type, description) values ('MRP_HORIZON_DAYS', '90', 'NUMBER', 'MRP 计划展望天数');
insert into t_app_param(param_key, param_value, param_type, description) values ('MRP_BUCKET', 'WEEK', 'STRING', 'MRP 时段桶粒度');
insert into t_app_param(param_key, param_value, param_type, description) values ('DEFAULT_SCRAP', '0.02', 'NUMBER', '默认损耗率');
insert into t_app_param(param_key, param_value, param_type, description) values ('FORECAST_METHOD', 'MA3', 'STRING', '默认预测方法');
insert into t_app_param(param_key, param_value, param_type, description) values ('ABC_A_PCT', '0.80', 'NUMBER', 'A 类累计占比阈值');
insert into t_app_param(param_key, param_value, param_type, description) values ('ABC_B_PCT', '0.95', 'NUMBER', 'B 类累计占比阈值');

-- 期初库存批次(原料库 1)，不同入库日期供 FIFO 排队
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (1, 'LOT-PCB-01', 121, 1, 500,   12.500000, date '2026-03-01');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (2, 'LOT-PCB-02', 121, 1, 300,   13.000000, date '2026-04-15');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (3, 'LOT-MCU-01', 122, 1, 1000,  18.000000, date '2026-03-10');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (4, 'LOT-CAP-01', 123, 1, 50000, 0.050000,  date '2026-02-20');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (5, 'LOT-RES-01', 124, 1, 80000, 0.020000,  date '2026-02-20');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (6, 'LOT-SCR-01', 125, 1, 20000, 0.080000,  date '2026-01-15');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (7, 'LOT-ANT-01', 126, 1, 2000,  1.200000,  date '2026-03-20');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (8, 'LOT-ABS-01', 127, 1, 500,   8.000000,  date '2026-04-01');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (9, 'LOT-TRF-01', 128, 1, 800,   3.500000,  date '2026-03-25');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (10, 'LOT-DB-01', 129, 1, 1500,  0.600000,  date '2026-03-25');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (11, 'LOT-FG1000-01', 101, 2, 50, 80.000000, date '2026-05-01');
insert into t_inventory_lot(lot_id, lot_no, item_id, warehouse_id, qty_on_hand, unit_cost, receipt_date) values (12, 'LOT-FG1001-01', 102, 2, 30, 95.000000, date '2026-05-10');

-- 期初余额汇总(与批次合计一致；电容/电阻为加权平均料，avg_cost 取入库单价)
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (121, 1, 800,   12.687500, date '2026-04-15');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (122, 1, 1000,  18.000000, date '2026-03-10');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (123, 1, 50000, 0.050000,  date '2026-02-20');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (124, 1, 80000, 0.020000,  date '2026-02-20');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (125, 1, 20000, 0.080000,  date '2026-01-15');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (126, 1, 2000,  1.200000,  date '2026-03-20');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (127, 1, 500,   8.000000,  date '2026-04-01');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (128, 1, 800,   3.500000,  date '2026-03-25');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (129, 1, 1500,  0.600000,  date '2026-03-25');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (101, 2, 50,    80.000000, date '2026-05-01');
insert into t_inventory_balance(item_id, warehouse_id, qty_on_hand, avg_cost, last_txn_date) values (102, 2, 30,    95.000000, date '2026-05-10');

-- 需求预测历史: 成品 101/102，2025-01 ~ 2026-05 共 17 个月
-- forecast_qty 用确定性公式造出季节波动，actual_qty 在其上叠固定偏差，供准确率与 MODEL 外推
insert into t_demand_forecast(forecast_id, item_id, warehouse_id, period_date, forecast_qty, actual_qty, method)
select seq_forecast_id.nextval,
       it.item_id,
       2,
       add_months(date '2025-01-01', lv.n),
       round(it.base_qty + 30 * sin(lv.n / 1.9) + 4 * lv.n),
       round(it.base_qty + 30 * sin(lv.n / 1.9) + 4 * lv.n + mod(lv.n * 7, 11) - 5),
       'MA3'
  from (select level - 1 as n from dual connect by level <= 17) lv
 cross join (select 101 as item_id, 120 as base_qty from dual
             union all
             select 102, 80 from dual) it;

commit;
