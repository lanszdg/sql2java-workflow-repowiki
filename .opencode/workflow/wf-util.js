#!/usr/bin/env bun
/**
 * wf-util.js — 工作流 CLI 工具集
 *
 * 为 AI agent 提示词中的跨平台文件操作提供简短子命令，
 * 替代冗长的 `node -e "..."` 单行命令。
 *
 * 使用 Bun 运行时（CJS + node: 内置模块）；refName 命名规范复用同目录
 * refname.ts（bun 运行时直解 TS，单一真相源，避免内联副本漂移）。
 *
 * 用法：bun .opencode/workflow/wf-util.js <subcommand> [options] [args]
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
const { validRefNameSet } = require("./refname")

// ── 帮助 ──────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`Usage: bun wf-util.js <subcommand> [options] [args]

Subcommands:
  mkdir <dir> [dir...]                        递归创建目录
  count-json <dir>                            统计 .json 文件数
  list-json <dir>                             列出 .json 文件名（无扩展名）
  find-json <dir>                             递归查找 .json 文件路径
  exists <path>                               检查路径（exists / not found）
  timestamp                                   输出 run-YYYYMMDD-HHmmss
  init-analysis-packages <dir> <pkgs>         写入空 analysis-packages JSON
  grep-calls <dir>                            提取 SQL 跨包调用关系
  validate-fsd <artifactsDir>                 FSD vs inventory 完整性校验
  check-stubs <dir> [--exit-with-count]       检查"详见"占位符`)
}

function die(msg) {
  console.error("Error: " + msg)
  process.exit(1)
}

// ── 通用工具 ──────────────────────────────────────────────────────────────────

/** 递归遍历目录，对每个文件调用 callback(filePath, entry) */
function walkDir(dir, callback) {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fp = path.join(dir, entry.name)
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
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true })
  }
}

/** count-json <dir> — 输出: === {dirname} === {N} */
function cmdCountJson(args) {
  if (!args[0]) die("count-json requires a directory path")
  const dir = args[0]
  if (!fs.existsSync(dir)) die("directory not found: " + dir)
  const files = fs.readdirSync(dir).filter(function (n) { return n.endsWith(".json") })
  const label = path.basename(dir)
  console.log("=== " + label + " === " + files.length)
}

/** list-json <dir> — 输出: 每行一个文件名（无 .json 扩展名） */
function cmdListJson(args) {
  if (!args[0]) die("list-json requires a directory path")
  const dir = args[0]
  if (!fs.existsSync(dir)) return
  const files = fs.readdirSync(dir).filter(function (n) { return n.endsWith(".json") })
  for (const f of files) {
    console.log(f.replace(/\.json$/, ""))
  }
}

/** find-json <dir> — 递归查找，输出排序后的绝对路径 */
function cmdFindJson(args) {
  if (!args[0]) die("find-json requires a directory path")
  const dir = args[0]
  const results = []
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
  const s = new Date().toISOString()
  console.log("run-" + s.slice(0, 10).replace(/-/g, "") + "-" + s.slice(11, 19).replace(/:/g, ""))
}

/**
 * init-analysis-packages <dir> <pkg1,pkg2,...>
 * 为逗号分隔的包名列表写入空的 {packageName, subprograms:[]} JSON 文件
 */
function cmdInitAnalysisPackages(args) {
  if (args.length < 2) die("init-analysis-packages requires <dir> <pkg1,pkg2,...>")
  const dir = args[0]
  const pkgs = args[1].split(",")
  fs.mkdirSync(dir, { recursive: true })
  for (const pkg of pkgs) {
    const filePath = path.join(dir, pkg + ".json")
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
  const dir = args[0]
  walkDir(dir, function (fp) {
    if (!fp.endsWith(".sql")) return
    const lines = fs.readFileSync(fp, "utf-8").split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
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
  const artifactsDir = args[0]
  const invDir = path.join(artifactsDir, "inventory-packages")
  const fsdDir = path.join(artifactsDir, "fsd")

  if (!fs.existsSync(invDir)) die("inventory-packages not found: " + invDir)

  const invFiles = fs.readdirSync(invDir).filter(function (n) { return n.endsWith(".json") })
  for (const fn of invFiles) {
    const pkg = fn.replace(/\.json$/, "")
    var procNames = []
    try {
      var data = JSON.parse(fs.readFileSync(path.join(invDir, fn), "utf-8"))
      procNames = (data.procedures || []).map(function (p) { return p.name })
    } catch (e) {
      die("failed to parse " + fn + ": " + e.message)
    }
    var invCount = procNames.length

    // 合法 refName 集合（大写 Set，大小写不敏感比对）；复用 refname.ts 的 validRefNameSet
    var expectedUpper = validRefNameSet(procNames)

    var pkgFsdDir = path.join(fsdDir, pkg)
    var actualFiles = []  // [{name, upper}]
    if (fs.existsSync(pkgFsdDir)) {
      fs.readdirSync(pkgFsdDir)
        .filter(function (n) { return n.endsWith(".md") })
        .forEach(function (n) { actualFiles.push({ name: n, upper: n.replace(/\.md$/i, "").toUpperCase() }) })
    }
    var fsdCount = actualFiles.length

    // 命名校验：孤儿（文件名不在合法 refName 集合，如旧格式 get_param.md）/ 缺失（应有却无）
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

// ── 路由 ──────────────────────────────────────────────────────────────────────

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
