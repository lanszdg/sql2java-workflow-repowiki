/**
 * validate-fsds.test.ts — analyze 边界 FSD 校验单测
 *
 * 验证 analyze 阶段（map）产出后引擎校验：
 *  - FSD 覆盖：每个子程序按 refName 规范有对应 md（含重载 __序号）
 *  - stub 检查：FSD 不得含"详见"占位符
 * 缺 FSD / 含占位符 → blocking（返回错误信息）。
 *
 * SUT: validateFsds（纯函数，直接读盘，@plugins 导出）。
 */

import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { validateFsds } from "@plugins/workflow-engine"

function setupArtifacts(dir: string, packages: Array<{ name: string; procedures: Array<{ name: string }> }>) {
  mkdirSync(join(dir, "inventory-packages"), { recursive: true })
  mkdirSync(join(dir, "fsd"), { recursive: true })
  writeFileSync(join(dir, "inventory.json"), JSON.stringify({
    sourcePath: "/src", packageNames: packages.map(p => p.name),
  }), "utf-8")
  for (const p of packages) {
    writeFileSync(join(dir, "inventory-packages", `${p.name}.json`), JSON.stringify({
      packageName: p.name,
      procedures: p.procedures,
    }), "utf-8")
  }
}

function writeFsd(dir: string, pkg: string, refName: string, content = "# FSD\n内容") {
  mkdirSync(join(dir, "fsd", pkg), { recursive: true })
  writeFileSync(join(dir, "fsd", pkg, `${refName}.md`), content, "utf-8")
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "validate-fsd-")) })

describe("validateFsds", () => {
  it("无子程序包不要求 FSD，校验通过", () => {
    setupArtifacts(dir, [{ name: "BASE_PKG", procedures: [] }])
    expect(validateFsds(dir)).toBeNull()
  })

  it("每个子程序都有 FSD（非重载裸名）→ 通过", () => {
    setupArtifacts(dir, [{ name: "PKG_A", procedures: [{ name: "p1" }, { name: "p2" }] }])
    writeFsd(dir, "PKG_A", "p1")
    writeFsd(dir, "PKG_A", "p2")
    expect(validateFsds(dir)).toBeNull()
  })

  it("重载子程序用 __序号 文件名 → 通过", () => {
    setupArtifacts(dir, [{ name: "PKG_A", procedures: [{ name: "get" }, { name: "get" }] }])
    writeFsd(dir, "PKG_A", "get__1")
    writeFsd(dir, "PKG_A", "get__2")
    expect(validateFsds(dir)).toBeNull()
  })

  it("缺一个 FSD → blocking 报错", () => {
    setupArtifacts(dir, [{ name: "PKG_A", procedures: [{ name: "p1" }, { name: "p2" }] }])
    writeFsd(dir, "PKG_A", "p1") // 缺 p2
    const err = validateFsds(dir)
    expect(err).toBeTruthy()
    expect(err).toContain("p2")
  })

  it("重载缺序号文件（只有裸名）→ blocking 报错", () => {
    setupArtifacts(dir, [{ name: "PKG_A", procedures: [{ name: "get" }, { name: "get" }] }])
    writeFsd(dir, "PKG_A", "get__1") // 缺 get__2
    const err = validateFsds(dir)
    expect(err).toBeTruthy()
    expect(err).toContain("get__2")
  })

  it("FSD 含'详见'占位符 → blocking 报错", () => {
    setupArtifacts(dir, [{ name: "PKG_A", procedures: [{ name: "p1" }] }])
    writeFsd(dir, "PKG_A", "p1", "# FSD\n详见 analysis-packages/PKG_A.json")
    const err = validateFsds(dir)
    expect(err).toBeTruthy()
    expect(err).toContain("详见")
  })

  it("缺 fsd 目录 → 报错", () => {
    setupArtifacts(dir, [{ name: "PKG_A", procedures: [{ name: "p1" }] }])
    // 不创建 fsd/PKG_A
    const err = validateFsds(dir)
    expect(err).toBeTruthy()
    expect(err).toContain("PKG_A")
  })

  it("大小写不敏感匹配 FSD 文件名", () => {
    setupArtifacts(dir, [{ name: "PKG_A", procedures: [{ name: "p1" }] }])
    // 文件名用小写 pkg_a 目录（大小写不敏感 FS / findDirCaseInsensitive）
    writeFsd(dir, "pkg_a", "p1")
    // findDirCaseInsensitive 应能匹配 PKG_A → pkg_a
    // 注：macOS 默认大小写不敏感 FS 下必过；Linux 大小写敏感下 findDirCaseInsensitive 兜底
    expect(validateFsds(dir)).toBeNull()
  })

  it("分片模式：targetPkgs 限定范围，非目标包缺 FSD 不报错", () => {
    setupArtifacts(dir, [
      { name: "PKG_A", procedures: [{ name: "p1" }] },
      { name: "PKG_B", procedures: [{ name: "p2" }] },
    ])
    writeFsd(dir, "PKG_A", "p1") // 只写 PKG_A 的 FSD（本分片）
    // PKG_B 缺 FSD，但不在 targetPkgs 范围 → 不报错（PKG_B 由其所属分片 advance 时校验）
    expect(validateFsds(dir, ["PKG_A"])).toBeNull()
    // 不传 targetPkgs（全量）→ PKG_B 缺 FSD 报错
    expect(validateFsds(dir)).toBeTruthy()
  })

  it("分片模式：本分片包缺 FSD 仍报错", () => {
    setupArtifacts(dir, [
      { name: "PKG_A", procedures: [{ name: "p1" }, { name: "p2" }] },
      { name: "PKG_B", procedures: [{ name: "p3" }] },
    ])
    writeFsd(dir, "PKG_A", "p1") // 缺 PKG_A/p2
    writeFsd(dir, "PKG_B", "p3")
    // 本分片 = PKG_A，缺 p2 → 报错
    expect(validateFsds(dir, ["PKG_A"])).toContain("p2")
  })
})
