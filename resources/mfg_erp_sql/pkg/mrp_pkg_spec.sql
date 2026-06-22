-- MRP 物料需求计划
-- 低层码(low-level code): 一个物料可能出现在多层 BOM，净算必须等它在所有上层的毛需求
-- 都汇齐了再算，所以先按 BOM 深度给每个物料定低层码，再自顶向下(低层码升序)逐层净算
-- 主流程: 收集独立需求(预测+销售订单) -> 逐层展开相关需求(递归 BOM) -> 净算 -> 产计划行
-- 计划行 merge 进 t_mrp_plan，相关需求展开靠 bom_pkg.explode

create or replace package mrp_pkg as

    -- 重算所有物料的低层码: 反复沿 BOM 下钻取每个物料的最大深度
    -- 计划净算严格按低层码升序，否则下层毛需求会算漏
    procedure compute_low_level_codes;

    -- 主流程: 一次 MRP 运行
    --   1) 建运行头 t_mrp_run
    --   2) 收集顶层独立需求(t_demand_forecast 未来期 + t_sales_order 未发货)
    --   3) 按低层码逐层: 毛需求 - 在手 - 在途 = 净需求 -> 计划下单(含提前期倒排)
    --   4) 相关需求按 bom_pkg.explode 下放到子件
    --   5) 计划行 merge 进 t_mrp_plan，回写运行头统计
    procedure run_mrp(
        p_run_date     in  date    default null,
        p_horizon_days in  number  default null,
        p_run_id       out number
    );

    -- 单物料净算明细(供排查): 时段桶上滚动投影在手量
    procedure netting_detail(
        p_run_id  in  number,
        p_item_id in  number,
        p_cur     out sys_refcursor
    );

    -- 把净需求转成生产工单(成品/半成品)或留给采购(原材料)
    procedure release_planned_orders(
        p_run_id      in  number,
        p_prod_count  out number
    );

end mrp_pkg;
/
