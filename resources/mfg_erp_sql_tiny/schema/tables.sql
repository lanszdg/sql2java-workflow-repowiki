CREATE TABLE t_error_log (
  log_id       NUMBER(18)    NOT NULL,
  error_code   VARCHAR2(16),
  error_msg    VARCHAR2(2000),
  operator     VARCHAR2(32),
  occurred_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_error_log PRIMARY KEY (log_id)
);

CREATE TABLE t_item (
  item_id      NUMBER(18)    NOT NULL,
  item_code    VARCHAR2(40)  NOT NULL,
  item_name    VARCHAR2(200) NOT NULL,
  item_type    VARCHAR2(8)   DEFAULT 'RAW' NOT NULL,
  base_uom     VARCHAR2(8)   DEFAULT 'EA' NOT NULL,
  std_cost     NUMBER(20,6)  DEFAULT 0,
  list_price   NUMBER(20,4)  DEFAULT 0,
  dim          t_dimension,
  tags         t_tag_varray,
  status       VARCHAR2(8)   DEFAULT 'ACTIVE',
  CONSTRAINT pk_item PRIMARY KEY (item_id),
  CONSTRAINT uk_item_code UNIQUE (item_code),
  CONSTRAINT ck_item_type CHECK (item_type IN ('RAW','SEMI','FG'))
);

CREATE TABLE t_bom_header (
  bom_id       NUMBER(18)    NOT NULL,
  item_id      NUMBER(18)    NOT NULL,
  bom_version  VARCHAR2(16)  DEFAULT 'V1' NOT NULL,
  status       VARCHAR2(8)   DEFAULT 'ACTIVE' NOT NULL,
  CONSTRAINT pk_bom_header PRIMARY KEY (bom_id),
  CONSTRAINT fk_bom_item FOREIGN KEY (item_id) REFERENCES t_item(item_id),
  CONSTRAINT ck_bom_status CHECK (status IN ('DRAFT','ACTIVE','OBSOLETE'))
);

CREATE TABLE t_bom_line (
  line_id            NUMBER(18)   NOT NULL,
  bom_id             NUMBER(18)   NOT NULL,
  component_item_id  NUMBER(18)   NOT NULL,
  qty_per            NUMBER(18,6) NOT NULL,
  scrap_rate         NUMBER(8,4)  DEFAULT 0,
  CONSTRAINT pk_bom_line PRIMARY KEY (line_id),
  CONSTRAINT fk_bl_header FOREIGN KEY (bom_id) REFERENCES t_bom_header(bom_id),
  CONSTRAINT fk_bl_comp   FOREIGN KEY (component_item_id) REFERENCES t_item(item_id),
  CONSTRAINT ck_bl_qty CHECK (qty_per > 0)
);

CREATE TABLE t_inventory_lot (
  lot_id        NUMBER(18)    NOT NULL,
  item_id       NUMBER(18)    NOT NULL,
  qty_on_hand   NUMBER(18,4)  DEFAULT 0,
  qty_allocated NUMBER(18,4)  DEFAULT 0,
  unit_cost     NUMBER(20,6)  DEFAULT 0,
  receipt_date  DATE          NOT NULL,
  status        VARCHAR2(12)  DEFAULT 'AVAILABLE',
  CONSTRAINT pk_inv_lot PRIMARY KEY (lot_id)
);

CREATE TABLE t_inventory_txn (
  txn_id     NUMBER(18)    NOT NULL,
  item_id    NUMBER(18)    NOT NULL,
  direction  CHAR(1)       NOT NULL,
  quantity   NUMBER(18,4)  NOT NULL,
  unit_cost  NUMBER(20,6)  DEFAULT 0,
  txn_date   DATE          NOT NULL,
  CONSTRAINT pk_inv_txn PRIMARY KEY (txn_id, txn_date),
  CONSTRAINT ck_txn_dir CHECK (direction IN ('I','O'))
) PARTITION BY RANGE (txn_date) (
  PARTITION p_2026q1 VALUES LESS THAN (TO_DATE('2026-04-01','YYYY-MM-DD')),
  PARTITION p_2026q2 VALUES LESS THAN (TO_DATE('2026-07-01','YYYY-MM-DD')),
  PARTITION p_max    VALUES LESS THAN (MAXVALUE)
);
