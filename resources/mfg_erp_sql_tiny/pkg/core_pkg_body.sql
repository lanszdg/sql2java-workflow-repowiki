CREATE OR REPLACE PACKAGE BODY core_pkg AS

  -- PRAGMA AUTONOMOUS_TRANSACTION: 日志独立提交
  PROCEDURE log_error(p_code IN VARCHAR2, p_msg IN VARCHAR2) IS
    PRAGMA AUTONOMOUS_TRANSACTION;
  BEGIN
    INSERT INTO t_error_log(log_id, error_code, error_msg, operator, occurred_at)
    VALUES(seq_error_log_id.NEXTVAL, p_code, p_msg, USER, CURRENT_TIMESTAMP);
    COMMIT;
  END;

  -- %ROWTYPE 返回 + 异常处理
  FUNCTION get_item(p_id IN NUMBER) RETURN t_item%ROWTYPE IS
    v t_item%ROWTYPE;
  BEGIN
    SELECT * INTO v FROM t_item WHERE item_id = p_id;
    RETURN v;
  EXCEPTION WHEN NO_DATA_FOUND THEN
    RAISE_APPLICATION_ERROR(-20101, 'Item not found: '||p_id);
  END;

  -- 多态构造: CASE 分派子型
  FUNCTION get_item_obj(p_id IN NUMBER) RETURN t_item_obj IS
    v t_item%ROWTYPE;
  BEGIN
    v := get_item(p_id);
    CASE v.item_type
      WHEN 'RAW' THEN
        RETURN t_raw_material_obj(v.item_id,v.item_code,v.item_name,v.base_uom,v.std_cost,NULL);
      ELSE RETURN NULL;
    END CASE;
  END;

  -- 重载版1 (无成本)
  PROCEDURE create_item(p_code IN VARCHAR2, p_name IN VARCHAR2, p_type IN VARCHAR2, p_id OUT NUMBER) IS
  BEGIN
    p_id := seq_item_id.NEXTVAL;
    INSERT INTO t_item(item_id,item_code,item_name,item_type,base_uom)
    VALUES(p_id, p_code, p_name, p_type, 'EA');
  END;

  -- 重载版2 (带成本 + RETURNING INTO)
  PROCEDURE create_item(p_code IN VARCHAR2, p_name IN VARCHAR2, p_type IN VARCHAR2, p_cost IN NUMBER, p_id OUT NUMBER) IS
  BEGIN
    INSERT INTO t_item(item_id,item_code,item_name,item_type,base_uom,std_cost)
    VALUES(seq_item_id.NEXTVAL, p_code, p_name, p_type, 'EA', NVL(p_cost,0))
    RETURNING item_id INTO p_id;
  END;

  -- BULK COLLECT INTO 对象集合
  FUNCTION get_bom_components(p_bom_id IN NUMBER) RETURN t_bom_comp_tab IS
    v t_bom_comp_tab;
  BEGIN
    SELECT t_bom_comp_obj(l.component_item_id, i.item_code, l.qty_per)
      BULK COLLECT INTO v
      FROM t_bom_line l JOIN t_item i ON i.item_id = l.component_item_id
     WHERE l.bom_id = p_bom_id;
    RETURN v;
  END;

  -- PIPELINED + PIPE ROW
  FUNCTION explode_bom(p_item_id IN NUMBER) RETURN t_bom_comp_tab PIPELINED IS
  BEGIN
    FOR r IN (
      SELECT l.component_item_id, ci.item_code, l.qty_per
        FROM t_bom_line l
        JOIN t_bom_header h  ON h.bom_id = l.bom_id
        JOIN t_item ci       ON ci.item_id = l.component_item_id
       WHERE h.item_id = p_item_id AND h.status = 'ACTIVE'
    ) LOOP
      PIPE ROW(t_bom_comp_obj(r.component_item_id, r.item_code, r.qty_per));
    END LOOP;
    RETURN;
  END;

  -- CONNECT BY + SYS_REFCURSOR + SYS_CONNECT_BY_PATH
  PROCEDURE list_bom(p_item_id IN NUMBER, p_cur OUT SYS_REFCURSOR) IS
  BEGIN
    OPEN p_cur FOR
      SELECT LEVEL AS lvl, l.component_item_id, ci.item_code,
             SYS_CONNECT_BY_PATH(ci.item_code,'/') AS path,
             CONNECT_BY_ISLEAF AS is_leaf
        FROM t_bom_line l
        JOIN t_bom_header h ON h.bom_id = l.bom_id
        JOIN t_item ci      ON ci.item_id = l.component_item_id
       WHERE h.status = 'ACTIVE'
      START WITH h.item_id = p_item_id
      CONNECT BY NOCYCLE PRIOR l.component_item_id = h.item_id
       ORDER SIBLINGS BY l.line_no;
  END;

  -- 递归 PL/SQL 函数: BOM 成本卷算
  FUNCTION bom_cost(p_item_id IN NUMBER) RETURN NUMBER IS
    v_total NUMBER := 0;
    v_cost  NUMBER;
  BEGIN
    BEGIN
      SELECT std_cost INTO v_cost FROM t_item WHERE item_id = p_item_id;
      FOR r IN (SELECT l.component_item_id, l.qty_per, l.scrap_rate
                  FROM t_bom_line l
                  JOIN t_bom_header h ON h.bom_id = l.bom_id
                 WHERE h.item_id = p_item_id AND h.status = 'ACTIVE') LOOP
        v_total := v_total + bom_cost(r.component_item_id)
                           * (r.qty_per / (1 - NVL(r.scrap_rate,0)));
      END LOOP;
      RETURN CASE WHEN v_total > 0 THEN ROUND(v_total,6) ELSE v_cost END;
    EXCEPTION WHEN NO_DATA_FOUND THEN RETURN 0;
    END;
  END;

  -- FORALL SAVE EXCEPTIONS + SQL%BULK_EXCEPTIONS + MERGE INTO
  PROCEDURE bulk_receive(p_lines IN t_recv_tab, p_ok OUT NUMBER) IS
    TYPE t_id_tab IS TABLE OF NUMBER INDEX BY PLS_INTEGER;
    v_ids t_id_tab;
  BEGIN
    p_ok := 0;
    FOR i IN p_lines.FIRST..p_lines.LAST LOOP
      v_ids(i) := seq_inv_txn_id.NEXTVAL;
    END LOOP;
    BEGIN
      FORALL i IN p_lines.FIRST..p_lines.LAST SAVE EXCEPTIONS
        INSERT INTO t_inventory_txn(txn_id,item_id,direction,quantity,unit_cost,txn_date)
        VALUES(v_ids(i), p_lines(i).item_id, base_pkg.c_dir_in,
               p_lines(i).qty, NVL(p_lines(i).unit_cost,0), SYSDATE);
      p_ok := p_lines.COUNT;
    EXCEPTION WHEN OTHERS THEN
      IF SQLCODE = -24381 THEN
        p_ok := p_lines.COUNT - SQL%BULK_EXCEPTIONS.COUNT;
        FOR j IN 1..SQL%BULK_EXCEPTIONS.COUNT LOOP
          log_error('M9999', 'Bulk fail idx='||SQL%BULK_EXCEPTIONS(j).error_index);
        END LOOP;
      ELSE RAISE;
      END IF;
    END;
    -- MERGE INTO: 按流水均值回写物料成本
    MERGE INTO t_item tgt USING (
      SELECT item_id, ROUND(AVG(unit_cost),6) AS avg_cost
        FROM t_inventory_txn WHERE direction = 'I' GROUP BY item_id
    ) src ON (tgt.item_id = src.item_id)
    WHEN MATCHED THEN UPDATE SET tgt.std_cost = src.avg_cost;
  END;

  -- FIFO: 窗口函数 SUM() OVER + FOR UPDATE 游标 + WHERE CURRENT OF
  PROCEDURE issue_fifo(p_item_id IN NUMBER, p_qty IN NUMBER) IS
    CURSOR c_fifo IS
      SELECT lot_id, qty_on_hand AS avail,
             SUM(qty_on_hand) OVER (ORDER BY receipt_date, lot_id) AS cum_avail
        FROM t_inventory_lot
       WHERE item_id = p_item_id AND qty_on_hand > 0
       ORDER BY receipt_date, lot_id
       FOR UPDATE OF qty_on_hand;
    v_rem NUMBER := p_qty;
  BEGIN
    FOR r IN c_fifo LOOP
      EXIT WHEN v_rem <= 0;
      UPDATE t_inventory_lot
         SET qty_on_hand = qty_on_hand - LEAST(r.avail, v_rem)
       WHERE CURRENT OF c_fifo;
      v_rem := v_rem - LEAST(r.avail, v_rem);
    END LOOP;
  END;

  -- EXECUTE IMMEDIATE + USING (动态 SQL)
  PROCEDURE archive_before(p_date IN DATE, p_count OUT NUMBER) IS
  BEGIN
    EXECUTE IMMEDIATE 'DELETE FROM t_inventory_txn WHERE txn_date < :1'
      USING p_date;
    p_count := SQL%ROWCOUNT;
  END;

-- 包初始化块
BEGIN
  g_biz_date := SYSDATE;
END core_pkg;
/
