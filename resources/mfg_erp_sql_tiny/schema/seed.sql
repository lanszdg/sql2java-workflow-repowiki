INSERT INTO t_item(item_id,item_code,item_name,item_type,base_uom,std_cost,dim,tags)
VALUES(101,'FG-1000','温控器','FG','EA',80,t_dimension(12,9,4,0.18),t_tag_varray('成品'));
INSERT INTO t_item(item_id,item_code,item_name,item_type,base_uom,std_cost,dim,tags)
VALUES(121,'RAW-3000','PCB板','RAW','EA',12.5,t_dimension(10,8,0.16,0.025),t_tag_varray('电子'));
INSERT INTO t_item(item_id,item_code,item_name,item_type,base_uom,std_cost,dim,tags)
VALUES(122,'RAW-3001','MCU芯片','RAW','EA',18,t_dimension(1,1,0.15,0.001),t_tag_varray('芯片'));

INSERT INTO t_bom_header(bom_id,item_id,bom_version,status) VALUES(1,101,'V1','ACTIVE');
INSERT INTO t_bom_line(line_id,bom_id,component_item_id,qty_per,scrap_rate)
VALUES(seq_bom_line_id.NEXTVAL,1,121,1,0.005);
INSERT INTO t_bom_line(line_id,bom_id,component_item_id,qty_per,scrap_rate)
VALUES(seq_bom_line_id.NEXTVAL,1,122,1,0.005);

INSERT INTO t_inventory_lot(lot_id,item_id,qty_on_hand,unit_cost,receipt_date)
VALUES(1,121,500,12.5,DATE '2026-03-01');
INSERT INTO t_inventory_lot(lot_id,item_id,qty_on_hand,unit_cost,receipt_date)
VALUES(2,121,300,13.0,DATE '2026-04-15');

COMMIT;
