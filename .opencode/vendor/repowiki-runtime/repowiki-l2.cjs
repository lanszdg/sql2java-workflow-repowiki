#!/usr/bin/env node
/**
 * repowiki-l2.cjs — 按 profile 确定性 L2 提取（不用大模型）。
 * dubbo: grep 找服务实现 + 解析接口拿方法 + codegraph `Class::method` callees 拿方法级下游。
 * spring-rest: 找 Controller + @*Mapping endpoint 方法 + codegraph callees 拿入口间调用。
 * 产出与大模型版同 schema 的分片：services/functions/downstream.part-<slug>.json
 *
 * 用法: node repowiki-l2.cjs <仓根> <模块绝对路径> <slug> [--profile dubbo|spring-rest]
 *       node repowiki-l2.cjs <仓根> --all [--profile dubbo|spring-rest]
 *
 * 坑已处理：
 *  - 图谱必须建好(带 OPENCODE_PARSERS_DIR、serve 不锁 db)：先 status 体检，节点太少直接报错不静默出空。
 *  - 同名方法下游归属：callees 用 `ClassName::method` 限定，单方法精确(已实测)。
 */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { docFirstLine, firstDocBeforeDecl, methodDocMap } = require(path.join(__dirname, "lib", "javadoc.cjs"));
const { buildProjectionParts } = require(path.join(__dirname, "lib", "l2-projection.cjs"));
const { inventory: l1Inventory, edgesFor: l1EdgesFor } = require(path.join(__dirname, "lib", "l1-adapter.cjs"));
const { openCodegraphSync, calleesForByNodeId, calleesForBySymbol } = require(path.join(__dirname, "lib", "l2-callees.cjs"));

const repo = process.argv[2];
const a3 = process.argv[3];   // 模块绝对路径 或 --all
const a4 = process.argv[4];   // slug(单模块时)
if (!repo || !a3) { console.error("usage: node repowiki-l2.cjs <仓根> <模块绝对路径> <slug>   |   <仓根> --all"); process.exit(2); }
const extraArgs = process.argv.slice(3);
let cliProfile = process.env.REPOWIKI_PROFILE || "";
const verbose = extraArgs.includes("--verbose");
const quietAll = a3 === "--all" && !verbose;
const FACT_SCHEMA_VERSION = 11;
const FACT_FEATURE_SET = {
  p0GraphFacts: true,
  sourceFile: true,
  modelTypes: true,
  evidenceConfidence: true,
  callgraphTopologyInput: true,
  profileMaterializationCompleteness: true,
  projectionMaterializedFunctions: true,
  dubboWideScanCandidates: true,
  springRestWideScanCandidates: true,
  springRestMappingExtractionV2: true,
  annotatedEntryWideScanCandidates: true,
  goEntryWideScanCandidates: true,
  graphDerivedExpectedFunctions: true,
  dubboTripleIdlCandidates: true,
  l2Diagnosis: true,
  repoArtifactFacts: true,
  tableFacts: true,
  l1Grounded: true,
  xmlExposureBinding: true,
  coverageLedger: true,
  xmlStructuralDedup: true,
  methodNodeGrounding: true,
  sourceFingerprintGuard: true,
  serviceIdentityV2: true,
  l1InterfaceMethodEnumeration: true,
  interfaceMethodLedger: true,
  oracleSpCrossPackageConstants: true,  // v12: 跨包抽取 const_pkg 常量值 + TYPE 定义，SQL 别名黑名单，独立函数归 __STANDALONE__
  oracleSpJavaTypePrecision: true,       // v12: oracleToJava 按精度映射 BigDecimal
  oracleSpDdlConstraintFilter: true,     // v13: L1 DDL 过滤 CONSTRAINT/PRIMARY KEY 等被误判为列；L2 constant_deps 过滤 SEQ_X.NEXTVAL
};
function usageAndExit(message) {
  if (message) console.error(message);
  console.error("usage: node repowiki-l2.cjs <repo> --all [--profile <profile>]");
  console.error("   or: node repowiki-l2.cjs <repo> <moduleAbsPath> <slug> [--profile <profile>]");
  process.exit(2);
}
for (let i = 0; i < extraArgs.length; i++) {
  const a = extraArgs[i];
  if (a === "--profile") cliProfile = extraArgs[++i] || cliProfile;
  else if (a.startsWith("--profile=")) cliProfile = a.slice("--profile=".length) || cliProfile;
}
function logDetail(message) {
  if (!quietAll) console.log(message);
}
function loadProfile(name) {
  const n = name || "dubbo";
  const f = path.join(__dirname, "profiles", `${n}.json`);
  if (!fs.existsSync(f)) { console.error(`✗ 未找到 profile: ${n} (${f})`); process.exit(2); }
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

const LINGXI = path.resolve(__dirname, "..", "..", "..");          // .../lingxicode-...
const CG_NODE = path.join(LINGXI, "config", "bin", "codegraph", "node.exe");
const CG_JS = path.join(LINGXI, "config", "bin", "codegraph", "dist", "bin", "codegraph.js");
const PARSERS = path.join(LINGXI, "parsers");
const env = { ...process.env, OPENCODE_PARSERS_DIR: PARSERS };
let L1 = null;
let CG = null;          // codegraph 进程内实例(openCodegraphSync)，替代 per-function spawnSync CLI
// isPlsqlOnlyRepo 在后面定义（行 ~216），这里先延迟判断
try {
  L1 = l1Inventory(repo, { includeEdges: false });
} catch (e) {
  L1 = { error: e.message, counts: { nodesByKind: {} }, nodes: [] };
}
// oracle-sp repo：codegraph 不支持 PL/SQL，改读 plsql-l1.json（plsql-l1-producer 生成）
// 延迟重载（isPlsqlOnlyRepo 在后面才赋值，这里在 countSources 后补充判断）
function _reloadL1ForPlsql() {
  if (!isPlsqlOnlyRepo) return;
  try {
    const { plsqlInventory } = require("./lib/plsql-l1-adapter.cjs");
    const pl1 = plsqlInventory(repo, { includeEdges: false });
    if (!pl1.error) {
      L1 = pl1;
      // 重建索引
      l1NodeByFileKindName.clear();
      l1NodesByFileKindName.clear();
      l1NodeById.clear();
      for (const node of L1.nodes || []) {
        if (node.id) l1NodeById.set(node.id, node);
        const key = `${node.file_path || ""}#${node.kind || ""}#${node.name || ""}`;
        l1NodeByFileKindName.set(key, node);
        const list = l1NodesByFileKindName.get(key) || [];
        list.push(node);
        l1NodesByFileKindName.set(key, list);
      }
    }
  } catch (e) {
    // 保持 codegraph 的 L1（或空 L1）
  }
}
const l1NodeByFileKindName = new Map();
const l1NodesByFileKindName = new Map();
const l1NodeById = new Map();
for (const node of L1.nodes || []) {
  if (node.id) l1NodeById.set(node.id, node);
  const key = `${node.file_path || ""}#${node.kind || ""}#${node.name || ""}`;
  l1NodeByFileKindName.set(key, node);
  const list = l1NodesByFileKindName.get(key) || [];
  list.push(node);
  l1NodesByFileKindName.set(key, list);
}
const l1OutgoingEdgesCache = new Map();
function l1OutgoingEdges(nodeId) {
  if (!nodeId || L1.error) return [];
  if (!l1OutgoingEdgesCache.has(nodeId)) {
    let edges = [];
    try {
      edges = l1EdgesFor(repo, [nodeId], { limit: 10000 }).filter((edge) => edge.source === nodeId);
    } catch (_) {
      edges = [];
    }
    l1OutgoingEdgesCache.set(nodeId, edges);
  }
  return l1OutgoingEdgesCache.get(nodeId) || [];
}

function cg(args) {
  const timeout = args && args[0] === "status" ? 60000 : 15000;
  const r = cp.spawnSync(CG_NODE, [CG_JS, ...args], { cwd: repo, env, encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024, timeout });
  if (r.error && r.error.code === "ETIMEDOUT") return "";
  return ((r.stdout || "") + "\n" + (r.stderr || "")).replace(/\x1b\[[0-9;]*m/g, "");        // 去 ANSI 色
}
function cgJson(args) {
  const out = cg([...args, "--json"]);
  const i = out.search(/[\[{]/); if (i < 0) return [];
  let jsonText = out.slice(i);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let p = 0; p < jsonText.length; p++) {
    const ch = jsonText[p];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) { end = p + 1; break; }
    }
  }
  if (end > 0) jsonText = jsonText.slice(0, end);
  let v; try { v = JSON.parse(jsonText); } catch { return []; }
  if (Array.isArray(v)) return v;                 // query 返回数组
  if (v && Array.isArray(v.callees)) return v.callees;   // callees 返回 {symbol,callees:[]}
  if (v && Array.isArray(v.callers)) return v.callers;
  if (v && Array.isArray(v.results)) return v.results;
  return [];
}

// ---- 0) 图谱体检（防"只索引到9文件"那种坑；小样例仓库放宽阈值） ----
const st = cg(["status"]);
const nodes = parseInt(((st.match(/Nodes:\s*([\d,]+)/) || st.match(/([\d,]+)\s+nodes\b/i) || [])[1] || "0").replace(/,/g, ""), 10);
let repoJavaCount = 0;
let repoGoCount = 0;
let repoPlsqlCount = 0;
function skipSourceName(name) {
  return name === "target" || name === "build" || name === "dist" || name === "out" ||
    name === "vendor" || name === "third_party" || name === "node_modules" || name.startsWith(".");
}
function skipSourceFile(file) {
  const rel = path.relative(repo, file).replace(/\\/g, "/");
  const srcMain = rel.startsWith("src/main/") ? 0 : rel.indexOf("/src/main/");
  const prefix = file.endsWith(".java") && srcMain >= 0 ? rel.slice(0, srcMain) : rel;
  const parts = prefix ? prefix.split("/") : [];
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
function countSources(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (skipSourceName(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) countSources(p);
    else if (!skipSourceFile(p) && e.name.endsWith(".java")) repoJavaCount++;
    else if (!skipSourceFile(p) && e.name.endsWith(".go")) repoGoCount++;
    else if (!skipSourceFile(p) && (e.name.endsWith(".pks") || e.name.endsWith(".pkb") || e.name.endsWith(".sql"))) repoPlsqlCount++;
  }
}
countSources(repo);
const repoSourceCount = repoJavaCount + repoGoCount + repoPlsqlCount;
const minNodes = repoSourceCount <= 20 ? 1 : 200;
const hasCodegraph = fs.existsSync(path.join(repo, ".codegraph"));
// oracle-sp repo 无 codegraph 支持（PL/SQL 不在建图范围），放宽体检
const isPlsqlOnlyRepo = repoPlsqlCount > 0 && repoJavaCount === 0 && repoGoCount === 0;
if (!isPlsqlOnlyRepo && nodes < minNodes && !(repoSourceCount <= 20 && hasCodegraph)) {
  console.error(`✗ 图谱可疑：只有 ${nodes} 个节点。多半没建对(需带 OPENCODE_PARSERS_DIR、且 serve 没锁 db)。`);
  console.error(`  先在仓根跑： OPENCODE_PARSERS_DIR=<lingxi>/parsers  codegraph index .   再重试。`);
  process.exit(3);
}

// PL/SQL repo：切换 L1 到 plsql-l1.json
_reloadL1ForPlsql();

// ---- 工具：列出目录下 java 文件 ----
function javaFiles(dir, acc = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (skipSourceName(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) javaFiles(p, acc);
    else if (e.name.endsWith(".java") && !skipSourceFile(p)) acc.push(p);
  }
  return acc;
}
function goFiles(dir, acc = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (skipSourceName(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) goFiles(p, acc);
    else if (e.name.endsWith(".go") && !skipSourceFile(p)) acc.push(p);
  }
  return acc;
}
function plsqlFiles(dir, acc = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (skipSourceName(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) plsqlFiles(p, acc);
    else if ((e.name.endsWith(".pks") || e.name.endsWith(".pkb") || e.name.endsWith(".sql")) && !skipSourceFile(p)) acc.push(p);
  }
  return acc;
}
function factSourceFiles(dir, acc = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (skipSourceName(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) factSourceFiles(p, acc);
    else if (/\.(java|go|xml|properties|yaml|yml|proto|thrift|pks|pkb|sql)$/i.test(e.name) || e.name === "pom.xml" || e.name === "go.mod") {
      if (!skipSourceFile(p)) acc.push(p);
    }
  }
  return acc;
}
function sourceFingerprint(dir) {
  const files = factSourceFiles(dir || repo).sort();
  let latestMtimeMs = 0;
  let totalSize = 0;
  const entries = [];
  for (const file of files) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    const rel = relFile(file);
    latestMtimeMs = Math.max(latestMtimeMs, Math.trunc(st.mtimeMs));
    totalSize += Number(st.size || 0);
    entries.push(`${rel}:${st.size}:${Math.trunc(st.mtimeMs)}`);
  }
  const hash = require("crypto").createHash("sha1").update(entries.join("\n")).digest("hex");
  return { hash, files: entries.length, totalSize, latestMtimeMs };
}
const pkgOf = (txt) => (txt.match(/package\s+([\w.]+)\s*;/) || [])[1] || "";
const clsOf = (txt) => (txt.match(/(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/) || [])[1] || "";
const annRe = (ann) => new RegExp(ann.replace("@", "@") + "\\b");
function splitTopLevel(text, sep = ",") {
  const out = [];
  let cur = "", angle = 0, paren = 0, bracket = 0, quote = "";
  for (let i = 0; i < String(text || "").length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    if (ch === sep && angle === 0 && paren === 0 && bracket === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function findMatchingParen(text, openIndex) {
  let depth = 0, quote = "";
  for (let i = openIndex; i < String(text || "").length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function scanUntilTopLevelBrace(text, start) {
  let paren = 0, bracket = 0, quote = "";
  for (let i = start; i < String(text || "").length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "{" && paren === 0 && bracket === 0) return i;
  }
  return -1;
}
function cleanType(s) {
  return String(s || "")
    .replace(/\.\.\./g, "[]")
    .replace(/\s+/g, " ")
    .replace(/\s*<\s*/g, "<")
    .replace(/\s*>\s*/g, ">")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}
function unwrapResponseType(type) {
  const t = cleanType(type);
  const m = t.match(/^(?:ResponseEntity|HttpEntity|Result|ApiResult|BaseResponse|Response|Mono|Flux|CompletableFuture)\s*<(.+)>$/);
  return m ? cleanType(m[1]) : t;
}
const simpleName = (s) => String(s || "").split(".").pop();
function parseParams(paramsText) {
  const text = String(paramsText || "").trim();
  if (!text) return [];
  return splitTopLevel(text).map((raw) => {
    const annotations = [...raw.matchAll(/@(\w+)(?:\s*\([^)]*\))?/g)].map((m) => m[1]);
    const cleaned = raw
      .replace(/@\w+(?:\s*\([^)]*\))?/g, "")
      .replace(/\bfinal\b/g, "")
      .trim();
    const m = cleaned.match(/^(.+?)\s+([\w$]+)$/);
    const name = m ? m[2] : "";
    const type = m ? cleanType(m[1]) : cleanType(cleaned);
    return { name, type, annotations };
  }).filter((p) => p.type);
}
function paramsSignature(params) {
  return params.map((p) => p.type).join(", ");
}
function requestTypes(params) {
  const infrastructure = new Set(["HttpServletRequest", "HttpServletResponse", "BindingResult", "Model", "ModelMap", "Principal"]);
  const body = params.filter((p) => p.annotations.includes("RequestBody")).map((p) => p.type);
  if (body.length) return body;
  return params
    .filter((p) => !infrastructure.has(simpleName(p.type)))
    .filter((p) => !p.annotations.includes("PathVariable") && !p.annotations.includes("RequestParam") && !p.annotations.includes("RequestHeader"))
    .map((p) => p.type);
}
function modelTypesFromFunction(fn) {
  const types = new Set();
  for (const t of [...(fn.request_types || []), fn.response_type, fn.return_type]) {
    collectModelTypes(t, types);
  }
  return [...types];
}
function collectModelTypes(type, out) {
  const t = cleanType(type);
  if (!t || /^(void|boolean|byte|short|int|long|float|double|char|String|Integer|Long|Boolean|BigDecimal|Date|LocalDate|LocalDateTime|Map|List|Set|Collection)$/i.test(simpleName(t))) return;
  const inner = t.match(/^[\w.]+\s*<(.+)>$/);
  if (inner) {
    for (const p of splitTopLevel(inner[1])) collectModelTypes(p, out);
    return;
  }
  out.add(t.replace(/\[\]$/, ""));
}
function downstreamKind(className, filePath) {
  const name = simpleName(className || filePath || "");
  const fp = String(filePath || "").toLowerCase();
  if (/(Controller|Resource)$/.test(name)) return "controller";
  if (/(Service|Facade|Client|Server)$/.test(name)) return "service";
  if (/(Repository|Mapper|Dao|DAO)$/.test(name)) return "dao";
  if (fp.includes("/controller/") || fp.includes("\\controller\\")) return "controller";
  if (fp.includes("/service/") || fp.includes("\\service\\")) return "service";
  if (fp.includes("/repository/") || fp.includes("\\repository\\") || fp.includes("/mapper/") || fp.includes("\\mapper\\") || fp.includes("/dao/") || fp.includes("\\dao\\")) return "dao";
  return "unknown";
}
function calleeClass(callee) {
  return ((callee.filePath || "").match(/(\w+)\.java$/) || [])[1] || "";
}

// JavaDoc 抽取（docFirstLine/firstDocBeforeDecl/methodDocMap）见 lib/javadoc.cjs

// 全仓建接口索引。★按全限定名(包名.接口名)，根治多模块同名接口(几十个 HelloService)撞名
const repoJava = javaFiles(repo);
const ifaceFileByFqn = new Map();   // pkg.Name -> file
const ifaceFileByName = new Map();  // Name -> file (兜底, 取第一个)
const javaClassByName = new Map();  // ClassName -> { qn, file }
const javaClassByQn = new Map();    // pkg.Name -> { qn, file }
for (const f of repoJava) {
  const t = fs.readFileSync(f, "utf8");
  const cls = clsOf(t);
  if (cls) {
    const qn = (pkgOf(t) ? pkgOf(t) + "." : "") + cls;
    javaClassByName.set(cls, { qn, file: f });
    javaClassByQn.set(qn, { qn, file: f });
  }
  const m = t.match(/(?:public\s+)?interface\s+(\w+)/);
  if (m) {
    const fqn = (pkgOf(t) ? pkgOf(t) + "." : "") + m[1];
    ifaceFileByFqn.set(fqn, f);
    if (!ifaceFileByName.has(m[1])) ifaceFileByName.set(m[1], f);
  }
}
// 把接口短名解析成 FQN：先看本文件 import，否则同包
function fqnOf(short, txt, pkg) {
  const im = txt.match(new RegExp("import\\s+([\\w.]+\\." + short + ")\\s*;"));
  if (im) return im[1];
  // 修复4: import 没找到时, 用 ifaceFileByFqn 反查含 short 的 FQN (对齐行内"继续向上查看父接口的方法")
  for (const fqn of ifaceFileByFqn.keys()) {
    if (fqn.endsWith("." + short) || fqn.split(".").pop() === short) return fqn;
  }
  return (pkg ? pkg + "." : "") + short;
}
const ifaceFile = (fqn, short) => ifaceFileByFqn.get(fqn) || ifaceFileByName.get(short);

function xmlAttrMap(tag) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(String(tag || "")))) out[m[1]] = m[2] != null ? m[2] : m[3];
  return out;
}

function lineOf(text, index) {
  return String(text || "").slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function precedingXmlComment(text, index) {
  const before = String(text || "").slice(0, Math.max(0, index));
  const comments = [...before.matchAll(/<!--([\s\S]*?)-->/g)];
  const last = comments.length ? comments[comments.length - 1] : null;
  return last ? last[1].replace(/\s+/g, " ").trim() : "";
}

function buildDubboXmlIndex(files) {
  const beanById = new Map();
  const exposures = [];
  for (const file of files || []) {
    const txt = readText(file);
    const rel = relFile(file);
    const beanRe = /<bean\b[\s\S]*?>/g;
    let bm;
    while ((bm = beanRe.exec(txt))) {
      const attrs = xmlAttrMap(bm[0]);
      if (!attrs.id || !attrs.class) continue;
      beanById.set(attrs.id, {
        id: attrs.id,
        class_qn: attrs.class,
        xml_file: rel,
        line: lineOf(txt, bm.index),
      });
    }
  }
  for (const file of files || []) {
    const txt = readText(file);
    const rel = relFile(file);
    const re = /<dubbo:service\b[\s\S]*?>/g;
    let m;
    while ((m = re.exec(txt))) {
      const attrs = xmlAttrMap(m[0]);
      const iface = attrs.interface || attrs.interfaceClass || "";
      if (!iface) continue;
      const ref = attrs.ref || "";
      const serviceIface = simpleName(iface);
      const lowerIface = (serviceIface || "").toLowerCase();
      const lowerRef = (ref || "").toLowerCase();
      if (lowerIface.includes("echoserver") || lowerIface.includes("echoimpl") || lowerRef.includes("echoserver") || lowerRef.includes("echoimpl")) continue;
      if (/(Mapper|Dao|DAO|Repository)$/.test(serviceIface)) continue;
      const bean = ref ? beanById.get(ref) || null : null;
      exposures.push({
        interface_qn: iface,
        service_iface: simpleName(iface),
        ref,
        impl_qn: bean && bean.class_qn || "",
        version: attrs.version || "默认",
        group: attrs.group || "",
        xml_file: rel,
        xml_line: lineOf(txt, m.index),
        xml_comment: precedingXmlComment(txt, m.index),
        bean,
      });
    }
  }
  return { beanById, exposures };
}

const repoXmlFiles = xmlFiles(repo);
const dubboXmlIndex = buildDubboXmlIndex(repoXmlFiles);

function l1NodeFor(file, kind, name) {
  const rel = file ? relFile(file) : "";
  return l1NodeByFileKindName.get(`${rel}#${kind}#${name}`) || null;
}

function nodeParamTypes(signature) {
  const m = String(signature || "").match(/\((.*)\)/);
  if (!m) return "";
  return splitTopLevel(m[1])
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const parts = raw.replace(/\bfinal\b/g, "").trim().split(/\s+/);
      return cleanType(parts.length > 1 ? parts.slice(0, -1).join(" ") : raw);
    })
    .join(", ");
}

function l1MethodNodeFor(file, name, params = null) {
  const rel = file ? relFile(file) : "";
  const list = l1NodesByFileKindName.get(`${rel}#method#${name}`) || [];
  if (!list.length) return null;
  if (Array.isArray(params)) {
    const expected = paramsSignature(params);
    const matched = list.find((node) => nodeParamTypes(node.signature) === expected);
    if (matched) return matched;
  }
  return list[0];
}

const methodDocsByRelFile = new Map();
function methodDocsForRelFile(rel) {
  const key = String(rel || "").replace(/\\/g, "/");
  if (!key) return {};
  if (!methodDocsByRelFile.has(key)) {
    const txt = readText(path.join(repo, key));
    methodDocsByRelFile.set(key, txt ? methodDocMap(txt) : {});
  }
  return methodDocsByRelFile.get(key) || {};
}

function firstInterfaceDocForRelFile(rel) {
  const txt = rel ? readText(path.join(repo, rel)) : "";
  return txt ? firstDocBeforeDecl(txt, /(?:public\s+)?interface\s+\w+/) : "";
}

function l1ClassNodeForQn(qn) {
  const rec = classRecord(qn);
  const short = simpleName(qn);
  if (rec && rec.file) {
    const node = l1NodeFor(rec.file, "class", short);
    if (node) return node;
  }
  return (L1.nodes || []).find((node) => node.kind === "class" && node.name === short) || null;
}

function interfaceNodeMatches(node, ifQn, short, ifaceRel = "") {
  if (!node || node.kind !== "interface") return false;
  const nodeFile = String(node.file_path || "").replace(/\\/g, "/");
  const wantShort = simpleName(short || ifQn);
  if (ifaceRel && nodeFile === ifaceRel) return true;
  if (ifQn && (node.qualified_name === ifQn || node.name === simpleName(ifQn))) return true;
  return !!wantShort && node.name === wantShort;
}

function disambiguateInterfaceNodes(nodes, ifQn, short, ifaceRel = "") {
  const candidates = (nodes || []).filter((node) => interfaceNodeMatches(node, ifQn, short, ifaceRel));
  if (candidates.length <= 1) return candidates;
  if (ifaceRel) {
    const byFile = candidates.filter((node) => String(node.file_path || "").replace(/\\/g, "/") === ifaceRel);
    if (byFile.length === 1) return byFile;
  }
  const byQn = candidates.filter((node) => node.qualified_name === ifQn);
  if (byQn.length === 1) return byQn;
  return candidates;
}

function l1InterfaceNodesFor(ifQn, short, options = {}) {
  const service = options.service || {};
  const ifaceRel = ifaceFile(ifQn, short) ? relFile(ifaceFile(ifQn, short)) : "";
  const implNode = service.evidence?.l1_impl_node_id
    ? l1NodeById.get(service.evidence.l1_impl_node_id)
    : l1ClassNodeForQn(service.impl_qn);

  if (implNode) {
    const implTargets = l1OutgoingEdges(implNode.id)
      .filter((edge) => edge.kind === "implements")
      .map((edge) => l1NodeById.get(edge.target))
      .filter((node) => node && node.kind === "interface");
    const matched = disambiguateInterfaceNodes(implTargets, ifQn, short, ifaceRel);
    if (matched.length === 1) return { nodes: matched, source: "impl-implements-edge", ambiguous: [] };
    if (matched.length > 1) return { nodes: [], source: "ambiguous-impl-implements-edge", ambiguous: matched };
  }

  const evidenceNode = service.evidence?.l1_iface_node_id ? l1NodeById.get(service.evidence.l1_iface_node_id) : null;
  if (evidenceNode && interfaceNodeMatches(evidenceNode, ifQn, short, ifaceRel)) {
    return { nodes: [evidenceNode], source: "service-evidence-node-id", ambiguous: [] };
  }

  if (ifaceRel) {
    const byFile = l1NodeByFileKindName.get(`${ifaceRel}#interface#${simpleName(short || ifQn)}`);
    if (byFile) return { nodes: [byFile], source: "source-file-index", ambiguous: [] };
  }

  const allMatches = disambiguateInterfaceNodes((L1.nodes || []).filter((node) => node.kind === "interface"), ifQn, short, ifaceRel);
  if (allMatches.length === 1) return { nodes: allMatches, source: "name-or-qn-index", ambiguous: [] };
  if (allMatches.length > 1) return { nodes: [], source: "ambiguous-name-or-qn-index", ambiguous: allMatches };
  return { nodes: [], source: "not-found", ambiguous: [] };
}

function parseL1MethodSignature(node) {
  const sig = String(node?.signature || "").trim();
  const m = sig.match(/^([\s\S]*?)\s*\(([\s\S]*)\)\s*$/);
  if (!m) return { ok: false, reason: "missing method signature parentheses", signature: sig };
  const returnType = cleanType(m[1] || "void") || "void";
  const params = parseParams(m[2] || "");
  return {
    ok: true,
    method: node.name || (String(node.qualified_name || "").split("::").pop()),
    return_type: returnType,
    params,
    signature: `${returnType} ${node.name || ""}(${paramsSignature(params)})`,
  };
}

function l1ReachableMethodNodes(ifaceNode, seen = new Set(), depth = 0, out = []) {
  if (!ifaceNode || !ifaceNode.id || seen.has(ifaceNode.id)) return out;
  seen.add(ifaceNode.id);
  const edges = l1OutgoingEdges(ifaceNode.id);
  for (const edge of edges) {
    if (edge.kind !== "contains") continue;
    const target = l1NodeById.get(edge.target);
    if (!target || target.kind !== "method") continue;
    out.push({
      node: target,
      owner_iface_node: ifaceNode,
      depth,
      inherited_from: depth > 0 ? ifaceNode.name || simpleName(ifaceNode.qualified_name) : null,
    });
  }
  for (const edge of edges) {
    if (edge.kind !== "extends") continue;
    const parent = l1NodeById.get(edge.target);
    if (parent && parent.kind === "interface") l1ReachableMethodNodes(parent, seen, depth + 1, out);
  }
  return out;
}

function materializeL1MethodNode(raw) {
  const parsed = parseL1MethodSignature(raw.node);
  const ifaceRel = String(raw.owner_iface_node?.file_path || "").replace(/\\/g, "/");
  if (!parsed.ok || !parsed.method) {
    return {
      ok: false,
      unresolved: {
        node_id: raw.node?.id || "",
        method: raw.node?.name || "",
        signature: raw.node?.signature || "",
        iface_node_id: raw.owner_iface_node?.id || "",
        iface_file: ifaceRel,
        reason: parsed.reason || "method node cannot be materialized",
      },
    };
  }
  const docs = methodDocsForRelFile(ifaceRel);
  return {
    ok: true,
    method: {
      method: parsed.method,
      signature: parsed.signature,
      return_type: parsed.return_type,
      params: parsed.params,
      method_doc: raw.node.docstring || docs[parsed.method] || "",
      iface_file: ifaceRel,
      inherited_from: raw.inherited_from,
      source_mode: "l1-codegraph-contains-v1",
      l1_iface_method_node_id: raw.node.id || "",
      l1_iface_node_id: raw.owner_iface_node?.id || "",
      _dedupe_key: `${parsed.method}(${paramsSignature(parsed.params)})`,
      _depth: raw.depth || 0,
    },
  };
}

function dedupeMaterializedMethods(methods) {
  const kept = new Map();
  const shadowed = [];
  for (const method of methods || []) {
    const key = method._dedupe_key || `${method.method}(${paramsSignature(method.params || [])})`;
    const old = kept.get(key);
    if (!old) {
      kept.set(key, method);
      continue;
    }
    const oldDepth = Number(old._depth || 0);
    const nextDepth = Number(method._depth || 0);
    if (nextDepth < oldDepth) {
      shadowed.push({
        node_id: old.l1_iface_method_node_id || "",
        method: old.method || "",
        signature: old.signature || "",
        iface_file: old.iface_file || "",
        reason: "shadowed by child interface method with same signature",
      });
      kept.set(key, method);
    } else {
      shadowed.push({
        node_id: method.l1_iface_method_node_id || "",
        method: method.method || "",
        signature: method.signature || "",
        iface_file: method.iface_file || "",
        reason: "shadowed by child interface method with same signature",
      });
    }
  }
  return {
    methods: [...kept.values()].map(({ _dedupe_key, _depth, ...method }) => method),
    shadowed,
  };
}

function methodsOfFromL1(ifQn, short, options = {}) {
  const found = l1InterfaceNodesFor(ifQn, short, options);
  if (!found.nodes.length) {
    return {
      status: "unresolved",
      source: found.source || "not-found",
      iface_node_id: "",
      ifaceDoc: "",
      raw_reachable_method_nodes: 0,
      methods: [],
      parse_unresolved_methods: [],
      shadowed_inherited_methods: [],
      skipped_methods: [],
      unresolved_methods: [{
        iface_qn: ifQn,
        service_iface: short,
        reason: found.ambiguous?.length ? "ambiguous interface node" : "interface node not found in L1",
        candidates: (found.ambiguous || []).map((node) => ({ node_id: node.id, name: node.name, file_path: node.file_path })),
      }],
    };
  }
  const ifaceNode = found.nodes[0];
  const raw = l1ReachableMethodNodes(ifaceNode);
  const ifaceRel = String(ifaceNode.file_path || "").replace(/\\/g, "/");
  const ifaceDoc = ifaceNode.docstring || firstInterfaceDocForRelFile(ifaceRel);
  if (!raw.length) {
    return {
      status: "empty_interface",
      source: "l1-codegraph-empty-interface-v1",
      iface_node_id: ifaceNode.id || "",
      ifaceDoc,
      raw_reachable_method_nodes: 0,
      methods: [],
      parse_unresolved_methods: [],
      shadowed_inherited_methods: [],
      skipped_methods: [],
      unresolved_methods: [],
    };
  }
  const parsed = raw.map(materializeL1MethodNode);
  const parseUnresolved = parsed.filter((x) => !x.ok).map((x) => x.unresolved);
  const materialized = parsed.filter((x) => x.ok).map((x) => x.method);
  const deduped = dedupeMaterializedMethods(materialized);
  const status = parseUnresolved.length ? "partial" : "passed";
  return {
    status,
    source: "l1-codegraph-contains-v1",
    iface_node_id: ifaceNode.id || "",
    ifaceDoc,
    raw_reachable_method_nodes: raw.length,
    methods: deduped.methods,
    parse_unresolved_methods: parseUnresolved,
    shadowed_inherited_methods: deduped.shadowed,
    skipped_methods: [],
    unresolved_methods: [],
  };
}

function classRecord(qnOrName) {
  const qn = String(qnOrName || "");
  return javaClassByQn.get(qn) || javaClassByName.get(simpleName(qn)) || null;
}

function serviceKeyFor(svc) {
  return [
    svc.impl_qn || "",
    svc.iface_qn || svc.service_iface || "",
    svc.version || "",
    svc.group || "",
    svc.profile || "",
  ].join("|");
}

// 全仓"服务接口短名"集合：@DubboService 实现的接口 + dubbo:service XML 的 interface + *Service/*Facade。
// 用它判定 dubbo "是不是服务"和"下游算不算跨服务"——不靠名字后缀(否则漏 ServiceA/B、IDL 生成接口)。
const TRIVIAL = new Set(["Serializable", "Cloneable", "Comparable", "Runnable", "AutoCloseable", "Closeable", "Iterable"]);
// 服务暴露置信(仅作信号, 不作种子门)：服务候选集来自 implements 结构全集，命名/注解只决定 in_scope vs review。
// 命名约定放宽到常见服务后缀(Server/Provider/... 不止 Service/Facade)；@DSF 等机制识别为证据而非门。
const SERVICE_NAME_RE = /(Service|Facade|Server|Provider|Api|Remote|Rpc|Endpoint|Gateway)$/;
function serviceExposureEvidence(implText, ifaceSimple, isDubboAnnotated) {
  if (isDubboAnnotated) return "dubbo-annotation";
  const t = implText || "";
  // Dubbo 旧版 @Service(interfaceClass=/version=/group=/timeout=...) 或带 dubbo import —— 与 Spring 的 @Service 区分(行内规约要求)
  if (/@Service\s*\([^)]*\b(?:interfaceClass|version|group|timeout)\b/.test(t) ||
      (/@Service\b/.test(t) && /import\s+(?:org\.apache\.dubbo|com\.alibaba\.dubbo)/.test(t))) return "dubbo-annotation";
  if (/@D(SF|sf)[A-Za-z]*\b/.test(t)) return "dsf-annotation";
  if (SERVICE_NAME_RE.test(ifaceSimple || "")) return "naming";
  return "none";
}
const implementedOf = (t) => { const cm = t.match(/class\s+\w+[^{]*\bimplements\s+([\w.,<>\s]+?)\s*\{/); return cm ? cm[1].split(",").map((s) => s.trim().replace(/<.*>/, "")).filter((s) => s && !TRIVIAL.has(s.split(".").pop())) : []; };
const serviceIfaceNames = new Set();
for (const f of repoJava) {
  const t = fs.readFileSync(f, "utf8");
  if (/@DubboService/.test(t)) for (const x of implementedOf(t)) serviceIfaceNames.add(x.split(".").pop());
}
for (const f of ifaceFileByFqn.keys()) { const n = f.split(".").pop(); if (SERVICE_NAME_RE.test(n)) serviceIfaceNames.add(n); }
// XML dubbo:service interface="..."
for (const x of dubboXmlIndex.exposures) serviceIfaceNames.add(simpleName(x.interface_qn));

// REST 全仓入口类/方法索引，用于 downstream 判定。
const restEntryClasses = new Set();
const restEntryMethods = new Set(); // Class::method
for (const f of repoJava) {
  const t = fs.readFileSync(f, "utf8");
  if (!/@(RestController|Controller)\b/.test(t)) continue;
  const cls = clsOf(t); if (!cls) continue;
  restEntryClasses.add(cls);
  const body = t.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /@(?:RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b[\s\S]*?(?:public\s+|protected\s+|private\s+)?(?:[\w.<>\[\],?]+\s+)+(\w+)\s*\(/g;
  let m; while ((m = re.exec(body))) restEntryMethods.add(`${cls}::${m[1]}`);
}

function annArgs(text) {
  const args = String(text || "");
  const out = [...args.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]).filter((x) => x.startsWith("/"));
  if (out.length) return [...new Set(out)];
  const m = args.match(/\(\s*(?:value\s*=\s*|path\s*=\s*)?([\w./{}-]+)\s*\)/);
  return m ? [m[1]] : [""];
}
function annArg(text) {
  return annArgs(text)[0] || "";
}
function joinPath(a, b) {
  const s = [a, b].filter(Boolean).join("/");
  return ("/" + s).replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}
function mappingInfo(annBlock) {
  const anns = [...annBlock.matchAll(/@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b(\s*\([^)]*\))?/g)];
  if (!anns.length) return null;
  const last = anns[anns.length - 1];
  const name = last[1], args = last[2] || "";
  const methodByAnn = {
    GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", DeleteMapping: "DELETE", PatchMapping: "PATCH",
  };
  let method = methodByAnn[name] || "";
  if (!method) {
    const methods = [...args.matchAll(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/g)].map((m) => m[1]);
    method = methods.length ? methods.join("|") : "ANY";
  }
  return { http_method: method, paths: annArgs(args), path: annArg(args) };
}

function parseModelFields(typeName) {
  const short = simpleName(cleanType(typeName).replace(/\[\]$/, ""));
  const found = javaClassByName.get(short);
  if (!found) return [];
  const txt = fs.readFileSync(found.file, "utf8").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const fields = [];
  const re = /(?:@\w+(?:\s*\([^)]*\))?\s*)*(?:private|protected|public)\s+(?!static\b)([\w.<>\[\],? ]+)\s+(\w+)\s*(?:=|;)/g;
  let m;
  while ((m = re.exec(txt))) {
    const name = m[2];
    if (/^(serialVersionUID|log|logger)$/i.test(name)) continue;
    fields.push({ name, type: cleanType(m[1]), source: found.qn });
  }
  return fields;
}

function xmlFiles(dir, acc = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (skipSourceName(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) xmlFiles(p, acc);
    else if (e.name.endsWith(".xml") && !skipXmlFile(p)) acc.push(p);
  }
  return acc;
}

function skipXmlFile(file) {
  const rel = path.relative(repo, file).replace(/\\/g, "/");
  return !rel || rel.startsWith("..") || rel.startsWith("src/test/") || rel.includes("/src/test/") ||
    rel.startsWith("test/") || rel.includes("/test/") || rel.includes("/target/") || rel.startsWith("target/");
}

function relFile(file) {
  return path.relative(repo, file).replace(/\\/g, "/");
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function stripXmlComments(text) {
  return String(text || "").replace(/<!--[\s\S]*?-->/g, "");
}

function extractSqlTables(sql) {
  const cleaned = String(sql || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ");
  const tables = new Set();
  const dynamic = /\$\{[^}]+}|#\{[^}]+}/.test(cleaned);
  const re = /\b(?:from|join|into|update|delete\s+from)\s+([`"\[]?[\w.$-]+[`"\]]?)/ig;
  let m;
  while ((m = re.exec(cleaned))) {
    const name = String(m[1] || "").replace(/^[`"\[]|[`"\]]$/g, "");
    if (!name || /^(select|values|set|where)$/i.test(name)) continue;
    if (name.includes("${") || name.includes("#{")) continue;
    tables.add(name);
  }
  return { tables: [...tables], dynamic };
}

function javaStringLiteralValue(raw) {
  const parts = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(String(raw || "")))) parts.push(m[1].replace(/\\"/g, "\""));
  return parts.join(" ");
}

function sqlAnnotationFacts(file, txt, module, profile) {
  const out = [];
  const pkg = pkgOf(txt);
  const cls = clsOf(txt) || path.basename(file, ".java");
  const qn = (pkg ? pkg + "." : "") + cls;
  const body = stripComments(txt);
  const re = /@(Select|Insert|Update|Delete)\s*\(([\s\S]*?)\)\s*(?:public\s+|protected\s+|private\s+)?(?:[\w.<>\[\],?]+\s+)+(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const sql = javaStringLiteralValue(m[2]) || m[2];
    const parsed = extractSqlTables(sql);
    for (const table of parsed.tables) out.push({
      module, profile: profile.name, impl_qn: qn, method: m[3], table,
      sql_kind: m[1].toLowerCase(), source: "java-sql-annotation", source_file: relFile(file),
      dao_qn: qn, dao_method: m[3], dynamic: false,
    });
    if (parsed.dynamic && !parsed.tables.length) out.push({
      module, profile: profile.name, impl_qn: qn, method: m[3], table: "无（根据实际运行参数动态确定，需人工复核）",
      sql_kind: m[1].toLowerCase(), source: "java-sql-annotation", source_file: relFile(file),
      dao_qn: qn, dao_method: m[3], dynamic: true,
    });
  }
  return out;
}

function jdbcTemplateFacts(file, txt, module, profile) {
  const out = [];
  const pkg = pkgOf(txt);
  const cls = clsOf(txt) || path.basename(file, ".java");
  const qn = (pkg ? pkg + "." : "") + cls;
  const body = stripComments(txt);
  const methodRe = /(?:public|protected|private)\s+[\w.<>\[\],?]+\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = methodRe.exec(body))) {
    const start = m.index;
    const brace = body.indexOf("{", methodRe.lastIndex - 1);
    if (brace < 0) continue;
    const end = scanJavaBlockEnd(body, brace);
    const chunk = end > brace ? body.slice(brace, end) : body.slice(brace, Math.min(body.length, brace + 4000));
    if (!/\b(?:JdbcTemplate|NamedParameterJdbcTemplate|jdbcTemplate|namedParameterJdbcTemplate)\b/.test(chunk)) continue;
    const sqls = [...chunk.matchAll(/"((?:\\.|[^"\\])*(?:select|insert|update|delete|from|join|into)[\s\S]*?)"/ig)].map((x) => x[1]);
    for (const sql of sqls) {
      const parsed = extractSqlTables(sql);
      for (const table of parsed.tables) out.push({
        module, profile: profile.name, impl_qn: qn, method: m[1], table,
        sql_kind: "jdbc", source: "jdbc-template", source_file: relFile(file), dynamic: false,
      });
      if (parsed.dynamic && !parsed.tables.length) out.push({
        module, profile: profile.name, impl_qn: qn, method: m[1], table: "无（根据实际运行参数动态确定，需人工复核）",
        sql_kind: "jdbc", source: "jdbc-template", source_file: relFile(file), dynamic: true,
      });
    }
  }
  return out;
}

function scanJavaBlockEnd(text, openIndex) {
  let depth = 0, quote = "";
  for (let i = openIndex; i < String(text || "").length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function mybatisXmlFacts(file, module, profile) {
  const txt = stripXmlComments(readText(file));
  const namespace = (txt.match(/<mapper[^>]*\bnamespace=["']([^"']+)["']/i) || [])[1] || "";
  if (!namespace) return [];
  const out = [];
  const re = /<(select|insert|update|delete)\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/ig;
  let m;
  while ((m = re.exec(txt))) {
    const parsed = extractSqlTables(m[3]);
    for (const table of parsed.tables) out.push({
      module, profile: profile.name, impl_qn: namespace, method: m[2], table,
      sql_kind: m[1].toLowerCase(), source: "mybatis-xml", source_file: relFile(file),
      dao_qn: namespace, dao_method: m[2], dynamic: false,
    });
    if (parsed.dynamic && !parsed.tables.length) out.push({
      module, profile: profile.name, impl_qn: namespace, method: m[2], table: "无（根据实际运行参数动态确定，需人工复核）",
      sql_kind: m[1].toLowerCase(), source: "mybatis-xml", source_file: relFile(file),
      dao_qn: namespace, dao_method: m[2], dynamic: true,
    });
  }
  return out;
}

function mybatisPlusFacts(file, txt, module, profile) {
  const pkg = pkgOf(txt);
  const cls = clsOf(txt) || (txt.match(/(?:public\s+)?interface\s+(\w+)/) || [])[1] || path.basename(file, ".java");
  const qn = (pkg ? pkg + "." : "") + cls;
  const out = [];
  const table = (txt.match(/@TableName\s*\(\s*["']([^"']+)["']/) || [])[1] || "";
  if (table) out.push({ module, profile: profile.name, impl_qn: qn, method: "", table, sql_kind: "mybatis-plus", source: "mybatis-plus-entity", source_file: relFile(file), dynamic: false });
  const mapper = txt.match(/interface\s+(\w+)[^{]*\bextends\s+[\w.]*BaseMapper\s*<\s*([\w.]+)\s*>/);
  if (mapper) {
    const entityShort = simpleName(mapper[2]);
    const found = javaClassByName.get(entityShort);
    const entityTxt = found ? readText(found.file) : "";
    const entityTable = (entityTxt.match(/@TableName\s*\(\s*["']([^"']+)["']/) || [])[1] || "";
    if (entityTable) out.push({
      module, profile: profile.name, impl_qn: qn, method: "", table: entityTable,
      sql_kind: "mybatis-plus", source: "mybatis-plus-basemapper", source_file: relFile(file),
      dao_qn: qn, dao_method: "", dynamic: false,
    });
  }
  return out;
}

function tableFactsForModule(moduleDir, slug, profile) {
  const out = [];
  for (const f of javaFiles(moduleDir)) {
    const txt = readText(f);
    out.push(...sqlAnnotationFacts(f, txt, slug, profile));
    out.push(...jdbcTemplateFacts(f, txt, slug, profile));
    out.push(...mybatisPlusFacts(f, txt, slug, profile));
  }
  for (const f of xmlFiles(moduleDir)) out.push(...mybatisXmlFacts(f, slug, profile));
  return out;
}

function attachTablesToFunctions(functions, tables, downstream) {
  const byImplMethod = new Map();
  const bySource = new Map();
  const byDao = new Map();
  for (const t of tables || []) {
    const im = `${t.impl_qn || ""}#${t.method || ""}`;
    const src = t.source_file || "";
    const dao = `${t.dao_qn || t.impl_qn || ""}#${t.dao_method || t.method || ""}`;
    if (!byImplMethod.has(im)) byImplMethod.set(im, []);
    byImplMethod.get(im).push(t);
    if (src) {
      if (!bySource.has(src)) bySource.set(src, []);
      bySource.get(src).push(t);
    }
    if (!byDao.has(dao)) byDao.set(dao, []);
    byDao.get(dao).push(t);
  }
  const daoByFunction = new Map();
  for (const d of downstream || []) {
    if (d.downstream_kind !== "dao") continue;
    const key = `${d.from_impl || ""}#${d.from_method || ""}`;
    let daoOwner = d.to_qn || d.to_service || "";
    if (d.to_method && daoOwner.endsWith(`.${d.to_method}`)) daoOwner = daoOwner.slice(0, -1 * (`.${d.to_method}`).length);
    const daoKey = `${daoOwner}#${d.to_method || ""}`;
    const list = daoByFunction.get(key) || [];
    list.push(daoKey);
    daoByFunction.set(key, list);
  }
  return (functions || []).map((fn) => {
    const found = [];
    const own = byImplMethod.get(`${fn.impl_qn || ""}#${fn.method || ""}`) || [];
    found.push(...own);
    const sameSource = fn.source_file ? (bySource.get(fn.source_file) || []).filter((t) => !t.method || t.method === fn.method) : [];
    found.push(...sameSource);
    for (const daoKey of daoByFunction.get(`${fn.impl_qn || ""}#${fn.method || ""}`) || []) found.push(...(byDao.get(daoKey) || []));
    found.push(...mapperTablesFromSource(fn, byDao));
    const uniq = new Map();
    for (const t of found) uniq.set([t.table, t.source, t.dao_qn || t.impl_qn || "", t.dao_method || t.method || ""].join("|"), t);
    return { ...fn, tables: [...uniq.values()].map((t) => t.table) };
  });
}

function mapperTablesFromSource(fn, byDao) {
  if (!fn || !fn.source_file) return [];
  const file = path.resolve(repo, fn.source_file);
  const txt = readText(file);
  if (!txt) return [];
  const pkg = pkgOf(txt);
  const imports = new Map([...txt.matchAll(/import\s+([\w.]+)\s*;/g)].map((m) => [simpleName(m[1]), m[1]]));
  const fields = new Map();
  const fieldRe = /(?:@\w+(?:\s*\([^)]*\))?\s*)*(?:private|protected|public)?\s*(?:final\s+)?([\w.<>]+)\s+(\w+)\s*(?:=|;)/g;
  let fm;
  while ((fm = fieldRe.exec(txt))) {
    const type = cleanType(fm[1]).replace(/<.*>/, "");
    if (!/(Mapper|Dao|DAO|Repository)$/.test(simpleName(type))) continue;
    fields.set(fm[2], resolveJavaType(type, imports, pkg));
  }
  if (!fields.size) return [];
  const body = javaMethodBody(txt, fn.method);
  if (!body) return [];
  const found = [];
  const callRe = /\b(\w+)\.(\w+)\s*\(/g;
  let cm;
  while ((cm = callRe.exec(body))) {
    const owner = fields.get(cm[1]);
    if (!owner) continue;
    found.push(...(byDao.get(`${owner}#${cm[2]}`) || []));
    found.push(...(byDao.get(`${simpleName(owner)}#${cm[2]}`) || []));
  }
  return found;
}

function resolveJavaType(type, imports, pkg) {
  const t = String(type || "").replace(/\[\]$/, "");
  if (t.includes(".")) return t;
  return imports.get(t) || (pkg ? `${pkg}.${t}` : t);
}

function javaMethodBody(txt, method) {
  const re = new RegExp(`\\b${method}\\s*\\(`, "g");
  let m;
  while ((m = re.exec(txt))) {
    const brace = txt.indexOf("{", m.index);
    if (brace < 0) continue;
    const prefix = txt.slice(Math.max(0, m.index - 180), m.index);
    if (!/(public|protected|private|\s)[\s\w.<>\[\],?]+$/.test(prefix)) continue;
    const end = scanJavaBlockEnd(txt, brace);
    return end > brace ? txt.slice(brace, end) : "";
  }
  return "";
}

function pomParentArtifactId(txt) {
  return ((String(txt || "").match(/<parent>[\s\S]*?<artifactId>\s*([^<]+)\s*<\/artifactId>[\s\S]*?<\/parent>/) || [])[1] || "").trim();
}

function pomOwnArtifactId(txt) {
  const cleaned = String(txt || "").replace(/<parent>[\s\S]*?<\/parent>/g, "");
  return ((cleaned.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/) || [])[1] || "").trim();
}

function nearestPomArtifact(fileOrDir) {
  let dir = fs.existsSync(fileOrDir) && fs.statSync(fileOrDir).isDirectory() ? fileOrDir : path.dirname(fileOrDir);
  while (dir && path.resolve(dir).startsWith(path.resolve(repo))) {
    const pom = path.join(dir, "pom.xml");
    if (fs.existsSync(pom)) {
      const txt = readText(pom);
      const artifactId = pomOwnArtifactId(txt);
      if (artifactId) return artifactId;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

function rootPomArtifact() {
  const pom = path.join(repo, "pom.xml");
  if (!fs.existsSync(pom)) return gradleRootName();
  const txt = readText(pom);
  return pomParentArtifactId(txt) || pomOwnArtifactId(txt) || gradleRootName();
}

function gradleRootName() {
  for (const name of ["settings.gradle", "settings.gradle.kts"]) {
    const file = path.join(repo, name);
    if (!fs.existsSync(file)) continue;
    const txt = readText(file);
    const m = txt.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
    if (m) return m[1].trim();
  }
  return "";
}

function gitRepoName() {
  try {
    const out = cp.spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: repo, encoding: "utf8", timeout: 3000, shell: false });
    const url = String(out.stdout || "").trim();
    if (url) return path.basename(url.replace(/\.git$/i, ""));
  } catch {}
  return path.basename(repo);
}

const REPO_ARTIFACT_ID = rootPomArtifact();
const REPO_NAME = gitRepoName();

function moduleDirBySlug(slug) {
  const file = path.join(repo, ".repowiki", "modules.json");
  try {
    const mods = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const mod = Array.isArray(mods) ? mods.find((m) => m.slug === slug) : null;
    if (!mod) return "";
    const repoRoot = path.resolve(repo);
    if (mod.absPath) {
      const abs = path.resolve(mod.absPath);
      if (abs === repoRoot || abs.startsWith(repoRoot + path.sep)) return abs;
    }
    if (mod.relPath) return path.join(repoRoot, mod.relPath);
    if (mod.baseSlug) return path.join(repoRoot, mod.baseSlug);
    return "";
  } catch {
    return "";
  }
}

function attachRepoFacts(records, moduleDir) {
  const moduleArtifact = nearestPomArtifact(moduleDir);
  return (records || []).map((x) => ({
    ...x,
    module_artifact_id: x.module_artifact_id || moduleArtifact || "",
    repo_artifact_id: x.repo_artifact_id || REPO_ARTIFACT_ID || "",
    repo_name: x.repo_name || REPO_NAME || path.basename(repo),
  }));
}

function stripComments(text) {
  return String(text || "").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
function goPackageOf(txt) {
  return (txt.match(/^\s*package\s+(\w+)/m) || [])[1] || "";
}
function goRel(file) {
  return path.relative(repo, file).replace(/\\/g, "/");
}
function goModulePath(file) {
  const rel = goRel(file);
  const dir = path.dirname(rel).replace(/\\/g, "/");
  return dir === "." ? "" : dir;
}
function goImplName(receiver, fnName, pkg) {
  const recv = String(receiver || "")
    .replace(/[()]/g, "")
    .trim()
    .split(/\s+/)
    .pop()
    ?.replace(/^\*/, "") || "";
  return recv ? (pkg ? `${pkg}.${recv}` : recv) : `${pkg}`;
}
function goFnQn(receiver, fnName, pkg) {
  const impl = goImplName(receiver, fnName, pkg);
  return impl ? `${impl}.${fnName}` : fnName;
}
function parseGoParams(paramsText) {
  const text = String(paramsText || "").trim();
  if (!text) return [];
  const out = [];
  const pendingNames = [];
  for (const raw of splitTopLevel(text)) {
    const part = raw.trim();
    if (!part) continue;
    const fields = part.split(/\s+/).filter(Boolean);
    if (fields.length === 1) {
      pendingNames.push(fields[0]);
      continue;
    }
    if (pendingNames.length === 0 && isLikelyUnnamedGoType(part, fields)) {
      out.push({ name: "", type: cleanType(part), annotations: [] });
      continue;
    }
    const names = [...pendingNames, fields[0]];
    pendingNames.length = 0;
    const type = cleanType(fields.slice(1).join(" "));
    for (const name of names) out.push({ name: name.trim(), type, annotations: [] });
  }
  for (const type of pendingNames) {
    if (type !== "_") out.push({ name: "", type: cleanType(type), annotations: [] });
  }
  return out.filter((p) => p.name || p.type);
}
function isLikelyUnnamedGoType(part, fields) {
  return fields[0] === "chan" ||
    fields[0] === "<-chan" ||
    part.startsWith("*") ||
    part.startsWith("[]") ||
    part.startsWith("map[") ||
    part.startsWith("func(") ||
    fields[0].includes(".");
}
function parseGoReturns(retText) {
  const text = String(retText || "").trim();
  if (!text) return [];
  const unwrapped = text.startsWith("(") && text.endsWith(")") ? text.slice(1, -1) : text;
  return splitTopLevel(unwrapped).map((x) => {
    const fields = x.trim().split(/\s+/);
    if (fields.length > 1) return cleanType(fields.slice(1).join(" "));
    return cleanType(x);
  }).filter(Boolean);
}
function parseGoFunctions(file) {
  const txt = stripComments(fs.readFileSync(file, "utf8"));
  const pkg = goPackageOf(txt);
  const out = [];
  const re = /\bfunc\b/g;
  let m;
  while ((m = re.exec(txt))) {
    const before = txt.slice(Math.max(0, m.index - 80), m.index);
    if (!/(^|[\n;])\s*$/.test(before)) continue;
    let i = re.lastIndex;
    while (/\s/.test(txt[i] || "")) i++;
    let receiver = "";
    if (txt[i] === "(") {
      const receiverEnd = findMatchingParen(txt, i);
      if (receiverEnd < 0) continue;
      receiver = txt.slice(i, receiverEnd + 1).trim();
      i = receiverEnd + 1;
      while (/\s/.test(txt[i] || "")) i++;
    }
    const nameMatch = txt.slice(i).match(/^([A-Za-z_]\w*)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    i += name.length;
    while (/\s/.test(txt[i] || "")) i++;
    if (txt[i] !== "(") continue;
    const paramsEnd = findMatchingParen(txt, i);
    if (paramsEnd < 0) continue;
    const paramsText = txt.slice(i + 1, paramsEnd);
    i = paramsEnd + 1;
    const bodyStart = scanUntilTopLevelBrace(txt, i);
    if (bodyStart < 0) continue;
    const returnsText = txt.slice(i, bodyStart).trim();
    const params = parseGoParams(paramsText);
    const returns = parseGoReturns(returnsText);
    const implQn = goImplName(receiver, name, pkg);
    out.push({
      file,
      start_index: m.index,
      package: pkg,
      receiver,
      receiver_type: receiver ? goImplName(receiver, name, "") : "",
      method: name,
      impl_qn: implQn,
      entry_qn: goFnQn(receiver, name, pkg),
      params,
      returns,
      return_type: returns.join(", ") || "void",
      response_type: goResponseType(returns),
      signature: `${name}(${paramsSignature(params)}) -> ${returns.join(", ") || "void"}`,
    });
    re.lastIndex = bodyStart + 1;
  }
  return out;
}
function goResponseType(returns) {
  const business = (returns || []).filter((t) => !/^(error|context\.Context)$/.test(t));
  return business[0] || (returns || [])[0] || "void";
}
function nearestGoFunction(functions, index) {
  let found = null;
  for (const fn of functions) {
    if (typeof fn.start_index === "number" && fn.start_index <= index) found = fn;
  }
  return found;
}
function goKindFromPath(filePath, fnName) {
  const fp = String(filePath || "").toLowerCase().replace(/\\/g, "/");
  if (fp.includes("/controller/") || fp.includes("/controllers/") || /^reconcile$|^sync/.test(fnName)) return "controller";
  if (fp.includes("/registry/") || fp.includes("/rest/")) return "storage-rest";
  if (fp.includes("/client/")) return "client";
  if (fp.includes("/pkg/scheduler/")) return "scheduler";
  if (fp.includes("/pkg/kubelet/")) return "kubelet";
  return "function";
}
function collectGoDownstream(fn, slug, profile, maxDepth = 1) {
  const downstream = [];
  if (/^(add|update|delete|enqueue)[A-Z]\w*/.test(fn.method)) return downstream;
  const symbol = fn.receiver_type ? `${fn.receiver_type}::${fn.method}` : fn.method;
  const callees = calleesForBySymbol(symbol, CG);
  const relRoot = goModulePath(fn.file);
  for (const c of callees) {
    const n = c.node || c;
    if (!["function", "method"].includes(n.kind)) continue;
    const fp = String(n.filePath || "").replace(/\\/g, "/");
    if (!fp || fp.includes("/vendor/") || fp.startsWith("vendor/") || fp.includes("/third_party/")) continue;
    if (fp.endsWith("_test.go") || fp.includes("/testing/") || fp.includes("/testdata/")) continue;
    if (n.name === fn.method && fp === goRel(fn.file)) continue;
    if (relRoot && !fp.startsWith(relRoot.split("/").slice(0, 2).join("/"))) continue;
    downstream.push({
      from_impl: fn.impl_qn,
      from_method: fn.method,
      via_impl: fn.impl_qn,
      via_method: fn.method,
      depth: Math.min(1, maxDepth),
      to_service: path.basename(fp, ".go"),
      to_method: n.name,
      to_qn: n.qualifiedName || n.qualified_name || n.name,
      downstream_kind: goKindFromPath(fp, n.name),
      source: "codegraph",
      module: slug,
      profile: profile.name,
      entry_type: profile.entry_type || "go",
      source_file: fp,
    });
  }
  return downstream;
}
function goModelTypesFromFunction(fn) {
  const types = new Set();
  for (const p of fn.params || []) collectModelTypes(p.type, types);
  for (const r of fn.returns || []) collectModelTypes(r, types);
  return [...types].filter((t) => !isGoInfrastructureType(t));
}
function isGoInfrastructureType(type) {
  const t = String(type || "").replace(/^\*/, "");
  if (/^func\s*\(/.test(t)) return true;
  return /^(context\.Context|error|string|bool|byte|rune|int|int32|int64|uint|uint32|uint64|float32|float64|any|interface\{\}|time\.Duration|chan error|<-chan struct\{\}|http\.ResponseWriter|\*?http\.Request|http\.Handler|http\.HandlerFunc|restful\.Request|restful\.Response|klog\.Logger)$/.test(t);
}
function goRequestTypes(params) {
  return (params || []).map((p) => p.type).filter((t) => t && !isGoInfrastructureType(t));
}
function goStringConsts(txt) {
  const out = new Map();
  const re = /^\s*([A-Za-z_]\w*)\s*(?:[A-Za-z_][\w.\[\]]+\s*)?=\s*"([^"]*)"/gm;
  let m;
  while ((m = re.exec(String(txt || "")))) out.set(m[1], m[2]);
  return out;
}
function resolveGoPathExpr(expr, consts) {
  const raw = String(expr || "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  const lit = raw.match(/^"([^"]*)"$/);
  if (lit) return lit[1];
  if (consts && consts.has(raw)) return consts.get(raw);
  if (raw.includes("+")) {
    const parts = splitTopLevel(raw, "+").map((x) => resolveGoPathExpr(x, consts));
    if (parts.every((x) => x !== "")) return parts.join("");
  }
  return "";
}
function goHandlerMethodName(expr) {
  const raw = String(expr || "").trim();
  if (!raw) return "";
  if (/^func\s*\(/.test(raw)) return "anonymous";
  const m = raw.match(/([A-Za-z_]\w*)\s*$/);
  return m ? m[1] : "";
}
function nearestGoPathBefore(txt, start, end, consts) {
  const slice = String(txt || "").slice(Math.max(0, start), Math.max(start, end));
  const re = /\bPath\s*\(\s*([^)]*?)\s*\)/g;
  let found = "";
  let m;
  while ((m = re.exec(slice))) {
    const p = resolveGoPathExpr(m[1], consts);
    if (p.startsWith("/")) found = p;
  }
  return found;
}
function collectGoRestfulRoutes(txt, fns, consts) {
  const routes = [];
  const re = /\bRoute\s*\(\s*(?:[A-Za-z_]\w*\.)?(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(\s*([^)]*)\s*\)([\s\S]{0,1600}?)\.\s*To\s*\(\s*([^)]+)\s*\)/g;
  let m;
  while ((m = re.exec(String(txt || "")))) {
    const owner = nearestGoFunction(fns, m.index);
    if (!owner) continue;
    const base = nearestGoPathBefore(txt, owner.start_index, m.index, consts);
    const routePart = resolveGoPathExpr(m[2], consts);
    const fullPath = joinPath(base, routePart);
    const handler = goHandlerMethodName(m[4]);
    routes.push({
      owner,
      http_method: m[1],
      path: fullPath,
      handler,
      handler_expr: String(m[4] || "").trim(),
    });
  }
  return routes;
}
function entryCandidateFromRecord(fn, profile, slug, evidence = {}) {
  const route = fn.route || "";
  const pathValue = fn.path || "";
  return {
    module: slug,
    profile: profile.name,
    entry_type: fn.entry_type || profile.entry_type || "",
    service_iface: fn.service_iface || "",
    impl_qn: fn.impl_qn || "",
    method: fn.method || "",
    signature: fn.signature || "",
    return_type: fn.return_type || "",
    params: fn.params || [],
    route,
    path: pathValue,
    http_method: fn.http_method || "",
    command_name: fn.command_name || "",
    event_type: fn.event_type || "",
    entry_qn: fn.entry_qn || "",
    confidence: "high",
    source_mode: "profile-wide-scan-v1",
    evidence: {
      source_file: fn.source_file || "",
      iface_file: fn.iface_file || "",
      annotation: fn.entry_annotation || "",
      entry_qn: fn.entry_qn || "",
      route: fn.http_method && (route || pathValue) ? `${fn.http_method} ${route || pathValue}` : (route || pathValue),
      command_name: fn.command_name || "",
      event_type: fn.event_type || "",
      ...evidence,
    },
  };
}
function pushEntryFunction(functions, entryCandidates, fn, profile, slug, evidence = {}) {
  functions.push(fn);
  entryCandidates.push(entryCandidateFromRecord(fn, profile, slug, evidence));
  return fn;
}
function goFunctionRecord(fn, service, slug, profile, extra = {}) {
  const returnType = fn.return_type || "void";
  const rec = {
    service_iface: service.service_iface,
    impl_qn: service.impl_qn,
    method: fn.method,
    signature: extra.signature || `${profile.entry_type || "go"} ${fn.signature}`,
    return_type: returnType,
    response_type: fn.response_type || returnType,
    params: fn.params || [],
    request_types: goRequestTypes(fn.params),
    model_types: [],
    inherited_from: null,
    source: "structural",
    module: slug,
    profile: profile.name,
    entry_type: profile.entry_type || "go",
    language: "go",
    go_package: fn.package,
    source_file: goRel(fn.file),
    entry_qn: fn.entry_qn,
    evidence: { source_file: goRel(fn.file), entry_qn: fn.entry_qn || "" },
    confidence: {
      signature: "high",
      param_names: (fn.params || []).length && (fn.params || []).every((p) => p.name) ? "high" : (fn.params || []).length ? "low" : "high",
      downstream: "medium",
    },
    ...extra,
  };
  rec.model_types = goModelTypesFromFunction(fn);
  return rec;
}
function extractGoCliModule(moduleDir, slug, profile) {
  const services = [];
  const functions = [];
  const downstream = [];
  const entryCandidates = [];
  const seenServices = new Map();
  const maxDepth = Math.max(1, Number(profile.downstream_depth || 1));
  for (const f of goFiles(moduleDir)) {
    const txt = stripComments(fs.readFileSync(f, "utf8"));
    const fns = parseGoFunctions(f);
    const pkg = goPackageOf(txt);
    const mainFn = fns.find((fn) => fn.method === "main" && pkg === "main");
    if (mainFn) {
      const service = {
        impl_qn: `${pkg}.${path.basename(moduleDir)}`,
        service_iface: path.basename(moduleDir),
        iface_qn: `${pkg}.${path.basename(moduleDir)}`,
        config: "go-main",
        version: "default",
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "cli",
        language: "go",
        go_package: pkg,
        source_file: goRel(f),
      };
      seenServices.set(service.impl_qn, service);
      pushEntryFunction(functions, entryCandidates, goFunctionRecord(mainFn, service, slug, profile, {
        signature: `CLI main ${goRel(f)} -> ${mainFn.return_type}`,
        command_name: path.basename(moduleDir),
      }), profile, slug, { source_mode: "go-main" });
      downstream.push(...collectGoDownstream(mainFn, slug, profile, maxDepth));
    }
    const commandRe = /(?:&|new\s*\()\s*cobra\.Command\s*\{([\s\S]*?)\n\s*\}/g;
    let m;
    while ((m = commandRe.exec(txt))) {
      const body = m[1];
      const use = (body.match(/\bUse\s*:\s*"([^"]+)"/) || [])[1] || "";
      if (!use) continue;
      const run = (body.match(/\b(?:Run|RunE)\s*:\s*([A-Za-z_]\w*)/) || [])[1] || "";
      const fn = run ? fns.find((x) => x.method === run) : null;
      const service = {
        impl_qn: `${pkg}.${path.basename(moduleDir)}`,
        service_iface: path.basename(moduleDir),
        iface_qn: `${pkg}.${path.basename(moduleDir)}`,
        config: "cobra",
        version: "default",
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "cli",
        language: "go",
        go_package: pkg,
        source_file: goRel(f),
      };
      seenServices.set(service.impl_qn, service);
      const commandFn = fn || { file: f, package: pkg, method: use.split(/\s+/)[0], impl_qn: service.impl_qn, entry_qn: `${service.impl_qn}.${use}`, params: [], returns: [], return_type: "void", response_type: "void", signature: `${use}() -> void` };
      pushEntryFunction(functions, entryCandidates, goFunctionRecord(commandFn, service, slug, profile, {
        signature: `CLI ${use} -> ${commandFn.return_type}`,
        command_name: use,
        entry_qn: `${service.impl_qn}.${use}`,
      }), profile, slug, { source_mode: "cobra-command" });
      if (fn) downstream.push(...collectGoDownstream(fn, slug, profile, maxDepth));
    }
    for (const fn of fns) {
      if (!/^New\w*(Command|Cmd)$/.test(fn.method)) continue;
      if (!/\*?cobra\.Command\b/.test(fn.return_type)) continue;
      const service = {
        impl_qn: `${pkg}.${path.basename(moduleDir)}`,
        service_iface: path.basename(moduleDir),
        iface_qn: `${pkg}.${path.basename(moduleDir)}`,
        config: "cobra-factory",
        version: "default",
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "cli",
        language: "go",
        go_package: pkg,
        source_file: goRel(f),
      };
      seenServices.set(service.impl_qn, service);
      pushEntryFunction(functions, entryCandidates, goFunctionRecord(fn, service, slug, profile, {
        signature: `CLI factory ${fn.method}(${paramsSignature(fn.params)}) -> ${fn.return_type}`,
        command_name: fn.method,
      }), profile, slug, { source_mode: "cobra-factory" });
      downstream.push(...collectGoDownstream(fn, slug, profile, maxDepth));
    }
  }
  services.push(...seenServices.values());
  writeParts(slug, services, functions, downstream, profile, [], entryCandidates, moduleDir);
  logDetail(`[L2-script] ${slug} (${profile.name}): services ${services.length} / functions ${functions.length} / downstream ${downstream.length}`);
}
function extractGoHttpModule(moduleDir, slug, profile) {
  const services = [];
  const functions = [];
  const downstream = [];
  const entryCandidates = [];
  const seenServices = new Map();
  const maxDepth = Math.max(1, Number(profile.downstream_depth || 1));
  const seenFunctionEntries = new Set();
  const pushFunction = (rec) => {
    const key = `${rec.entry_qn || rec.impl_qn}.${rec.method}|${rec.http_method || ""}|${rec.path || ""}|${rec.source_file || ""}`;
    if (seenFunctionEntries.has(key)) return;
    seenFunctionEntries.add(key);
    pushEntryFunction(functions, entryCandidates, rec, profile, slug, { source_mode: "go-http" });
  };
  for (const f of goFiles(moduleDir)) {
    const txt = stripComments(fs.readFileSync(f, "utf8"));
    const fns = parseGoFunctions(f);
    const pkg = goPackageOf(txt);
    const consts = goStringConsts(txt);
    const routeByMethod = new Map();
    const handleRe = /\b(?:HandleFunc|Handle)\s*\(\s*"([^"]+)"\s*,\s*([A-Za-z_]\w*)/g;
    let hm;
    while ((hm = handleRe.exec(txt))) routeByMethod.set(hm[2], hm[1]);
    const routeRegs = [];
    const routeRe = /\b(?:\w+\.)?Handle(Func)?\s*\(\s*"([^"]+)"\s*,/g;
    let rm;
    while ((rm = routeRe.exec(txt))) {
      const owner = nearestGoFunction(fns, rm.index);
      if (owner) routeRegs.push({ kind: rm[1] ? "HandleFunc" : "Handle", path: rm[2], owner });
    }
    for (const fn of fns) {
      const isServeHTTP = fn.method === "ServeHTTP" && (fn.params || []).some((p) => p.type === "*http.Request");
      const isHandlerFactory = /Handler/.test(fn.method) && /\bhttp\.Handler(Func)?\b/.test(fn.return_type);
      const isRouteHandler = routeByMethod.has(fn.method);
      if (!isServeHTTP && !isHandlerFactory && !isRouteHandler) continue;
      const serviceName = fn.receiver_type || path.basename(moduleDir);
      const service = {
        impl_qn: fn.impl_qn || `${pkg}.${serviceName}`,
        service_iface: serviceName,
        iface_qn: fn.impl_qn || `${pkg}.${serviceName}`,
        config: isServeHTTP ? "ServeHTTP" : isRouteHandler ? "HandleFunc" : "http.Handler",
        version: "default",
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "http",
        language: "go",
        go_package: pkg,
        source_file: goRel(f),
      };
      seenServices.set(service.impl_qn, service);
      const route = routeByMethod.get(fn.method) || (isServeHTTP ? "ServeHTTP" : fn.method);
      pushFunction(goFunctionRecord(fn, service, slug, profile, {
        signature: `HTTP ${route} -> ${fn.return_type} ${fn.method}(${paramsSignature(fn.params)})`,
        http_method: "ANY",
        path: route.startsWith("/") ? route : "",
        route,
      }));
      downstream.push(...collectGoDownstream(fn, slug, profile, maxDepth));
    }
    for (const reg of routeRegs) {
      const fn = reg.owner;
      const serviceName = fn.receiver_type || path.basename(moduleDir);
      const service = {
        impl_qn: fn.impl_qn || `${pkg}.${serviceName}`,
        service_iface: serviceName,
        iface_qn: fn.impl_qn || `${pkg}.${serviceName}`,
        config: reg.kind,
        version: "default",
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "http",
        language: "go",
        go_package: pkg,
        source_file: goRel(f),
      };
      seenServices.set(service.impl_qn, service);
      pushFunction(goFunctionRecord(fn, service, slug, profile, {
        method: fn.method,
        signature: `HTTP ${reg.path} -> registered in ${fn.method}(${paramsSignature(fn.params)})`,
        http_method: "ANY",
        path: reg.path,
        route: reg.path,
        entry_qn: `${fn.entry_qn}#${reg.path}`,
      }));
    }
    for (const reg of collectGoRestfulRoutes(txt, fns, consts)) {
      const target = fns.find((fn) => fn.method === reg.handler) || reg.owner;
      const methodName = target === reg.owner && reg.handler && reg.handler !== reg.owner.method ? reg.handler : target.method;
      const serviceName = target.receiver_type || reg.owner.receiver_type || path.basename(moduleDir);
      const service = {
        impl_qn: target.impl_qn || reg.owner.impl_qn || `${pkg}.${serviceName}`,
        service_iface: serviceName,
        iface_qn: target.impl_qn || reg.owner.impl_qn || `${pkg}.${serviceName}`,
        config: "go-restful",
        version: "default",
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "http",
        language: "go",
        go_package: pkg,
        source_file: goRel(f),
      };
      seenServices.set(service.impl_qn, service);
      const routeFn = {
        ...target,
        method: methodName,
        entry_qn: `${target.entry_qn || reg.owner.entry_qn}#${reg.http_method}:${reg.path}`,
      };
      pushFunction(goFunctionRecord(routeFn, service, slug, profile, {
        signature: `HTTP ${reg.http_method} ${reg.path} -> ${reg.handler || target.method}`,
        http_method: reg.http_method,
        path: reg.path,
        route: reg.path,
        handler: reg.handler,
        handler_expr: reg.handler_expr,
      }));
      if (target !== reg.owner) downstream.push(...collectGoDownstream(target, slug, profile, maxDepth));
    }
  }
  services.push(...seenServices.values());
  writeParts(slug, services, functions, downstream, profile, [], entryCandidates, moduleDir);
  logDetail(`[L2-script] ${slug} (${profile.name}): services ${services.length} / functions ${functions.length} / downstream ${downstream.length}`);
}
function extractK8sControllerModule(moduleDir, slug, profile) {
  const services = [];
  const functions = [];
  const downstream = [];
  const entryCandidates = [];
  const seenServices = new Map();
  const maxDepth = Math.max(1, Number(profile.downstream_depth || 1));
  for (const f of goFiles(moduleDir)) {
    const txt = stripComments(fs.readFileSync(f, "utf8"));
    const fns = parseGoFunctions(f);
    const pkg = goPackageOf(txt);
    const eventMethods = new Map();
    const eventRe = /\b(AddFunc|UpdateFunc|DeleteFunc)\s*:\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/g;
    let em;
    while ((em = eventRe.exec(txt))) eventMethods.set(em[2].split(".").pop(), em[1].replace("Func", "").toLowerCase());
    for (const fn of fns) {
      const isController =
        fn.method === "Reconcile" ||
        /^AddEventHandler/.test(fn.method) ||
        /^sync[A-Z]\w*/.test(fn.method) ||
        /^enqueue[A-Z]\w*/.test(fn.method) ||
        /^(add|update|delete)[A-Z]\w*/.test(fn.method) ||
        eventMethods.has(fn.method);
      if (!isController) continue;
      const serviceName = fn.receiver_type || path.basename(moduleDir);
      const service = {
        impl_qn: fn.impl_qn || `${pkg}.${serviceName}`,
        service_iface: serviceName,
        iface_qn: fn.impl_qn || `${pkg}.${serviceName}`,
        config: eventMethods.has(fn.method) ? "informer-event" : fn.method === "Reconcile" ? "reconciler" : "controller-method",
        version: "default",
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "controller",
        language: "go",
        go_package: pkg,
        source_file: goRel(f),
      };
      seenServices.set(service.impl_qn, service);
      const eventType = eventMethods.get(fn.method) || (fn.method === "Reconcile" ? "reconcile" : /^sync/.test(fn.method) ? "sync" : /^enqueue/.test(fn.method) ? "enqueue" : "handler");
      pushEntryFunction(functions, entryCandidates, goFunctionRecord(fn, service, slug, profile, {
        signature: `K8S ${eventType} ${fn.method}(${paramsSignature(fn.params)}) -> ${fn.return_type}`,
        event_type: eventType,
      }), profile, slug, { source_mode: "k8s-controller" });
      downstream.push(...collectGoDownstream(fn, slug, profile, maxDepth));
    }
    const anonymousEventRe = /\b(AddFunc|UpdateFunc|DeleteFunc)\s*:\s*func\s*\(([^)]*)\)/g;
    let am;
    while ((am = anonymousEventRe.exec(txt))) {
      const owner = nearestGoFunction(fns, am.index);
      if (!owner) continue;
      const eventType = am[1].replace("Func", "").toLowerCase();
      const params = parseGoParams(am[2]);
      const serviceName = owner.receiver_type || path.basename(moduleDir);
      const service = {
        impl_qn: owner.impl_qn || `${pkg}.${serviceName}`,
        service_iface: serviceName,
        iface_qn: owner.impl_qn || `${pkg}.${serviceName}`,
        config: "anonymous-informer-event",
        version: "default",
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "controller",
        language: "go",
        go_package: pkg,
        source_file: goRel(f),
      };
      seenServices.set(service.impl_qn, service);
      const synthetic = {
        file: f,
        package: pkg,
        receiver: owner.receiver,
        receiver_type: owner.receiver_type,
        method: `${owner.method}.${eventType}`,
        impl_qn: service.impl_qn,
        entry_qn: `${owner.entry_qn}#${eventType}`,
        params,
        returns: [],
        return_type: "void",
        response_type: "void",
        signature: `${owner.method}.${eventType}(${paramsSignature(params)}) -> void`,
      };
      pushEntryFunction(functions, entryCandidates, goFunctionRecord(synthetic, service, slug, profile, {
        signature: `K8S ${eventType} anonymous handler in ${owner.method}(${paramsSignature(params)}) -> void`,
        event_type: eventType,
      }), profile, slug, { source_mode: "k8s-anonymous-event" });
    }
  }
  services.push(...seenServices.values());
  writeParts(slug, services, functions, downstream, profile, [], entryCandidates, moduleDir);
  logDetail(`[L2-script] ${slug} (${profile.name}): services ${services.length} / functions ${functions.length} / downstream ${downstream.length}`);
}

// ====== Oracle PL/SQL 单模块提取 ======
// L1 codegraph 不支持 PL/SQL，L2 用正则从 .pks/.pkb 文本抽取。
// 服务=Package, 功能=Procedure/Function, 下游=跨包调用+表操作+序列/常量引用
function extractOracleSpModule(moduleDir, slug, profile) {
  const services = [];
  const functions = [];
  const downstream = [];
  const entryCandidates = [];
  const seenServices = new Map();
  // 跨包常量值映射：pkg.UpperConstName → { value, type, source_file }
  // 第一遍扫描所有 .pks/.pkb 抽取所有包的 CONSTANT 声明，供后续 func.constant_deps 合并值
  const crossPackageConstants = new Map();
  // 跨包 TYPE 定义映射：pkg.UpperTypeName → { name, kind, fields, element_type, source_package, source_file }
  // 用于解决"复合类型字段未抽取"问题（如 t_recv_tab 跨包 TYPE 定义）
  const crossPackageTypeDefinitions = new Map();

  // 去注释（-- 行注释和 /* */ 块注释）
  function stripSqlComments(txt) {
    return txt
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
  }

  // 解析参数列表： (p_lines IN t_recv_tab, p_ok OUT NUMBER)
  function parseParams(paramStr) {
    if (!paramStr || !paramStr.trim()) return [];
    const params = [];
    let depth = 0, cur = "", inStr = false;
    for (let i = 0; i < paramStr.length; i++) {
      const ch = paramStr[i];
      if (ch === "'" ) inStr = !inStr;
      if (inStr) { cur += ch; continue; }
      if (ch === "(" ) depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        params.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) params.push(cur.trim());
    return params.map((p) => {
      // p 形如 "p_lines IN t_recv_tab" 或 "p_ok OUT NUMBER" 或 "p_idx IN NUMBER"
      const m = p.match(/^([A-Za-z_][\w#$]*)\s+(IN\s+OUT|IN|OUT)\s+(.+)$/i);
      if (!m) return { name: p, direction: "IN", type: "", oracle_type: "" };
      const direction = m[2].toUpperCase().trim();
      const typeRaw = m[3].trim();
      return {
        name: m[1],
        direction,
        type: typeRaw,
        oracle_type: typeRaw,
      };
    });
  }

  // Oracle 类型 → Java 类型映射（供 L3 参考，L2 只记录 oracle_type）
  function oracleToJava(oracleType) {
    const t = (oracleType || "").toUpperCase().replace(/\s+/g, "");
    // NUMBER(p,s) / NUMBER(p) / NUMBER：按精度映射
    if (/^NUMBER(\(\d+(?:,\s*\d+)?\))?/.test(t) || /^NUMERIC/.test(t)) {
      const pm = t.match(/\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/);
      const precision = pm ? parseInt(pm[1], 10) : null;
      const scale = pm && pm[2] ? parseInt(pm[2], 10) : 0;
      // 浮点：NUMBER 无精度 → BigDecimal（避免精度丢失）
      if (precision === null) return "BigDecimal";
      // 含小数（scale > 0）→ BigDecimal
      if (scale > 0) return "BigDecimal";
      // 大整数（precision > 10）→ BigDecimal（超出 Long 范围）
      if (precision > 10) return "BigDecimal";
      return "Long";
    }
    // FLOAT / BINARY_FLOAT / BINARY_DOUBLE → BigDecimal（精度丢失风险）
    if (/^FLOAT|^BINARY_FLOAT|^BINARY_DOUBLE/.test(t)) return "BigDecimal";
    if (/^VARCHAR2?|^CHAR|^NVARCHAR2|^NCHAR/.test(t)) return "String";
    if (/^DATE$/.test(t)) return "LocalDateTime";
    if (/^TIMESTAMP/.test(t)) return "LocalDateTime";
    if (/^CLOB$|^NCLOB$/.test(t)) return "String";
    if (/^BLOB$|^RAW/.test(t)) return "byte[]";
    if (/^BOOLEAN$/.test(t)) return "Boolean";
    return "Object";
  }

  // 解析 TYPE IS RECORD / TABLE OF
  function parseTypeDefinitions(txt) {
    const types = [];
    // TYPE t_recv_line IS RECORD (item_id NUMBER(18), qty NUMBER(18,4), ...)
    const recordRe = /\bTYPE\s+([A-Za-z_][\w#$]*)\s+IS\s+RECORD\s*\(([\s\S]*?)\)/gi;
    let m;
    while ((m = recordRe.exec(txt))) {
      const fields = m[2].split(",").map((f) => {
        const fm = f.trim().match(/^([A-Za-z_][\w#$]*)\s+(.+)$/);
        if (!fm) return null;
        const fieldType = fm[2].trim().replace(/\s+/g, " ");
        return { name: fm[1], type: fieldType, oracle_type: fieldType, java_type: oracleToJava(fieldType) };
      }).filter(Boolean);
      types.push({ name: m[1], kind: "RECORD", fields });
    }
    // TYPE t_recv_tab IS TABLE OF t_recv_line INDEX BY PLS_INTEGER
    const tableRe = /\bTYPE\s+([A-Za-z_][\w#$]*)\s+IS\s+TABLE\s+OF\s+([A-Za-z_][\w#$\.]*)/gi;
    while ((m = tableRe.exec(txt))) {
      types.push({ name: m[1], kind: "TABLE_OF", element_type: m[2], index_by: "PLS_INTEGER" });
    }
    return types;
  }

  // 解析常量声明：c_dir_in CONSTANT VARCHAR2(1) := 'I'
  function parseConstants(txt) {
    const consts = [];
    const re = /\b([A-Za-z_][\w#$]*)\s+CONSTANT\s+([A-Za-z_][\w#$()]*)\s*:=\s*('[^']*'|[0-9.]+|NULL)/gi;
    let m;
    while ((m = re.exec(txt))) {
      consts.push({ name: m[1], type: m[2], value: m[3] });
    }
    return consts;
  }

  // 解析表操作：INSERT INTO <T> / UPDATE <T> / MERGE INTO <T> / DELETE FROM <T> / SELECT ... FROM <T>
  function parseTableOps(txt, procName) {
    const ops = [];
    const patterns = [
      { re: /\bINSERT\s+INTO\s+([A-Za-z_][\w#$]*)/gi, op: "INSERT" },
      { re: /\bUPDATE\s+([A-Za-z_][\w#$]*)\s+/gi, op: "UPDATE" },
      { re: /\bMERGE\s+INTO\s+([A-Za-z_][\w#$]*)/gi, op: "MERGE" },
      { re: /\bDELETE\s+FROM\s+([A-Za-z_][\w#$]*)/gi, op: "DELETE" },
      { re: /\bFROM\s+([A-Za-z_][\w#$]*)\b/gi, op: "SELECT" },
    ];
    for (const { re, op } of patterns) {
      let m;
      while ((m = re.exec(txt))) {
        const table = m[1].toUpperCase();
        // 过滤 SQL 关键字误匹配
        if (["DUAL", "ALL", "WHERE", "SET", "VALUES", "TABLE"].includes(table)) continue;
        ops.push({ table, op, procedure: procName });
      }
    }
    // 去重
    const seen = new Set();
    return ops.filter((o) => {
      const k = `${o.table}|${o.op}|${o.procedure}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // 解析序列引用：SEQ_*.NEXTVAL / SEQ_*.CURRVAL
  function parseSequenceRefs(txt, procName) {
    const refs = [];
    const re = /\b([A-Za-z_][\w#$]*)\.(NEXTVAL|CURRVAL)\b/gi;
    let m;
    while ((m = re.exec(txt))) {
      refs.push({ sequence: m[1].toUpperCase(), usage: m[2].toUpperCase(), procedure: procName });
    }
    return refs;
  }

  // 解析跨包调用：<PKG>.<PROC>( 或 <PKG>.<CONST>
  function parseCrossPackageRefs(txt, currentPkg, procName, localVars) {
    const refs = [];
    const localVarSet = new Set((localVars || []).map((v) => v.toUpperCase()));
    // SQL 别名黑名单：CONNECT BY / SELECT / MERGE 等 SQL 语句中的表别名（h/ci/r/t/old/new/cur/row/rec）
    // 这些短名不可能是 PL/SQL 包名，避免误判为跨包常量依赖
    const SQL_ALIAS_BLACKLIST = new Set([
      "H", "CI", "R", "T", "OLD", "NEW", "CUR", "ROW", "REC", "SRC", "DST", "TGT",
      "A", "B", "C", "D", "E", "F", "G", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "S", "U", "V", "W", "X", "Y", "Z",
    ]);
    const isSqlAlias = (name) => {
      const upper = String(name || "").toUpperCase();
      if (SQL_ALIAS_BLACKLIST.has(upper)) return true;
      // 单字符或双字符大写名字视为 SQL 别名
      if (upper.length <= 2 && /^[A-Z]+$/.test(upper)) return true;
      return false;
    };
    // 跨包过程/函数调用：PKG.PROC(  （排除 SQL%BULK_EXCEPTIONS 等伪对象）
    const re = /\b([A-Za-z_][\w#$]*)\.([A-Za-z_][\w#$]*)\s*\(/g;
    let m;
    while ((m = re.exec(txt))) {
      const pkg = m[1];
      const member = m[2];
      if (pkg.toUpperCase() === currentPkg.toUpperCase()) continue;
      if (["SQL", "DBMS", "UTL", "APEX"].includes(pkg.toUpperCase())) continue;
      // 过滤局部变量（如 p_lines.COUNT、tgt.item_id、src.avg_cost）
      if (localVarSet.has(pkg.toUpperCase())) continue;
      // 过滤 SQL 别名（h.x、ci.x、r.x、t.x 等）
      if (isSqlAlias(pkg)) continue;
      refs.push({ target_package: pkg, target_member: member, kind: "call", procedure: procName });
    }
    // 跨包常量引用：PKG.c_xxx（非调用形式）
    const constRe = /\b([A-Za-z_][\w#$]*)\.([A-Za-z_][\w#$]*)\b(?!\s*\()/g;
    while ((m = constRe.exec(txt))) {
      const pkg = m[1];
      const member = m[2];
      if (pkg.toUpperCase() === currentPkg.toUpperCase()) continue;
      if (["SQL", "DBMS", "UTL", "APEX", "NEXTVAL", "CURRVAL"].includes(pkg.toUpperCase())) continue;
      // 过滤序列引用：SEQ_XXX.NEXTVAL / SEQ_XXX.CURRVAL（已被 parseSequenceRefs 处理，不应进 constant_deps）
      if (/^SEQ_/i.test(pkg)) continue;
      if (["NEXTVAL", "CURRVAL"].includes(member.toUpperCase())) continue;
      // 过滤局部变量
      if (localVarSet.has(pkg.toUpperCase())) continue;
      // 过滤 SQL 别名（h.x、ci.x、r.x、t.x 等）
      if (isSqlAlias(pkg)) continue;
      // 过滤 PL/SQL 集合方法（FIRST/LAST/COUNT/EXISTS/NEXT/PRIOR/DELETE/EXTEND/TRIM）
      if (["FIRST", "LAST", "COUNT", "EXISTS", "NEXT", "PRIOR", "DELETE", "EXTEND", "TRIM"].includes(member.toUpperCase())) continue;
      // 已在调用形式中记录的跳过
      if (refs.some((r) => r.target_package === pkg && r.target_member === member)) continue;
      refs.push({ target_package: pkg, target_member: member, kind: "constant_ref", procedure: procName });
    }
    return refs;
  }

  // 解析控制流骨架：IF/LOOP/FORALL/EXCEPTION
  // bodyStart: 过程体在文件中的字符偏移；bodyLineOffset: bodyStart 之前的换行数（文件绝对行偏移）
  function parseControlFlow(txt, procName, bodyLineOffset) {
    const offset = bodyLineOffset || 0;
    const flow = [];
    const lines = txt.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const fileLine = offset + i + 1;
      if (/^\bIF\b/i.test(line)) flow.push({ construct: "IF", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bELSIF\b/i.test(line)) flow.push({ construct: "ELSIF", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bELSE\b/i.test(line)) flow.push({ construct: "ELSE", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bFOR\b/i.test(line)) flow.push({ construct: "FOR", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bWHILE\b/i.test(line)) flow.push({ construct: "WHILE", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bLOOP\b/i.test(line)) flow.push({ construct: "LOOP", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bFORALL\b/i.test(line)) flow.push({ construct: "FORALL", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bMERGE\b/i.test(line)) flow.push({ construct: "MERGE", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bEXCEPTION\b/i.test(line)) flow.push({ construct: "EXCEPTION", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bWHEN\b/i.test(line)) flow.push({ construct: "WHEN", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bRAISE\b/i.test(line)) flow.push({ construct: "RAISE", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bCOMMIT\b/i.test(line)) flow.push({ construct: "COMMIT", line: fileLine, text: line.slice(0, 80), procedure: procName });
      else if (/^\bROLLBACK\b/i.test(line)) flow.push({ construct: "ROLLBACK", line: fileLine, text: line.slice(0, 80), procedure: procName });
    }
    return flow;
  }

  // 解析异常处理：EXCEPTION WHEN OTHERS THEN ... SQLCODE = -24381
  function parseExceptionHandlers(txt, procName) {
    const handlers = [];
    // 先定位 EXCEPTION 块（从 EXCEPTION 关键字到 END <procName>）
    const excBlockRe = /\bEXCEPTION\b([\s\S]*?)(?=\bEND\s+[A-Za-z_][\w#$]*\s*;|\bEND\s*;)/gi;
    let em;
    while ((em = excBlockRe.exec(txt))) {
      const excBlock = em[1];
      // 在 EXCEPTION 块内匹配 WHEN 子句（排除 MERGE 的 WHEN MATCHED）
      const whenRe = /\bWHEN\s+(OTHERS|[A-Za-z_][\w#$]*(?:\s*\|\|\s*[A-Za-z_][\w#$]*)*)\s+THEN([\s\S]*?)(?=\bWHEN\b|\bEND\b|$)/gi;
      let m;
      while ((m = whenRe.exec(excBlock))) {
        const condition = m[1];
        // 排除 MERGE 的 WHEN MATCHED / WHEN NOT MATCHED
        if (["MATCHED", "NOT"].includes(condition.toUpperCase())) continue;
        const body = m[2] || "";
        const sqlcodeMatch = body.match(/SQLCODE\s*=\s*(-?\d+)/);
        const hasRaise = /\bRAISE\b/i.test(body);
        const hasLog = /log_error\s*\(/i.test(body);
        const action = hasRaise ? "RAISE" : (hasLog ? "LOG" : (/\bNULL\b/i.test(body) ? "NULL" : ""));
        handlers.push({
          name: condition,
          action,
          condition,
          sqlcode: sqlcodeMatch ? parseInt(sqlcodeMatch[1], 10) : null,
          has_raise: hasRaise,
          has_log: hasLog,
          body_preview: body.trim().slice(0, 200),
          procedure: procName,
        });
      }
    }
    return handlers;
  }

  // 解析特殊语法：16-killer 确定性扫描（对齐 sql2java plsql-scanner + outline §1.2）
  // bodyStart: 过程体在文件 txt 中的起始字符偏移（用于行号转文件绝对行）
  // fileTxt: 整个文件文本（用于行号转文件绝对行）
  function parseSpecialSyntax(procBody, procName, bodyStart, fileTxt) {
    const offset = bodyStart || 0;
    const specials = [];
    const patterns = [
      // 批量与游标
      { re: /\bFORALL\s+\w+\s+IN\s+[\w.]+\s*\.\.\s*[\w.]+\s+SAVE\s+EXCEPTIONS\b/gi, construct: "FORALL SAVE EXCEPTIONS", risk: "high" },
      { re: /\bFORALL\s+\w+\s+IN\s+[\w.]+\s*\.\.\s*[\w.]+\b(?!\\s+SAVE)/gi, construct: "FORALL", risk: "medium" },
      { re: /\bSQL%BULK_EXCEPTIONS\b/gi, construct: "SQL%BULK_EXCEPTIONS", risk: "high" },
      { re: /\bEXECUTE\s+IMMEDIATE\b/gi, construct: "EXECUTE IMMEDIATE", risk: "high" },
      { re: /\bDBMS_SQL\b/gi, construct: "DBMS_SQL", risk: "high" },
      { re: /\bOPEN\s+[A-Za-z_][\w#$]*\s+FOR\b/gi, construct: "OPEN FOR", risk: "high" },
      { re: /\bBULK\s+COLLECT\s+INTO\b/gi, construct: "BULK COLLECT INTO", risk: "medium" },
      // DML 与表操作
      { re: /\bMERGE\s+INTO\b/gi, construct: "MERGE INTO", risk: "medium" },
      { re: /\bRETURNING\s+.+?\s+INTO\b/gi, construct: "RETURNING INTO", risk: "medium" },
      // 高级 SQL
      { re: /\bMODEL\b/gi, construct: "MODEL", risk: "high" },
      { re: /\bCONNECT\s+BY\b/gi, construct: "CONNECT BY", risk: "high" },
      { re: /\bWITH\s+FUNCTION\b/gi, construct: "WITH FUNCTION", risk: "medium" },
      { re: /\bMULTISET\b/gi, construct: "MULTISET", risk: "medium" },
      // 事务控制
      { re: /\bPRAGMA\s+AUTONOMOUS_TRANSACTION\b/gi, construct: "PRAGMA AUTONOMOUS_TRANSACTION", risk: "medium" },
      { re: /\bCOMMIT\b/gi, construct: "COMMIT", risk: "low" },
      { re: /\bROLLBACK\b/gi, construct: "ROLLBACK", risk: "low" },
      // 条件编译
      { re: /\$IF\b/gi, construct: "CONDITIONAL_COMPILE ($IF)", risk: "medium" },
      // 调度
      { re: /\bDBMS_SCHEDULER\b/gi, construct: "DBMS_SCHEDULER", risk: "medium" },
      // 参数传递
      { re: /\bNOCOPY\b/gi, construct: "NOCOPY", risk: "low" },
      // 常用函数
      { re: /\bNVL\s*\(/gi, construct: "NVL", risk: "low" },
      { re: /\bNVL2\s*\(/gi, construct: "NVL2", risk: "low" },
      { re: /\bDECODE\s*\(/gi, construct: "DECODE", risk: "medium" },
      { re: /\bSYSDATE\b/gi, construct: "SYSDATE", risk: "low" },
      { re: /\bSQLERRM\s*\(/gi, construct: "SQLERRM", risk: "low" },
      { re: /\bSQLCODE\b/gi, construct: "SQLCODE", risk: "low" },
    ];
    for (const { re, construct, risk } of patterns) {
      let m;
      let count = 0;
      while ((m = re.exec(procBody))) {
        count++;
        // 记录首次出现位置（文件绝对行 = fileTxt 中 offset+m.index 之前的换行数 + 1）
        if (count === 1) {
          const line = fileTxt ? fileTxt.slice(0, offset + m.index).split("\n").length
            : procBody.slice(0, m.index).split("\n").length;
          specials.push({ construct, line, risk, count: 0, procedure: procName });
        }
      }
      if (specials.length && specials[specials.length - 1].construct === construct) {
        specials[specials.length - 1].count = count;
      }
    }
    return specials;
  }

  function sanitizePlsqlIdentifier(name, fallback) {
    const cleaned = String(name || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_");
    return cleaned || fallback;
  }

  function tableSubjectForScript(tableName) {
    const parts = sanitizePlsqlIdentifier(tableName, "script").split("_").filter(Boolean);
    while (parts.length > 1 && ["copy", "temp", "tmp", "bak", "backup", "hist", "history"].includes(parts[parts.length - 1])) {
      parts.pop();
    }
    while (parts.length > 1 && parts[parts.length - 1].length <= 2) {
      parts.pop();
    }
    return parts.join("_") || "script";
  }

  function standaloneSqlMethodName(txt, relFile) {
    const base = sanitizePlsqlIdentifier(path.basename(relFile, path.extname(relFile)), "script");
    const mergeMatch = txt.match(/\bMERGE\s+INTO\s+([A-Za-z_][\w#$]*)/i);
    if (mergeMatch) {
      if (base && base !== "merge") return base.startsWith("merge_") ? base : `merge_${base}`;
      return `merge_${tableSubjectForScript(mergeMatch[1])}`;
    }
    return base;
  }

  // 第一遍：扫描所有 .pks/.pkb，建立跨包常量值映射（crossPackageConstants）+ 跨包 TYPE 定义映射
  // 这样第二遍解析 func.constant_deps / input_types 时可以直接合并，避免 FSD 板块3 出现"需人工复核（L2 未抽取到值）"
  for (const f of plsqlFiles(moduleDir)) {
    try {
      const raw0 = fs.readFileSync(f, "utf8");
      const txt0 = stripSqlComments(raw0);
      const relFile0 = path.relative(repo, f).replace(/\\/g, "/");
      // 找到所有 PACKAGE NAME 并记录其常量 + TYPE 定义
      const pkgIter = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\s+(?:BODY\s+)?([A-Za-z_][\w#$]*)\b/gi;
      let pm0;
      while ((pm0 = pkgIter.exec(txt0))) {
        const pkg0 = pm0[1];
        // 找到包体范围（从 PACKAGE 到下一个 CREATE 或 EOF）
        const pkgStart = pm0.index;
        const nextCreate = txt0.slice(pkgStart + pm0[0].length).search(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:PACKAGE|PROCEDURE|FUNCTION)\b/i);
        const pkgEnd = nextCreate >= 0 ? pkgStart + pm0[0].length + nextCreate : txt0.length;
        const pkgTxt = txt0.slice(pkgStart, pkgEnd);
        // 抽取常量值
        const consts0 = parseConstants(pkgTxt);
        for (const c of consts0) {
          const key = `${pkg0.toUpperCase()}.${String(c.name || "").toUpperCase()}`;
          if (!crossPackageConstants.has(key)) {
            crossPackageConstants.set(key, { value: c.value, type: c.type, source_package: pkg0, source_file: relFile0 });
          }
        }
        // 抽取 TYPE 定义
        const types0 = parseTypeDefinitions(pkgTxt);
        for (const t0 of types0) {
          const key = `${pkg0.toUpperCase()}.${String(t0.name || "").toUpperCase()}`;
          if (!crossPackageTypeDefinitions.has(key)) {
            crossPackageTypeDefinitions.set(key, { ...t0, source_package: pkg0, source_file: relFile0 });
          }
        }
      }
    } catch (e) {
      // 忽略单文件读取失败，不影响主流程
    }
  }

  // 处理单个 .pks/.pkb 文件
  for (const f of plsqlFiles(moduleDir)) {
    const raw = fs.readFileSync(f, "utf8");
    const txt = stripSqlComments(raw);
    const relFile = path.relative(repo, f).replace(/\\/g, "/");

    // 发现 Package（服务）
    const pkgRe = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\s+(?:BODY\s+)?([A-Za-z_][\w#$]*)\b/gi;
    let pm;
    while ((pm = pkgRe.exec(txt))) {
      const pkgName = pm[1];
      const isBody = /PACKAGE\s+BODY/i.test(txt.slice(pm.index, pm.index + 50));
      const serviceKey = pkgName;
      if (seenServices.has(serviceKey)) {
        // 已有说明文件，补充 body 信息
        const svc = seenServices.get(serviceKey);
        if (isBody) svc.source_body = relFile;
        continue;
      }
      const service = {
        impl_qn: pkgName,
        service_iface: pkgName,
        iface_qn: pkgName,
        config: profile.name,
        version: "default",
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "procedure",
        language: "plsql",
        source_file: relFile,
        source_body: isBody ? relFile : "",
        evidence: { file: relFile },
      };
      seenServices.set(serviceKey, service);
      services.push(service);

      // 解析包级类型定义和常量（从说明文件）
      if (!isBody) {
        const types = parseTypeDefinitions(txt);
        const consts = parseConstants(txt);
        if (types.length) service.input_types = types;
        if (consts.length) service.constants = consts;
      }
    }

    // 发现 Procedure/Function（功能）
    // 匹配：PROCEDURE <name>(params) [IS|AS] 或 FUNCTION <name>(params) RETURN <type> [deterministic|parallelenable|pipelined|result_cache] [IS|AS]
    // 注：独立函数(无包归属)与包内子程序共用此正则；deterministic 等修饰关键字需容忍
    const procRe = /\b(PROCEDURE|FUNCTION)\s+([A-Za-z_][\w#$]*)\s*\(([^)]*)\)(?:\s+RETURN\s+([A-Za-z_][\w#$%.]*(?:\([^)]*\))?))?(?:\s+(?:DETERMINISTIC|PARALLEL_ENABLE|PIPELINED|RESULT_CACHE|AGENT\s+IN-OUT|NOCOPY))*\s+(?:IS|AS)\b/gi;
    let fm;
    while ((fm = procRe.exec(txt))) {
      const kind = fm[1].toUpperCase();
      const procName = fm[2];
      const paramStr = fm[3];
      const returnType = fm[4] || "";
      // 独立子程序（无包归属，如 CREATE OR REPLACE FUNCTION fn_xxx）：
      // pkgNameOf 返回空串，此时以子程序归到 __STANDALONE__ 虚拟包（路径契约：fsd/__STANDALONE__/{name}.md）
      let pkgName = pkgNameOf(txt, fm.index);
      if (!pkgName) {
        pkgName = "__STANDALONE__";
        if (!seenServices.has(pkgName)) {
          const standaloneSvc = {
            impl_qn: pkgName,
            service_iface: pkgName,
            iface_qn: pkgName,
            config: profile.name,
            version: "default",
            source: "structural",
            module: slug,
            profile: profile.name,
            entry_type: profile.entry_type || "procedure",
            language: "plsql",
            source_file: relFile,
            source_body: "",
            evidence: { file: relFile },
            standalone: true,
          };
          seenServices.set(pkgName, standaloneSvc);
          services.push(standaloneSvc);
        }
      }

      const params = parseParams(paramStr);
      const signature = `${kind} ${procName}(${paramStr.trim()})${returnType ? " RETURN " + returnType : ""}`;
      // 入口签名：PACKAGE.PROC(类型 参数名, ...) 对齐 L3 校验格式
      const paramsSig = params.map((p) => `${p.oracle_type} ${p.name}`).join(", ");
      const entry = `${pkgName}.${procName}(${paramsSig})`;

      // 提取过程体（从 IS/AS 后到匹配的 END; —— 用 BEGIN/CASE/END 嵌套计数）
      const afterDecl = txt.slice(fm.index);
      const isAsMatch = afterDecl.match(/\b(IS|AS)\b/i);
      let bodyStart = fm.index;
      let bodyEnd = txt.length;
      if (isAsMatch) {
        bodyStart = fm.index + isAsMatch.index + isAsMatch[0].length;
        // 过程体结束：用 BEGIN/CASE/END 嵌套计数找到匹配的 END;
        // 包内过程常以 END; 结尾（不带过程名），旧逻辑只找 END <procName>; 导致
        // 匹配失败、bodyEnd 回退到文件尾，每个过程吞掉后续所有过程的控制流。
        // END IF;/END LOOP; 是控制结构结尾（IF/FOR/LOOP 未计数，跳过）；
        // END CASE; 是 CASE 块结尾（CASE 已计数，需 depth--，不能跳过）。
        const afterBody = txt.slice(bodyStart);
        const tokenRe = /\b(BEGIN|CASE)\b|\bEND\b\s+(IF|LOOP)\b|\bEND\b\s*(?:[A-Za-z_][\w#$]*)?\s*;/gi;
        let depth = 0;
        let tm;
        while ((tm = tokenRe.exec(afterBody))) {
          if (tm[2]) continue;              // END IF/LOOP — 控制结构结尾（未计数，跳过）
          if (tm[1]) { depth++; continue; } // BEGIN 或 CASE
          depth--;                           // END; 或 END <name>;（含 END CASE;）
          if (depth === 0) { bodyEnd = bodyStart + tm.index + tm[0].length; break; }
        }
      }
      const procBody = bodyEnd > bodyStart ? txt.slice(bodyStart, bodyEnd) : "";
      // bodyStart 之前的换行数（body 第 1 行的文件绝对行号 - 1）
      const bodyLineOffset = txt.slice(0, bodyStart).split("\n").length - 1;

      // 解析局部变量（v_ids t_id_tab; / tgt T_ITEM%ROWTYPE; 等）
      const localVars = [];
      const varRe = /\b([A-Za-z_][\w#$]*)\s+([A-Za-z_][\w#$%]*)(?:\s*\([^)]*\))?\s*;/g;
      let vm;
      while ((vm = varRe.exec(procBody))) {
        localVars.push(vm[1]);
      }
      // 参数也是局部变量
      params.forEach((p) => localVars.push(p.name));
      // SQL 别名（tgt/src）也作为局部变量
      const aliasRe = /\b(?:FROM|INTO|UPDATE|MERGE\s+INTO)\s+[A-Za-z_][\w#$]*\s+([A-Za-z_][\w#$]*)/gi;
      while ((vm = aliasRe.exec(procBody))) {
        localVars.push(vm[1]);
      }

      const func = {
        service_iface: pkgName,
        impl_qn: pkgName,
        method: procName,
        signature,
        params,
        return_type: returnType,
        response_type: returnType,
        request_types: params.filter((p) => !["NUMBER", "VARCHAR2", "DATE", "BOOLEAN"].includes(p.oracle_type.toUpperCase().split("(")[0])).map((p) => p.oracle_type),
        profile: profile.name,
        entry_type: profile.entry_type || "procedure",
        language: "plsql",
        source: "structural",
        source_file: relFile,
        module: slug,
        version: "default",
        // 存过专属扩展字段（additive）
        procedure_type: kind,
        package_name: pkgName,
        entry,
        oracle_params: params.map((p) => ({ ...p, java_type: oracleToJava(p.oracle_type) })),
        input_types: [],
        table_facts: parseTableOps(procBody, procName).map(t => {
          // 从 L1 plsql-l1.json 补列 schema（FSD §2 表结构映射）
          const tblNode = (L1.nodes || []).find(n => n.kind === "table" && n.name && n.name.toUpperCase() === t.table.toUpperCase());
          return tblNode && tblNode.columns ? { ...t, columns: tblNode.columns } : t;
        }),
        sequence_deps: parseSequenceRefs(procBody, procName),
        constant_deps: parseCrossPackageRefs(procBody, pkgName, procName, localVars).filter((r) => r.kind === "constant_ref").map((r) => {
          // 合并跨包常量值（crossPackageConstants）
          const key = `${String(r.target_package || "").toUpperCase()}.${String(r.target_member || "").toUpperCase()}`;
          const c = crossPackageConstants.get(key);
          if (c) {
            return {
              ...r,
              value: c.value,
              source_package: c.source_package,
              source_file: c.source_file,
              type: c.type,
              resolved: true,
            };
          }
          return { ...r, value: null, resolved: false };
        }),
        control_flow: parseControlFlow(procBody, procName, bodyLineOffset),
        exception_handlers: parseExceptionHandlers(procBody, procName),
        special_syntax: parseSpecialSyntax(procBody, procName, bodyStart, txt),
        cross_package_calls: parseCrossPackageRefs(procBody, pkgName, procName, localVars).filter((r) => r.kind === "call"),
      };

      // 关联包级类型定义
      const pkgService = seenServices.get(pkgName);
      if (pkgService && pkgService.input_types) {
        func.input_types = pkgService.input_types.filter((t) =>
          params.some((p) => p.oracle_type === t.name)
        );
      }

      // 跨包 TYPE 定义补充：参数引用了其他包定义的 RECORD/TABLE OF（如 p_lines IN const_pkg.t_recv_tab）
      // 此前仅能匹配本包的 input_types，导致跨包复合类型字段无法抽取；现在 crossPackageTypeDefinitions 可补全
      if (Array.isArray(func.input_types)) {
        for (const p of params) {
          const t = p.oracle_type || "";
          // 参数类型形如 OTHER_PKG.T_XXX
          const m = t.match(/^([A-Za-z_][\w#$]*)\.([A-Za-z_][\w#$]*)$/);
          if (!m) continue;
          const refPkg = m[1];
          const refType = m[2];
          // 已包含则跳过
          if (func.input_types.some((it) => it.name === refType && (it.source_package || pkgName) === refPkg)) continue;
          const key = `${refPkg.toUpperCase()}.${refType.toUpperCase()}`;
          const cross = crossPackageTypeDefinitions.get(key);
          if (cross) {
            func.input_types.push({
              name: refType,
              kind: cross.kind,
              fields: cross.fields,
              element_type: cross.element_type,
              index_by: cross.index_by,
              source_package: cross.source_package,
              source_file: cross.source_file,
              resolved: true,
            });
          }
        }
      }

      functions.push(func);
      entryCandidates.push({
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "procedure",
        impl_qn: pkgName,
        method: procName,
        signature,
        confidence: "high",
        source_mode: isPlsqlOnlyRepo ? "plsql-l1-antlr+regex" : "plsql-regex-v1",
        evidence: { file: relFile, kind },
        route: "",
        version: "default",
      });

      // 下游：跨包调用
      for (const ref of func.cross_package_calls) {
        downstream.push({
          from_impl: pkgName,
          from_method: procName,
          to_service: ref.target_package,
          to_method: ref.target_member,
          to_qn: `${ref.target_package}.${ref.target_member}`,
          downstream_kind: "rpc-service",
          source: "structural",
          module: slug,
          profile: profile.name,
          entry_type: profile.entry_type || "procedure",
        });
      }
      // 下游：表操作
      for (const t of func.table_facts) {
        downstream.push({
          from_impl: pkgName,
          from_method: procName,
          to_service: t.table,
          to_method: t.op,
          to_qn: t.table,
          downstream_kind: "dao",
          source: "structural",
          module: slug,
          profile: profile.name,
          entry_type: profile.entry_type || "procedure",
          table_op: t.op,
        });
      }
      // 下游：序列引用
      for (const s of func.sequence_deps) {
        downstream.push({
          from_impl: pkgName,
          from_method: procName,
          to_service: s.sequence,
          to_method: s.usage,
          to_qn: s.sequence,
          downstream_kind: "sequence",
          source: "structural",
          module: slug,
          profile: profile.name,
          entry_type: profile.entry_type || "procedure",
        });
      }
    }

    const hasSubprogramDefinition = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:PACKAGE|PROCEDURE|FUNCTION|TRIGGER)\b/i.test(txt);
    const hasStandaloneMerge = /\bMERGE\s+INTO\b/i.test(txt);
    if (!hasSubprogramDefinition && hasStandaloneMerge) {
      const pkgName = "__STANDALONE__";
      const methodName = standaloneSqlMethodName(txt, relFile);
      if (!seenServices.has(pkgName)) {
        const standaloneSvc = {
          impl_qn: pkgName,
          service_iface: pkgName,
          iface_qn: pkgName,
          config: profile.name,
          version: "default",
          source: "structural",
          module: slug,
          profile: profile.name,
          entry_type: profile.entry_type || "procedure",
          language: "plsql",
          source_file: relFile,
          source_body: "",
          evidence: { file: relFile },
          standalone: true,
        };
        seenServices.set(pkgName, standaloneSvc);
        services.push(standaloneSvc);
      }
      const signature = `SCRIPT ${methodName}`;
      const func = {
        service_iface: pkgName,
        impl_qn: pkgName,
        method: methodName,
        signature,
        params: [],
        return_type: "",
        response_type: "",
        request_types: [],
        profile: profile.name,
        entry_type: profile.entry_type || "procedure",
        language: "plsql",
        source: "structural",
        source_file: relFile,
        module: slug,
        version: "default",
        procedure_type: "SCRIPT",
        package_name: pkgName,
        entry: `${pkgName}.${methodName}()`,
        oracle_params: [],
        input_types: [],
        table_facts: parseTableOps(txt, methodName),
        sequence_deps: parseSequenceRefs(txt, methodName),
        constant_deps: [],
        control_flow: parseControlFlow(txt, methodName, 0),
        exception_handlers: [],
        special_syntax: parseSpecialSyntax(txt, methodName, 0, txt),
        cross_package_calls: [],
        standalone_sql_script: true,
      };
      functions.push(func);
      entryCandidates.push({
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "procedure",
        impl_qn: pkgName,
        method: methodName,
        signature,
        confidence: "medium",
        source_mode: "plsql-standalone-sql-script",
        evidence: { file: relFile, kind: "SCRIPT" },
        route: "",
        version: "default",
      });
      for (const t of func.table_facts) {
        downstream.push({
          from_impl: pkgName,
          from_method: methodName,
          to_service: t.table,
          to_method: t.op,
          to_qn: t.table,
          downstream_kind: "dao",
          source: "structural",
          module: slug,
          profile: profile.name,
          entry_type: profile.entry_type || "procedure",
          table_op: t.op,
        });
      }
    }
  }

  writeParts(slug, services, functions, downstream, profile, [], entryCandidates, moduleDir);
  logDetail(`[L2-script] ${slug} (${profile.name}): services ${services.length} / functions ${functions.length} / downstream ${downstream.length}`);
}

// 辅助：从位置往前找最近的 PACKAGE 名
function pkgNameOf(txt, pos) {
  const before = txt.slice(0, pos);
  const matches = [...before.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\s+(?:BODY\s+)?([A-Za-z_][\w#$]*)\b/gi)];
  return matches.length ? matches[matches.length - 1][1] : "";
}

// ====== 单模块提取 ======
function extractDubboModule(moduleDir, slug, profile) {
// ---- 1) 服务发现：XML 声明 + 注解/Triple 结构路径。XML 是声明事实，不按名字过滤。----
const services = [];           // {impl_qn, service_iface, iface_qn, config, version, source, module}
const unresolvedExposures = [];
const serviceSeen = new Map();
const xmlServicePairs = new Set();
function servicePairKey(implQn, ifaceQnOrName) {
  return `${implQn || ""}|${ifaceQnOrName || ""}`;
}
function addService(service) {
  if (!service || !service.impl_qn) return;
  const implShort = simpleName(service.impl_qn) || "";
  const ifaceShort = service.service_iface || "";
  const lowerImpl = implShort.toLowerCase();
  const lowerIface = (ifaceShort || "").toLowerCase();
  if (lowerImpl.includes("echoserver") || lowerImpl.includes("echoimpl") || lowerIface.includes("echoserver") || lowerIface.includes("echoimpl")) return;
  if (/(Mapper|Dao|DAO|Repository)$/.test(ifaceShort)) return;
  const next = { ...service, module: slug, profile: profile.name, entry_type: service.entry_type || profile.entry_type || "rpc" };
  const key = serviceKeyFor(next);
  if (next.source === "dubbo-xml") {
    xmlServicePairs.add(servicePairKey(next.impl_qn, next.iface_qn || next.service_iface));
    xmlServicePairs.add(servicePairKey(next.impl_qn, next.service_iface));
  }
  if (!serviceSeen.has(key)) {
    serviceSeen.set(key, next);
    services.push(next);
    return;
  }
  const old = serviceSeen.get(key);
  old.source = old.source === next.source ? old.source : `${old.source || ""}+${next.source || ""}`.replace(/^\+|\+$/g, "");
  old.evidence = { ...(old.evidence || {}), ...(next.evidence || {}) };
  if (!old.impl_doc && next.impl_doc) old.impl_doc = next.impl_doc;
  if (!old.iface_doc && next.iface_doc) old.iface_doc = next.iface_doc;
  if ((old.version || "默认") === "默认" && next.version) old.version = next.version;
  if (!old.group && next.group) old.group = next.group;
}

const moduleRel = path.relative(repo, moduleDir).replace(/\\/g, "/");
for (const exposure of dubboXmlIndex.exposures) {
  // 修复1: XML 服务发现全仓 (对齐行内 service-list 全仓 grep src/main/resources)
  // 去掉 per-module 过滤 (xmlInModule/beanInModule), 仓根/跨模块 XML 也转 service (serviceSeen 去重防重复)
  if (!exposure.impl_qn) {
    continue;
  }
  const rec = classRecord(exposure.impl_qn);
  const implText = rec && rec.file ? readText(rec.file) : "";
  const cls = simpleName(exposure.impl_qn);
  const implRel = rec && rec.file ? relFile(rec.file) : "";
  const implDoc = implText ? firstDocBeforeDecl(implText, new RegExp("(?:public\\s+)?(?:abstract\\s+)?class\\s+" + cls + "\\b")) : "";
  const ifaceNode = l1NodeFor(ifaceFile(exposure.interface_qn, exposure.service_iface), "interface", exposure.service_iface);
  const implNode = l1NodeFor(rec && rec.file, "class", cls);
  addService({
    impl_qn: exposure.impl_qn,
    service_iface: exposure.service_iface,
    iface_qn: exposure.interface_qn,
    config: "XML",
    version: exposure.version || "默认",
    group: exposure.group || "",
    impl_doc: implDoc,
    iface_doc: exposure.xml_comment || "",
    source_file: implRel,
    evidence: {
      source: "dubbo-xml",
      xml_file: exposure.xml_file,
      xml_line: exposure.xml_line,
      ref: exposure.ref,
      bean_file: exposure.bean?.xml_file || "",
      bean_line: exposure.bean?.line || null,
      l1_iface_node_id: ifaceNode?.id || "",
      l1_impl_node_id: implNode?.id || "",
    },
    source: "dubbo-xml",
  });
}

const implFiles = javaFiles(moduleDir);
for (const f of implFiles) {
  const t = fs.readFileSync(f, "utf8");
  const cm = t.match(/class\s+(\w+)[^{]*\bimplements\s+([\w.,<>\s]+?)\s*\{/);
  const isDubbo = /@DubboService/.test(t);
  const cls = (cm && cm[1]) || clsOf(t);
  if (!cls) continue;
  const ext = t.match(/class\s+\w+[^{]*\bextends\s+([\w.]+)\s*\{/);
  const tripleBase = isDubbo && ext && /(?:ImplBase|Triple\.\w+ImplBase)$/.test(ext[1]);
  const allIfaces = cm ? cm[2].split(",").map((s) => s.trim().replace(/<.*>/, "")).filter((s) => s && !TRIVIAL.has(s.split(".").pop())) : [];
  // 候选集 = 所有非 trivial 实现接口(implements 结构全集)，不按命名门 —— 命名/暴露只决定置信(serviceExposureEvidence)：
  // 有 XML/@DubboService/@DSF/服务命名 → in_scope；无任何证据 → review_required(可见不丢)。
  // 根治"暴露机制不被识别(@DSF)或命名不在白名单(*Server/*Provider)就静默漏 + 守恒假 passed"这一类。
  const ifaces = allIfaces;
  if (!ifaces.length && !tripleBase) continue;
  const pkg = pkgOf(t);
  const config = isDubbo ? "注解" : "XML/其它";
  const implDoc = firstDocBeforeDecl(t, new RegExp("(?:public\\s+)?(?:abstract\\s+)?class\\s+" + cls + "\\b"));   // 实现类 JavaDoc
  const implRel = path.relative(repo, f).replace(/\\/g, "/");   // 实现类源文件(供 ①增量/grounding)
  const implNode = l1NodeFor(f, "class", cls);
  for (const iface of ifaces) {
    const ifQn = fqnOf(iface, t, pkg);   // 从 impl 的 import 拿接口 FQN
    if (xmlServicePairs.has(servicePairKey(pkg + "." + cls, ifQn)) || xmlServicePairs.has(servicePairKey(pkg + "." + cls, simpleName(iface)))) continue;
    const ifaceNode = l1NodeFor(ifaceFile(ifQn, iface), "interface", simpleName(iface));
    const exposure_evidence = serviceExposureEvidence(t, simpleName(iface), isDubbo);
    const lowConfidence = exposure_evidence === "none" || exposure_evidence === "naming";  // 命名不证明暴露→review（对齐行内 @DubboService/XML/@DSF 暴露驱动 in_scope；不漏：review 保留可见，人工复核）
    addService({ impl_qn: pkg + "." + cls, service_iface: iface, iface_qn: ifQn, config, version: "默认", impl_doc: implDoc, source_file: implRel,
      exposure_evidence,
      review_required: lowConfidence ? true : undefined,
      review_reasons: lowConfidence ? [exposure_evidence === "naming" ? "naming_only_no_exposure_evidence" : "unexposed_internal_interface"] : undefined,
      evidence: { file: implRel, source: "structural", exposure_evidence, l1_iface_node_id: ifaceNode?.id || "", l1_impl_node_id: implNode?.id || "" }, source: "structural" });
  }
  if (tripleBase) {
    const baseShort = ext[1].split(".").pop();
    const serviceName = baseShort.replace(/ImplBase$/, "") || cls;
    const baseQn = fqnOf(baseShort, t, pkg);
    addService({ impl_qn: pkg + "." + cls, service_iface: serviceName, iface_qn: baseQn, config: "注解-Triple/IDL", version: "默认", impl_doc: implDoc, source_file: implRel, evidence: { file: implRel, extends: baseQn, source: "dubbo-triple-idl", l1_impl_node_id: implNode?.id || "" }, source: "structural", triple_idl: true });
  }
}

// ---- 1b) codegraph implements 边补扫 (增量B)：cm 正则 t.match 只取文件首个 class、跨行/复杂 implements 子句也易漏，
//      会静默丢"多类同文件 / 复杂 implements"的服务。用 L1 结构边补全(纯加法, addService 按 serviceKeyFor 去重, 只补 cm 漏的)。
//      qualified_name 是简单名, 故仍用 pkgOf+fqnOf 算 FQN 保证与 cm 键一致。见 _fbase-vtest BetaApi 回归。
const moduleRelPrefixB = String(moduleRel || "").replace(/\/$/, "") + "/";
const implTextCacheB = new Map();
function readImplTextB(cfp) {
  if (implTextCacheB.has(cfp)) return implTextCacheB.get(cfp);
  const absB = path.resolve(repo, cfp);
  const txt = fs.existsSync(absB) ? readText(absB) : "";
  implTextCacheB.set(cfp, txt);
  return txt;
}
for (const classNode of (L1.nodes || [])) {
  if (!classNode || classNode.kind !== "class" || !classNode.name) continue;
  const cfp = String(classNode.file_path || "").replace(/\\/g, "/");
  if (!moduleRelPrefixB || !cfp.startsWith(moduleRelPrefixB)) continue;
  const edgesB = l1OutgoingEdges(classNode.id).filter((e) => e.kind === "implements");
  if (!edgesB.length) continue;
  const tB = readImplTextB(cfp);
  if (!tB) continue;
  const pkgB = pkgOf(tB);
  const clsB = classNode.name;
  const implQnB = (pkgB ? pkgB + "." : "") + clsB;
  const isDubboB = /@DubboService/.test(tB);
  const implDocB = firstDocBeforeDecl(tB, new RegExp("(?:public\\s+)?(?:abstract\\s+)?class\\s+" + clsB + "\\b"));
  for (const edge of edgesB) {
    const ifaceNode = l1NodeById.get(edge.target);
    if (!ifaceNode || ifaceNode.kind !== "interface" || !ifaceNode.name) continue;
    const ifaceSimpleB = ifaceNode.name;
    if (TRIVIAL.has(ifaceSimpleB)) continue;
    const ifQnB = fqnOf(ifaceSimpleB, tB, pkgB);
    if (xmlServicePairs.has(servicePairKey(implQnB, ifQnB)) || xmlServicePairs.has(servicePairKey(implQnB, ifaceSimpleB))) continue;
    const evB = serviceExposureEvidence(tB, ifaceSimpleB, isDubboB);
    const lowB = evB === "none";
    addService({ impl_qn: implQnB, service_iface: ifaceSimpleB, iface_qn: ifQnB, config: isDubboB ? "注解" : "结构-implements边", version: "默认", impl_doc: implDocB, source_file: cfp,
      exposure_evidence: evB,
      review_required: lowB ? true : undefined,
      review_reasons: lowB ? ["unexposed_internal_interface"] : undefined,
      evidence: { file: cfp, source: "structural-l1-edge", exposure_evidence: evB, l1_iface_node_id: ifaceNode.id, l1_impl_node_id: classNode.id }, source: "structural" });
  }
}

// ---- 2) 方法枚举：解析接口源码(含 extends 父接口)，重载各记一条 ----
function implMethodsOf(s) {
  if (!s.triple_idl) return [];
  const cls = s.impl_qn.split(".").pop();
  const rec = javaClassByName.get(cls);
  const f = rec && rec.file;
  if (!f) return [];
  const t = fs.readFileSync(f, "utf8");
  const implRel = path.relative(repo, f).replace(/\\/g, "/");
  const docs = methodDocMap(t);
  const body = t.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /@Override\s+(?:public\s+)([\w.<>\[\],\s]+?)\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
  const out = [];
  let m;
  while ((m = re.exec(body))) {
    const ret = cleanType(m[1].trim().split(/\s+/).pop());
    const name = m[2];
    if (["toString", "hashCode", "equals"].includes(name)) continue;
    const params = parseParams(m[3].trim());
    const methodNode = l1MethodNodeFor(f, name, params);
    out.push({ method: name, signature: `${ret} ${name}(${paramsSignature(params)})`, return_type: ret, params, method_doc: docs[name] || "", iface_file: "", source_file: implRel, source_mode: "dubbo-triple-idl", l1_impl_method_node_id: methodNode?.id || "" });
  }
  return out;
}
function methodsOfFromSourceRegex(ifQn, short, seen = new Set(), acc = []) {
  if (seen.has(ifQn)) return acc; seen.add(ifQn);
  const f = ifaceFile(ifQn, short); if (!f) return acc;
  const t = fs.readFileSync(f, "utf8");
  const ipkg = pkgOf(t);
  const ifaceRel = path.relative(repo, f).replace(/\\/g, "/");          // 接口源文件(供 ①增量/grounding)
  const docs = methodDocMap(t);                                          // 方法 JavaDoc（在原始文本上扫描）
  if (seen.size === 1 && !acc.ifaceDoc) acc.ifaceDoc = firstDocBeforeDecl(t, /(?:public\s+)?interface\s+\w+/);  // 接口 JavaDoc
  // 接口体内的方法声明： 返回类型 名字( ... ) ;  或 default ... { }
  const body = t.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /(?:default\s+)?([\w.<>\[\],\s]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?\s*(?:\{|;)/g;  // 修复3: 支持 throws (对齐行内"所有 public 方法")
  let m;
  while ((m = re.exec(body))) {
    const ret = m[1].trim().split(/\s+/).pop(), name = m[2], params = m[3].trim();
    if (["if", "for", "while", "switch", "catch", "return", "new"].includes(name)) continue;
    const parsedParams = parseParams(params);
    const returnType = cleanType(ret);
    const ifaceMethodNode = l1MethodNodeFor(f, name, parsedParams);
    acc.push({ method: name, signature: `${returnType} ${name}(${paramsSignature(parsedParams)})`, return_type: returnType, params: parsedParams, method_doc: docs[name] || "", iface_file: ifaceRel, inherited_from: seen.size > 1 ? short : null, l1_iface_method_node_id: ifaceMethodNode?.id || "" });
  }
  const ext = t.match(/interface\s+\w+\s+extends\s+([\w.,<>\s]+?)\s*\{/);
  if (ext) for (const p of ext[1].split(",").map((s) => s.trim().replace(/<.*>/, ""))) methodsOfFromSourceRegex(fqnOf(p, t, ipkg), p, seen, acc);
  return acc;
}

function methodsOf(ifQn, short, options = {}) {
  // 修复2: 源码扫优先 (对齐行内 service to func 步骤1.3 所有 public + 递归父接口), L1 作辅助 (源码失败时 AST 增准)
  const src = methodsOfFromSourceRegex(ifQn, short);
  if (src.length) {
    return {
      status: "passed",
      source: "source-regex-primary",
      iface_node_id: "",
      ifaceDoc: src.ifaceDoc || "",
      raw_reachable_method_nodes: 0,
      methods: src.map((x) => ({ ...x, source_mode: "source-regex-primary" })),
      parse_unresolved_methods: [],
      shadowed_inherited_methods: [],
      skipped_methods: [],
      unresolved_methods: [],
    };
  }

  const l1 = methodsOfFromL1(ifQn, short, options);
  if (l1.status === "passed" || l1.status === "partial" || l1.status === "empty_interface") return l1;

  return {
    status: "unresolved",
    source: "unresolved",
    iface_node_id: "",
    ifaceDoc: "",
    raw_reachable_method_nodes: 0,
    methods: [],
    parse_unresolved_methods: [],
    shadowed_inherited_methods: [],
    skipped_methods: [],
    unresolved_methods: [{
      iface_qn: ifQn,
      service_iface: short,
      reason: "interface methods not enumerable by L1 or source fallback",
    }],
  };
}

const functions = [];          // {service_iface, impl_qn, method, signature, inherited_from, source, module}
const downstream = [];         // {from_impl, from_method, to_service, to_method, source, module}
const models = [];             // {type, fields, module, profile}  DTO 字段(代码事实)
const entryCandidates = [];
const methodEnumerationLedger = [];
const seenModel = new Set();
let _methodCount = 0; const _t0 = Date.now();
for (const s of services) {
  const cls = s.impl_qn.split(".").pop();
  let enumResult;
  if (s.triple_idl) {
    const tripleMethods = implMethodsOf(s);
    enumResult = {
      status: tripleMethods.length ? "passed" : "unresolved",
      source: "dubbo-triple-idl",
      iface_node_id: "",
      ifaceDoc: "",
      raw_reachable_method_nodes: tripleMethods.length,
      methods: tripleMethods,
      parse_unresolved_methods: [],
      shadowed_inherited_methods: [],
      skipped_methods: [],
      unresolved_methods: tripleMethods.length ? [] : [{ iface_qn: s.iface_qn || "", service_iface: s.service_iface || "", reason: "triple impl methods not enumerable" }],
    };
  } else {
    enumResult = methodsOf(s.iface_qn, s.service_iface, { service: s });
  }
  const ms = enumResult.methods || [];
  if (enumResult.iface_node_id) {
    s.evidence = s.evidence || {};
    if (!s.evidence.l1_iface_node_id) s.evidence.l1_iface_node_id = enumResult.iface_node_id;
  }
  methodEnumerationLedger.push({
    service_iface: s.service_iface || "",
    iface_qn: s.iface_qn || "",
    impl_qn: s.impl_qn || "",
    version: s.version || "",
    group: s.group || "",
    method_source: enumResult.source || "",
    status: enumResult.status || "",
    iface_node_id: enumResult.iface_node_id || "",
    raw_reachable_method_nodes: Number(enumResult.raw_reachable_method_nodes || 0),
    materialized_functions: ms.length,
    parse_unresolved_methods: enumResult.parse_unresolved_methods || [],
    shadowed_inherited_methods: enumResult.shadowed_inherited_methods || [],
    skipped_methods: enumResult.skipped_methods || [],
    unresolved_methods: enumResult.unresolved_methods || [],
  });
  const ifaceDoc = enumResult.ifaceDoc || "";
  if (ifaceDoc && !s.iface_doc) s.iface_doc = ifaceDoc;   // 接口 JavaDoc 回填到 service 记录
  for (const mm of ms) {
    _methodCount++;
    if (_methodCount % 500 === 0) logDetail(`[L2-dubbo] ${slug} downstream ${_methodCount} methods (elapsed ${((Date.now()-_t0)/1000)|0}s, cg=${CG ? "on" : "null"})`);
    const l1IfaceNodeId = s.evidence?.l1_iface_node_id || mm.l1_iface_node_id || enumResult.iface_node_id || "";
    const params = mm.params || [];
    const implRec = classRecord(s.impl_qn);
    const implMethodNode = mm.l1_impl_method_node_id ? { id: mm.l1_impl_method_node_id } : l1MethodNodeFor(implRec && implRec.file, mm.method, params);
    const candidateBase = {
      module: slug,
      profile: profile.name,
      entry_type: profile.entry_type || "rpc",
      service_iface: s.service_iface,
      iface_qn: s.iface_qn || "",
      impl_qn: s.impl_qn,
      method: mm.method,
      signature: mm.signature,
      return_type: mm.return_type,
      params,
      version: s.version || "默认",
      group: s.group || "",
      route: "",
      confidence: "high",
      source_mode: mm.source_mode || (s.source === "dubbo-xml" ? "dubbo-xml-exposure-v1" : "profile-wide-scan-v1"),
      evidence: {
        impl_file: s.source_file || "",
        iface_file: mm.iface_file || "",
        extends: s.evidence?.extends || "",
        source_mode: mm.source_mode || (s.source === "dubbo-xml" ? "dubbo-xml-exposure-v1" : "profile-wide-scan-v1"),
        service_iface: s.iface_qn || s.service_iface || "",
        xml_file: s.evidence?.xml_file || "",
        xml_line: s.evidence?.xml_line || null,
        l1_iface_node_id: l1IfaceNodeId,
        l1_impl_node_id: s.evidence?.l1_impl_node_id || "",
        l1_iface_method_node_id: mm.l1_iface_method_node_id || "",
        l1_impl_method_node_id: implMethodNode?.id || "",
      },
    };
    entryCandidates.push(candidateBase);
    const fnRec = { service_iface: s.service_iface, impl_qn: s.impl_qn, iface_qn: s.iface_qn || "", method: mm.method, signature: mm.signature, return_type: mm.return_type, params, request_types: params.map((p) => p.type), response_type: mm.return_type, method_doc: mm.method_doc || "", iface_doc: ifaceDoc, impl_doc: s.impl_doc || "", inherited_from: mm.inherited_from, source: "structural", source_file: s.source_file || mm.source_file || "", iface_file: mm.iface_file || "", version: s.version || "默认", group: s.group || "", model_types: [], evidence: { impl_file: s.source_file || mm.source_file || "", iface_file: mm.iface_file || "", extends: s.evidence?.extends || "", source_mode: mm.source_mode || (s.source === "dubbo-xml" ? "dubbo-xml-exposure-v1" : "profile-wide-scan-v1"), xml_file: s.evidence?.xml_file || "", xml_line: s.evidence?.xml_line || null, l1_iface_node_id: l1IfaceNodeId, l1_impl_node_id: s.evidence?.l1_impl_node_id || "", l1_iface_method_node_id: mm.l1_iface_method_node_id || "", l1_impl_method_node_id: implMethodNode?.id || "" }, confidence: { signature: "high", param_names: params.length && params.every((p) => p.name) ? "high" : params.length ? "low" : "high", downstream: "medium" }, module: slug, profile: profile.name, entry_type: profile.entry_type || "rpc" };
    fnRec.model_types = modelTypesFromFunction(fnRec);   // ★ function->model 链
    functions.push(fnRec);
    // DTO/model 字段：入参/返回的业务对象类型 -> 字段清单（代码事实，非 L3 猜测）
    for (const mt of fnRec.model_types) {
      const key = slug + "|" + mt;
      if (seenModel.has(key)) continue;
      const fields = parseModelFields(mt);
      if (fields.length) { seenModel.add(key); models.push({ type: mt, fields, module: slug, profile: profile.name, source: "structural" }); }
    }
    // 下游：callees "Impl::method"，取 kind=method 且在别的服务接口里的
    const callees = calleesForByNodeId(implMethodNode?.id, CG);
    for (const c of callees) {
      const n = c.node || c;
      if (n.kind !== "method") continue;
      const fp = n.filePath || "";
      const toIface = (fp.match(/(\w+)\.java$/) || [])[1] || "";
      if (!toIface || toIface === cls) continue;
      if (!serviceIfaceNames.has(toIface)) continue;             // 只算下游是"已知服务接口"(不靠名字后缀)
      downstream.push({ from_impl: s.impl_qn, from_method: mm.method, to_service: toIface, to_method: n.name, to_qn: n.qualifiedName || n.qualified_name || "", downstream_kind: "rpc-service", source: "structural", module: slug, profile: profile.name, entry_type: profile.entry_type || "rpc" });
    }
  }
}

writeParts(slug, services, functions, downstream, profile, models, entryCandidates, moduleDir, { unresolvedExposures, methodEnumerationLedger });
logDetail(`[L2-script] ${slug}: services ${services.length} / functions ${functions.length} / downstream ${downstream.length} / models ${models.length}`);
}

function extractSpringRestModule(moduleDir, slug, profile) {
  const services = [];
  const functions = [];
  const downstream = [];
  const models = [];
  const entryCandidates = [];
  const maxDepth = Math.max(1, Number(profile.downstream_depth || 1));
  function collectRestDownstream(rootImpl, rootMethod, cls, method, depth, seen = new Set()) {
    if (depth > maxDepth) return;
    const key = `${cls}::${method}#${depth}`;
    if (seen.has(key)) return;
    seen.add(key);
    const callees = calleesForBySymbol(`${cls}::${method}`, CG);
    for (const c of callees) {
      const n = c.node || c;
      if (n.kind !== "method") continue;
      const toCls = calleeClass(n);
      if (!toCls || (toCls === cls && n.name === method)) continue;
      const kind = downstreamKind(toCls, n.filePath || "");
      if (kind === "unknown") continue;
      const toQn = n.qualifiedName || n.qualified_name || (javaClassByName.get(toCls)?.qn ? `${javaClassByName.get(toCls).qn}.${n.name}` : "");
      downstream.push({
        from_impl: rootImpl,
        from_method: rootMethod,
        via_impl: javaClassByName.get(cls)?.qn || cls,
        via_method: method,
        depth,
        to_service: toCls,
        to_method: n.name,
        to_qn: toQn,
        downstream_kind: restEntryClasses.has(toCls) || restEntryMethods.has(`${toCls}::${n.name}`) ? "http-entry" : kind,
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "http",
      });
      if (depth < maxDepth && (kind === "service" || kind === "controller" || kind === "http-entry")) {
        collectRestDownstream(rootImpl, rootMethod, toCls, n.name, depth + 1, seen);
      }
    }
  }
  const implFiles = javaFiles(moduleDir);
  for (const f of implFiles) {
    const t = fs.readFileSync(f, "utf8");
    if (!/@(RestController|Controller)\b/.test(t)) continue;
    const cls = clsOf(t); if (!cls) continue;
    const pkg = pkgOf(t);
    const implQn = (pkg ? pkg + "." : "") + cls;
    const sourceFile = path.relative(repo, f).replace(/\\/g, "/");
    const classDecl = new RegExp("(?:public\\s+)?(?:abstract\\s+)?class\\s+" + cls + "\\b").exec(t);
    const classPrefix = classDecl ? t.slice(0, classDecl.index) : "";
    const classMap = classPrefix.match(/@RequestMapping\b\s*(\([^)]*\))?/);
    const basePath = classMap ? annArg(classMap[1] || "") : "";
    services.push({
      impl_qn: implQn,
      service_iface: cls,
      iface_qn: implQn,
      config: /@RestController\b/.test(t) ? "RestController" : "Controller",
      version: "默认",
      source: "structural",
      module: slug,
      profile: profile.name,
      entry_type: profile.entry_type || "http",
      base_path: basePath,
      source_file: sourceFile,
      evidence: { file: sourceFile, annotation: /@RestController\b/.test(t) ? "@RestController" : "@Controller" },
    });

    const body = t.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /((?:@\w+\b\s*(?:\([^)]*\))?\s*)+)(?:public\s+|protected\s+|private\s+)?([\w.<>\[\],?]+)\s+(\w+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(body))) {
      const info = mappingInfo(m[1]); if (!info) continue;
      const ret = m[2], method = m[3], params = m[4].trim();
      const parsedParams = parseParams(params);
      const returnType = cleanType(ret);
      const responseType = unwrapResponseType(returnType);
      const reqTypes = requestTypes(parsedParams);
      for (const p of info.paths || [""]) {
        const routePath = joinPath(basePath, p);
        const signature = `${info.http_method} ${routePath} -> ${returnType} ${method}(${paramsSignature(parsedParams)})`;
        const route = routePath;
        entryCandidates.push({
          module: slug,
          profile: profile.name,
          entry_type: profile.entry_type || "http",
          service_iface: cls,
          impl_qn: implQn,
          method,
          signature,
          return_type: returnType,
          params: parsedParams,
          route,
          path: routePath,
          http_method: info.http_method,
          confidence: "high",
          source_mode: "profile-wide-scan-v1",
          evidence: {
            source_file: sourceFile,
            annotation: m[1],
            route: `${info.http_method} ${routePath}`,
          },
        });
        const fn = {
          service_iface: cls,
          impl_qn: implQn,
          method,
          signature,
          return_type: returnType,
          response_type: responseType,
          params: parsedParams,
          request_types: reqTypes,
          model_types: [],
          inherited_from: null,
          source: "structural",
          module: slug,
          profile: profile.name,
          entry_type: profile.entry_type || "http",
          http_method: info.http_method,
          path: routePath,
          route,
          controller_qn: implQn,
          source_file: sourceFile,
          evidence: {
            source_file: sourceFile,
            annotation: m[1],
            route: `${info.http_method} ${routePath}`,
          },
          confidence: {
            signature: "high",
            param_names: parsedParams.length && parsedParams.every((x) => x.name) ? "high" : parsedParams.length ? "low" : "high",
            route: "high",
            downstream: "medium",
          },
        };
        fn.model_types = modelTypesFromFunction(fn);
        for (const mt of fn.model_types) {
          models.push({ module: slug, profile: profile.name, type: mt, fields: parseModelFields(mt), source: "structural" });
        }
        functions.push(fn);
      }

      collectRestDownstream(implQn, method, cls, method, 1);
    }
  }
  writeParts(slug, services, functions, downstream, profile, models, entryCandidates, moduleDir);
  logDetail(`[L2-script] ${slug} (${profile.name}): services ${services.length} / functions ${functions.length} / downstream ${downstream.length}`);
}

function extractAnnotatedEntryModule(moduleDir, slug, profile) {
  const services = [];
  const functions = [];
  const downstream = [];
  const models = [];
  const entryCandidates = [];
  const annNames = profile.entry_annotations || [];
  const annPattern = annNames.length
    ? new RegExp("@(" + annNames.map((a) => a.replace(/^@/, "")).join("|") + ")\\b(?:\\s*\\([^)]*\\))?")
    : /@(Scheduled|XxlJob|KafkaListener|RabbitListener|JmsListener|RocketMQMessageListener)\b(?:\s*\([^)]*\))?/;
  const maxDepth = Math.max(1, Number(profile.downstream_depth || 1));

  function collectDownstream(rootImpl, rootMethod, cls, method, depth, seen = new Set()) {
    if (depth > maxDepth) return;
    const key = `${cls}::${method}#${depth}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const c of calleesForBySymbol(`${cls}::${method}`, CG)) {
      const n = c.node || c;
      if (n.kind !== "method") continue;
      const toCls = calleeClass(n);
      if (!toCls || (toCls === cls && n.name === method)) continue;
      const kind = downstreamKind(toCls, n.filePath || "");
      if (kind === "unknown") continue;
      downstream.push({
        from_impl: rootImpl,
        from_method: rootMethod,
        via_impl: javaClassByName.get(cls)?.qn || cls,
        via_method: method,
        depth,
        to_service: toCls,
        to_method: n.name,
        to_qn: n.qualifiedName || n.qualified_name || "",
        downstream_kind: kind,
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "job",
      });
      if (depth < maxDepth && kind !== "dao") collectDownstream(rootImpl, rootMethod, toCls, n.name, depth + 1, seen);
    }
  }

  for (const f of javaFiles(moduleDir)) {
    const txt = fs.readFileSync(f, "utf8");
    if (!annPattern.test(txt)) continue;
    annPattern.lastIndex = 0;
    const cls = clsOf(txt); if (!cls) continue;
    const pkg = pkgOf(txt);
    const implQn = (pkg ? pkg + "." : "") + cls;
    const sourceFile = path.relative(repo, f).replace(/\\/g, "/");
    services.push({ impl_qn: implQn, service_iface: cls, iface_qn: implQn, config: profile.name, version: "default", source: "structural", module: slug, profile: profile.name, entry_type: profile.entry_type || "job", source_file: sourceFile, evidence: { file: sourceFile } });
    const body = txt.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /((?:@\w+(?:\s*\([^)]*\))?\s*)+)(?:public\s+|protected\s+|private\s+)?([\w.<>\[\],?]+)\s+(\w+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(body))) {
      if (!annPattern.test(m[1])) continue;
      annPattern.lastIndex = 0;
      const ret = cleanType(m[2]);
      const method = m[3];
      const parsedParams = parseParams(m[4]);
      const entryAnnotation = (m[1].match(annPattern) || [])[0] || "";
      const fn = {
        service_iface: cls,
        impl_qn: implQn,
        method,
        signature: `${profile.entry_type || "job"} ${method}(${paramsSignature(parsedParams)}) -> ${ret}`,
        return_type: ret,
        response_type: unwrapResponseType(ret),
        params: parsedParams,
        request_types: requestTypes(parsedParams),
        model_types: [],
        inherited_from: null,
        source: "structural",
        module: slug,
        profile: profile.name,
        entry_type: profile.entry_type || "job",
        entry_annotation: entryAnnotation,
        entry_qn: `${implQn}.${method}`,
        source_file: sourceFile,
        evidence: {
          source_file: sourceFile,
          annotation: entryAnnotation,
          entry_qn: `${implQn}.${method}`,
        },
        confidence: {
          signature: "high",
          param_names: parsedParams.length && parsedParams.every((p) => p.name) ? "high" : parsedParams.length ? "low" : "high",
          downstream: "medium",
        },
      };
      fn.model_types = modelTypesFromFunction(fn);
      for (const mt of fn.model_types) models.push({ module: slug, profile: profile.name, type: mt, fields: parseModelFields(mt), source: "structural" });
      pushEntryFunction(functions, entryCandidates, fn, profile, slug, { source_mode: "java-annotation" });
      collectDownstream(implQn, method, cls, method, 1);
    }
  }
  writeParts(slug, services, functions, downstream, profile, models, entryCandidates, moduleDir);
  logDetail(`[L2-script] ${slug} (${profile.name}): services ${services.length} / functions ${functions.length} / downstream ${downstream.length}`);
}

function buildCoverageLedger(slug, profile, services, functions, entryCandidates, options = {}) {
  const exposedSymbolIds = new Set();
  for (const svc of services || []) {
    if (svc.evidence?.l1_iface_node_id) exposedSymbolIds.add(svc.evidence.l1_iface_node_id);
    if (svc.evidence?.l1_impl_node_id) exposedSymbolIds.add(svc.evidence.l1_impl_node_id);
  }
  for (const fn of functions || []) {
    if (fn.evidence?.l1_iface_node_id) exposedSymbolIds.add(fn.evidence.l1_iface_node_id);
    if (fn.evidence?.l1_impl_node_id) exposedSymbolIds.add(fn.evidence.l1_impl_node_id);
    if (fn.evidence?.l1_iface_method_node_id) exposedSymbolIds.add(fn.evidence.l1_iface_method_node_id);
    if (fn.evidence?.l1_impl_method_node_id) exposedSymbolIds.add(fn.evidence.l1_impl_method_node_id);
  }
  const moduleDir = options.moduleDir || moduleDirBySlug(slug);
  const modulePrefix = moduleDir
    ? `${path.relative(repo, moduleDir).replace(/\\/g, "/").replace(/\/$/, "")}/`
    : `${slug.replace(/^.+__/, "")}/`;
  const scopedNodes = (L1.nodes || []).filter((node) =>
    ["class", "interface", "method"].includes(node.kind) &&
    (node.file_path || "").replace(/\\/g, "/").startsWith(modulePrefix)
  );
  const extendedParentIds = new Set();
  for (const node of (L1.nodes || [])) {
    if (node.kind !== "interface") continue;
    const edges = l1OutgoingEdges(node.id);
    for (const edge of edges) {
      if (edge.kind === "extends") extendedParentIds.add(edge.target);
    }
  }
  const classifiedInternal = [];
  const unexplained = [];
  for (const node of scopedNodes) {
    const kind = node.kind;
    const name = node.name || "";
    const fp = (node.file_path || "").toLowerCase().replace(/\\/g, "/");
    if (exposedSymbolIds.has(node.id)) continue;
    if (kind === "method" && (node.visibility === "private" || /^(toString|hashCode|equals)$/.test(name))) {
      classifiedInternal.push({ node_id: node.id, kind, name, qualified_name: node.qualified_name, file_path: node.file_path, reason: "private-or-object-method" });
      continue;
    }
    if (kind === "interface" && (/(Mapper|Dao|DAO|Repository)$/.test(name) || fp.includes("/mapper/") || fp.includes("/dao/"))) {
      classifiedInternal.push({ node_id: node.id, kind, name, qualified_name: node.qualified_name, file_path: node.file_path, reason: "dao-or-mapper-interface" });
      continue;
    }
    if (kind === "interface" && extendedParentIds.has(node.id)) {
      classifiedInternal.push({ node_id: node.id, kind, name, qualified_name: node.qualified_name, file_path: node.file_path, reason: "service-parent-interface" });
      continue;
    }
    if (kind === "method" && (/(Mapper|Dao|DAO|Repository)::/.test(node.qualified_name || "") || fp.includes("/mapper/") || fp.includes("/dao/"))) {
      classifiedInternal.push({ node_id: node.id, kind, name, qualified_name: node.qualified_name, file_path: node.file_path, reason: "dao-or-mapper-method" });
      continue;
    }
    if (kind === "class" && (/\/dto\//.test(fp) || /\/common\//.test(fp) || /\/model\//.test(fp) || /\/entity\//.test(fp))) {
      classifiedInternal.push({ node_id: node.id, kind, name, qualified_name: node.qualified_name, file_path: node.file_path, reason: "data-or-common-class" });
      continue;
    }
    if (kind === "method" && (/\/dto\//.test(fp) || /\/common\//.test(fp) || /\/model\//.test(fp) || /\/entity\//.test(fp))) {
      classifiedInternal.push({ node_id: node.id, kind, name, qualified_name: node.qualified_name, file_path: node.file_path, reason: "data-or-common-method" });
      continue;
    }
    unexplained.push({ node_id: node.id, kind, name, qualified_name: node.qualified_name, file_path: node.file_path });
  }
  const declaredExposures = (services || []).filter((svc) => svc.source === "dubbo-xml" || svc.evidence?.source === "dubbo-xml").length + (options.unresolvedExposures || []).length;
  const methodEnumeration = options.methodEnumerationLedger || [];
  let rawReachableInterfaceMethods = 0;
  let materializedInterfaceFunctions = 0;
  let methodParseUnresolved = 0;
  let methodUnresolvedServices = 0;
  let methodUnresolvedMethods = 0;
  let methodFallbackServices = 0;
  let methodLedgerMismatches = 0;
  let shadowedInheritedMethods = 0;
  let skippedInterfaceMethods = 0;
  let emptyInterfaces = 0;
  for (const item of methodEnumeration) {
    const raw = Number(item.raw_reachable_method_nodes || 0);
    const materialized = Number(item.materialized_functions || 0);
    const parseUnresolved = (item.parse_unresolved_methods || []).length;
    const shadowed = (item.shadowed_inherited_methods || []).length;
    const skipped = (item.skipped_methods || []).length;
    const unresolved = (item.unresolved_methods || []).length;
    rawReachableInterfaceMethods += raw;
    materializedInterfaceFunctions += materialized;
    methodParseUnresolved += parseUnresolved;
    methodUnresolvedMethods += unresolved;
    shadowedInheritedMethods += shadowed;
    skippedInterfaceMethods += skipped;
    if (item.status === "empty_interface") emptyInterfaces++;
    if (item.method_source === "source-regex-fallback-v1") methodFallbackServices++;
    if (item.status === "unresolved" || item.status === "fallback") methodUnresolvedServices++;
    if (raw > 0 && raw !== materialized + parseUnresolved + shadowed + skipped) methodLedgerMismatches++;
  }
  return {
    schemaVersion: 1,
    module: slug,
    profile: profile.name,
    l1: {
      status: L1.error ? "unavailable" : "available",
      error: L1.error || "",
      counts: L1.counts || {},
    },
    counts: {
      scopedSymbols: scopedNodes.length,
      exposedSymbols: exposedSymbolIds.size,
      classifiedInternal: classifiedInternal.length,
      unexplained: unexplained.length,
      declaredExposures,
      resolvedBindings: (services || []).filter((svc) => svc.source === "dubbo-xml" || svc.evidence?.source === "dubbo-xml").length,
      unresolvedBindings: (options.unresolvedExposures || []).length,
      services: (services || []).length,
      structuralServices: (services || []).filter((svc) => svc.source === "structural").length,
      reviewServices: (services || []).filter((svc) => svc.review_required === true).length,
      lowExposureConfidence: (services || []).filter((svc) => svc.exposure_evidence === "none").length,
      functions: (functions || []).length,
      candidates: Array.isArray(entryCandidates) ? entryCandidates.length : 0,
      rawReachableInterfaceMethods,
      materializedInterfaceFunctions,
      methodParseUnresolved,
      methodUnresolvedServices,
      methodUnresolvedMethods,
      methodFallbackServices,
      methodLedgerMismatches,
      shadowedInheritedMethods,
      skippedInterfaceMethods,
      emptyInterfaces,
    },
    exposed: [...exposedSymbolIds].map((node_id) => ({ node_id })),
    classified_internal: classifiedInternal,
    unexplained,
    unresolved_bindings: options.unresolvedExposures || [],
    method_enumeration: methodEnumeration,
    status: (options.unresolvedExposures || []).length || methodUnresolvedServices || methodParseUnresolved || methodLedgerMismatches ? "partial" : "passed",
  };
}

function writeParts(slug, services, functions, downstream, profile, models = [], entryCandidates = null, moduleDirArg = "", options = {}) {
  const partsDir = path.join(repo, ".repowiki", "knowledge", "parts");
  fs.mkdirSync(partsDir, { recursive: true });
  const w = (kind, data) => fs.writeFileSync(path.join(partsDir, `${kind}.part-${slug}.json`), JSON.stringify(data, null, 2), "utf8");
  const uniq = (arr, keyf) => { const s = new Map(); for (const x of arr) s.set(keyf(x), x); return [...s.values()]; };
  const moduleDir = moduleDirArg || moduleDirBySlug(slug);
  const sourceFingerprintInfo = sourceFingerprint(moduleDir || repo);
  const rawTables = tableFactsForModule(moduleDir || repo, slug, profile);
  const tablesOut = uniq(attachRepoFacts(rawTables, moduleDir || repo), (x) => [x.module, x.profile, x.impl_qn, x.method, x.table, x.dao_qn || "", x.dao_method || ""].join("|"));
  const servicesOut = attachRepoFacts(uniq(services, (x) => [x.impl_qn, x.service_iface, x.iface_qn || "", x.version || "", x.group || "", x.profile || profile.name].join("|")), moduleDir || repo);
  const downstreamOut = uniq(downstream, (x) => [x.from_impl, x.from_method, x.to_service, x.to_method, x.profile || profile.name].join("|"));
  const profileFunctions = attachRepoFacts(attachTablesToFunctions(
    uniq(functions, (x) => [x.impl_qn, x.signature, x.version || "", x.group || "", x.profile || profile.name].join("|")),
    tablesOut,
    downstreamOut
  ), moduleDir || repo);
  const modelsOut = uniq(models || [], (x) => [x.module, x.profile, x.type].join("|"));
  const projection = buildProjectionParts({
    slug,
    profile,
    services: servicesOut,
    functions: profileFunctions,
    downstream: downstreamOut,
    models: modelsOut,
    entryCandidates,
  });
  const functionsOut = uniq(projection.materializedFunctions, (x) => x.function_key || (x.impl_qn + "|" + x.signature + "|" + (x.profile || profile.name)));
  w("services", servicesOut);
  w("functions", functionsOut);
  w("downstream", downstreamOut);
  w("models", modelsOut);
  w("tables", tablesOut);
  w("entry-candidates", projection.entryCandidates);
  w("entities", projection.entities);
  w("relations", projection.relations);
  w("expected-functions", projection.expectedFunctions);
  const coverageLedger = buildCoverageLedger(slug, profile, servicesOut, functionsOut, projection.entryCandidates.candidates, { ...options, moduleDir });
  w("coverage-ledger", coverageLedger);
  w("meta", {
    schemaVersion: FACT_SCHEMA_VERSION,
    featureSet: FACT_FEATURE_SET,
    extractor: "repowiki-l2",
    profile: profile.name,
    slug,
    sourceFingerprint: sourceFingerprintInfo,
    counts: {
      services: servicesOut.length,
      functions: functionsOut.length,
      downstream: downstreamOut.length,
      models: modelsOut.length,
      tables: tablesOut.length,
      entryCandidates: projection.entryCandidates.candidates.length,
      entities: projection.entities.length,
      relations: projection.relations.length,
      expectedFunctions: projection.expectedFunctions.length,
      coverageLedger: coverageLedger.counts,
    },
    updated_at: new Date().toISOString(),
  });
}

function removeParts(partsDir, slug) {
  for (const kind of ["services", "functions", "downstream", "models", "tables", "meta", "entry-candidates", "entities", "relations", "expected-functions", "coverage-ledger"]) {
    const p = path.join(partsDir, `${kind}.part-${slug}.json`);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

function partState(partsDir, slug, profile) {
  const metaFile = path.join(partsDir, `meta.part-${slug}.json`);
  if (!fs.existsSync(metaFile)) return { fresh: false, reason: "missing meta" };
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return { fresh: false, reason: "bad meta json" };
  }
  if (meta.schemaVersion !== FACT_SCHEMA_VERSION) return { fresh: false, reason: `schema ${meta.schemaVersion || "none"} != ${FACT_SCHEMA_VERSION}` };
  if (meta.profile && meta.profile !== profile.name) return { fresh: false, reason: `profile ${meta.profile} != ${profile.name}` };
  const fsx = meta.featureSet || {};
  for (const k of Object.keys(FACT_FEATURE_SET)) {
    if (fsx[k] !== FACT_FEATURE_SET[k]) return { fresh: false, reason: `feature ${k} mismatch` };
  }
  const moduleDir = moduleDirBySlug(slug);
  if (moduleDir) {
    const currentFingerprint = sourceFingerprint(moduleDir);
    if (!meta.sourceFingerprint || meta.sourceFingerprint.hash !== currentFingerprint.hash) {
      return { fresh: false, reason: "source fingerprint mismatch" };
    }
  }
  for (const kind of ["services", "functions", "downstream", "models", "tables", "entry-candidates", "entities", "relations", "expected-functions", "coverage-ledger"]) {
    if (!fs.existsSync(path.join(partsDir, `${kind}.part-${slug}.json`))) return { fresh: false, reason: `missing ${kind} part` };
  }
  return { fresh: true, reason: "fresh" };
}

function extractModule(moduleDir, slug, profile) {
  if (!CG) CG = openCodegraphSync(repo);  // 进程内 codegraph，惰性 open 一次复用全模块（替代 spawnSync CLI）
  if (profile.name === "spring-rest") return extractSpringRestModule(moduleDir, slug, profile);
  if (["mq-listener", "scheduled-job", "batch-job"].includes(profile.name)) return extractAnnotatedEntryModule(moduleDir, slug, profile);
  if (profile.name === "go-cli") return extractGoCliModule(moduleDir, slug, profile);
  if (profile.name === "go-http") return extractGoHttpModule(moduleDir, slug, profile);
  if (profile.name === "k8s-controller") return extractK8sControllerModule(moduleDir, slug, profile);
  if (profile.name === "oracle-sp") return extractOracleSpModule(moduleDir, slug, profile);
  return extractDubboModule(moduleDir, slug, profile);
}

// ====== 入口 ======
function progressBar(done, total, width = 24) {
  const pct = total ? done / total : 1;
  const filled = Math.round(pct * width);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}] ${done}/${total} ${(pct * 100).toFixed(1)}%`;
}
function printL2Progress(done, total, current, action) {
  const suffix = verbose && current ? ` ${action || ""} ${current}` : "";
  console.log(`[L2-progress] ${progressBar(done, total)}${suffix}`.trim());
}
function shouldPrintL2Progress(seen, total, lastPrinted) {
  if (verbose || seen === 0 || seen === total) return true;
  if (seen - lastPrinted >= 20) return true;
  const prevBucket = Math.floor((lastPrinted * 20) / Math.max(1, total));
  const nextBucket = Math.floor((seen * 20) / Math.max(1, total));
  return nextBucket > prevBucket;
}

if (a3 === "--all") {
  const mf = path.join(repo, ".repowiki", "modules.json");
  if (!fs.existsSync(mf)) { console.error(`✗ 无 ${mf}，先跑 list-services.cjs`); process.exit(4); }
  const mods = JSON.parse(fs.readFileSync(mf, "utf8"));
  if (!Array.isArray(mods) || mods.length === 0) {
    console.error(`✗ ${mf} 中没有模块。`);
    console.error("停止 L2：当前 profile 未发现入口，不能把空模块清单当成正常完成。");
    process.exit(4);
  }
  const partsDir = path.join(repo, ".repowiki", "knowledge", "parts");
  let done = 0, skip = 0, seen = 0;
  let lastProgressPrinted = 0;
  printL2Progress(0, mods.length, "", "start");
  for (const m of mods) {
    const profile = loadProfile(m.profile || cliProfile || "dubbo");
    const state = partState(partsDir, m.slug, profile);
    if (state.fresh) {
      skip++;
      seen++;
      if (shouldPrintL2Progress(seen, mods.length, lastProgressPrinted)) {
        printL2Progress(seen, mods.length, m.slug, "skip");
        lastProgressPrinted = seen;
      }
      continue;
    }
    removeParts(partsDir, m.slug);
    if (verbose) logDetail(`[L2-script] ${m.slug}: stale ${state.reason}`);
    const moduleDir = moduleDirBySlug(m.slug) || m.absPath;
    extractModule(moduleDir, m.slug, profile);
    done++;
    seen++;
    if (shouldPrintL2Progress(seen, mods.length, lastProgressPrinted)) {
      printL2Progress(seen, mods.length, m.slug, "done");
      lastProgressPrinted = seen;
    }
  }
  console.log(`[L2-script] complete processed=${done} skipped=${skip} modules=${mods.length}`);
  console.log(`NEXT: L2 抽取完成。禁止输出 text-only response 停下，必须立即运行合并：`);
  console.log(`  node "${path.join(__dirname, "merge-knowledge.cjs")}" "${path.join(repo, ".repowiki", "knowledge")}"`);
  if (CG) { try { CG.destroy(); } catch (_) {} CG = null; }
} else {
  if (a3.startsWith("--")) usageAndExit(`invalid L2 usage: ${a3} cannot be used as a module path. Use --all before --profile.`);
  if (!a4) { console.error("单模块模式需要 slug：node repowiki-l2.cjs <仓根> <模块绝对路径> <slug>"); process.exit(2); }
  if (a4.startsWith("--")) usageAndExit("single-module mode requires a concrete slug.");
  const resolvedModuleDir = path.resolve(a3);
  if (!fs.existsSync(resolvedModuleDir) || !fs.statSync(resolvedModuleDir).isDirectory()) {
    usageAndExit(`single-module mode requires an existing module directory: ${a3}`);
  }
  const mf = path.join(repo, ".repowiki", "modules.json");
  if (fs.existsSync(mf)) {
    const mods = JSON.parse(fs.readFileSync(mf, "utf8").replace(/^\uFEFF/, ""));
    const mod = Array.isArray(mods) ? mods.find((x) => x.slug === a4) : null;
    if (!mod) usageAndExit(`single-module slug is not listed in ${mf}: ${a4}`);
  }
  const profile = loadProfile(cliProfile || "dubbo");
  extractModule(resolvedModuleDir, a4, profile);
  if (CG) { try { CG.destroy(); } catch (_) {} CG = null; }
}
