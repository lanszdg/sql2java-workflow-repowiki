CREATE OR REPLACE PACKAGE account_management_pkg AS

    -- 1. 声明全局常量（对应 Java 的 public static final）
    STATUS_ACTIVE   CONSTANT VARCHAR2(10) := 'ACTIVE';
    MIN_BALANCE     CONSTANT NUMBER(10,2) := 10.00;

    -- 2. 声明游标类型
    TYPE ref_cursor IS REF CURSOR;

    -- 3. 声明公开存储过程（含 IN/OUT 参数）
    PROCEDURE transfer_money (
        p_from_account IN  NUMBER,
        p_to_account   IN  NUMBER,
        p_amount       IN  NUMBER,
        p_status_msg   OUT VARCHAR2
    );

END account_management_pkg;
/
