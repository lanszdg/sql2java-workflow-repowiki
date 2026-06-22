/**
 * schema-fetcher.test.ts — DB Schema 发现集成测试（规划中）
 *
 * 计划测试 loadDbConfig / fetchSchemaIfNeeded / DDL 生成。
 * Mock oracledb，不连接真实数据库。
 *
 * 注意：以下用例均为 it.todo（尚未实现），不会被判为通过——
 *   这是为了避免「空 it() 体被 vitest 判为 pass」造成的虚假绿。
 *   实现时把 it.todo 改回 it 并补「输入 → 预期输出」。
 *   SUT 通过 @workflow 别名访问（实现时取消下方注释的 import）。
 */

import { describe, it } from "vitest"

// import { loadDbConfig, fetchSchemaIfNeeded, cleanupGeneratedDdl, type DbConfig } from "@workflow/schema-fetcher"

describe("schema-fetcher", () => {
  describe("loadDbConfig", () => {
    // 构造 db.xml (easy-connect)，验证解析出的 connectString/user/password
    it.todo("easy-connect 格式解析正确")
    it.todo("TNS 格式解析正确")
    it.todo("环境变量密码替换 ${ENV_VAR}")
    it.todo("缺失 url 字段返回 null")
    it.todo("文件不存在返回 null")
  })

  describe("fetchSchemaIfNeeded", () => {
    it.todo("无 db.xml 时跳过 (fetched=false)")
    // mock require.resolve 抛错，预期返回 { fetched: false, error: "..." }
    it.todo("oracledb 未安装时优雅降级")
    // mock oracledb 的 execute 方法返回预定义数据，验证 tablesFetched/triggersFetched 等计数
    it.todo("成功连接后返回各对象计数")
  })

  describe("DDL 生成", () => {
    // mock 返回 OracleColumn + OracleConstraint，验证生成的 .sql 文件内容
    it.todo("表 DDL 包含列和约束")
    // mock 返回 OracleTableComment + OracleColumnComment
    it.todo("注释正确写入")
    it.todo("序列 DDL 正确")
  })

  describe("cleanupGeneratedDdl", () => {
    it.todo("清理生成的 DDL 文件")
    it.todo("不删除非生成文件")
  })

  describe("文件路径去重", () => {
    // TABLE_A 和 table_a 视为冲突
    it.todo("大小写冲突检测")
  })
})
