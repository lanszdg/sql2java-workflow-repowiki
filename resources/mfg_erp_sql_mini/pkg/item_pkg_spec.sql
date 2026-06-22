-- 物料主数据 + 分类树
-- get_item_obj 按 item_type 构造对应对象子型(RAW/FG)，返回基类引用供上层多态调用
-- 分类树操作集中走 connect by: 取路径、取子树、重算 level_no/path/is_leaf

create or replace package item_pkg as

    function get_item_obj(p_item_id in number) return t_item_obj;
    function get_item(p_item_id in number) return t_item%rowtype;
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

    function get_category_path(p_category_id in number) return varchar2;

    procedure list_category_subtree(
        p_root_category_id in  number,
        p_cur              out sys_refcursor
    );

    procedure rebuild_category_tree;

    procedure reclassify_abc(p_from_date in date, p_to_date in date);

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
