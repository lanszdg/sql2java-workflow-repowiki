-- DETERMINISTIC 独立函数
CREATE OR REPLACE FUNCTION fn_abc_class(
  p_cum_pct IN NUMBER,
  p_a_pct   IN NUMBER DEFAULT 0.80,
  p_b_pct   IN NUMBER DEFAULT 0.95
) RETURN VARCHAR2 DETERMINISTIC IS
BEGIN
  IF p_cum_pct IS NULL THEN RETURN NULL; END IF;
  IF p_cum_pct <= p_a_pct THEN RETURN 'A';
  ELSIF p_cum_pct <= p_b_pct THEN RETURN 'B';
  ELSE RETURN 'C';
  END IF;
END fn_abc_class;
/
