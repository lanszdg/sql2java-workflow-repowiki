/**
 * plsql-trigger-text.test.ts — extractTriggerFromText 触发器结尾定位测试
 *
 * 锁定修复：触发器结尾须用大小写不敏感 + 词边界的 /\bEND\s*;/gi 定位最后一个 END;，
 * 而非 lastIndexOf("END")（区分大小写子串搜索）——后者会漏掉小写 end;，并误命中
 * PENDING/APPEND 等含 "END" 子串的标识符，导致 trigger.lineRange 偏到真正 END 之后或整文件。
 */

import { describe, it, expect } from "vitest"
import { extractTriggerFromText, type TriggerIndex } from "@workflow/plsql-scanner"

function extract(code: string): TriggerIndex | undefined {
  const triggers: TriggerIndex[] = []
  extractTriggerFromText(code, triggers, "trg.sql")
  return triggers[0]
}

describe("extractTriggerFromText 触发器结尾定位", () => {
  it("小写 end; 结尾：lineRange 不应覆盖整个文件（旧实现因 /\\bEND\\s*;/g 无 i 标志会漏匹配）", () => {
    const code = [
      "CREATE OR REPLACE TRIGGER trg_a",
      "BEFORE INSERT ON t_a",
      "FOR EACH ROW",
      "BEGIN",
      "  :NEW.flag := 'x';",
      "end;",
      "/",
    ].join("\n")
    const t = extract(code)!
    expect(t).toBeDefined()
    // end; 在第 6 行；旧实现回退 code.length 会把 endLine 算到第 7 行（含 / ）或更后
    expect(t.lineRange).toEqual([1, 6])
    expect(t.timing).toBe("before")
    expect(t.level).toBe("row")
    expect(t.events).toEqual(["insert"])
    expect(t.targetTable).toBe("T_A")
  })

  it("触发体含 'PENDING' 等含 END 子串的标识符：endLine 不应被推到真正 END; 之后", () => {
    const code = [
      "CREATE OR REPLACE TRIGGER trg_b",
      "BEFORE INSERT ON t_b",
      "FOR EACH ROW",
      "WHEN (new.status = 'PENDING')",
      "BEGIN",
      "  :NEW.s := 'APPEND';",
      "  :NEW.t := 'SENDING';",
      "END;",
      "/",
    ].join("\n")
    const t = extract(code)!
    // 旧实现 lastIndexOf("END") 会命中 'PENDING' 内的 END 子串 → endIdx 落在真正 END; 之后
    expect(t.lineRange).toEqual([1, 8])
  })

  it("嵌套 END IF; / END LOOP; 不被误当作触发器结尾", () => {
    const code = [
      "CREATE OR REPLACE TRIGGER trg_c",
      "AFTER UPDATE ON t_c",
      "FOR EACH ROW",
      "BEGIN",
      "  IF :NEW.a = 1 THEN",
      "    :NEW.b := 2;",
      "  END IF;",
      "  END;",
      "/",
    ].join("\n")
    const t = extract(code)!
    // \\bEND\\s*; 不匹配 "END IF;"（END 后跟 IF 而非 ;）；最后一个 END; 在第 8 行
    expect(t.lineRange).toEqual([1, 8])
    expect(t.timing).toBe("after")
    expect(t.events).toEqual(["update"])
  })

  it("大写 END; 基线仍正确", () => {
    const code = [
      "CREATE TRIGGER trg_d",
      "BEFORE DELETE ON t_d",
      "FOR EACH ROW",
      "BEGIN",
      "  NULL;",
      "END;",
      "/",
    ].join("\n")
    const t = extract(code)!
    expect(t.lineRange).toEqual([1, 6])
    expect(t.events).toEqual(["delete"])
  })
})
