-- 全构造包: 覆盖所有 PL/SQL 要素的 spec+body 包
CREATE OR REPLACE PACKAGE core_pkg AS
  -- 包变量
  g_biz_date DATE;
  -- RECORD + 关联数组
  TYPE t_recv_line IS RECORD (item_id NUMBER(18), qty NUMBER(18,4), unit_cost NUMBER(20,6));
  TYPE t_recv_tab IS TABLE OF t_recv_line INDEX BY PLS_INTEGER;

  -- %ROWTYPE 返回
  FUNCTION get_item(p_id IN NUMBER) RETURN t_item%ROWTYPE;
  -- 多态对象构造
  FUNCTION get_item_obj(p_id IN NUMBER) RETURN t_item_obj;
  -- 重载: 按参数个数/类型
  PROCEDURE create_item(p_code IN VARCHAR2, p_name IN VARCHAR2, p_type IN VARCHAR2, p_id OUT NUMBER);
  PROCEDURE create_item(p_code IN VARCHAR2, p_name IN VARCHAR2, p_type IN VARCHAR2, p_cost IN NUMBER, p_id OUT NUMBER);
  -- BULK COLLECT INTO
  FUNCTION get_bom_components(p_bom_id IN NUMBER) RETURN t_bom_comp_tab;
  -- PIPELINED + PIPE ROW
  FUNCTION explode_bom(p_item_id IN NUMBER) RETURN t_bom_comp_tab PIPELINED;
  -- CONNECT BY + SYS_REFCURSOR
  PROCEDURE list_bom(p_item_id IN NUMBER, p_cur OUT SYS_REFCURSOR);
  -- 递归 PL/SQL 函数
  FUNCTION bom_cost(p_item_id IN NUMBER) RETURN NUMBER;
  -- FORALL SAVE EXCEPTIONS + MERGE INTO
  PROCEDURE bulk_receive(p_lines IN t_recv_tab, p_ok OUT NUMBER);
  -- FIFO: 窗口函数 + FOR UPDATE + WHERE CURRENT OF
  PROCEDURE issue_fifo(p_item_id IN NUMBER, p_qty IN NUMBER);
  -- EXECUTE IMMEDIATE + USING
  PROCEDURE archive_before(p_date IN DATE, p_count OUT NUMBER);
  -- PRAGMA AUTONOMOUS_TRANSACTION
  PROCEDURE log_error(p_code IN VARCHAR2, p_msg IN VARCHAR2);
END core_pkg;
/
