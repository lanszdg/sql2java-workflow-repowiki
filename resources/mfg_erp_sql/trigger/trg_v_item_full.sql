-- 物料宽视图的 INSTEAD OF 触发器
-- v_item_full 是多表 join + 对象列拍平的视图，本身不可直接 DML
-- 前台维护界面对视图增改时，由本触发器拆解平铺字段、委托 item_pkg 拼回对象列写主表
-- 分类名/单位名等 join 出来的列只读，界面传了也忽略

create or replace trigger trg_v_item_full
instead of insert or update on v_item_full
for each row
begin
    if inserting then
        declare
            v_item_id number;
        begin
            item_pkg.create_item(
                p_item_code   => :new.item_code,
                p_item_name   => :new.item_name,
                p_item_type   => :new.item_type,
                p_category_id => :new.category_id,
                p_base_uom    => :new.base_uom,
                p_std_cost    => :new.std_cost,
                p_dim         => t_dimension(:new.length_cm, :new.width_cm,
                                             :new.height_cm, :new.weight_kg),
                p_item_id     => v_item_id);
        end;
    else
        item_pkg.apply_item_flat(
            p_item_id    => :old.item_id,
            p_item_name  => :new.item_name,
            p_std_cost   => :new.std_cost,
            p_list_price => :new.list_price,
            p_status     => :new.status,
            p_length_cm  => :new.length_cm,
            p_width_cm   => :new.width_cm,
            p_height_cm  => :new.height_cm,
            p_weight_kg  => :new.weight_kg);
    end if;
end;
/
