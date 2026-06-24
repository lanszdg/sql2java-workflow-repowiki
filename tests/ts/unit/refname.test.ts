/**
 * refname.test.ts — refName 命名规范纯函数单元测试（P1：refName 约定的代码级单一真相源）
 */

import { describe, it, expect } from "vitest"
import { refNamesForPackage, validRefNameSet, parseQualified, pkgOf, refOf } from "@workflow/refname"

describe("refNamesForPackage", () => {
  it("非重载子程序保留裸名", () => {
    expect(refNamesForPackage(["create_order"])).toEqual(["create_order"])
    expect(refNamesForPackage(["create_order", "cancel_order"])).toEqual(["create_order", "cancel_order"])
  })

  it("重载子程序全部带 1-based 序号（含 __1）", () => {
    expect(refNamesForPackage(["get_param", "get_param"])).toEqual(["get_param__1", "get_param__2"])
    expect(refNamesForPackage(["get_param", "get_param", "get_param"])).toEqual([
      "get_param__1",
      "get_param__2",
      "get_param__3",
    ])
  })

  it("重载与非重载混合，仅重载名带序号", () => {
    expect(refNamesForPackage(["get_item", "get_param", "get_param"])).toEqual([
      "get_item",
      "get_param__1",
      "get_param__2",
    ])
  })

  it("序号按 procedures 数组中的出现顺序（即 inventory-packages 顺序）分配", () => {
    // 即使中间夹了别的子程序，同名出现的顺序仍是 1,2
    expect(refNamesForPackage(["get_param", "other", "get_param"])).toEqual([
      "get_param__1",
      "other",
      "get_param__2",
    ])
  })

  it("空数组返回空数组", () => {
    expect(refNamesForPackage([])).toEqual([])
  })

  it("大小写变体视为同名重载（PL/SQL 标识符不区分大小写）", () => {
    // Oracle 默认大写化未加引号的标识符，get_item 与 GET_ITEM 是同一子程序、互为重载。
    // 须按大写键合并计数，否则 analysis-builder 与 validateCrossSchema 的 validRefNameSet
    // 会对大小写变体产出不相交的 refName 集合（callGraph 误报「未知 refName」）。
    expect(refNamesForPackage(["get_item", "GET_ITEM"])).toEqual(["get_item__1", "GET_ITEM__2"])
    // 混合：唯一名保留裸名（按大写判定唯一），重载名带序号
    expect(refNamesForPackage(["get_item", "GET_ITEM", "do_thing"])).toEqual([
      "get_item__1",
      "GET_ITEM__2",
      "do_thing",
    ])
  })
})

describe("validRefNameSet", () => {
  it("返回大写化的合法 refName 集合（便于大小写不敏感比对）", () => {
    const set = validRefNameSet(["get_item", "get_param", "get_param"])
    expect(set.has("GET_ITEM")).toBe(true)
    expect(set.has("GET_PARAM__1")).toBe(true)
    expect(set.has("GET_PARAM__2")).toBe(true)
    // 重载名不应有裸名（这正是要防的"裸名撞重载"）
    expect(set.has("GET_PARAM")).toBe(false)
  })

  it("非重载名裸名在集合内", () => {
    expect(validRefNameSet(["create_order"]).has("CREATE_ORDER")).toBe(true)
  })

  it("大小写变体重载的合法集合包含全部带序号变体（与 analysis-builder 口径一致）", () => {
    // analysis-builder.procNameToRefNames 按 toUpperCase 分组，其 refName 大写化后须与此集合一致
    const set = validRefNameSet(["get_item", "GET_ITEM"])
    expect(set.has("GET_ITEM__1")).toBe(true)
    expect(set.has("GET_ITEM__2")).toBe(true)
    expect(set.has("GET_ITEM")).toBe(false) // 重载名不应有裸名
  })
})

describe("parseQualified", () => {
  it("按第一个点拆分 PKG.refName", () => {
    expect(parseQualified("ORDER_PKG.create_order")).toEqual(["ORDER_PKG", "create_order"])
    expect(parseQualified("UTIL_PKG.get_param__2")).toEqual(["UTIL_PKG", "get_param__2"])
  })

  it("无点或空段返回 null", () => {
    expect(parseQualified("noseparator")).toBeNull()
    expect(parseQualified(".missingpkg")).toBeNull()
    expect(parseQualified("missingproc.")).toBeNull()
  })

  it("非字符串输入（raw JSON 中的 null/number/object）返回 null，不抛异常", () => {
    expect(parseQualified(null as unknown as string)).toBeNull()
    expect(parseQualified(123 as unknown as string)).toBeNull()
    expect(parseQualified({} as unknown as string)).toBeNull()
  })
})

describe("pkgOf / refOf（宽松版 unit id 拆分）", () => {
  it("按首个点拆分 PKG.refName（refName 含重载 __序号 也只按首点拆）", () => {
    expect(pkgOf("ORDER_PKG.create_order")).toBe("ORDER_PKG")
    expect(refOf("ORDER_PKG.create_order")).toBe("create_order")
    expect(pkgOf("UTIL_PKG.get_param__2")).toBe("UTIL_PKG")
    expect(refOf("UTIL_PKG.get_param__2")).toBe("get_param__2")
  })

  it("无点时返回原串（宽松，不报 null）", () => {
    expect(pkgOf("standalone")).toBe("standalone")
    expect(refOf("standalone")).toBe("standalone")
  })
})
