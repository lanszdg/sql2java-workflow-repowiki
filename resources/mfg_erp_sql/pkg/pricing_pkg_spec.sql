-- 定价引擎: 多维阶梯规则命中
-- 取价优先级: 客户专属价目表 > 默认表; 同表内按 priority 小者先命中
-- 规则可按 物料 / 分类 / 客户 任意组合限定，min_qty/max_qty 划数量阶梯
-- 与 bank 的 calc_fee 同思路但叠了多维匹配 + 四种规则类型，命中后按类型算最终价

create or replace package pricing_pkg as

    -- 取最终单价(命中规则后按类型算): LIST 直接取 / DISCOUNT_PCT 折扣 / DISCOUNT_AMT 减额 / OVERRIDE 一口价
    function get_price(
        p_item_id     in number,
        p_customer_id in number   default null,
        p_qty         in number   default 1,
        p_as_of       in date     default null
    ) return number;

    -- 取价明细: 基准价/最终价/命中规则/规则类型一并出参，便于销售单展示与审计
    procedure get_price_detail(
        p_item_id     in  number,
        p_customer_id in  number,
        p_qty         in  number,
        p_base_price  out number,
        p_final_price out number,
        p_rule_id     out number,
        p_rule_type   out varchar2
    );

    -- 对整张销售单重新定价: 游标遍历订单行，where current of 逐行回写单价与折扣
    procedure reprice_sales_order(p_so_id in number);

    -- 列出某物料/客户当前所有生效规则，按命中优先级排序(分析函数标注"是否会被选中")
    procedure list_effective_rules(
        p_item_id     in  number,
        p_customer_id in  number   default null,
        p_cur         out sys_refcursor
    );

end pricing_pkg;
/
