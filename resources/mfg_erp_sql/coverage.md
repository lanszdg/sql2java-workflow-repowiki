# 要素覆盖矩阵

制造/供应链 ERP 的 PL/SQL 库,作为"存储过程 → Java(Spring Boot + MyBatis)"转译工作流的复杂输入。
相比 `bank_core_sql`,本库刻意补齐了对象类型/继承、递归(三种等价实现)、分析与集合写、以及 MODEL/DBMS_SQL 等转译杀手级要素,且多要素叠加。

## 目录结构

```
mfg_erp_sql/                                56 文件，6126 行
├── install.sql / schema_install.sql        完整部署 / 仅 schema 入口
├── type/        7 个对象类型(含继承体系 + varray + 嵌套表 + pipelined 行类型)
├── schema/      28 张表 + 序列 + 索引 + 视图 + 种子(含 3 层 BOM、对象列、范围分区)
├── pkg/         12 个包 × spec/body(const 仅 spec) = 25 文件
├── func/        4 个独立函数(1 个递归卷算)
└── trigger/     3 个触发器(复合 / 行级 WHEN / INSTEAD OF)
```

## 行数最大的几个包体

| 文件 | 行数 | 重点要素 |
|---|---|---|
| `inventory_pkg_body.sql` | 573 | 重载、FORALL SAVE EXCEPTIONS、窗口 FIFO + WHERE CURRENT OF、MERGE、RETURNING、NOCOPY |
| `procurement_pkg_body.sql` | 532 | PO 状态机、收货过账、按供应商归并 bulk、补货游标、RANK 排名 |
| `mrp_pkg_body.sql` | 457 | 低层码、逐层净算、递归展开相关需求、FORALL + MERGE、滚动窗口投影 |
| `bom_pkg_body.sql` | 431 | 三种递归展开(CONNECT BY/递归子程序/递归 CTE)、MULTISET 版本比对、pipelined |
| `pricing_pkg_body.sql` | 307 | 多维阶梯命中、四种规则类型、WHERE CURRENT OF 重定价 |
| `report_pkg_body.sql` | 269 | PIVOT、LISTAGG、ROLLUP/CUBE/GROUPING、NTILE、RANK、RATIO_TO_REPORT |
| `item_pkg_body.sql` | 255 | 对象子型多态构造、CONNECT BY 分类树、MERGE 重建树、窗口 ABC |

## 静态验证(sqlglot 30.8 oracle 方言)

```
files                 : 54   (.sql，不含两个 install)
词法错误(TokenError)  : 0
DDL/DML 解析成 AST    : 222   (真正解析错误: 0)
PL/SQL 单元           : 53    (括号/引号/begin-end 配平、终止符: 全通过)
范围分区 DDL          : 1     sqlglot 不支持 partition by range，与 bank_core_sql/txn.sql 同款限制
```

说明: sqlglot 无 PL/SQL 语法树,对 package/type/trigger body 一律降级为 Command 节点(对本库与 `bank_core_sql` 表现一致)。故 PL/SQL 部分改用词法 + 结构配平校验,DDL/DML 部分做完整 AST 解析。

## 要素 → 落点矩阵

### 对象类型 / 继承 / 集合

| 要素 | 落点 |
|---|---|
| 对象类型 + 成员方法 | `t_money`(plus/minus/scale_by/to_display)、`t_dimension`(volume/体积重)、`t_bom_comp_obj`、`t_alloc_obj` |
| MAP 方法(对象排序) | `t_money.sort_key`(map member function) |
| 类型继承 UNDER / NOT FINAL | `t_item_obj`(not instantiable not final) ← `t_raw_material_obj` / `t_finished_good_obj` / `t_service_item_obj` |
| OVERRIDING 成员方法 | 三个子型覆写 `valuation_method` / `is_stockable` / `lead_time_days` |
| 对象子型多态构造 | `item_pkg.get_item_obj` 按 item_type 实例化子型，返回基类引用 |
| VARRAY | `t_tag_varray`,作 `t_item.tags` 列 |
| 嵌套表(对象集合) | `t_bom_comp_tab` / `t_alloc_tab` / `t_explosion_tab` |
| 对象列(表内嵌) | `t_item.dim t_dimension`、`t_item.tags t_tag_varray` |
| 对象方法在 SQL 中调用 | `v_item_full` 视图调 `dim.volume_cm3()` |
| MULTISET EXCEPT / INTERSECT | `bom_pkg.compare_versions`(BOM 版本差异) |
| TABLE() 解嵌套 | `bom_pkg.compare_versions`、`get_components` 返回的集合 |
| 集合方法 EXTEND / COUNT | `bom_pkg.explode_table`、`inventory_pkg.issue_stock` |

### 递归与层级

| 要素 | 落点 |
|---|---|
| CONNECT BY + START WITH + NOCYCLE | `bom_pkg.explode`(正向)、`where_used`(反查)、`item_pkg.list_category_subtree` |
| SYS_CONNECT_BY_PATH | `bom_pkg.explode` / `where_used`、`item_pkg.get_category_path` |
| CONNECT_BY_ISLEAF / CONNECT_BY_ROOT / LEVEL | `bom_pkg.explode`、`item_pkg.list_category_subtree` |
| ORDER SIBLINGS BY | `bom_pkg.explode` / `where_used` |
| 递归子程序(局部过程自调) | `bom_pkg.explode_table` 内的 `walk`(EXTEND + 环路检测) |
| 递归 CTE(recursive WITH) | `bom_pkg.explode_cte` |
| 递归独立函数 | `fn_bom_unit_cost`、`bom_pkg` 私有 `unit_cost`(成本卷算) |
| 低层码 + 逐层净算 | `mrp_pkg.compute_low_level_codes` / `run_mrp` |

### 分析函数与集合写

| 要素 | 落点 |
|---|---|
| 窗口 SUM/AVG OVER(累计/滚动) | `costing_pkg.fifo_layers`、`report_pkg.inventory_pareto`、`forecast_pkg.forecast_accuracy`、`mrp_pkg.netting_detail` |
| RANK / DENSE_RANK / ROW_NUMBER | `procurement_pkg.supplier_ranking`、`report_pkg.top_consumed_items`、`pricing_pkg.list_effective_rules` |
| RATIO_TO_REPORT | `costing_pkg.inventory_value`、`report_pkg.inventory_pareto` |
| NTILE | `report_pkg.stock_aging`(四分位) |
| LAG / LEAD(环比) | `forecast_pkg.forecast_accuracy`(上/下期实绩 + 需求环比 mom_growth) |
| FETCH FIRST n ROWS | `report_pkg.top_consumed_items` |
| PIVOT(静态) | `report_pkg.inventory_by_warehouse` |
| LISTAGG | `report_pkg.bom_component_list` |
| ROLLUP / CUBE / GROUPING(_ID) | `report_pkg.sales_summary` |
| MERGE(upsert) | `inventory_pkg`(余额)、`item_pkg.rebuild_category_tree`/`reclassify_abc`、`costing_pkg.roll_standard_cost`、`mrp_pkg.run_mrp`、`forecast_pkg.generate_forecast` |
| RETURNING INTO | `inventory_pkg.receive_stock`(取回 lot_id) |
| WHERE CURRENT OF | `inventory_pkg.issue_stock`、`pricing_pkg.reprice_sales_order`、`procurement_pkg.reorder_scan` |
| BULK COLLECT(+ LIMIT) | `bom_pkg.get_components`、`procurement_pkg.create_po_from_mrp` |
| FORALL | `mrp_pkg.run_mrp`(forall + merge)、`inventory_pkg` |
| FORALL SAVE EXCEPTIONS + %BULK_EXCEPTIONS | `inventory_pkg.bulk_receive` |

### 转译杀手级

| 要素 | 落点 |
|---|---|
| MODEL 子句(rules / iterate / cv) | `forecast_pkg.generate_forecast`(滚动预测 MA3/MA6/TREND) |
| DBMS_SQL 动态 SQL(parse/bind/to_refcursor) | `forecast_pkg.pivot_demand_dynamic`(列数编译期未知的动态透视) |
| EXECUTE IMMEDIATE(动态 DDL + 绑定 DML) | `inventory_pkg.archive_txns_before`(运行期拼归档表名,动态建表/搬数/清理) |
| WITH FUNCTION(SQL 内联 PL/SQL) | `costing_pkg.landed_cost_report`(运费/关税分摊) |
| 复合触发器(compound) | `trg_inv_txn`(语句级净变动审计,规避变异表) |
| INSTEAD OF 触发器(视图 DML) | `trg_v_item_full`(拍平字段拼回对象列写主表) |
| 行级触发器 + WHEN 子句 + :OLD/:NEW | `trg_item_audit` |
| 条件编译 `$IF ... $THEN` | `util_pkg.convert_qty`(trace 代码受 `c_trace_compile` 静态布尔常量控制) |
| DBMS_SCHEDULER 作业 | `sched_pkg`(每日 MRP / 每月预测,create_job/run_job/drop_job) |
| 子程序重载(overload) | `util_pkg.get_param`(按默认值类型 ×3)、`inventory_pkg.receive_stock`(按 id / 编码) |
| NOCOPY 大集合出参 | `inventory_pkg.issue_stock`(out nocopy t_alloc_tab) |

### 与 bank_core_sql 同样覆盖(延续)

| 要素 | 落点 |
|---|---|
| 自治事务(autonomous_transaction) | `exc_pkg.log_error` |
| PRAGMA EXCEPTION_INIT + 自定义异常 + RAISE_APPLICATION_ERROR | `exc_pkg`(24 个异常) |
| 包级全局变量 + 包初始化块 | `util_pkg`(业务日期/单位缓存) |
| 关联数组(index by) | `util_pkg`、`mrp_pkg`、`bom_pkg`、`inventory_pkg` |
| RECORD 类型 + 集合做入参 | `inventory_pkg.t_recv_line/t_recv_tab` |
| REF CURSOR(sys_refcursor) | 各 report / list / 查询类过程 |
| %TYPE / %ROWTYPE | 全部业务包 |
| 范围分区表 | `t_inventory_txn`(按季) |
| FOR UPDATE 行锁 + 乐观锁 version | `inventory_pkg`(批次 for update of、余额 version) |
| 状态机 | `procurement_pkg`(PO)、生产工单状态 |

## sql2java 测试时建议优先看的"坑点"

1. **对象继承 `t_item_obj` + OVERRIDING + 多态构造** → Java 抽象基类 + 子类,`get_item_obj` 的工厂分派 → 多态;`valuation_method()` 这类是策略模式候选。
2. **对象列 `t_item.dim/tags` + 视图里 `dim.volume_cm3()`** → JDBC/MyBatis 不直接支持对象列,需 TypeHandler 或拍平 DO(见 `trg_v_item_full` 的拍平逻辑)。
3. **`bom_pkg` 三种等价递归** → 三种 Java 目标对照: CONNECT BY/递归 CTE → 递归 SQL 或 MyBatis 递归 mapper;递归子程序 `walk` → Java 递归方法。同一业务三实现,适合校验转译器对递归的识别。
4. **MULTISET EXCEPT/INTERSECT(`compare_versions`)** → Java 端集合差/交(`Set.removeAll`)或 SQL 改写,JDBC 无 multiset。
5. **`forecast_pkg.generate_forecast` 的 MODEL 子句** → 近乎无法纯 SQL 直译,应转为 Java 端按期迭代计算(`MERGE` 部分可保留)。
6. **`forecast_pkg.pivot_demand_dynamic` 的 DBMS_SQL 动态透视** → 列数运行时才知,对应 Java 动态拼 SQL / `JdbcTemplate` + 动态列 RowMapper。
7. **`costing_pkg.landed_cost_report` 的 WITH FUNCTION** → 内联 PL/SQL 需提到 Java service 方法或独立 SQL 函数。
8. **`inventory_pkg.bulk_receive` 的 FORALL SAVE EXCEPTIONS** → MyBatis batch executor + 单行异常收集,不能错翻成逐条循环吞异常。
9. **`inventory_pkg.issue_stock` 的窗口 FIFO + WHERE CURRENT OF** → 游标定位扣减改成"查可用层 + 批量更新",注意 NOCOPY 出参语义。
10. **`util_pkg.get_param` / `inventory_pkg.receive_stock` 重载** → Java 方法重载,按参数类型分派。
11. **`util_pkg` 的 `$IF` 条件编译** → 编译期开关,Java 侧无对应,通常落成日志级别/配置开关。
12. **复合触发器 `trg_inv_txn` / INSTEAD OF `trg_v_item_full`** → AOP 拦截 / MyBatis Interceptor / 视图写转 service。
13. **`exc_pkg.log_error` 自治事务** → `@Transactional(propagation = REQUIRES_NEW)`。
14. **`util_pkg` 包级全局 + 初始化块** → 不能错翻成 static 常量;初始化块语义近似 `@PostConstruct` 但非完全等价。
