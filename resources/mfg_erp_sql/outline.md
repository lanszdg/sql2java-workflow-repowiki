# 制造/供应链 ERP PL/SQL → Java 转换大纲

## 一、概述

### 1.1 项目功能

**项目名称**：mfg_erp_sql（制造/供应链 ERP 数据库）

**主要功能**：完整的制造业 ERP 后端业务逻辑，覆盖物料主数据、BOM 管理、库存收发、成本核算、定价引擎、采购管理、MRP 物料需求计划、需求预测与分析报表

**技术栈**：GaussDB (Oracle 兼容模式)，PL/SQL，56 个 SQL 文件，约 6126 行

**处理逻辑**：
- 物料主数据维护（含对象类型继承体系、分类树、ABC 分类）
- BOM 多层展开（三种递归实现：CONNECT BY / 递归子程序 / 递归 CTE）与版本比对
- 库存收发（FIFO 批次扣减、FORALL 批量收货、MERGE 余额同步）
- 成本核算（FIFO 分层、移动加权平均、落地成本分摊、标准成本卷算）
- 多维阶梯定价引擎（LIST / DISCOUNT_PCT / DISCOUNT_AMT / OVERRIDE）
- 采购 PO 状态机（DRAFT → APPROVED → PARTIAL → RECEIVED → CLOSED）
- MRP 物料需求计划（低层码 + 逐层净算 + 相关需求展开）
- 需求预测（MODEL 子句滚动外推 + DBMS_SQL 动态透视）
- 分析报表（PIVOT / LISTAGG / ROLLUP / CUBE / GROUPING / NTILE / RANK）
- 定时调度（DBMS_SCHEDULER 作业封装）

### 1.2 转换策略

1. **对象类型映射**：
   - `t_money` → `Money` 值对象（不可变，含 plus/minus/scale_by/to_display 方法）
   - `t_dimension` → `Dimension` 值对象（含 volume_cm3/volumetric_weight_kg/chargeable_weight_kg）
   - `t_tag_varray` → `List<String>`（VARRAY → Java List，上限 20 由校验保证）
   - `t_item_obj` 继承体系 → 抽象基类 `ItemObj` + 子类 `RawMaterialObj` / `FinishedGoodObj` / `ServiceItemObj`（OVERRIDING 方法对应 Java @Override）
   - `t_bom_comp_obj` → `BomCompObj`（含 effective_qty 计算方法）
   - `t_alloc_obj` → `AllocObj`（含 alloc_cost 计算方法）
   - `t_explosion_row` → `ExplosionRow`（pipelined 返回的行类型）
   - 嵌套表 `t_bom_comp_tab` / `t_alloc_tab` / `t_explosion_tab` → `List<T>`

2. **包映射**：`xxx_pkg` → `XxxService`（Spring Bean）
   - `const_pkg` → `ErpConstants` 常量类（仅 spec，无 body）
   - `exc_pkg` → `BizException` 枚举 + `ErrorLogService`（自治事务 → `@Transactional(propagation = REQUIRES_NEW)`）
   - `util_pkg` → `UtilService`（包级全局变量 → 实例字段，初始化块 → `@PostConstruct`）
   - `item_pkg` → `ItemService`
   - `bom_pkg` → `BomService`
   - `inventory_pkg` → `InventoryService`
   - `costing_pkg` → `CostingService`
   - `pricing_pkg` → `PricingService`
   - `procurement_pkg` → `ProcurementService`
   - `mrp_pkg` → `MrpService`
   - `forecast_pkg` → `ForecastService`
   - `report_pkg` → `ReportService`
   - `sched_pkg` → `SchedService`（DBMS_SCHEDULER → `@Scheduled` / Quartz / XXL-JOB）

3. **独立函数映射**：`fn_xxx` → `XxxUtil` 工具类静态方法
   - `fn_uom_convert` → `UomUtil.convert(qty, fromUom, toUom)`（deterministic → 纯函数，可缓存）
   - `fn_abc_class` → `AbcClassUtil.classify(cumPct, aPct, bPct)`
   - `fn_landed_cost` → `LandedCostUtil.calculate(unitPrice, freightShare, dutyRate, miscShare)`
   - `fn_bom_unit_cost` → `BomCostUtil.calculate(itemId, asOf)`（递归函数 → 递归方法）

4. **触发器映射**：
   - `trg_inv_txn`（复合触发器）→ AOP 拦截 / MyBatis Interceptor（语句级聚合审计）
   - `trg_item_audit`（行级 WHEN）→ MyBatis Interceptor（字段变更审计）
   - `trg_v_item_full`（INSTEAD OF）→ 视图写转 Service 层（拍平字段拼回对象列）

5. **高级特性映射**：
   - CONNECT BY → 递归 SQL（MyBatis mapper）或 Java 递归方法
   - MODEL 子句 → Java 端按期迭代计算（`forecast_pkg.generate_forecast`）
   - DBMS_SQL 动态透视 → `JdbcTemplate` + 动态列 RowMapper
   - WITH FUNCTION → 独立 Service 方法或工具函数
   - FORALL SAVE EXCEPTIONS → MyBatis batch executor + 单行异常收集
   - WHERE CURRENT OF → "查可用层 + 批量更新"替代游标定位
   - `$IF` 条件编译 → 日志级别 / 配置开关
   - MULTISET EXCEPT/INTERSECT → `Set.removeAll` / `Set.retainAll` 或 SQL 改写
   - 范围分区表 → 应用层按日期分表或使用数据库原生分区

## 二、实体类设计

### 2.1 DO 类（映射数据库表）

#### 2.1.1 码表与基础

| 表名 | DO 类 | 主键 | 说明 |
|------|-------|------|------|
| `t_code_dict` | `CodeDictDO` | `(dict_type, code)` | 通用码表，dict_type 区分枚举域 |
| `t_uom` | `UomDO` | `uom_code` | 计量单位（EA/WT/VOL/LEN/TIME） |
| `t_uom_conversion` | `UomConversionDO` | `(from_uom, to_uom)` | 单位换算系数，枢轴为基本单位 |
| `t_business_date` | `BusinessDateDO` | `sys_code` | 系统业务日期（日切状态机） |
| `t_app_param` | `AppParamDO` | `param_key` | 运行参数键值对（类型：STRING/NUMBER/BOOL/DATE/JSON） |
| `t_error_log` | `ErrorLogDO` | `log_id` | 错误日志（自治事务写入） |
| `t_audit_log` | `AuditLogDO` | `audit_id` | 审计日志（old/new 为 JSON CLOB） |

#### 2.1.2 仓库与库位

| 表名 | DO 类 | 主键 | 说明 |
|------|-------|------|------|
| `t_warehouse` | `WarehouseDO` | `warehouse_id` | 仓库（RAW/FG/WIP/RET 四类） |
| `t_location` | `LocationDO` | `location_id` | 库位（自引用父子，支持任意层级） |

#### 2.1.3 供应商与客户

| 表名 | DO 类 | 主键 | 说明 |
|------|-------|------|------|
| `t_supplier` | `SupplierDO` | `supplier_id` | 供应商（含提前期/评级/币种） |
| `t_customer` | `CustomerDO` | `customer_id` | 客户（含价目表/信用额度） |

#### 2.1.4 物料与分类

| 表名 | DO 类 | 主键 | 说明 |
|------|-------|------|------|
| `t_item_category` | `ItemCategoryDO` | `category_id` | 物料分类树（自引用，冗余 level_no/path/is_leaf） |
| `t_item` | `ItemDO` | `item_id` | 物料主表（**含对象列 `dim t_dimension`、VARRAY 列 `tags t_tag_varray`**） |

**⚠️ 对象列映射要点**：
- `dim` (t_dimension) → 方案 A：`Dimension` 嵌入字段 + MyBatis TypeHandler；方案 B：拍平为 `length_cm`/`width_cm`/`height_cm`/`weight_kg` 四列（参考 `trg_v_item_full` 拍平逻辑）
- `tags` (t_tag_varray) → `List<String>` + TypeHandler，或 JSON 字符串存储

#### 2.1.5 BOM

| 表名 | DO 类 | 主键 | 说明 |
|------|-------|------|------|
| `t_bom_header` | `BomHeaderDO` | `bom_id` | BOM 头（版本 + 基准产出量 + 生效期） |
| `t_bom_line` | `BomLineDO` | `line_id` | BOM 行（组件 + 用量 + 损耗率 + 虚拟标志） |

#### 2.1.6 库存

| 表名 | DO 类 | 主键 | 说明 |
|------|-------|------|------|
| `t_inventory_lot` | `InventoryLotDO` | `lot_id` | 批次明细（FIFO 排队键 receipt_date，乐观锁） |
| `t_inventory_balance` | `InventoryBalanceDO` | `(item_id, warehouse_id)` | 余额汇总（乐观锁 version） |
| `t_inventory_txn` | `InventoryTxnDO` | `(txn_id, txn_date)` | 库存流水（**按季范围分区**，不可变事件流） |

**⚠️ 分区表映射**：`t_inventory_txn` 按季分区，Java 侧需要按 `txn_date` 路由，或使用数据库原生分区对应用透明

#### 2.1.7 采购与销售订单

| 表名 | DO 类 | 主键 | 说明 |
|------|-------|------|------|
| `t_purchase_order` | `PurchaseOrderDO` | `po_id` | 采购订单头（状态机驱动） |
| `t_po_line` | `PoLineDO` | `po_line_id` | 采购订单行 |
| `t_sales_order` | `SalesOrderDO` | `so_id` | 销售订单头 |
| `t_so_line` | `SoLineDO` | `so_line_id` | 销售订单行（含折扣率） |

#### 2.1.8 生产与 MRP

| 表名 | DO 类 | 主键 | 说明 |
|------|-------|------|------|
| `t_production_order` | `ProductionOrderDO` | `prod_id` | 生产工单 |
| `t_mrp_run` | `MrpRunDO` | `run_id` | MRP 运行头 |
| `t_mrp_plan` | `MrpPlanDO` | `plan_id` | MRP 计划明细（含低层码/毛需求/净需求/计划下单） |

#### 2.1.9 定价与预测

| 表名 | DO 类 | 主键 | 说明 |
|------|-------|------|------|
| `t_price_list` | `PriceListDO` | `price_list_id` | 价目表（默认/专属） |
| `t_price_rule` | `PriceRuleDO` | `rule_id` | 定价规则（多维阶梯：物料/分类/客户 × 数量区间 × 四种规则类型） |
| `t_demand_forecast` | `DemandForecastDO` | `forecast_id` | 需求预测（唯一约束 item+仓库+期+方法） |

#### 2.1.10 视图

| 视图名 | 映射方式 | 说明 |
|--------|---------|------|
| `v_item_full` | `ItemFullVO`（只读 VO） | 物料宽视图：主表 + 分类名 + 单位名 + 对象列拍平 + `dim.volume_cm3()` 对象方法调用 |

### 2.2 DTO 类（入参封装）

| DTO 类 | 来源包/函数 | 字段 |
|--------|-----------|------|
| `RecvLineDTO` | `inventory_pkg.bulk_receive` 的 `t_recv_line` | `itemId`, `warehouseId`, `qty`, `unitCost`, `lotNo`, `refDocType`, `refDocId` |
| `RecvBatchDTO` | `inventory_pkg.bulk_receive` 的 `t_recv_tab` | `List<RecvLineDTO>`（关联数组 → List） |
| `CreateItemDTO` | `item_pkg.create_item` | `itemCode`, `itemName`, `itemType`, `categoryId`, `baseUom`, `stdCost`, `dim`(Dimension), `tags`(List\<String\>) |
| `CreatePodTO` | `procurement_pkg.create_po` | `supplierId`, `warehouseId`, `expectedDate` |
| `AddPoLineDTO` | `procurement_pkg.add_po_line` | `poId`, `itemId`, `qty`, `unitPrice`, `uom`, `needDate` |
| `RunMrpDTO` | `mrp_pkg.run_mrp` | `runDate`, `horizonDays` |
| `GenerateForecastDTO` | `forecast_pkg.generate_forecast` | `runDate`, `method`, `periodsAhead` |
| `PriceQueryDTO` | `pricing_pkg.get_price` | `itemId`, `customerId`, `qty`, `asOf` |

### 2.3 Result 类（出参封装）

| Result 类 | 来源 | 字段 |
|-----------|------|------|
| `PriceDetailResult` | `pricing_pkg.get_price_detail` | `basePrice`, `finalPrice`, `ruleId`, `ruleType` |
| `StockReceiveResult` | `inventory_pkg.receive_stock` | `lotId`, `txnId` |
| `BulkReceiveResult` | `inventory_pkg.bulk_receive` | `okCount`, `failCount` |
| `IssueStockResult` | `inventory_pkg.issue_stock` | `List<AllocObj>`（NOCOPY 嵌套表 → List） |
| `MrpRunResult` | `mrp_pkg.run_mrp` | `runId` |
| `MrpReleaseResult` | `mrp_pkg.release_planned_orders` | `prodCount` |
| `PoCreateResult` | `procurement_pkg.create_po` | `poId`, `poNo` |
| `ArchiveResult` | `inventory_pkg.archive_txns_before` | `archived`(归档行数) |
| `ReorderResult` | `procurement_pkg.reorder_scan` | `suggestCount` |
| `PoFromMrpResult` | `procurement_pkg.create_po_from_mrp` | `poCount` |

## 三、对象类型映射

### 3.1 值对象

#### t_money → Money

**类定义**：
```java
public class Money {
    private BigDecimal amount;       // NUMBER(20,4)
    private String currencyCode;     // VARCHAR2(8)
}
```

**方法映射**：
| PL/SQL 方法 | Java 方法 | 说明 |
|------------|----------|------|
| `plus(p_other)` | `plus(Money other)` | 同币种校验后加总 |
| `minus(p_other)` | `minus(Money other)` | 委托 plus，传入取反后的 Money |
| `scale_by(p_factor)` | `scaleBy(BigDecimal factor)` | 金额乘系数，round 4 位 |
| `is_zero` | `isZero()` | 返回 boolean（原返回 Y/N） |
| `abs_value` | `absValue()` | 返回绝对值新对象 |
| `to_display` | `toDisplay()` | 格式化显示：`999,999,999,990.0000 CNY` |
| `sort_key`(map) | `compareTo`(实现 Comparable) | 仅比金额，币种由业务层折算 |

#### t_dimension → Dimension

**类定义**：
```java
public class Dimension {
    private BigDecimal lengthCm;   // NUMBER(10,2)
    private BigDecimal widthCm;    // NUMBER(10,2)
    private BigDecimal heightCm;   // NUMBER(10,2)
    private BigDecimal weightKg;   // NUMBER(10,3)
}
```

**方法映射**：
| PL/SQL 方法 | Java 方法 | 说明 |
|------------|----------|------|
| `volume_cm3` | `volumeCm3()` | 长×宽×高 |
| `volumetric_weight_kg` | `volumetricWeightKg()` | 体积 / 5000（空运惯例） |
| `chargeable_weight_kg` | `chargeableWeightKg()` | max(实重, 体积重) |

### 3.2 继承体系

#### t_item_obj → ItemObj（抽象基类）

```
ItemObj (abstract)
├── item_id, item_code, item_name, base_uom, std_cost
├── valuation_method() [abstract]  → 估值方法
├── is_stockable() [abstract]      → 可库存标志
├── lead_time_days()               → 提前期（默认 0，子类覆写）
└── describe()                     → 描述字符串
```

**子类覆写**：
| 子类 | valuation_method | is_stockable | lead_time_days | 特有字段 |
|------|-----------------|-------------|----------------|---------|
| `RawMaterialObj` | `FIFO` | `Y` | `7` | `supplierId`, `shelfLifeDays`, `reorderPoint` + `needsReorder(onHand)` |
| `FinishedGoodObj` | `STD` | `Y` | `makeLeadDays`（默认 1） | `bomId`, `makeLeadDays` |
| `ServiceItemObj` | `NONE` | `N` | 继承基类 `0` | 无 |

**工厂方法**：`item_pkg.get_item_obj` → `ItemService.getItemObj(itemId)` 按 `item_type` 实例化子型，返回基类引用（多态入口）

### 3.3 集合类型

| PL/SQL 类型 | Java 类型 | 说明 |
|------------|----------|------|
| `t_tag_varray` (VARRAY(20) of VARCHAR2) | `List<String>` | 有序、上限 20，整体读写 |
| `t_bom_comp_tab` (TABLE OF t_bom_comp_obj) | `List<BomCompObj>` | BOM 组件嵌套表 |
| `t_alloc_tab` (TABLE OF t_alloc_obj) | `List<AllocObj>` | FIFO 分配结果嵌套表 |
| `t_explosion_tab` (TABLE OF t_explosion_row) | `List<ExplosionRow>` | BOM 展开结果 |

## 四、子函数调用与包依赖

### 4.1 包调用依赖图

```
基础层:
  const_pkg (常量) ← 所有包依赖，未画出
  exc_pkg (异常+日志) ← util_pkg
  util_pkg (业务日期/参数/单位换算) ← item_pkg, bom_pkg, inventory_pkg, pricing_pkg, forecast_pkg

主数据层:
  item_pkg (物料+分类树) ← bom_pkg (间接), trg_v_item_full
  bom_pkg (BOM 递归展开) ← costing_pkg, mrp_pkg

业务层:
  inventory_pkg (收发/FIFO) ← procurement_pkg, mrp_pkg
  costing_pkg (估值/卷算) ← bom_pkg
  pricing_pkg (阶梯定价) ← 无业务包依赖
  procurement_pkg (PO 状态机) ← inventory_pkg, mrp_pkg
  mrp_pkg (MRP) ← bom_pkg, inventory_pkg
  forecast_pkg (预测) ← report_pkg
  report_pkg (报表) ← forecast_pkg
  sched_pkg (调度) ← mrp_pkg, forecast_pkg (运行时作业体字符串，非编译期依赖)
```

### 4.2 独立函数调用关系

| 独立函数 | 调用方 | Java 映射 |
|---------|--------|----------|
| `fn_uom_convert` | SQL 直调（报表场景），与 `util_pkg.convert_qty` 同逻辑 | `UomUtil.convert()`，报表宽容版不抛异常返回 null |
| `fn_abc_class` | `item_pkg.reclassify_abc`、`report_pkg.inventory_pareto` | `AbcClassUtil.classify()`，帕累托判级口径统一 |
| `fn_landed_cost` | `costing_pkg.landed_cost_report` 内 WITH FUNCTION 同逻辑 | `LandedCostUtil.calculate()`，完税价 = (单价+运费)×税率 + 杂费 |
| `fn_bom_unit_cost` | `bom_pkg.rolled_cost` 调用等价递归，SQL 直调 | `BomCostUtil.calculate()`，递归自底向上累加 |

### 4.3 触发器调用关系

| 触发器 | 依赖 | Java 映射 |
|--------|------|----------|
| `trg_inv_txn` (compound) | `t_inventory_txn` INSERT → 写 `t_audit_log` | AOP 拦截 InventoryService，语句级聚合净变动审计 |
| `trg_item_audit` (行级 WHEN) | `t_item` UPDATE of status/std_cost/list_price → 写 `t_audit_log` | AOP 拦截 ItemService，仅关键变更记录 |
| `trg_v_item_full` (INSTEAD OF) | `v_item_full` INSERT/UPDATE → 调 `item_pkg.create_item` / `apply_item_flat` | Service 层直接处理：拍平字段 → 构造 Dimension 对象 → 写主表 |

## 五、业务逻辑

### 5.1 const_pkg → ErpConstants

**类定义**：常量类，全部 `public static final`

**常量分组**：
- **错误码**（M1xxx 物料 / M2xxx BOM / M3xxx 库存 / M4xxx 采购 / M5xxx MRP / M6xxx 定价 / M9999 系统）
- **物料类型**：RAW / SEMI / FG / SVC
- **估值方法**：FIFO / STD / AVG / NONE
- **库存事务类型**：RECV / ISSUE / ADJ / XFER_OUT / XFER_IN / PROD_IN / PROD_OUT / RETURN
- **库存方向**：I(入库) / O(出库)
- **批次状态**：AVAILABLE / QUARANTINE / EXPIRED / CONSUMED
- **采购订单状态**：DRAFT / APPROVED / PARTIAL / RECEIVED / CLOSED / CANCELLED
- **订单行状态**：OPEN / PARTIAL / CLOSED / CANCELLED
- **生产工单状态**：PLANNED / RELEASED / IN_PROGRESS / COMPLETED / CLOSED
- **MRP 运行状态**：RUNNING / SUCCESS / FAILED / PARTIAL
- **定价规则类型**：LIST / DISCOUNT_PCT / DISCOUNT_AMT / OVERRIDE
- **业务参数**：默认币种 CNY / BOM 最大层级 20 / 年天数 365 / 批量上限 1000
- **模块名**：ITEM / BOM / INVENTORY / COSTING / PRICING / PROCUREMENT / MRP / FORECAST / REPORT / UTIL / SCHED

### 5.2 exc_pkg → BizException + ErrorLogService

**异常体系**：
- 24 个自定义异常 → `BizException` 枚举，每个异常关联 SQLCODE（-20101 ~ -20602）
- `PRAGMA EXCEPTION_INIT` → 异常枚举的 `errorCode` 字段
- `raise_biz_error` → `BizException.throw(errorCode, module, procedure, message, bizKey)`
- `log_error`（自治事务）→ `ErrorLogService.logError()` + `@Transactional(propagation = REQUIRES_NEW)`
- `debug` → `log.debug()`
- `format_error_stack` → `ExceptionUtils.getStackTrace()`

### 5.3 util_pkg → UtilService

**包级全局变量**（⚠️ 不能错翻成 static 常量）：
- `g_curr_biz_date` / `g_last_biz_date` / `g_next_biz_date` → 实例字段，`@PostConstruct` 加载
- `g_curr_operator` / `g_session_id` → ThreadLocal 或请求作用域

**条件编译**：`c_trace_compile` → 日志级别控制（`log.isTraceEnabled()`），不产生编译期剔除

**方法映射**：

| PL/SQL 方法 | Java 方法 | 说明 |
|------------|----------|------|
| `refresh_biz_date` | `refreshBizDate()` | 重新加载业务日期 |
| `curr_biz_date` | `currBizDate()` | 取当前业务日期 |
| `last_biz_date` | `lastBizDate()` | 上一业务日期 |
| `next_biz_date` | `nextBizDate()` | 下一业务日期 |
| `set_operator` | `setOperator(String)` | 设置当前操作员 |
| `get_operator` | `getOperator()` | 取当前操作员 |
| `get_param`(varchar2) | `getParam(String key, String defaultValue)` | 参数读取重载 × 3 |
| `get_param`(number) | `getParam(String key, BigDecimal defaultValue)` | 按默认值类型分派 |
| `get_param`(date) | `getParam(String key, LocalDate defaultValue)` | 按默认值类型分派 |
| `gen_doc_no` | `genDocNo(String prefix, Long seq, LocalDate date)` | 前缀 + YYYYMMDD + 序列 6 位 |
| `convert_qty` | `convertQty(BigDecimal qty, String fromUom, String toUom)` | 单位换算（跨类抛异常） |
| `round_qty` | `roundQty(BigDecimal qty, String uom)` | 按单位小数位规整 |
| `format_qty` | `formatQty(BigDecimal qty, String uom)` | 格式化数量显示 |
| `clear_cache` | `clearCache()` | 清除缓存变量 |

### 5.4 item_pkg → ItemService

| PL/SQL 方法 | Java 方法 | 说明 |
|------------|----------|------|
| `get_item_obj` | `getItemObj(Long itemId)` | **多态工厂**：按 item_type 构造子型（RAW→RawMaterialObj, FG→FinishedGoodObj, SVC→ServiceItemObj），返回基类引用 |
| `get_item` | `getItem(Long itemId)` | 取物料行（`%ROWTYPE` → `ItemDO`），找不到抛异常 |
| `find_item_id` | `findItemId(String itemCode)` | 编码查 id |
| `create_item` | `createItem(CreateItemDTO dto)` | 创建物料，`p_dim t_dimension` → 构造 Dimension 对象，`p_tags t_tag_varray` → List\<String\> |
| `get_category_path` | `getCategoryPath(Long categoryId)` | CONNECT BY + SYS_CONNECT_BY_PATH 拼路径 |
| `list_category_subtree` | `listCategorySubtree(Long rootCategoryId)` | CONNECT BY START WITH 递归列子树 |
| `rebuild_category_tree` | `rebuildCategoryTree()` | CONNECT BY 算层级/路径后 MERGE 回写 |
| `reclassify_abc` | `reclassifyAbc(LocalDate from, LocalDate to)` | 窗口函数算累计消耗占比 + `fn_abc_class` 判级 + MERGE 回写 `t_item.abc_class` |
| `apply_item_flat` | `applyItemFlat(...)` | 视图拍平字段 → 构造 `t_dimension` 对象 → UPDATE 主表 |

### 5.5 bom_pkg → BomService

**⚠️ 三种递归展开实现，同一业务不同技术路线，适合校验转译器对递归的识别**

| PL/SQL 方法 | Java 方法 | 递归实现方式 | 说明 |
|------------|----------|-------------|------|
| `get_components` | `getComponents(Long bomId)` | 无递归，BULK COLLECT | 取当层组件为 `List<BomCompObj>` |
| `get_active_bom_id` | `getActiveBomId(Long itemId, LocalDate asOf)` | 无递归 | 取当前生效默认 BOM id |
| `explode` | `explode(Long itemId, BigDecimal qty, LocalDate asOf)` | **CONNECT BY** + SYS_CONNECT_BY_PATH + NOCYCLE + LEVEL + CONNECT_BY_ISLEAF + ORDER SIBLINGS BY，pipelined 流式返回 `List<ExplosionRow>` |
| `explode_table` | `explodeTable(Long itemId, BigDecimal qty, LocalDate asOf)` | **递归 PL/SQL 子程序** `walk(...)` + EXTEND + 环路检测，累积进嵌套表返回 |
| `explode_cte` | `explodeCte(Long itemId, BigDecimal qty, LocalDate asOf)` | **递归 CTE** (`WITH ... SELECT ... UNION ALL`)，返回 ref cursor |
| `where_used` | `whereUsed(Long componentId, Integer maxLevels)` | CONNECT BY 反查上层 | 某组件被哪些上层用到 |
| `compare_versions` | `compareVersions(Long bomIdOld, Long bomIdNew)` | MULTISET EXCEPT / INTERSECT | BOM 版本差异比对（新增/删除/用量变更） |
| `rolled_cost` | `rolledCost(Long itemId, LocalDate asOf)` | 调 `fn_bom_unit_cost` 递归 | 标准成本卷算 |

### 5.6 inventory_pkg → InventoryService

**⚠️ 本包是行数最大（573 行）、要素最密集的包**

| PL/SQL 方法 | Java 方法 | 重点要素 | 说明 |
|------------|----------|---------|------|
| `receive_stock`(按 id) | `receiveStock(Long itemId, Long whId, BigDecimal qty, BigDecimal unitCost, ...)` | RETURNING INTO | 收货：新建批次 + 写流水 + MERGE 余额；RETURNING INTO 取回 lot_id |
| `receive_stock`(按编码) | `receiveStock(String itemCode, String whCode, ...)` | **重载** | 编码转 id 后委托上方法 |
| `issue_stock` | `issueStock(Long itemId, Long whId, BigDecimal qty, ...)` | 窗口 FIFO + WHERE CURRENT OF + NOCOPY | FIFO 发料：窗口函数算批次累计可用量定位扣减批次，游标逐批扣，返回 `List<AllocObj>`（NOCOPY） |
| `bulk_receive` | `bulkReceive(List<RecvLineDTO> lines)` | **FORALL SAVE EXCEPTIONS** + %BULK_EXCEPTIONS | 批量收货，单行失败不阻断整批，收集异常行 |
| `adjust_stock` | `adjustStock(Long itemId, Long whId, BigDecimal newQty, String reason)` | ADJ 流水 | 盘盈盘亏调整 |
| `transfer_stock` | `transferStock(Long itemId, Long fromWh, Long toWh, BigDecimal qty)` | 同事务两条流水 | 仓间调拨 |
| `sync_balance` | `syncBalance(Long itemId, Long whId)` | MERGE | 按批次重算余额并 MERGE 回写 |
| `get_available` | `getAvailable(Long itemId, Long whId)` | 查询 | 取可用量 = qty_on_hand - qty_allocated |
| `archive_txns_before` | `archiveTxnsBefore(LocalDate beforeDate)` | **EXECUTE IMMEDIATE** 动态 DDL + DML | 动态建归档表 + 搬数 + 清理，归档表名 `t_inv_txn_arch_YYYYMM` 运行期才定 |

### 5.7 costing_pkg → CostingService

| PL/SQL 方法 | Java 方法 | 重点要素 | 说明 |
|------------|----------|---------|------|
| `fifo_layers` | `fifoLayers(Long itemId, Long whId)` | 窗口 SUM OVER | FIFO 成本分层：累计可用量与累计金额 |
| `inventory_value` | `inventoryValue(Long whId)` | SUM OVER + RATIO_TO_REPORT | 库存估值表：仓库小计 + 占比 |
| `recompute_avg_cost` | `recomputeAvgCost(Long itemId, Long whId)` | 计算回写 | 重算移动加权平均成本 |
| `landed_cost_report` | `landedCostReport(Long poId)` | **WITH FUNCTION** | 落地成本报表：SQL 内联 PL/SQL 按金额/重量分摊运费关税 |
| `roll_standard_cost` | `rollStandardCost(LocalDate asOf)` | MERGE + 递归 | 对所有成品/半成品算 rolled cost 后 MERGE 回写 |

### 5.8 pricing_pkg → PricingService

| PL/SQL 方法 | Java 方法 | 重点要素 | 说明 |
|------------|----------|---------|------|
| `get_price` | `getPrice(Long itemId, Long customerId, BigDecimal qty, LocalDate asOf)` | 多维阶梯匹配 | 取最终单价：客户专属表 > 默认表，按 priority 小者先命中 |
| `get_price_detail` | `getPriceDetail(PriceQueryDTO dto)` | 四种规则类型计算 | 返回基准价/最终价/命中规则/规则类型 |
| `reprice_sales_order` | `repriceSalesOrder(Long soId)` | **WHERE CURRENT OF** | 游标遍历订单行，逐行重定价回写 |
| `list_effective_rules` | `listEffectiveRules(Long itemId, Long customerId)` | RANK + DENSE_RANK | 列出所有生效规则，标注是否会被选中 |

### 5.9 procurement_pkg → ProcurementService

| PL/SQL 方法 | Java 方法 | 重点要素 | 说明 |
|------------|----------|---------|------|
| `create_po` | `createPo(CreatePoDTO dto)` | 序列号生成 | 创建 PO 头 |
| `add_po_line` | `addPoLine(AddPoLineDTO dto)` | — | 添加 PO 行 |
| `approve_po` | `approvePo(Long poId)` | 状态机 | DRAFT → APPROVED，校验供应商未冻结 |
| `receive_po_line` | `receivePoLine(Long poId, Integer lineNo, BigDecimal qty, BigDecimal unitCost)` | **跨包事务** + 状态机 | 调 `inventory_pkg.receive_stock` + 累加 qty_received + 重算行/头状态，超收抛异常 |
| `create_po_from_mrp` | `createPoFromMrp(Long runId)` | BULK COLLECT + 按供应商归并 | MRP 计划批量转采购单 |
| `reorder_scan` | `reorderScan(Long whId)` | **WHERE CURRENT OF** + 游标 | 补货扫描：遍历低于再订货点的物料 |
| `supplier_ranking` | `supplierRanking(LocalDate from, LocalDate to)` | RANK / DENSE_RANK / 窗口函数 | 供应商排名：按采购金额/到货及时率 |
| `cancel_po` | `cancelPo(Long poId, String reason)` | 状态机 | 取消采购单 |

### 5.10 mrp_pkg → MrpService

| PL/SQL 方法 | Java 方法 | 重点要素 | 说明 |
|------------|----------|---------|------|
| `compute_low_level_codes` | `computeLowLevelCodes()` | 递归 BOM 深度 | 重算所有物料低层码（BOM 最大深度） |
| `run_mrp` | `runMrp(RunMrpDTO dto)` | **FORALL + MERGE** + 逐层净算 + 递归展开相关需求 | 主流程：建运行头 → 收集独立需求(预测+销售) → 按低层码逐层净算(毛需求-在手-在途=净需求) → 计划行 MERGE 进 `t_mrp_plan` |
| `netting_detail` | `nettingDetail(Long runId, Long itemId)` | 窗口 SUM OVER 滚动投影 | 单物料净算明细（时段桶上投影在手量） |
| `release_planned_orders` | `releasePlannedOrders(Long runId)` | — | 净需求转生产工单(成品/半成品)或留给采购(原材料) |

### 5.11 forecast_pkg → ForecastService

**⚠️ 本包包含 MODEL 子句和 DBMS_SQL 两个转译杀手级要素**

| PL/SQL 方法 | Java 方法 | 重点要素 | 说明 |
|------------|----------|---------|------|
| `generate_forecast` | `generateForecast(GenerateForecastDTO dto)` | **MODEL 子句**（rules / iterate / cv） | 滚动预测 MA3/MA6/TREND：将历史按期排成"行=物料,列=期"，用 rule 递推未来期。⚠️ 近乎无法纯 SQL 直译，应转为 Java 端按期迭代计算 |
| `forecast_accuracy` | `forecastAccuracy(Long itemId)` | LAG / LEAD + 窗口 AVG | 预测准确率：MAPE / 偏差 / 滚动准确率 / 环比增长 |
| `pivot_demand_dynamic` | `pivotDemandDynamic(LocalDate from, LocalDate to)` | **DBMS_SQL**（parse/bind/to_refcursor） | 动态透视：列(期数)编译期未知，DBMS_SQL 拼 SELECT ... PIVOT(...) 后转 ref cursor。⚠️ Java 侧 → `JdbcTemplate` + 动态列 RowMapper |

### 5.12 report_pkg → ReportService

| PL/SQL 方法 | Java 方法 | 重点要素 | 说明 |
|------------|----------|---------|------|
| `bom_component_list` | `bomComponentList(Long bomId)` | **LISTAGG** | BOM 当层组件拼成一行字符串 |
| `inventory_by_warehouse` | `inventoryByWarehouse()` | **PIVOT**（静态） | 库存按仓库透视：行=物料，列=各仓库在手量 |
| `sales_summary` | `salesSummary(LocalDate from, LocalDate to, String groupMode)` | **ROLLUP / CUBE / GROUPING(_ID)** | 销售汇总多维小计 |
| `stock_aging` | `stockAging()` | **NTILE** 四分位 + 窗口占比 | 库龄分桶分析 |
| `top_consumed_items` | `topConsumedItems(LocalDate from, LocalDate to, Integer topN)` | ROW_NUMBER / RANK / DENSE_RANK + **FETCH FIRST n ROWS** | 物料消耗 Top N |
| `inventory_pareto` | `inventoryPareto()` | SUM OVER ORDER BY + **RATIO_TO_REPORT** | 库存货值帕累托（ABC 决策依据） |

### 5.13 sched_pkg → SchedService

| PL/SQL 方法 | Java 方法 | 映射方式 | 说明 |
|------------|----------|---------|------|
| `schedule_nightly_mrp` | `scheduleNightlyMrp()` | `@Scheduled(cron = "0 0 2 * * ?")` 或 Quartz | 每日 02:00 跑 MRP |
| `schedule_monthly_forecast` | `scheduleMonthlyForecast()` | `@Scheduled(cron = "0 0 1 1 * ?")` | 每月 1 号 01:00 刷新预测 |
| `run_job_now` | `runJobNow(String jobName)` | 手动触发 | 排障/补跑 |
| `drop_job` | `dropJob(String jobName)` | 删除调度 | — |
| `list_jobs` | `listJobs()` | 查询 | 列出作业及上次运行结果 |

## 六、触发器逻辑

### 6.1 trg_inv_txn（复合触发器）→ AOP 拦截

**触发条件**：`t_inventory_txn` INSERT

**处理逻辑**：
1. `before statement`：清空本次语句的累积 Map
2. `after each row`：按 `item_id-warehouse_id` 为 key，按 direction 累加 signed quantity 到关联数组
3. `after statement`：遍历关联数组，每 key 写一条净变动审计到 `t_audit_log`（JSON 格式：`{"net_qty":xx, "rows_in_stmt":xx}`）

**Java 映射**：AOP 拦截 `InventoryService` 的写操作，用 `ThreadLocal<HashMap>` 累积，方法结束后统一写审计

**设计目的**：规避变异表问题 + 批量收发时只写聚合审计而非每行一条

### 6.2 trg_item_audit（行级触发器 + WHEN）→ MyBatis Interceptor

**触发条件**：`t_item` UPDATE of `status`, `std_cost`, `list_price`，WHEN 子句过滤值没变的伪更新

**处理逻辑**：实际值变化时，写 `t_audit_log`（old_value / new_value 为 JSON）

**Java 映射**：MyBatis Interceptor 拦截 ItemDO 的 UPDATE，比较新旧值，仅关键变更记录

### 6.3 trg_v_item_full（INSTEAD OF）→ Service 层

**触发条件**：`v_item_full` INSERT / UPDATE

**处理逻辑**：
- INSERT：调 `item_pkg.create_item`，将 `length_cm/width_cm/height_cm/weight_kg` 构造为 `t_dimension` 对象
- UPDATE：调 `item_pkg.apply_item_flat`，拍平字段拼回对象列

**Java 映射**：不映射触发器，直接在 Service 层处理 VO → DO 转换

## 七、序列映射

| 序列名 | Java 映射 | 策略 |
|--------|----------|------|
| `seq_category_id` (nocache) | MyBatis `@Options(useGeneratedKeys=true)` 或雪花 ID | 主数据 nocache |
| `seq_item_id` (nocache) | 同上 | 起始 10000 |
| `seq_bom_id` (nocache) | 同上 | 起始 1000 |
| `seq_bom_line_id` (cache 50) | 同上 | 高频写入 cache |
| `seq_warehouse_id` (nocache) | 同上 | 起始 10 |
| `seq_location_id` (nocache) | 同上 | 起始 1000 |
| `seq_supplier_id` (nocache) | 同上 | 起始 5000 |
| `seq_customer_id` (nocache) | 同上 | 起始 6000 |
| `seq_lot_id` (cache 100) | 同上 | 高频写入，起始 700000 |
| `seq_inv_txn_id` (cache 100) | 同上 | 分区表主键组成 |
| `seq_po_id` / `seq_so_id` / `seq_prod_id` (cache 20) | 同上 | 各类订单头 |
| `seq_mrp_run_id` / `seq_mrp_plan_id` (cache 200) | 同上 | MRP 运行与计划 |
| `seq_price_list_id` / `seq_price_rule_id` | 同上 | 定价 |
| `seq_forecast_id` (cache 200) | 同上 | 预测 |
| `seq_error_log_id` / `seq_audit_log_id` (cache 50) | 同上 | 日志 |

## 八、转译重点注意事项

1. **对象继承 `t_item_obj` + OVERRIDING + 多态构造** → Java 抽象基类 + 子类，`get_item_obj` 工厂分派；`valuation_method()` 是策略模式候选
2. **对象列 `t_item.dim/tags` + 视图 `dim.volume_cm3()`** → JDBC/MyBatis 不直接支持对象列，需 TypeHandler 或拍平 DO
3. **`bom_pkg` 三种等价递归** → 三种 Java 目标对照，同一业务三实现，校验转译器对递归的识别
4. **MULTISET EXCEPT/INTERSECT (`compare_versions`)** → Java `Set.removeAll`/`retainAll` 或 SQL 改写
5. **`forecast_pkg.generate_forecast` 的 MODEL 子句** → 近乎无法纯 SQL 直译，应转为 Java 端按期迭代
6. **`forecast_pkg.pivot_demand_dynamic` 的 DBMS_SQL** → 动态拼 SQL / `JdbcTemplate` + 动态列 RowMapper
7. **`costing_pkg.landed_cost_report` 的 WITH FUNCTION** → 提到 Java Service 方法或独立工具函数
8. **`inventory_pkg.bulk_receive` 的 FORALL SAVE EXCEPTIONS** → MyBatis batch executor + 单行异常收集，不能错翻成逐条循环吞异常
9. **`inventory_pkg.issue_stock` 的窗口 FIFO + WHERE CURRENT OF** → 改成"查可用层 + 批量更新"，注意 NOCOPY 出参语义
10. **`util_pkg.get_param` / `inventory_pkg.receive_stock` 重载** → Java 方法重载，按参数类型分派
11. **`util_pkg` 的 `$IF` 条件编译** → 编译期开关，Java 侧无对应，落成日志级别/配置开关
12. **复合触发器 `trg_inv_txn` / INSTEAD OF `trg_v_item_full`** → AOP 拦截 / MyBatis Interceptor / 视图写转 Service
13. **`exc_pkg.log_error` 自治事务** → `@Transactional(propagation = REQUIRES_NEW)`
14. **`util_pkg` 包级全局 + 初始化块** → 不能错翻成 static 常量；初始化块近似 `@PostConstruct` 但非完全等价
15. **范围分区表 `t_inventory_txn`** → 数据库原生分区对应用透明，或应用层按日期分表
