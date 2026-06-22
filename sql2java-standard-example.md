# SQL 存储过程 → MyBatis 改写：完整实战

## 一、存储过程是什么？

存储过程是**预编译并存储在数据库中的一段 SQL 程序**，可以包含：
- 变量声明、条件判断、循环
- 游标遍历
- 事务控制
- 调用其他存储过程
- 异常处理

本质上就是一个**跑在数据库里的"函数"**。

---

## 二、一个复杂的存储过程示例

假设有一个电商订单系统，存储过程 `sp_process_order` 做了这些事情：

```sql
-- =============================================
-- 存储过程：处理订单（下单 + 扣库存 + 计算折扣 + 记录日志）
-- =============================================
CREATE PROCEDURE sp_process_order(
    IN  p_customer_id   BIGINT,
    IN  p_coupon_code   VARCHAR(32),
    OUT p_order_id      BIGINT,
    OUT p_total_amount  DECIMAL(12,2),
    OUT p_result_code   INT
)
BEGIN
    DECLARE v_discount_rate  DECIMAL(4,2) DEFAULT 0.00;
    DECLARE v_coupon_id      BIGINT DEFAULT NULL;
    DECLARE v_stock_enough   INT DEFAULT 1;
    DECLARE v_item_price     DECIMAL(10,2);
    DECLARE v_quantity       INT;
    DECLARE v_product_id     BIGINT;

    -- 游标：遍历购物车中的商品
    DECLARE cart_cursor CURSOR FOR
        SELECT ci.product_id, ci.quantity, p.price
        FROM cart_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.customer_id = p_customer_id
          AND ci.is_deleted = 0;

    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_result_code = -1;  -- 系统异常
    END;

    SET p_result_code = 0;

    -- ========== 1. 检查并锁定优惠券 ==========
    SELECT id, discount_rate INTO v_coupon_id, v_discount_rate
    FROM coupons
    WHERE code = p_coupon_code
      AND status = 'ACTIVE'
      AND expire_time > NOW()
    LIMIT 1;

    IF v_coupon_id IS NULL THEN
        SET p_result_code = 1001;  -- 优惠券无效
    END IF;

    -- ========== 2. 校验库存（游标遍历） ==========
    OPEN cart_cursor;
    stock_check: LOOP
        FETCH cart_cursor INTO v_product_id, v_quantity, v_item_price;
        IF done THEN
            LEAVE stock_check;
        END IF;

        SELECT COUNT(1) INTO v_stock_enough
        FROM inventory
        WHERE product_id = v_product_id
          AND available_qty >= v_quantity;

        IF v_stock_enough = 0 THEN
            CLOSE cart_cursor;
            SET p_result_code = 1002;  -- 库存不足
        END IF;
    END LOOP;
    CLOSE cart_cursor;

    IF p_result_code <> 0 THEN
        -- 提前退出（优惠券无效或库存不足，不在事务中）
        RETURN;
    END IF;

    -- ========== 3. 开启事务 ==========
    START TRANSACTION;

    -- 3a. 创建订单主记录
    INSERT INTO orders (customer_id, status, total_amount, coupon_id, created_at)
    VALUES (p_customer_id, 'CREATED', 0.00, v_coupon_id, NOW());
    SET p_order_id = LAST_INSERT_ID();

    -- 3b. 遍历购物车，创建订单明细 + 扣库存 + 累加金额
    SET p_total_amount = 0.00;

    OPEN cart_cursor;
    item_loop: LOOP
        FETCH cart_cursor INTO v_product_id, v_quantity, v_item_price;
        IF done THEN
            LEAVE item_loop;
        END IF;

        -- 插入订单明细
        INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal)
        VALUES (p_order_id, v_product_id, v_quantity, v_item_price,
                v_quantity * v_item_price);

        -- 扣减库存
        UPDATE inventory
        SET available_qty = available_qty - v_quantity,
            locked_qty    = locked_qty + v_quantity
        WHERE product_id = v_product_id;

        -- 累加总金额
        SET p_total_amount = p_total_amount + (v_quantity * v_item_price);
    END LOOP;
    CLOSE cart_cursor;

    -- 3c. 应用折扣
    IF v_discount_rate > 0 THEN
        SET p_total_amount = p_total_amount * (1 - v_discount_rate / 100);

        -- 标记优惠券已使用
        UPDATE coupons
        SET status = 'USED', used_at = NOW(), used_by = p_customer_id
        WHERE id = v_coupon_id;
    END IF;

    -- 3d. 更新订单总金额
    UPDATE orders
    SET total_amount = p_total_amount
    WHERE id = p_order_id;

    -- 3e. 清空购物车
    UPDATE cart_items
    SET is_deleted = 1
    WHERE customer_id = p_customer_id;

    -- 3f. 记录操作日志
    INSERT INTO order_audit_log (order_id, action, operator_id, created_at)
    VALUES (p_order_id, 'CREATE_ORDER', p_customer_id, NOW());

    COMMIT;
    SET p_result_code = 0;  -- 成功
END;
```

这个存储过程涉及 **5 张表**，有**事务、游标、条件分支、OUT 参数**。

---

## 三、依赖的表结构 → Entity / DO

先把所有涉及的表识别出来，逐一建立映射：

```
┌─────────────────────────────────────────────────────────────┐
│                    存储过程涉及的表                          │
├──────────────┬──────────────────────────────────────────────┤
│ orders       │ 订单主表（INSERT + UPDATE）                  │
│ order_items  │ 订单明细（INSERT）                           │
│ cart_items   │ 购物车（SELECT + UPDATE）                    │
│ products     │ 商品（SELECT）                               │
│ inventory    │ 库存（SELECT + UPDATE）                      │
│ coupons      │ 优惠券（SELECT + UPDATE）                    │
│ order_audit_log │ 操作日志（INSERT）                        │
└──────────────┴──────────────────────────────────────────────┘
```

### 3.1 DO（Data Object）— 与表字段一一对应

```java
// ============ orders 表 ============
@Data
@TableName("orders")
public class OrderDO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long customerId;
    private String status;        // CREATED, PAID, SHIPPED, ...
    private BigDecimal totalAmount;
    private Long couponId;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}

// ============ order_items 表 ============
@Data
@TableName("order_items")
public class OrderItemDO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long orderId;
    private Long productId;
    private Integer quantity;
    private BigDecimal unitPrice;
    private BigDecimal subtotal;
}

// ============ cart_items 表 ============
@Data
@TableName("cart_items")
public class CartItemDO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long customerId;
    private Long productId;
    private Integer quantity;
    private Integer isDeleted;
}

// ============ products 表 ============
@Data
@TableName("products")
public class ProductDO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String name;
    private BigDecimal price;
    private Integer status;
}

// ============ inventory 表 ============
@Data
@TableName("inventory")
public class InventoryDO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long productId;
    private Integer availableQty;
    private Integer lockedQty;
}

// ============ coupons 表 ============
@Data
@TableName("coupons")
public class CouponDO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String code;
    private String status;           // ACTIVE, USED, EXPIRED
    private BigDecimal discountRate;
    private LocalDateTime expireTime;
    private LocalDateTime usedAt;
    private Long usedBy;
}

// ============ order_audit_log 表 ============
@Data
@TableName("order_audit_log")
public class OrderAuditLogDO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long orderId;
    private String action;
    private Long operatorId;
    private LocalDateTime createdAt;
}
```

### 3.2 Entity（业务层对象）— 面向业务逻辑

```java
/**
 * 订单业务实体 —— 和数据库表不是 1:1 映射，
 * 而是聚合根，包含订单 + 明细 + 优惠券信息
 */
@Data
public class OrderEntity {
    private Long orderId;
    private Long customerId;
    private String status;
    private BigDecimal totalAmount;
    private BigDecimal discountRate;

    // 聚合的子对象
    private List<OrderItemEntity> items;
    private CouponEntity coupon;

    @Data
    public static class OrderItemEntity {
        private Long productId;
        private String productName;
        private Integer quantity;
        private BigDecimal unitPrice;
        private BigDecimal subtotal;
    }

    @Data
    public static class CouponEntity {
        private Long couponId;
        private String code;
        private BigDecimal discountRate;
    }
}
```

### 3.3 DTO（接口层传参/返回）

```java
/** 下单请求 */
@Data
public class CreateOrderRequest {
    @NotNull
    private Long customerId;
    private String couponCode;
}

/** 下单结果 */
@Data
public class CreateOrderResult {
    private int resultCode;       // 0=成功, 1001=优惠券无效, 1002=库存不足, -1=异常
    private Long orderId;
    private BigDecimal totalAmount;
}
```

---

## 四、Mapper XML — 替代存储过程中的每一条 SQL

存储过程被拆成多个独立的 SQL 语句，分散在 Mapper XML 中：

```xml
<!-- OrderMapper.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
    "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.mapper.OrderMapper">

    <!-- 1. 查询购物车（对应游标部分） -->
    <select id="selectCartItems" resultType="CartItemDO">
        SELECT ci.product_id, ci.quantity, p.price AS unit_price
        FROM cart_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.customer_id = #{customerId}
          AND ci.is_deleted = 0
    </select>

    <!-- 2. 查询并锁定优惠券 -->
    <select id="selectActiveCoupon" resultType="CouponDO">
        SELECT id, discount_rate
        FROM coupons
        WHERE code = #{couponCode}
          AND status = 'ACTIVE'
          AND expire_time > NOW()
        LIMIT 1
    </select>

    <!-- 3. 校验库存是否充足 -->
    <select id="checkStock" resultType="int">
        SELECT COUNT(1)
        FROM inventory
        WHERE product_id = #{productId}
          AND available_qty >= #{quantity}
    </select>

    <!-- 4. 创建订单主记录 -->
    <insert id="insertOrder" useGeneratedKeys="true" keyProperty="id">
        INSERT INTO orders (customer_id, status, total_amount, coupon_id, created_at)
        VALUES (#{customerId}, 'CREATED', 0.00, #{couponId}, NOW())
    </insert>

    <!-- 5. 插入订单明细 -->
    <insert id="insertOrderItem">
        INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal)
        VALUES (#{orderId}, #{productId}, #{quantity}, #{unitPrice}, #{subtotal})
    </insert>

    <!-- 6. 扣减库存 -->
    <update id="deductInventory">
        UPDATE inventory
        SET available_qty = available_qty - #{quantity},
            locked_qty    = locked_qty + #{quantity}
        WHERE product_id = #{productId}
    </update>

    <!-- 7. 标记优惠券已使用 -->
    <update id="useCoupon">
        UPDATE coupons
        SET status = 'USED', used_at = NOW(), used_by = #{customerId}
        WHERE id = #{couponId}
    </update>

    <!-- 8. 更新订单总金额 -->
    <update id="updateOrderTotal">
        UPDATE orders SET total_amount = #{totalAmount} WHERE id = #{orderId}
    </update>

    <!-- 9. 清空购物车 -->
    <update id="clearCart">
        UPDATE cart_items SET is_deleted = 1 WHERE customer_id = #{customerId}
    </update>

    <!-- 10. 记录审计日志 -->
    <insert id="insertAuditLog">
        INSERT INTO order_audit_log (order_id, action, operator_id, created_at)
        VALUES (#{orderId}, #{action}, #{operatorId}, NOW())
    </insert>
</mapper>
```

### Mapper 接口

```java
@Mapper
public interface OrderMapper {

    List<CartItemDO> selectCartItems(@Param("customerId") Long customerId);

    CouponDO selectActiveCoupon(@Param("couponCode") String couponCode);

    int checkStock(@Param("productId") Long productId, @Param("quantity") Integer quantity);

    void insertOrder(OrderDO order);  // useGeneratedKeys 会回填 id

    void insertOrderItem(OrderItemDO item);

    void deductInventory(@Param("productId") Long productId, @Param("quantity") Integer quantity);

    void useCoupon(@Param("couponId") Long couponId, @Param("customerId") Long customerId);

    void updateOrderTotal(@Param("orderId") Long orderId, @Param("totalAmount") BigDecimal totalAmount);

    void clearCart(@Param("customerId") Long customerId);

    void insertAuditLog(OrderAuditLogDO log);
}
```

---

## 五、Service 层 — 用 Java 编排存储过程的逻辑

**存储过程的"控制流"全部搬到 Service 中**：事务、游标循环、条件判断都在这里：

```java
@Service
@Slf4j
public class OrderService {

    @Autowired
    private OrderMapper orderMapper;

    /**
     * 处理下单 —— 完整替代 sp_process_order 存储过程
     *
     * 核心思路：存储过程的每个步骤 → 一个 Mapper 调用
     *           存储过程的事务    → @Transactional
     *           存储过程的游标    → Java for 循环
     *           存储过程的 IF     → Java if
     *           存储过程的 OUT    → 返回值对象
     */
    @Transactional(rollbackFor = Exception.class)   // ← 对应 START TRANSACTION ... COMMIT/ROLLBACK
    public CreateOrderResult processOrder(CreateOrderRequest request) {
        CreateOrderResult result = new CreateOrderResult();

        // ========== 1. 查询并校验优惠券（对应存储过程第1步） ==========
        BigDecimal discountRate = BigDecimal.ZERO;
        Long couponId = null;

        if (StringUtils.isNotBlank(request.getCouponCode())) {
            CouponDO coupon = orderMapper.selectActiveCoupon(request.getCouponCode());
            if (coupon == null) {
                result.setResultCode(1001);  // 优惠券无效
                return result;
            }
            couponId = coupon.getId();
            discountRate = coupon.getDiscountRate();
        }

        // ========== 2. 查询购物车 + 校验库存（对应游标遍历） ==========
        List<CartItemDO> cartItems = orderMapper.selectCartItems(request.getCustomerId());

        if (cartItems.isEmpty()) {
            result.setResultCode(1003);  // 购物车为空
            return result;
        }

        // 检查每件商品库存（替代存储过程中的游标循环检查）
        for (CartItemDO item : cartItems) {
            int stockAvailable = orderMapper.checkStock(item.getProductId(), item.getQuantity());
            if (stockAvailable == 0) {
                result.setResultCode(1002);  // 库存不足
                return result;               // @Transactional 会自动 ROLLBACK
            }
        }

        // ========== 3. 创建订单主记录（对应 INSERT INTO orders） ==========
        OrderDO order = new OrderDO();
        order.setCustomerId(request.getCustomerId());
        order.setStatus("CREATED");
        order.setTotalAmount(BigDecimal.ZERO);
        order.setCouponId(couponId);
        orderMapper.insertOrder(order);  // id 自动回填

        Long orderId = order.getId();

        // ========== 4. 遍历购物车 → 插入明细 + 扣库存 + 累加金额 ==========
        BigDecimal totalAmount = BigDecimal.ZERO;

        for (CartItemDO item : cartItems) {
            BigDecimal subtotal = item.getUnitPrice().multiply(BigDecimal.valueOf(item.getQuantity()));

            // 4a. 插入订单明细
            OrderItemDO orderItem = new OrderItemDO();
            orderItem.setOrderId(orderId);
            orderItem.setProductId(item.getProductId());
            orderItem.setQuantity(item.getQuantity());
            orderItem.setUnitPrice(item.getUnitPrice());
            orderItem.setSubtotal(subtotal);
            orderMapper.insertOrderItem(orderItem);

            // 4b. 扣减库存
            orderMapper.deductInventory(item.getProductId(), item.getQuantity());

            // 4c. 累加金额
            totalAmount = totalAmount.add(subtotal);
        }

        // ========== 5. 应用折扣（对应 IF v_discount_rate > 0） ==========
        if (discountRate.compareTo(BigDecimal.ZERO) > 0) {
            totalAmount = totalAmount.multiply(
                BigDecimal.ONE.subtract(discountRate.divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_UP))
            );
            // 标记优惠券已使用
            orderMapper.useCoupon(couponId, request.getCustomerId());
        }

        // ========== 6. 更新订单总金额 ==========
        orderMapper.updateOrderTotal(orderId, totalAmount);

        // ========== 7. 清空购物车 ==========
        orderMapper.clearCart(request.getCustomerId());

        // ========== 8. 记录审计日志 ==========
        OrderAuditLogDO auditLog = new OrderAuditLogDO();
        auditLog.setOrderId(orderId);
        auditLog.setAction("CREATE_ORDER");
        auditLog.setOperatorId(request.getCustomerId());
        orderMapper.insertAuditLog(auditLog);

        // ========== 9. 返回结果（对应 OUT 参数） ==========
        result.setResultCode(0);
        result.setOrderId(orderId);
        result.setTotalAmount(totalAmount);
        return result;
    }
}
```

---

## 六、依赖关系全景图

```
┌─────────────────────────────────────────────────────────────────────┐
│                      存储过程 → Java 改写映射                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   SQL 存储过程                      Java 工程                       │
│   ────────────                      ──────────                       │
│                                                                     │
│   表结构                         →  DO (Data Object)                │
│   ┌───────────────┐                ┌───────────────┐                │
│   │ orders        │                │ OrderDO       │                │
│   │ order_items   │     1:1        │ OrderItemDO   │                │
│   │ cart_items    │   ──────→      │ CartItemDO    │                │
│   │ products      │                │ ProductDO     │                │
│   │ inventory     │                │ InventoryDO   │                │
│   │ coupons       │                │ CouponDO      │                │
│   │ order_audit   │                │ OrderAuditDO  │                │
│   └───────────────┘                └───────────────┘                │
│         │                                │                          │
│         │                          聚合/组合关系                      │
│         │                                ↓                          │
│         │                          Entity (业务实体)                 │
│         │                          ┌───────────────┐                │
│         │                          │ OrderEntity   │                │
│         │                          │  ├─items[]    │                │
│         │                          │  └─coupon     │                │
│         │                          └───────────────┘                │
│         │                                │                          │
│         ↓                                ↓                          │
│   SQL 语句                       Mapper XML + Mapper Interface      │
│   ┌───────────────┐                ┌───────────────┐                │
│   │ SELECT ...    │                │ <select>      │                │
│   │ INSERT ...    │     1:1        │ <insert>      │                │
│   │ UPDATE ...    │   ──────→      │ <update>      │                │
│   └───────────────┘                └───────────────┘                │
│         │                                │                          │
│         │                          方法调用关系                      │
│         │                                ↓                          │
│   控制流                          Service (业务编排层)               │
│   ┌───────────────┐                ┌───────────────┐                │
│   │ 游标 LOOP     │                │ for 循环      │                │
│   │ IF ... THEN   │     改写为     │ if / switch   │                │
│   │ DECLARE var   │   ──────→      │ 局部变量      │                │
│   │ START TRANS   │                │ @Transactional│                │
│   │ COMMIT/ROLLBACK│               │ 自动提交/回滚  │                │
│   │ OUT 参数      │                │ 返回值对象     │                │
│   │ SQLEXCEPTION  │                │ try-catch     │                │
│   └───────────────┘                └───────────────┘                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 七、核心对应关系速查表

| 存储过程概念 | MyBatis + Java 对应 | 说明 |
|---|---|---|
| `IN` 参数 | Service 方法参数 | 直接传入 |
| `OUT` 参数 | 返回值对象（DTO/Result） | Java 没有 OUT，用 return |
| `DECLARE v_xxx` | Java 局部变量 | 类型映射：`INT→Integer`，`BIGINT→Long`，`DECIMAL→BigDecimal`，`VARCHAR→String`，`DATETIME→LocalDateTime` |
| `CURSOR ... LOOP` | `List<XxxDO> + for` 循环 | 先 SELECT 全部，再遍历 |
| `IF ... THEN ... END IF` | `if { } else { }` | 直接改写 |
| `SELECT ... INTO` | `mapper.selectXxx()` | 单条用对象接收，多条用 List |
| `INSERT/UPDATE/DELETE` | `mapper.insertXxx()` 等 | 影响行数从返回值获取 |
| `LAST_INSERT_ID()` | `useGeneratedKeys=true` | 自增主键回填到 DO 的 id 字段 |
| `START TRANSACTION` | `@Transactional` | 声明式事务 |
| `COMMIT / ROLLBACK` | Spring 自动管理 | 异常自动回滚 |
| `DECLARE CONTINUE HANDLER` | `try-catch` + `@Transactional` | 捕获异常后回滚 |
| `CALL sp_other()` | 注入其他 Service 调用 | 存储过程间调用 → Service 间调用 |

---

## 八、改写的核心难点和注意事项

### 1. 类型映射必须准确

```
SQL 类型           →  Java 类型
─────────────────────────────────
TINYINT            →  Integer (不是 Byte!)
SMALLINT           →  Integer
INT / INTEGER      →  Integer
BIGINT             →  Long
DECIMAL(p,s)       →  BigDecimal (不要用 Double!)
VARCHAR(n)         →  String
CHAR(n)            →  String
DATETIME/TIMESTAMP →  LocalDateTime
DATE               →  LocalDate
BIT/BOOLEAN        →  Boolean
```

### 2. 游标 → 批量查询 + Java 循环

存储过程中游标是一行一行 fetch 的，Java 中通常**一次查出所有行再用 for 循环**。如果数据量巨大，考虑分页查询或 MyBatis 的 `ResultHandler` 流式读取。

### 3. 事务边界

存储过程的事务是数据库级别的，Java 中用 `@Transactional` 保证。注意：
- 同一个 Service 内的方法调用 `@Transactional` 才生效（Spring 代理机制）
- 如果校验阶段（库存检查）不需要回滚，可以把校验逻辑放在事务外

### 4. 并发问题

存储过程中 `SELECT ... FOR UPDATE` 是悲观锁，Java 中同样在 Mapper XML 中使用 `FOR UPDATE`。上面的库存扣减示例，在生产中应改为：

```xml
<!-- 悲观锁：先锁再扣 -->
<update id="deductInventory">
    UPDATE inventory
    SET available_qty = available_qty - #{quantity},
        locked_qty    = locked_qty + #{quantity}
    WHERE product_id = #{productId}
      AND available_qty >= #{quantity}   <!-- 乐观保护 -->
</update>
```

检查返回的影响行数，如果为 0 说明并发冲突。

---

**总结一句话**：存储过程改写 MyBatis 的本质就是——**SQL 语句拆到 Mapper XML，控制流（事务/循环/判断）搬到 Java Service，表结构映射为 DO 对象**。难点不在语法转换，而在识别存储过程的隐含语义（事务边界、锁、异常处理）并正确地在 Java 中表达。
