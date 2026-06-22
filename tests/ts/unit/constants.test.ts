/**
 * constants.test.ts — 共享常量值校验
 */

import { describe, it, expect } from "vitest"
import {
  VALID_SOURCE_EXTENSIONS,
  GENERATED_MARKER,
  GENERATED_MARKER_ID,
  GENERATED_OUTPUT_DIR,
} from "@workflow/constants"

describe("VALID_SOURCE_EXTENSIONS", () => {
  it("包含 .sql", () => {
    expect(VALID_SOURCE_EXTENSIONS).toContain(".sql")
  })

  it("包含 .pks", () => {
    expect(VALID_SOURCE_EXTENSIONS).toContain(".pks")
  })

  it("包含 .pkb", () => {
    expect(VALID_SOURCE_EXTENSIONS).toContain(".pkb")
  })

  it("包含 .pls", () => {
    expect(VALID_SOURCE_EXTENSIONS).toContain(".pls")
  })

  it("恰好 4 个扩展名", () => {
    expect(VALID_SOURCE_EXTENSIONS).toHaveLength(4)
  })

  it("所有扩展名以点开头", () => {
    for (const ext of VALID_SOURCE_EXTENSIONS) {
      expect(ext.startsWith(".")).toBe(true)
    }
  })

  it("所有扩展名为小写", () => {
    for (const ext of VALID_SOURCE_EXTENSIONS) {
      expect(ext).toBe(ext.toLowerCase())
    }
  })
})

describe("GENERATED_MARKER", () => {
  it("值为 .sql2java-generated", () => {
    expect(GENERATED_MARKER).toBe(".sql2java-generated")
  })
})

describe("GENERATED_MARKER_ID", () => {
  it("值为 sql2java-schema-fetcher", () => {
    expect(GENERATED_MARKER_ID).toBe("sql2java-schema-fetcher")
  })
})

describe("GENERATED_OUTPUT_DIR", () => {
  it("值为 ddl-output", () => {
    expect(GENERATED_OUTPUT_DIR).toBe("ddl-output")
  })
})
