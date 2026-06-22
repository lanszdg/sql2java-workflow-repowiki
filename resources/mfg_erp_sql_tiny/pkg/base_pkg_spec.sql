-- spec-only 包: 常量 + 异常
CREATE OR REPLACE PACKAGE base_pkg AS
  c_err_item_not_found CONSTANT VARCHAR2(16) := 'M1001';
  c_err_system         CONSTANT VARCHAR2(16) := 'M9999';
  c_dir_in   CONSTANT CHAR(1) := 'I';
  c_dir_out  CONSTANT CHAR(1) := 'O';
  c_lot_available CONSTANT VARCHAR2(12) := 'AVAILABLE';
  e_item_not_found EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_item_not_found, -20101);
END base_pkg;
/
