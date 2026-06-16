/**
 * wf-util.js — 工作流 CLI / 模块工具集
 *
 * 为 AI agent 提供跨平台文件操作子命令。
 *
 * 双模式使用：
 *   1. 模块导入（生产环境，opencode 插件进程内调用）：
 *      const { runCommand } = require("./wf-util")
 *      const output = runCommand("mkdir", ["dir1", "dir2"])
 *
 *   2. CLI 直接调用（开发调试）：
 *      bun .opencode/workflow/wf-util.js <subcommand> [options] [args]
 *      node .opencode/workflow/wf-util.js <subcommand> [options] [args]
 *
 * 使用 node: 内置模块（CJS），不依赖任何第三方包。
 * refName 命名规范复用同目录 refname.ts（需 bun 运行时直解 TS，
 * 故此处改为内联 validRefNameSet 的 JS 实现，保持单文件可运行）。
 *
 * 子命令：
 *   mkdir <dir> [dir...]                        递归创建目录
 *   count-json <dir>                            统计目录下 .json 文件数
 *   list-json <dir>                             列出 .json 文件名（无扩展名）
 *   find-json <dir>                             递归查找所有 .json 文件路径
 *   exists <path>                               检查路径是否存在
 *   timestamp                                   输出 run-YYYYMMDD-HHmmss
 *   init-analysis-packages <dir> <pkg1,pkg2,..> 为包列表写空 JSON
 *   grep-calls <dir>                            提取 SQL 跨包调用
 *   validate-fsd <artifactsDir>                 FSD 完整性校验
 *   check-stubs <dir> [--exit-with-count]       检查"详见"占位符
 */

"use strict"

const fs = require("node:fs")
const path = require("node:path")

// ── refName 内联实现（JS 版，避免依赖 refname.ts 的 TS 运行时） ────────────

/**
 * 给定一个包内有序的子程序名数组，计算每个出现位置的 refName。
 * 非重载 = 裸名；重载 = name__序号（1-based，全部带后缀）。
 */
function refNamesForPackage(procedureNames) {
  var totals = new Map()
  for (var _i = 0, _a = procedureNames; _i < _a.length; _i++) {
    var name_1 = _a[_i]
    totals.set(name_1, (totals.get(name_1) ?? 0) + 1)
  }
  var seen = new Map()
  return procedureNames.map(function (name) {
    if ((totals.get(name) ?? 0) === 1) return name
    var i = (seen.get(name) ?? 0) + 1
    seen.set(name, i)
    return name + "__" + i
  })
}

/**
 * 一个包所有合法 refName 的集合（统一转大写，大小写不敏感比对）。
 */
function validRefNameSet(procedureNames) {
  return new Set(refNamesForPackage(procedureNames).map(function (r) { return r.toUpperCase() }))
}

// ── 帮助 ──────────────────────────────────────────────────────────────────────

function usage() {
  console.log("Usage: wf-util.js <subcommand> [options] [args]\n\
\n\
Subcommands:\n\
  mkdir <dir> [dir...]                        递归创建目录\n\
  count-json <dir>                            统计 .json 文件数\n\
  list-json <dir>                             列出 .json 文件名（无扩展名）\n\
  find-json <dir>                             递归查找 .json 文件路径\n\
  exists <path>                               检查路径（exists / not found）\n\
  timestamp                                   输出 run-YYYYMMDD-HHmmss\n\
  init-analysis-packages <dir> <pkgs>         写入空 analysis-packages JSON\n\
  grep-calls <dir>                            提取 SQL 跨包调用关系\n\
  validate-fsd <artifactsDir>                 FSD vs inventory 完整性校验\n\
  check-stubs <dir> [--exit-with-count]       检查\"详见\"占位符")
}

function die(msg) {
  console.error("Error: " + msg)
  process.exit(1)
}

// ── 通用工具 ──────────────────────────────────────────────────────────────────

/** 递归遍历目录，对每个文件调用 callback(filePath, entry) */
function walkDir(dir, callback) {
  if (!fs.existsSync(dir)) return
  var entries = fs.readdirSync(dir, { withFileTypes: true })
  for (var _i = 0, entries_1 = entries; _i < entries_1.length; _i++) {
    var entry = entries_1[_i]
    var fp = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkDir(fp, callback)
    } else {
      callback(fp, entry)
    }
  }
}

// ── 子命令实现 ────────────────────────────────────────────────────────────────

/** mkdir <dir> [dir...] */
function cmdMkdir(dirs) {
  if (!dirs.length) die("mkdir requires at least one directory path")
  for (var _i = 0, dirs_1 = dirs; _i < dirs_1.length; _i++) {
    var d = dirs_1[_i]
    fs.mkdirSync(d, { recursive: true })
  }
}

/** count-json <dir> — 输出: === {dirname} === {N} */
function cmdCountJson(args) {
  if (!args[0]) die("count-json requires a directory path")
  var dir = args[0]
  if (!fs.existsSync(dir)) die("directory not found: " + dir)
  var files = fs.readdirSync(dir).filter(function (n) { return n.endsWith(".json") })
  var label = path.basename(dir)
  console.log("=== " + label + " === " + files.length)
}

/** list-json <dir> — 输出: 每行一个文件名（无 .json 扩展名） */
function cmdListJson(args) {
  if (!args[0]) die("list-json requires a directory path")
  var dir = args[0]
  if (!fs.existsSync(dir)) return
  var files = fs.readdirSync(dir).filter(function (n) { return n.endsWith(".json") })
  for (var _i = 0, files_1 = files; _i < files_1.length; _i++) {
    var f = files_1[_i]
    console.log(f.replace(/\.json$/, ""))
  }
}

/** find-json <dir> — 递归查找，输出排序后的绝对路径 */
function cmdFindJson(args) {
  if (!args[0]) die("find-json requires a directory path")
  var dir = args[0]
  var results = []
  walkDir(dir, function (fp) {
    if (fp.endsWith(".json")) results.push(fp)
  })
  results.sort()
  console.log(results.join("\n"))
}

/** exists <path> — 输出: exists / not found */
function cmdExists(args) {
  if (!args[0]) die("exists requires a path")
  console.log(fs.existsSync(args[0]) ? "exists" : "not found")
}

/** timestamp — 输出: run-YYYYMMDD-HHmmss */
function cmdTimestamp() {
  var s = new Date().toISOString()
  console.log("run-" + s.slice(0, 10).replace(/-/g, "") + "-" + s.slice(11, 19).replace(/:/g, ""))
}

/**
 * init-analysis-packages <dir> <pkg1,pkg2,...>
 * 为逗号分隔的包名列表写入空的 {packageName, subprograms:[]} JSON 文件
 */
function cmdInitAnalysisPackages(args) {
  if (args.length < 2) die("init-analysis-packages requires <dir> <pkg1,pkg2,...>")
  var dir = args[0]
  var pkgs = args[1].split(",")
  fs.mkdirSync(dir, { recursive: true })
  for (var _i = 0, pkgs_1 = pkgs; _i < pkgs_1.length; _i++) {
    var pkg = pkgs_1[_i]
    var filePath = path.join(dir, pkg + ".json")
    fs.writeFileSync(filePath, JSON.stringify({ packageName: pkg, subprograms: [] }), "utf-8")
  }
}

/**
 * grep-calls <dir>
 * 递归查找 .sql 文件中跨包调用（\w+_\w+\.\w+），跳过注释行
 * 输出: filepath:linenum:trimmed-line
 */
function cmdGrepCalls(args) {
  if (!args[0]) die("grep-calls requires a directory path")
  var dir = args[0]
  walkDir(dir, function (fp) {
    if (!fp.endsWith(".sql")) return
    var lines = fs.readFileSync(fp, "utf-8").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim()
      if (line.startsWith("--")) continue
      if (/\w+_\w+\.\w+/.test(line)) {
        console.log(fp + ":" + (i + 1) + ":" + line)
      }
    }
  })
}

/**
 * validate-fsd <artifactsDir>
 * 逐包对比 FSD 文件数 vs inventory 子程序数
 * 输出: ✅ PKG: N FSD files / ❌ MISSING: PKG inventory=N fsd=N
 */
function cmdValidateFsd(args) {
  if (!args[0]) die("validate-fsd requires artifactsDir path")
  var artifactsDir = args[0]
  var invDir = path.join(artifactsDir, "inventory-packages")
  var fsdDir = path.join(artifactsDir, "fsd")

  if (!fs.existsSync(invDir)) die("inventory-packages not found: " + invDir)

  var invFiles = fs.readdirSync(invDir).filter(function (n) { return n.endsWith(".json") })
  for (var _i = 0, invFiles_1 = invFiles; _i < invFiles_1.length; _i++) {
    var fn = invFiles_1[_i]
    var pkg = fn.replace(/\.json$/, "")
    var procNames = []
    try {
      var data = JSON.parse(fs.readFileSync(path.join(invDir, fn), "utf-8"))
      procNames = (data.procedures || []).map(function (p) { return p.name })
    } catch (e) {
      die("failed to parse " + fn + ": " + e.message)
    }
    var invCount = procNames.length

    // 合法 refName 集合（大写 Set，大小写不敏感比对）
    var expectedUpper = validRefNameSet(procNames)

    var pkgFsdDir = path.join(fsdDir, pkg)
    var actualFiles = []  // [{name, upper}]
    if (fs.existsSync(pkgFsdDir)) {
      fs.readdirSync(pkgFsdDir)
        .filter(function (n) { return n.endsWith(".md") })
        .forEach(function (n) { actualFiles.push({ name: n, upper: n.replace(/\.md$/i, "").toUpperCase() }) })
    }
    var fsdCount = actualFiles.length

    // 命名校验：孤儿 / 缺失
    var orphans = actualFiles.filter(function (a) { return !expectedUpper.has(a.upper) })
    var actualUpperSet = {}
    actualFiles.forEach(function (a) { actualUpperSet[a.upper] = true })
    var missing = Array.from(expectedUpper).filter(function (r) { return !actualUpperSet[r] })

    if (invCount !== fsdCount || orphans.length > 0 || missing.length > 0) {
      var parts = [pkg + " inventory=" + invCount + " fsd=" + fsdCount]
      if (orphans.length > 0) parts.push("孤儿/命名错误: " + orphans.map(function (a) { return a.name }).join(", "))
      if (missing.length > 0) parts.push("缺失: " + missing.map(function (r) { return r + ".md" }).join(", "))
      console.log("❌ MISSING: " + parts.join(" | "))
    } else {
      console.log("✅ " + pkg + ": " + fsdCount + " FSD files")
    }
  }
}

/**
 * check-stubs <dir> [--exit-with-count]
 * 递归查找 .md 文件中包含"详见"占位符的文件
 * --exit-with-count: exit code = stub 数量
 */
function cmdCheckStubs(args) {
  if (!args[0]) die("check-stubs requires a directory path")
  var dir = args[0]
  var exitWithCount = args.indexOf("--exit-with-count") >= 0
  var count = 0

  walkDir(dir, function (fp) {
    if (!fp.endsWith(".md")) return
    var content = fs.readFileSync(fp, "utf-8")
    if (content.includes("详见")) {
      count++
      console.log(fp)
    }
  })

  if (count === 0) {
    console.log("=== Stub check: 0 ===")
  }

  if (exitWithCount) {
    process.exit(count)
  }
}

// ── 模块导出接口 ──────────────────────────────────────────────────────────────

/**
 * 统一命令路由表（供 runCommand 和 CLI 共用）。
 * key = 子命令名，value = 处理函数。
 */
var COMMAND_TABLE = {
  "mkdir":                  cmdMkdir,
  "count-json":             cmdCountJson,
  "list-json":              cmdListJson,
  "find-json":              cmdFindJson,
  "exists":                 cmdExists,
  "timestamp":              cmdTimestamp,
  "init-analysis-packages": cmdInitAnalysisPackages,
  "grep-calls":             cmdGrepCalls,
  "validate-fsd":           cmdValidateFsd,
  "check-stubs":            cmdCheckStubs,
}

/**
 * 在进程内执行子命令，捕获 console 输出并返回字符串。
 * 供 opencode 插件 tool 调用（不走 bash / execSync）。
 *
 * @param command 子命令名
 * @param args    参数数组
 * @returns 捕获的 stdout 输出（多行字符串）
 * @throws Error 未知命令或子命令内部错误
 */
function runCommand(command, args) {
  if (!command || !COMMAND_TABLE[command]) {
    throw new Error("unknown subcommand: " + command)
  }
  // 捕获 console.log / console.error 输出
  var output = []
  var origLog = console.log
  var origError = console.error
  console.log = function () {
    var parts = []
    for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]))
    output.push(parts.join(" "))
  }
  console.error = function () {
    var parts = []
    for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]))
    output.push(parts.join(" "))
  }
  try {
    COMMAND_TABLE[command](args || [])
  } finally {
    console.log = origLog
    console.error = origError
  }
  return output.join("\n")
}

// 导出所有子命令函数 + runCommand + COMMAND_TABLE（供 plugin 使用）
module.exports = {
  runCommand: runCommand,
  COMMAND_TABLE: COMMAND_TABLE,
  // 单个函数也导出，方便按需调用
  cmdMkdir: cmdMkdir,
  cmdCountJson: cmdCountJson,
  cmdListJson: cmdListJson,
  cmdFindJson: cmdFindJson,
  cmdExists: cmdExists,
  cmdTimestamp: cmdTimestamp,
  cmdInitAnalysisPackages: cmdInitAnalysisPackages,
  cmdGrepCalls: cmdGrepCalls,
  cmdValidateFsd: cmdValidateFsd,
  cmdCheckStubs: cmdCheckStubs,
}

// ── CLI 入口（仅直接执行时运行） ─────────────────────────────────────────────

if (require.main === module) {
  var command = process.argv[2]
  var rest = process.argv.slice(3)

  switch (command) {
    case "mkdir":                  cmdMkdir(rest); break
    case "count-json":             cmdCountJson(rest); break
    case "list-json":              cmdListJson(rest); break
    case "find-json":              cmdFindJson(rest); break
    case "exists":                 cmdExists(rest); break
    case "timestamp":              cmdTimestamp(); break
    case "init-analysis-packages": cmdInitAnalysisPackages(rest); break
    case "grep-calls":             cmdGrepCalls(rest); break
    case "validate-fsd":           cmdValidateFsd(rest); break
    case "check-stubs":            cmdCheckStubs(rest); break
    case "--help":
    case "-h":
    case undefined:
      usage()
      break
    default:
      die("unknown subcommand: " + command + "\n")
      usage()
      process.exit(1)
  }
}
