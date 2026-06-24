/**
 * refName 命名规范 —— 跨 artifact 子程序引用名的**单一真相源**。
 *
 * 规范：
 *   - 非重载子程序（同名仅出现 1 次）= Oracle 原始名（裸名）。
 *   - 重载子程序（同名出现 K 次）= `{name}__{序号}`，序号为该同名子程序在
 *     `inventory-packages/{PKG}.json` 的 `procedures` 数组中的第几次出现（1-based），
 *     **全部** K 个版本都带后缀（即 `__1`..`__K`），避免裸名撞重载。
 *
 * 该 refName 在以下四处必须一致：
 *   analysis.json.callGraph 的 key/value、FSD 文件名、
 *   translation.json.subprogramMethods.oracleName、translation.json.completedSubprograms。
 *
 * 本模块的纯函数被 validateCrossSchema 用作校验依据（见 engine-core.ts D9），
 * 也是 callGraph 重建等未来确定性代码的复用基础——约定不再只活在 markdown 注释里。
 */

/**
 * 给定一个包内**有序**的子程序名数组，计算每个出现位置的 refName。
 * 返回数组与输入等长、同序（第 i 个输入 → 第 i 个 refName）。
 *
 * @example
 *   refNamesForPackage(["get_item"])              // => ["get_item"]          （非重载，裸名）
 *   refNamesForPackage(["get_param","get_param"]) // => ["get_param__1","get_param__2"]
 */
export function refNamesForPackage(procedureNames: string[]): string[] {
  // PL/SQL 标识符不区分大小写（Oracle 默认把未加引号的标识符大写化），因此 get_item 与
  // GET_ITEM 是同一子程序、互为重载，必须按大写键合并计数——否则 analysis-builder 与
  // validateCrossSchema 的 validRefNameSet 会对大小写变体产出不相交的 refName 集合。
  // 第一遍：按大写键统计每个名字的总出现次数，判定是否重载
  const totals = new Map<string, number>()
  for (const name of procedureNames) {
    const key = name.toUpperCase()
    totals.set(key, (totals.get(key) ?? 0) + 1)
  }

  // 第二遍：重载名按出现顺序追加 1-based 序号（序号同样按大写键累计），非重载保留裸名。
  // refName 保留 Oracle 原始大小写（裸名/带序号均用原始 name 拼接）。
  const seen = new Map<string, number>()
  return procedureNames.map((name) => {
    const key = name.toUpperCase()
    if ((totals.get(key) ?? 0) === 1) return name
    const i = (seen.get(key) ?? 0) + 1
    seen.set(key, i)
    return `${name}__${i}`
  })
}

/**
 * 一个包所有**合法** refName 的集合（统一转大写，便于跨来源做大小写不敏感比对）。
 * 用于校验 callGraph 引用、subprogramMethods.oracleName 是否落在合法集合内。
 */
export function validRefNameSet(procedureNames: string[]): Set<string> {
  return new Set(refNamesForPackage(procedureNames).map((r) => r.toUpperCase()))
}

/**
 * 解析限定名 `PKG.refName` 为 `[PKG, refName]`。
 * 仅按第一个 `.` 拆分（refName 本身不含 `.`），格式非法返回 null。
 * 非字符串输入（null/number/object 等，来自未经 schema 校验的 LLM JSON）返回 null，不抛异常。
 */
export function parseQualified(qualified: string): [string, string] | null {
  if (typeof qualified !== "string") return null
  const idx = qualified.indexOf(".")
  if (idx <= 0 || idx >= qualified.length - 1) return null
  return [qualified.slice(0, idx), qualified.slice(idx + 1)]
}

/**
 * 从 unit id `PKG.refName` 取包名（宽松版，按首个 `.` 切分）。
 * 无 `.` 时返回原串（用于已保证合法的 unit id 热路径，避免 null 检查）。
 * 需要严格校验非法格式时用 parseQualified。
 *
 * 与 refOf 配对，取代散落在 workflow-engine / engine-core / analysis-builder 的
 * `const i = u.indexOf("."); return i < 0 ? u : u.slice(...)` 内联闭包（单一真相源）。
 */
export function pkgOf(unitId: string): string {
  const i = unitId.indexOf(".")
  return i < 0 ? unitId : unitId.slice(0, i)
}

/** 从 unit id `PKG.refName` 取 refName（宽松版，按首个 `.` 切分）。无 `.` 时返回原串。 */
export function refOf(unitId: string): string {
  const i = unitId.indexOf(".")
  return i < 0 ? unitId : unitId.slice(i + 1)
}
