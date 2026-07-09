#!/usr/bin/env node
/**
 * list-services.cjs — 按 profile 确定性枚举"全仓含服务/入口的模块"，输出强制清单。
 * 目的：根治"整仓单会话漏模块"——模块清单由脚本穷举给出，不靠模型采样。
 * 用法: node list-services.cjs [仓库根, 默认当前目录] [--profile dubbo|spring-rest]
 * 输出: 每个含服务模块一行(模块路径 + 服务种子计数) + 总数；供编排器逐个处理、核对完整性。
 */
const fs = require("fs");
const path = require("path");
const { repowikiWorkDir } = require(path.join(__dirname, "lib", "repowiki-workdir.cjs"));

const args = process.argv.slice(2);
let rootArg = ".";
let profileName = "auto";
let showHelp = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--help" || a === "-h") showHelp = true;
  else if (a === "--profile") profileName = args[++i] || profileName;
  else if (a.startsWith("--profile=")) profileName = a.slice("--profile=".length) || profileName;
  else if (a.startsWith("--")) {
    console.error(`未知参数: ${a}`);
    process.exit(2);
  }
  else if (!a.startsWith("--")) rootArg = a;
}

const BUILTIN_PROFILES = ["dubbo", "spring-rest", "mq-listener", "scheduled-job", "batch-job", "go-cli", "go-http", "k8s-controller", "oracle-sp"];

function printHelp() {
  console.log("usage: node list-services.cjs <repo-root> [--profile <profile>]");
  console.log("");
  console.log("default profile: auto");
  console.log(`profiles: auto, ${BUILTIN_PROFILES.join(", ")}`);
  console.log("");
  console.log("This command writes <repo-root>/.repowiki/modules.json only when at least one module is found.");
  console.log("If zero modules are found, the profile is treated as unsupported/mismatched and no state is written.");
}
if (showHelp) {
  printHelp();
  process.exit(0);
}
const root = path.resolve(rootArg);
const SKIP = new Set(["node_modules", "target", ".git", ".codegraph", ".repowiki", "docs", "build", "dist", "out", "vendor", "third_party"]);

function loadProfile(name) {
  const profilePath = path.join(__dirname, "profiles", `${name}.json`);
  if (!fs.existsSync(profilePath)) {
    console.error(`✗ 未找到 profile: ${name} (${profilePath})`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(profilePath, "utf8"));
}

function shouldSkipFile(file) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  // PL/SQL 文件始终放行（不走 java/go 的 src/main 模块边界规则）
  if (file.endsWith(".pks") || file.endsWith(".pkb") || file.endsWith(".sql")) return false;
  const srcMain = rel.indexOf("/src/main/");
  const parts = (file.endsWith(".java") && srcMain >= 0 ? rel.slice(0, srcMain) : rel).split("/");
  if (!rel || rel.startsWith("..")) return true;
  if (rel.startsWith("test/") || rel.includes("/test/")) return true;
  if (rel.includes("/testing/") || rel.includes("/testdata/")) return true;
  if (parts.includes("examples") || parts.includes("example")) return true;
  if (rel.includes("/vendor/") || rel.startsWith("vendor/")) return true;
  if (rel.includes("/third_party/") || rel.startsWith("third_party/")) return true;
  if (rel.endsWith("_test.go")) return true;
  if (rel.includes("/generated/") || rel.includes("/zz_generated.") || rel.includes(".pb.go")) return true;
  return false;
}

function walk(dir, exts, acc = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, acc);
    else if (exts.some((x) => e.name.endsWith(x)) && !shouldSkipFile(p)) acc.push(p);
  }
  return acc;
}
// 记忆化：profile=auto 对每个 profile 都遍历全部 java/xml，不缓存会把每文件读 N 次(9 个 profile→万级仓超时)。读一次即可。
const _readCache = new Map();
const read = (f) => { if (_readCache.has(f)) return _readCache.get(f); let c; try { c = fs.readFileSync(f, "utf8"); } catch { c = ""; } _readCache.set(f, c); return c; };

// "模块" = 含 src/main 的最近祖先目录(到仓库根为止)
// 按目录记忆化(同目录文件同模块, 省掉每文件 existsSync 上溯)
const _modCache = new Map();
function moduleOf(file) {
  const dir = path.dirname(file);
  if (_modCache.has(dir)) return _modCache.get(dir);
  const r = _moduleOfImpl(file);
  _modCache.set(dir, r);
  return r;
}
function _moduleOfImpl(file) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  // PL/SQL 文件：模块=文件所在目录（无 Maven src/main 概念）
  if (file.endsWith(".pks") || file.endsWith(".pkb") || file.endsWith(".sql")) {
    return path.dirname(file);
  }
  const goCmd = rel.match(/^(cmd|cluster\/images|hack\/tools|pkg\/generated\/openapi\/cmd)\/([^/]+)/);
  if (goCmd) {
    const parts = rel.split("/");
    return path.join(root, ...parts.slice(0, Math.min(parts.length - 1, goCmd[1].split("/").length + 1)));
  }
  const topModule = rel.match(/^(pkg\/(?:controller|scheduler|kubelet|controlplane|registry|routes|proxy)|plugin\/pkg\/(?:admission|auth))\/([^/]+)/);
  if (topModule) {
    const parts = rel.split("/");
    const take = parts[2] && parts[2].endsWith(".go") ? 2 : 3;
    return path.join(root, ...parts.slice(0, take));
  }
  let d = path.dirname(file);
  while (d.startsWith(root) && d !== root) {
    if (fs.existsSync(path.join(d, "pom.xml")) || fs.existsSync(path.join(d, "src", "main"))) {
      // 取含 src/main 的那层(更贴近"可部署模块")
      if (fs.existsSync(path.join(d, "src", "main"))) return d;
    }
    d = path.dirname(d);
  }
  // 回退：含 src/main 的祖先
  d = path.dirname(file);
  while (d.startsWith(root) && d !== root) { if (fs.existsSync(path.join(d, "src", "main"))) return d; d = path.dirname(d); }
  return path.dirname(file);
}

const javas = walk(root, [".java"]);
const xmls = walk(root, [".xml"]);
const gos = walk(root, [".go"]);
const plsqls = walk(root, [".pks", ".pkb", ".sql"]);

function emptyCounters() {
  return { anno: 0, xml: 0, impl: 0, controller: 0, mapping: 0, listener: 0, scheduled: 0, batch: 0, main: 0, command: 0, http: 0, k8s: 0, package: 0, procedure: 0 };
}

function statsText(profile, row) {
  return profile.name === "spring-rest"
    ? `controller=${row.controller} mapping=${row.mapping}`
    : profile.name === "go-cli"
      ? `main=${row.main} command=${row.command}`
      : profile.name === "go-http"
        ? `http=${row.http}`
        : profile.name === "k8s-controller"
          ? `controller=${row.k8s}`
    : profile.name === "mq-listener"
      ? `listener=${row.listener}`
      : profile.name === "scheduled-job"
        ? `scheduled=${row.scheduled}`
        : profile.name === "batch-job"
          ? `batch=${row.batch}`
          : profile.name === "oracle-sp"
            ? `package=${row.package} procedure=${row.procedure}`
            : `@DubboService=${row.anno} dubbo:service=${row.xml} implements=${row.impl}`;
}

function collectRows(profile) {
  const mods = new Map(); // modDir -> counters
  const bump = (file, kind, n = 1) => {
    const m = moduleOf(file);
    if (!mods.has(m)) mods.set(m, emptyCounters());
    mods.get(m)[kind] += n;
  };

  if (profile.name === "spring-rest") {
    const methodAnnotations = profile.method_annotations || [];
    for (const f of javas) {
      const t = read(f);
      if (/@(RestController|Controller)\b/.test(t)) bump(f, "controller");
      const count = methodAnnotations.reduce((n, ann) => n + (t.match(new RegExp(ann.replace("@", "@") + "\\b", "g")) || []).length, 0);
      if (count) bump(f, "mapping", count);
    }
  } else if (profile.name === "go-cli") {
    for (const f of gos) {
      const t = read(f);
      if (/\bpackage\s+main\b/.test(t) && /\bfunc\s+main\s*\(/.test(t)) bump(f, "main");
      const commands = (t.match(/(?:&|new\s*\()\s*cobra\.Command\b|cobra\.Command\s*\{/g) || []).length;
      if (commands && /\bUse\s*:\s*"/.test(t)) bump(f, "command", commands);
      const commandFactories = (t.match(/\bfunc\s+New\w*(?:Command|Cmd)\s*\([^)]*\)\s+\*?cobra\.Command\b/g) || []).length;
      if (commandFactories) bump(f, "command", commandFactories);
    }
  } else if (profile.name === "go-http") {
    const patterns = [
      /\bfunc\s*\([^)]*\)\s*ServeHTTP\s*\(\s*\w+\s+http\.ResponseWriter\s*,\s*\w+\s+\*http\.Request\s*\)/g,
      /\bHandleFunc\s*\(/g,
      /\bHandle\s*\(\s*"\/[^"]*"\s*,/g,
      /\bfunc\s+\w*Handler\w*\s*\([^)]*\)\s+http\.Handler/g,
      /\bfunc\s+\w*Handler\w*\s*\([^)]*\)\s+http\.HandlerFunc/g,
    ];
    for (const f of gos) {
      const t = read(f);
      const count = patterns.reduce((n, re) => n + (t.match(re) || []).length, 0);
      if (count) bump(f, "http", count);
    }
  } else if (profile.name === "k8s-controller") {
    const patterns = [
      /\bResourceEventHandlerFuncs\b/g,
      /\bAddEventHandler(?:WithResyncPeriod)?\s*\(/g,
      /\b(AddFunc|UpdateFunc|DeleteFunc)\s*:/g,
      /\bfunc\s*\([^)]*\)\s*Reconcile\s*\(/g,
      /\bfunc\s*\([^)]*\)\s*sync[A-Z]\w*\s*\(/g,
      /\bfunc\s*\([^)]*\)\s*enqueue[A-Z]\w*\s*\(/g,
      /\bfunc\s*\([^)]*\)\s*(add|update|delete)[A-Z]\w*\s*\(/g,
    ];
    for (const f of gos) {
      const rel = path.relative(root, f).replace(/\\/g, "/");
      if (!/^(pkg|plugin)\//.test(rel)) continue;
      const t = read(f);
      const count = patterns.reduce((n, re) => n + (t.match(re) || []).length, 0);
      if (count) bump(f, "k8s", count);
    }
  } else if (profile.name === "mq-listener") {
    for (const f of javas) {
      const t = read(f);
      const count = (t.match(/@(KafkaListener|RabbitListener|JmsListener|RocketMQMessageListener)\b/g) || []).length;
      if (count) bump(f, "listener", count);
    }
  } else if (profile.name === "scheduled-job") {
    for (const f of javas) {
      const t = read(f);
      const count = (t.match(/@(Scheduled|XxlJob)\b/g) || []).length;
      if (count) bump(f, "scheduled");
    }
  } else if (profile.name === "batch-job") {
    for (const f of javas) {
      const t = read(f);
      const count = (t.match(/@(JobScope|StepScope|EnableBatchProcessing)\b/g) || []).length + (/\bJobBuilderFactory\b|\bStepBuilderFactory\b/.test(t) ? 1 : 0);
      if (count) bump(f, "batch", count);
    }
  } else if (profile.name === "oracle-sp") {
    // Oracle PL/SQL: 服务=Package, 功能=Procedure/Function
    // 模块边界：.pks/.pkb 文件所在目录（无 Maven 概念）
    for (const f of plsqls) {
      const t = read(f);
      const pkgCount = (t.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\s+(?:BODY\s+)?([A-Za-z_][\w#$]*)/gi) || []).length;
      if (pkgCount) bump(f, "package", pkgCount);
      const procCount = (t.match(/\bPROCEDURE\s+([A-Za-z_][\w#$]*)\s*[\(\;]/gi) || []).length;
      const funcCount = (t.match(/\bFUNCTION\s+([A-Za-z_][\w#$]*)\s*[\(\;]/gi) || []).length;
      if (procCount + funcCount) bump(f, "procedure", procCount + funcCount);
    }
  } else {
    // 模块发现 = 任意 implements <接口>(结构, 不按命名门) + @DubboService + Dubbo 旧版 @Service。
    // 与 L2 extractDubboModule"候选来自 implements 结构全集"对齐, 否则非标准命名/暴露的服务在发现层就整模块被丢。
    const ifacePattern = /\bimplements\s+[A-Z][\w.]*/;
    for (const f of javas) {
      const t = read(f);
      if (/@DubboService\b/.test(t) || /@Service\s*\([^)]*\b(?:interfaceClass|version|group)\b/.test(t)) bump(f, "anno");
      if (ifacePattern.test(t)) bump(f, "impl");
    }
    for (const f of xmls) {
      if (/<dubbo:service\b/.test(read(f))) bump(f, "xml");
    }
  }

  return [...mods.entries()]
    .map(([m, c]) => {
    const relPath = path.relative(root, m).replace(/\\/g, "/");
    const baseSlug = relPath.replace(/\//g, "__");
    return {
      relPath,                                   // 真实相对路径(带斜杠) —— 渲染输出用 docs/<relPath>/
      absPath: m,                                // 绝对路径 —— 子代理的"模块根"
      baseSlug,
      slug: `${profile.name}__${baseSlug}`,      // profile 入 slug，避免同模块多入口分片互相覆盖
      profile: profile.name,
      ...c,
    };
    })
    .filter((r) => {
    if (profile.name === "spring-rest") return r.controller || r.mapping;
    if (profile.name === "go-cli") return r.main || r.command;
    if (profile.name === "go-http") return r.http;
    if (profile.name === "k8s-controller") return r.k8s;
    if (profile.name === "mq-listener") return r.listener;
    if (profile.name === "scheduled-job") return r.scheduled;
    if (profile.name === "batch-job") return r.batch;
    if (profile.name === "oracle-sp") return r.package || r.procedure;
    return r.anno || r.xml || r.impl;
    })
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

const requestedProfiles = profileName === "auto" ? BUILTIN_PROFILES : [profileName];
const attempts = requestedProfiles.map((name) => {
  const profile = loadProfile(name);
  const rows = collectRows(profile);
  return { profile, rows };
});
const rows = attempts.flatMap((a) => a.rows)
  .sort((a, b) => `${a.profile}:${a.relPath}`.localeCompare(`${b.profile}:${b.relPath}`));

// ★ 写权威清单文件 —— 编排器/进度脚本/子代理 一律从这里读 relPath/absPath/slug，绝不自行拼名拍平路径(根治路径错误)
const repowikiDir = repowikiWorkDir(root);
fs.mkdirSync(repowikiDir, { recursive: true });
if (rows.length === 0) {
  const diagnostics = {
    status: "blocked",
    reason: "no L2 profile matched this repository",
    repo: root,
    requestedProfile: profileName,
    attemptedProfiles: attempts.map((a) => ({ profile: a.profile.name, modules: a.rows.length })),
    javaFiles: javas.length,
    xmlFiles: xmls.length,
    goFiles: gos.length,
    next: "Add or select a matching L2 profile/adapter, then rerun list-services.cjs from L2. Do not proceed to L3 with empty modules.",
    updated_at: new Date().toISOString(),
  };
  const mismatchFile = path.join(repowikiDir, "profile-mismatch.json");
  fs.writeFileSync(mismatchFile, JSON.stringify(diagnostics, null, 2), "utf8");
  console.error(`✗ profile=${profileName} 未发现任何服务入口。`);
  console.error("这通常表示当前仓库与所选 L2 profile 不匹配，或该技术栈尚未接入 repowiki L2。");
  console.error(`已写诊断: ${mismatchFile}`);
  console.error(`已停止，未写入 ${path.join(repowikiDir, "modules.json")}`);
  process.exit(4);
}
const staleMismatchFile = path.join(repowikiDir, "profile-mismatch.json");
if (fs.existsSync(staleMismatchFile)) fs.rmSync(staleMismatchFile);
fs.writeFileSync(path.join(repowikiDir, "modules.json"), JSON.stringify(rows, null, 2), "utf8");

console.log(`# 全仓含服务模块清单 (profile=${profileName}, 共 ${rows.length} 个) — 编排器必须逐个处理, 一个都不能漏`);
console.log(`# 权威清单已写: ${path.join(repowikiDir, "modules.json").replace(/\\/g, "/")}  (含 relPath/absPath/slug, 后续一律从此读)`);
if (profileName === "auto") {
  console.log(`# profile 命中: ${attempts.map((a) => `${a.profile.name}=${a.rows.length}`).join(" ")}`);
}
rows.forEach((r, i) => {
  const profile = loadProfile(r.profile);
  const stats = statsText(profile, r);
  console.log(`${String(i + 1).padStart(2)}. ${r.relPath}   slug=${r.slug}   profile=${r.profile}   [${stats}]`);
});
console.log(`\n总计 ${rows.length} 个模块。完成后核对: 服务清单/功能文档必须覆盖以上每一个模块。`);
console.log(`NEXT: 模块枚举完成。禁止输出 text-only response 停下，必须立即运行 L2 抽取：`);
console.log(`  node "${path.join(__dirname, "repowiki-l2.cjs")}" "${root}" --all`);
