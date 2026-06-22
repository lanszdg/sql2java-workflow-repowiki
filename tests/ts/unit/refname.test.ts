/**
 * refname.test.ts — refName 命名规范纯函数单元测试（P1：refName 约定的代码级单一真相源）
 */

import { describe, it, expect } from "vitest"
import { refNamesForPackage, validRefNameSet, parseQualified } from "@workflow/refname"

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
