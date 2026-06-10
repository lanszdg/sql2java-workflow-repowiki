-- 值对象 + VARRAY + 继承体系 + 嵌套表
CREATE OR REPLACE TYPE t_dimension FORCE AS OBJECT (
  length_cm NUMBER(10,2), width_cm NUMBER(10,2), height_cm NUMBER(10,2), weight_kg NUMBER(10,3),
  MEMBER FUNCTION volume_cm3 RETURN NUMBER
);
/
CREATE OR REPLACE TYPE BODY t_dimension AS
  MEMBER FUNCTION volume_cm3 RETURN NUMBER IS
  BEGIN RETURN NVL(self.length_cm,0)*NVL(self.width_cm,0)*NVL(self.height_cm,0); END;
END;
/

CREATE OR REPLACE TYPE t_tag_varray FORCE AS VARRAY(20) OF VARCHAR2(30);
/

-- 抽象基类(not instantiable not final)
CREATE OR REPLACE TYPE t_item_obj FORCE AS OBJECT (
  item_id NUMBER(18), item_code VARCHAR2(40), item_name VARCHAR2(200),
  base_uom VARCHAR2(8), std_cost NUMBER(20,6),
  NOT INSTANTIABLE MEMBER FUNCTION valuation_method RETURN VARCHAR2,
  MEMBER FUNCTION describe RETURN VARCHAR2
) NOT INSTANTIABLE NOT FINAL;
/
CREATE OR REPLACE TYPE BODY t_item_obj AS
  MEMBER FUNCTION describe RETURN VARCHAR2 IS
  BEGIN RETURN self.item_code||' ['||self.valuation_method||']'; END;
END;
/

-- 子类(under + overriding)
CREATE OR REPLACE TYPE t_raw_material_obj FORCE UNDER t_item_obj (
  shelf_life_days NUMBER,
  OVERRIDING MEMBER FUNCTION valuation_method RETURN VARCHAR2,
  MEMBER FUNCTION needs_reorder(p_on_hand IN NUMBER) RETURN VARCHAR2
);
/
CREATE OR REPLACE TYPE BODY t_raw_material_obj AS
  OVERRIDING MEMBER FUNCTION valuation_method RETURN VARCHAR2 IS
  BEGIN RETURN 'FIFO'; END;
  MEMBER FUNCTION needs_reorder(p_on_hand IN NUMBER) RETURN VARCHAR2 IS
  BEGIN RETURN CASE WHEN NVL(p_on_hand,0)<=0 THEN 'Y' ELSE 'N' END; END;
END;
/

-- 嵌套表(用于 BULK COLLECT / MULTISET / PIPELINED 返回)
CREATE OR REPLACE TYPE t_bom_comp_obj FORCE AS OBJECT (
  component_item_id NUMBER(18), component_code VARCHAR2(40), qty_per NUMBER(18,6)
);
/
CREATE OR REPLACE TYPE t_bom_comp_tab FORCE AS TABLE OF t_bom_comp_obj;
/
