-- BOM 展开 / 反查 / 版本比对 / 成本卷算
-- 递归是本包主题，刻意给出三种等价展开实现压测 sql2java:
--   explode        -> connect by + pipelined，流式吐展开行
--   explode_table  -> 递归 PL/SQL 子程序(局部过程自调)，累积进嵌套表返回
--   explode_cte    -> 递归 with(recursive CTE)，返回 ref cursor
-- 虚拟件(is_phantom)展开时穿透不计为领料点；环路用 nocycle 兜底并抛 e_bom_cycle

create or replace package bom_pkg as

    -- 取某 BOM 的当层组件为对象嵌套表(bulk collect into 对象集合)
    function get_components(p_bom_id in number) return t_bom_comp_tab;

    -- 取物料当前生效的默认 ACTIVE BOM 头 id，无则抛 e_bom_no_active
    function get_active_bom_id(p_item_id in number, p_as_of in date default null) return number;

    -- 多层展开(connect by 版)，pipelined 流式返回
    -- 用 sys_connect_by_path 记路径，connect_by_isleaf 标叶子，level 记层级
    -- p_qty 为顶层需求量，cum_qty 自顶向下累乘(含损耗)
    function explode(
        p_item_id in number,
        p_qty     in number   default 1,
        p_as_of   in date     default null
    ) return t_explosion_tab pipelined;

    -- 多层展开(递归子程序版)，结果累积进嵌套表
    -- body 内定义局部递归过程 walk(...)，每层 extend 集合并自调下钻，演示递归子程序 + 集合扩展
    procedure explode_table(
        p_item_id in  number,
        p_qty     in  number   default 1,
        p_as_of   in  date     default null,
        p_result  out t_explosion_tab
    );

    -- 多层展开(递归 CTE 版)，返回 ref cursor 供应用层流式读
    procedure explode_cte(
        p_item_id in  number,
        p_qty     in  number   default 1,
        p_cur     out sys_refcursor
    );

    -- 反查: 某组件被哪些上层用到(单层 + 逐层向上 connect by)
    procedure where_used(
        p_component_id in  number,
        p_max_levels   in  number default null,
        p_cur          out sys_refcursor
    );

    -- 版本比对: 两个 BOM 的组件差异(新增/删除/用量变更)
    -- 各自取 t_bom_comp_tab，用 multiset except 求两向差集，multiset intersect 求交集后比用量
    procedure compare_versions(
        p_bom_id_old in  number,
        p_bom_id_new in  number,
        p_cur        out sys_refcursor
    );

    -- 标准成本卷算: 沿 BOM 树自底向上累加材料成本(递归)，返回单位成本
    -- 调用递归独立函数 fn_bom_unit_cost
    function rolled_cost(p_item_id in number, p_as_of in date default null) return number;

end bom_pkg;
/
