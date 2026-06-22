-- 物料主数据 + 分类树
-- get_item_obj 按 item_type 构造对应对象子型(RAW/SEMI/FG/SVC)，返回基类引用供上层多态调用
-- 分类树操作集中走 connect by: 取路径、取子树、重算 level_no/path/is_leaf

create or replace package item_pkg as

    -- 取物料对象: 按 item_type 实例化 t_item_obj 的子型(对象继承多态入口)
    -- 上层拿到基类引用后调 valuation_method/is_stockable/lead_time_days 走动态分派
    function get_item_obj(p_item_id in number) return t_item_obj;

    -- 取物料行(轻量)，找不到抛 e_item_not_found
    function get_item(p_item_id in number) return t_item%rowtype;

    -- 编码查 id，重载: 既支持 item_code 也支持(类型,关键词)模糊
    function find_item_id(p_item_code in varchar2) return number;

    procedure create_item(
        p_item_code      in  varchar2,
        p_item_name      in  varchar2,
        p_item_type      in  varchar2,
        p_category_id    in  number,
        p_base_uom       in  varchar2,
        p_std_cost       in  number   default 0,
        p_dim            in  t_dimension default null,
        p_tags           in  t_tag_varray default null,
        p_item_id        out number
    );

    -- 分类路径: connect by + sys_connect_by_path 从根拼到本节点
    function get_category_path(p_category_id in number) return varchar2;

    -- 列出某节点整棵子树(含层级/是否叶/根路径)，connect by start with ... connect by prior
    procedure list_category_subtree(
        p_root_category_id in  number,
        p_cur              out sys_refcursor
    );

    -- 重算分类树的 level_no / path / is_leaf
    -- connect by 算出层级与路径后，用 merge 一次性回写(集合写)
    procedure rebuild_category_tree;

    -- 按累计消耗占比做 ABC 分类，窗口函数算累计占比后 merge 回写 t_item.abc_class
    -- 阈值取 t_app_param 的 ABC_A_PCT / ABC_B_PCT
    procedure reclassify_abc(p_from_date in date, p_to_date in date);

    -- 物料宽视图的 INSTEAD OF 触发器会调它把平铺字段拼回对象列后更新主表
    procedure apply_item_flat(
        p_item_id    in number,
        p_item_name  in varchar2,
        p_std_cost   in number,
        p_list_price in number,
        p_status     in varchar2,
        p_length_cm  in number,
        p_width_cm   in number,
        p_height_cm  in number,
        p_weight_kg  in number
    );

end item_pkg;
/
