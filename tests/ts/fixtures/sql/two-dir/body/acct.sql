CREATE OR REPLACE PACKAGE BODY account_management_pkg AS

    -- 1. 私有函数（body-only，header 未声明，对应 Java private 方法）
    FUNCTION check_balance_sufficient (
        p_account_id IN NUMBER,
        p_amount     IN NUMBER
    ) RETURN BOOLEAN IS
        v_balance NUMBER(10,2);
    BEGIN
        SELECT balance INTO v_balance
        FROM accounts
        WHERE account_id = p_account_id;

        IF (v_balance - p_amount) >= MIN_BALANCE THEN
            RETURN TRUE;
        ELSE
            RETURN FALSE;
        END IF;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            RETURN FALSE;
    END check_balance_sufficient;


    -- 2. 实现 header 中声明的公开存储过程
    PROCEDURE transfer_money (
        p_from_account IN  NUMBER,
        p_to_account   IN  NUMBER,
        p_amount       IN  NUMBER,
        p_status_msg   OUT VARCHAR2
    ) IS
    BEGIN
        IF NOT check_balance_sufficient(p_from_account, p_amount) THEN
            p_status_msg := 'FAILED: Insufficient balance or account inactive.';
            RETURN;
        END IF;

        UPDATE accounts
        SET balance = balance - p_amount
        WHERE account_id = p_from_account;

        UPDATE accounts
        SET balance = balance + p_amount
        WHERE account_id = p_to_account;

        COMMIT;

        p_status_msg := 'SUCCESS: Transfer completed. Account status remains ' || STATUS_ACTIVE;

    EXCEPTION
        WHEN OTHERS THEN
            ROLLBACK;
            p_status_msg := 'FAILED: SQL Error occurred. ' || SQLERRM;
    END transfer_money;

END account_management_pkg;
/
