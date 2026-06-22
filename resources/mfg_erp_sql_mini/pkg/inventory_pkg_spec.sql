-- 库存收发: 收货 / 发料(FIFO) / 余额同步 / 批量收货 / 归档
-- receive_stock 重载: 既可传 id 也可传编码
-- issue_stock 走 FIFO: 窗口函数算批次累计可用量定位扣减批次，游标 where current of 逐批扣
-- bulk_receive 用 forall save exceptions 收集单行失败不阻断整批
-- 余额同步用 merge，新批次插入用 returning into 取回 lot_id

create or replace package inventory_pkg as

    -- 批量收货输入: record + 关联数组
    type t_recv_line is record (
        item_id       number(18),
        warehouse_id  number(18),
        qty           number(18,4),
        unit_cost     number(20,6),
        lot_no        varchar2(40),
        ref_doc_type  varchar2(16),
        ref_doc_id    number(18)
    );
    type t_recv_tab is table of t_recv_line index by pls_integer;

    -- 收货(按 id)
    procedure receive_stock(
        p_item_id       in  number,
        p_warehouse_id  in  number,
        p_qty           in  number,
        p_unit_cost     in  number,
        p_lot_no        in  varchar2 default null,
        p_ref_doc_type  in  varchar2 default null,
        p_ref_doc_id    in  number   default null,
        p_lot_id        out number,
        p_txn_id        out number
    );

    -- 收货(按编码)，重载版
    procedure receive_stock(
        p_item_code       in  varchar2,
        p_warehouse_code  in  varchar2,
        p_qty             in  number,
        p_unit_cost       in  number,
        p_lot_no          in  varchar2 default null,
        p_lot_id          out number,
        p_txn_id          out number
    );

    -- 发料(FIFO)，跨批次分配，返回每批扣减明细(对象嵌套表)
    procedure issue_stock(
        p_item_id       in  number,
        p_warehouse_id  in  number,
        p_qty           in  number,
        p_ref_doc_type  in  varchar2 default null,
        p_ref_doc_id    in  number   default null,
        p_alloc         out nocopy t_alloc_tab
    );

    -- 批量收货: forall save exceptions
    procedure bulk_receive(
        p_lines      in  t_recv_tab,
        p_ok_count   out number,
        p_fail_count out number
    );

    -- 按批次实时重算并 merge 余额行
    procedure sync_balance(p_item_id in number, p_warehouse_id in number);

    function get_available(p_item_id in number, p_warehouse_id in number) return number;

    -- 归档某日期前的库存流水，动态 SQL 建归档表
    procedure archive_txns_before(
        p_before_date in  date,
        p_archived    out number
    );

end inventory_pkg;
/
