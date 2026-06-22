-- 物料尺寸/重量值对象，作为 t_item 的对象列内嵌存储
-- 体积重(volumetric weight)是物流计费常用口径: 体积(cm3)/5000，与实重取大者
-- 除数 5000 是空运惯例，海运/陆运不同，真实系统按承运商配置，这里固定示意

create or replace type t_dimension force as object (
    length_cm   number(10,2),
    width_cm    number(10,2),
    height_cm   number(10,2),
    weight_kg   number(10,3),

    member function volume_cm3 return number,
    member function volumetric_weight_kg return number,
    member function chargeable_weight_kg return number
);
/

create or replace type body t_dimension as

    member function volume_cm3 return number is
    begin
        return nvl(self.length_cm, 0) * nvl(self.width_cm, 0) * nvl(self.height_cm, 0);
    end volume_cm3;

    member function volumetric_weight_kg return number is
    begin
        return round(self.volume_cm3 / 5000, 3);
    end volumetric_weight_kg;

    member function chargeable_weight_kg return number is
    begin
        return greatest(nvl(self.weight_kg, 0), self.volumetric_weight_kg);
    end chargeable_weight_kg;

end;
/
