#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { repowikiWorkDir } = require(path.join(__dirname, "lib", "repowiki-workdir.cjs"));
const skillContract = require(path.join(__dirname, "lib", "l3-skill-contract.cjs"));
const l3Selection = require(path.join(__dirname, "lib", "l3-selection.cjs"));
const rowsLib = require(path.join(__dirname, "lib", "rows.cjs"));

const args = process.argv.slice(2);
const repo = path.resolve(args[0] || ".");
let l3Skill = ""; // 空=自动推断（从 modules.json profile）
let concurrency = 8;
let concurrencyExplicit = false;
// gatePolicy：auto | review-on-fail(默认) | manual-after-service-list | manual-after-function-list
let gatePolicy = "review-on-fail";
let l3SkillExplicit = false;

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--l3-skill") { l3Skill = args[++i] || l3Skill; l3SkillExplicit = true; }
  else if (a.startsWith("--l3-skill=")) { l3Skill = a.slice("--l3-skill=".length); l3SkillExplicit = true; }
  else if (a === "--concurrency") { concurrency = Number(args[++i] || concurrency); concurrencyExplicit = true; }
  else if (a.startsWith("--concurrency=")) { concurrency = Number(a.slice("--concurrency=".length)); concurrencyExplicit = true; }
  else if (a === "--gate-policy") gatePolicy = args[++i] || gatePolicy;
  else if (a.startsWith("--gate-policy=")) gatePolicy = a.slice("--gate-policy=".length);
}

if (!args[0]) {
  console.error("usage: node repowiki-l3-scheduler.cjs <repo> --l3-skill <L3_SKILL> --concurrency <N>");
  process.exit(2);
}

const repowikiDir = repowikiWorkDir(repo);
const knowledgeDir = path.join(repowikiDir, "knowledge");
const schedulerDir = path.join(repowikiDir, "l3-scheduler");
const modulesFile = path.join(repowikiDir, "modules.json");
const functionsFile = path.join(knowledgeDir, "functions.json");
const downstreamFile = path.join(knowledgeDir, "downstream.json");
const schemaReportFile = path.join(knowledgeDir, "l2-schema-report.json");
const completenessFile = path.join(knowledgeDir, "l2-completeness.json");
const tasksFile = path.join(schedulerDir, "tasks.json");
const stateFile = path.join(schedulerDir, "state.json");
const businessViewFile = path.join(schedulerDir, "business-view.json");
const lockFile = path.join(schedulerDir, "state.lock");
const servicesFile = path.join(knowledgeDir, "services.json");
const CURRENT_FACT_SCHEMA_VERSION = 9;
const CURRENT_COMPLETENESS_SCHEMA_VERSION = 3;
const zeroFunctionsFile = path.join(schedulerDir, "zero-functions.json");
const metadataDir = path.join(schedulerDir, "metadata");
const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 30000;
const LOCK_STALE_MS = 10 * 60 * 1000;

// L3 skill 自动推断：如果未指定 --l3-skill，从 modules.json 的 profile 推断
if (!l3SkillExplicit) {
  const _modules = readJson(modulesFile, []);
  if (Array.isArray(_modules) && _modules.length > 0) {
    const _profiles = [...new Set(_modules.map(m => m.profile).filter(Boolean))];
    if (_profiles.length === 1) {
      const _p = _profiles[0];
      // profile → skill 映射
      const _skillMap = {
        "oracle-sp": "wiki-l3-oracle-sp",
        "dubbo": "wiki-l3-icbc",
        "spring-rest": "wiki-l3-icbc",
      };
      l3Skill = _skillMap[_p] || "wiki-l3-icbc";
    } else {
      l3Skill = "wiki-l3-icbc";
    }
  } else {
    l3Skill = "wiki-l3-icbc";
  }
}

const l3Manifest = skillContract.loadManifest(__dirname, l3Skill);
const docsDir = skillContract.docsDir(repo, l3Manifest);

function readJson(file, defaultValue) {
  if (!fs.existsSync(file)) return defaultValue;
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function truthyEnv(name) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function softL2CompletenessEnabled() {
  return truthyEnv("REPOWIKI_L3_SOFT_L2_COMPLETENESS") || truthyEnv("REPOWIKI_L3_SKIP_L2_COMPLETENESS_GATE");
}

function softOrThrowL2Completeness(reason) {
  if (!softL2CompletenessEnabled()) throw new Error(reason);
  console.warn(`[L3-scheduler] WARN ${reason}; continuing because REPOWIKI_L3_SOFT_L2_COMPLETENESS=1`);
}

function acquireStateLock() {
  const started = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      return fd;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (_) {
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error("timed out waiting for L3 state lock");
      sleep(LOCK_RETRY_MS);
    }
  }
}

function withStateLock(fn) {
  fs.mkdirSync(schedulerDir, { recursive: true });
  const fd = acquireStateLock();
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(lockFile); } catch (_) {}
  }
}

function requireFile(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`missing ${file}; ${hint}`);
}

function docExists(file) {
  if (!file) return false;
  const output = path.isAbsolute(file) ? file : path.resolve(repo, file);
  return fs.existsSync(output) && fs.statSync(output).isFile() && fs.statSync(output).size > 20;
}

function isControlPlaneOnly(task) {
  return !!(task && task.controlPlaneOnly);
}

function safeName(s) {
  return String(s || "item").replace(/[\\/:*?"<>|#\r\n]+/g, "_").slice(0, 120);
}

function simpleName(s) {
  return String(s || "").split(".").pop() || "Function";
}

function shortHash(s) {
  let h = 2166136261;
  for (const ch of String(s || "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).slice(0, 8);
}

function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) out.push(file);
    }
  };
  walk(dir);
  return out;
}

function contractFilesFor(skillName) {
  const businessSkillDir = path.resolve(__dirname, "..", skillName || "wiki-l3-icbc");
  const files = [
    path.join(__dirname, "l3-worker-prompt.md"),
    path.join(__dirname, "lib", "rows.cjs"),
    path.join(__dirname, "lib", "l3-skill-contract.cjs"),
    path.join(businessSkillDir, "SKILL.md"),
    path.join(businessSkillDir, "manifest.json"),
    path.join(businessSkillDir, "selection-policy.json"),
    path.join(businessSkillDir, "validation.json"),
    ...collectFiles(path.join(businessSkillDir, "rules")),
    ...collectFiles(path.join(businessSkillDir, "templates")),
  ];
  return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
}

function contractHashFor(skillName) {
  const hash = crypto.createHash("sha256");
  hash.update("repowiki-l3-contract-v1\n");
  for (const file of contractFilesFor(skillName)) {
    const rel = path.relative(__dirname, file).replace(/\\/g, "/");
    hash.update(`FILE ${rel}\n`);
    hash.update(fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from("<missing>"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function functionId(fn, index) {
  return `${fn.module}__${safeName(fn.impl_qn)}__${safeName(fn.method || index)}__${shortHash(fn.signature || fn.id || JSON.stringify(fn))}`;
}

function downstreamCount(fn, downstream) {
  return downstream.filter((d) =>
    d.module === fn.module &&
    d.from_impl === fn.impl_qn &&
    d.from_method === fn.method
  ).length;
}

function appName() {
  return skillContract.appName(repo, l3Manifest);
}

function serviceRowsFilePath() {
  return path.join(docsDir, `${skillContract.outputBaseName("service-list", appName(), l3Manifest)}.rows.json`);
}

function functionRowsFilePath() {
  return path.join(docsDir, `${skillContract.outputBaseName("function-list", appName(), l3Manifest)}.rows.json`);
}

function readFunctionRowsFile() {
  const rowsFile = functionRowsFilePath();
  try {
    const rows = readJson(rowsFile, null);
    return Array.isArray(rows) ? rows : null;
  } catch (_) {
    return null;
  }
}

function readServiceRowsFile() {
  const rowsFile = serviceRowsFilePath();
  try {
    const rows = readJson(rowsFile, null);
    return Array.isArray(rows) ? rows : null;
  } catch (_) {
    return null;
  }
}

function validationForSkill(skillName) {
  const dir = path.resolve(__dirname, "..", skillName || "wiki-l3-icbc");
  return readJson(path.join(dir, "validation.json"), {});
}

function validatedFunctionRows(rows, businessView, functions, services) {
  if (!Array.isArray(rows)) return null;
  const result = rowsLib.validateFunctionRows(rows, {
    functionsCount: (businessView.functions && businessView.functions.in_scope || functions).length,
    functions: businessView.functions && businessView.functions.in_scope || functions,
    allServices: services,
    allFunctions: functions,
    view: businessView,
    serviceRows: readServiceRowsFile() || [],
    validation: validationForSkill(l3Skill),
  });
  return result.ok ? rows : null;
}

function readSelectionPolicy(skillName) {
  const file = path.resolve(__dirname, "..", skillName || "wiki-l3-icbc", "selection-policy.json");
  return readJson(file, {});
}

function canonicalModule(s) {
  const parts = String(s || "").split("__").filter(Boolean);
  if (parts.length > 2 && /^(dubbo|spring-rest|mq-listener|scheduled-job|batch-job|go-cli|go-http|k8s-controller)$/i.test(parts[0])) {
    return parts.slice(2).join("__");
  }
  return parts.join("__");
}

function moduleMatches(rowModule, taskModule) {
  const r = String(rowModule || "");
  const t = String(taskModule || "");
  if (!r || !t || r === t) return true;
  const cr = canonicalModule(r);
  const ct = canonicalModule(t);
  return cr === ct || t.endsWith(`__${r}`) || r.endsWith(`__${t}`);
}

function rowMatchesFunction(row, fn) {
  return row &&
    fn &&
    (!row.module || !fn.module || moduleMatches(row.module, fn.module)) &&
    row.impl_qn === fn.impl_qn &&
    row.method === fn.method &&
    (!fn.signature || !row.signature || row.signature === fn.signature);
}

function sameMethodSignature(row, fn) {
  return row &&
    fn &&
    row.impl_qn === fn.impl_qn &&
    row.method === fn.method &&
    (!fn.signature || !row.signature || row.signature === fn.signature);
}

function safePathParts(s, fallback = "未分类") {
  const raw = String(s || "").trim() || fallback;
  return raw
    .split(/[\\/]+/)
    .map((part) => safeName(part).trim())
    .filter(Boolean);
}

function rowForFunction(fn, rows) {
  if (!Array.isArray(rows)) return null;
  const exact = rows.find((r) => rowMatchesFunction(r, fn));
  if (exact) return exact;
  const candidates = rows.filter((r) => sameMethodSignature(r, fn));
  return candidates.length === 1 ? candidates[0] : null;
}

function preferredOutputFromRows(task, rows) {
  if (!task || task.kind !== "function-doc" || !Array.isArray(rows)) return "";
  const row = rowForFunction(task.function || {}, rows);
  if (!row) return "";
  const dirParts = safePathParts(row.business_name, "未分类");
  const base = safeName(row.function_name || row.method || simpleName(row.impl_qn));
  const suffix = skillContract.functionDocSuffix(l3Manifest);
  const file = suffix ? `${base}_${suffix}.md` : `${base}.md`;
  return path.join(docsDir, ...dirParts, file);
}

function sameOutputPath(a, b) {
  return path.resolve(String(a || "")).toLowerCase() === path.resolve(String(b || "")).toLowerCase();
}

function buildTasks(modules, functions, downstream) {
  const modulesBySlug = new Map(modules.map((m) => [m.slug, m]));
  const caps = (l3Manifest && l3Manifest.capabilities) || {};
  const listTasks = [];

  if (caps.serviceList !== false) {
    listTasks.push({
      id: "l3__service-list",
      kind: "service-list",
      status: "pending",
      l3Skill,
      module: "",
      relPath: "",
      deps: [],
      output: serviceRowsFilePath(),
      facts: { contextFile: "" },
    });
  }
  if (caps.functionList !== false) {
    listTasks.push({
      // 控制面锚点：function-list-scope 全部完成后，由控制面合并并复用 function-list 全量门禁。
      id: "l3__function-list",
      kind: "function-list",
      role: "function-list-merge",
      controlPlaneOnly: true,
      status: "pending",
      l3Skill,
      module: "",
      relPath: "",
      deps: caps.serviceList === false ? [] : ["l3__service-list"],
      output: functionRowsFilePath(),
      facts: { contextFile: "" },
    });
  }
  if (caps.functionDocGuide !== false) {
    const guideDeps = [];
    if (caps.serviceList !== false) guideDeps.push("l3__service-list");
    if (caps.functionList !== false) guideDeps.push("l3__function-list");
    listTasks.push({
      id: "l3__function-doc-guide",
      kind: "function-doc-guide",
      status: "pending",
      l3Skill,
      module: "",
      relPath: "",
      deps: guideDeps,
      output: path.join(docsDir, `${skillContract.outputBaseName("function-doc-guide", appName(), l3Manifest)}.md`),
      facts: { contextFile: "" },
    });
  }

  // function-doc 的 deps：默认依赖 function-list；oracle-sp 等无 function-list 的 skill 为空，可立即领取
  const functionDocDeps = [];
  if (caps.functionList !== false) functionDocDeps.push("l3__function-list");

  const functionTasks = functions.map((fn, index) => {
    const mod = modulesBySlug.get(fn.module) || { relPath: fn.module, slug: fn.module };
    const id = functionId(fn, index);
    return {
      id,
      kind: "function-doc",
      status: "pending",
      l3Skill,
      module: fn.module || "",
      relPath: mod.relPath || fn.module || "",
      deps: functionDocDeps,
      output: "",
      function: {
        module: fn.module || "",
        impl_qn: fn.impl_qn || "",
        iface_qn: fn.iface_qn || fn.service_iface || "",
        service_iface: fn.service_iface || "",
        method: fn.method || "",
        signature: fn.signature || "",
        entry_type: fn.entry_type || fn.profile || "",
        route: fn.route || fn.path || "",
      },
      facts: {
        contextFile: "",
        downstreamCount: downstreamCount(fn, downstream),
      },
    };
  });

  return [...listTasks, ...functionTasks];
}

function preservedDynamicTasks(previousPlan, previousTasks, currentContractHash) {
  return (Array.isArray(previousPlan) ? previousPlan : [])
    .filter((task) => task && task.kind === "function-list-scope")
    .filter((task) => {
      const item = previousTasks && previousTasks[task.id];
      return !item || !item.contractHash || item.contractHash === currentContractHash;
    })
    .map((task) => ({
      id: task.id,
      kind: "function-list-scope",
      status: "pending",
      l3Skill: task.l3Skill || l3Skill,
      module: task.module || "",
      relPath: task.relPath || "",
      deps: Array.isArray(task.deps) && task.deps.length ? task.deps : ["l3__service-list"],
      output: task.output || "",
      facts: task.facts || {},
      scopeKeys: Array.isArray(task.scopeKeys) ? task.scopeKeys : [],
      serviceRowsHash: task.serviceRowsHash || "",
      role: task.role || "function-list-scope",
    }));
}

function writeManifests(modules, services, functions, downstream, tasks, businessView) {
  const functionCount = new Map();
  for (const fn of functions) functionCount.set(fn.module, (functionCount.get(fn.module) || 0) + 1);
  const zero = modules
    .filter((m) => !functionCount.has(m.slug))
    .map((m) => ({ slug: m.slug, relPath: m.relPath, absPath: m.absPath, profile: m.profile || "" }));

  const previousPlan = readJson(tasksFile, []);
  const previousState = readJson(stateFile, { tasks: {} });
  const previousTasks = previousState.mode === "l3-claim-context" && previousState.tasks ? previousState.tasks : {};
  const hasPreviousTasks = Object.keys(previousTasks).length > 0;
  const runningCount = Object.values(previousTasks).filter((item) => item.status === "running").length;
  if (runningCount > 0) {
    throw new Error(`scheduler already has ${runningCount} running task(s); do not reinitialize while L3 workers are active`);
  }
  const requestedConcurrency = Math.max(1, Math.floor(concurrency || 1));
  const previousConcurrency = Math.max(1, Math.floor(Number(previousState.concurrency) || 0));
  const effectiveConcurrency = hasPreviousTasks && previousConcurrency && !concurrencyExplicit ? previousConcurrency : requestedConcurrency;
  let reusedDone = 0;
  let resetDone = 0;
  let resetSkillMismatch = 0;
  let resetStalePath = 0;
  let resetContractMismatch = 0;
  // oracle-sp 等不产 function-list 的 skill：跳过 rows 校验（rows=null 时 preferredOutputFromRows 返回空，output 由 task.cjs 在 claim 时按 docPathSource 绑定）
  const _caps = (l3Manifest && l3Manifest.capabilities) || {};
  const rows = _caps.functionList === false
    ? null
    : validatedFunctionRows(readFunctionRowsFile(), businessView || l3Selection.emptyView(services, functions), functions, services);
  const currentContractHash = contractHashFor(l3Skill);
  const nextState = {
    version: 7,
    mode: "l3-claim-context",
    l3Skill,
    gatePolicy,
    contractHash: currentContractHash,
    metadataDir,
    concurrency: effectiveConcurrency,
    updated_at: new Date().toISOString(),
    tasks: {},
  };

  const allTasks = [...tasks, ...preservedDynamicTasks(previousPlan, previousTasks, currentContractHash)]
    .filter((task, index, arr) => arr.findIndex((x) => x.id === task.id) === index);

  for (const task of allTasks) {
    const old = previousTasks && previousTasks[task.id];
    const rowOutput = preferredOutputFromRows(task, rows);
    const previousOutput = old && (old.boundOutput || old.output);
    const sameSkill = !old || !old.l3Skill || old.l3Skill === task.l3Skill;
    const sameContract = !old || old.contractHash === currentContractHash;
    const targetOutput = task.kind === "function-doc" ? rowOutput : task.output;
    const staleOutputPath = !!(old && previousOutput && targetOutput && !sameOutputPath(previousOutput, targetOutput));
    const compatibleStateVersion = Number(previousState.version || 0) >= 6;
    const nextOutput = targetOutput;
    const reusableCompletedBy = old && ["l3-skill", "control-plane"].includes(old.completed_by || "");
    const reusableDone = old && compatibleStateVersion && sameSkill && sameContract && !staleOutputPath && old.status === "done" && reusableCompletedBy && docExists(previousOutput || task.output);
    const invalidDone = old && old.status === "done" && !reusableDone;
    const skillMismatchDone = old && old.status === "done" && !sameSkill;
    const contractMismatchDone = old && old.status === "done" && sameSkill && !sameContract;
    if (old && old.status === "done" && staleOutputPath) resetStalePath++;
    const reusableFailed = old && sameSkill && sameContract && old.status === "failed";
    const nextStatus = reusableDone ? "done" : reusableFailed ? "failed" : "pending";
    if (reusableDone) reusedDone++;
    if (skillMismatchDone) resetSkillMismatch++;
    if (contractMismatchDone) resetContractMismatch++;
    if (invalidDone) resetDone++;
    nextState.tasks[task.id] = {
      id: task.id,
      kind: task.kind,
      role: task.role || "",
      controlPlaneOnly: !!task.controlPlaneOnly,
      module: task.module,
      relPath: task.relPath,
      deps: Array.isArray(task.deps) ? task.deps : [],
      output: nextOutput,
      boundOutput: rowOutput || "",
      facts: task.facts || {},
      scopeKeys: Array.isArray(task.scopeKeys) ? task.scopeKeys : [],
      serviceRowsHash: task.serviceRowsHash || "",
      needs_review: rowOutput ? false : (sameSkill && old && old.needs_review ? old.needs_review : false),
      l3Skill: task.l3Skill,
      contractHash: currentContractHash,
      status: nextStatus,
      attempts: sameSkill && old && old.attempts ? old.attempts : 0,
      agent: reusableDone || reusableFailed ? (old.agent || "") : "",
      completed_by: reusableDone ? old.completed_by : "",
      started_at: reusableDone || reusableFailed ? (old.started_at || "") : "",
      finished_at: reusableDone || reusableFailed ? (old.finished_at || "") : "",
      error: staleOutputPath ? "reset done: output path changed after canonical rows became available" :
        skillMismatchDone ? `reset done: l3Skill changed from ${old.l3Skill || "<empty>"} to ${task.l3Skill}` :
        contractMismatchDone ? "reset done: L3 contract changed" :
        invalidDone ? "reset fake done: missing or empty output" :
        (reusableFailed && old.error ? old.error : ""),
    };
  }

  fs.mkdirSync(schedulerDir, { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });
  writeJson(zeroFunctionsFile, zero);
  writeJson(businessViewFile, businessView || l3Selection.emptyView(services, functions));
  writeJson(tasksFile, allTasks);
  writeJson(stateFile, nextState);
  return { reusedDone, resetDone, resetSkillMismatch, resetStalePath, resetContractMismatch, contractHash: currentContractHash, concurrency: effectiveConcurrency };
}

function progressBar(done, total, width = 24) {
  const pct = total ? done / total : 1;
  const filled = Math.round(pct * width);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}] ${done}/${total} ${(pct * 100).toFixed(1)}%`;
}

function depsDone(task, state) {
  const deps = Array.isArray(task && task.deps) ? task.deps : [];
  return deps.every((id) => state.tasks && state.tasks[id] && state.tasks[id].status === "done");
}

function initialDispatchSummary(tasks, state, concurrency) {
  const running = Object.values(state.tasks || {}).filter((item) => item.status === "running").length;
  const ready = tasks.filter((task) => {
    if (isControlPlaneOnly(task)) return false;
    const item = state.tasks && state.tasks[task.id];
    const status = item && item.status ? item.status : "pending";
    return status === "pending" && depsDone(task, state);
  }).length;
  const blocked = tasks.filter((task) => {
    if (isControlPlaneOnly(task)) return false;
    const item = state.tasks && state.tasks[task.id];
    const status = item && item.status ? item.status : "pending";
    return status === "pending" && !depsDone(task, state);
  }).length;
  const failed = Object.values(state.tasks || {}).filter((item) => item.status === "failed").length;
  const dispatch = Math.max(0, Math.min(Math.max(1, Math.floor(Number(concurrency) || 1)) - running, ready));
  const hint = dispatch > 0 ? `spawn_exactly_${dispatch}` : (running > 0 ? "wait_running" : "wait_upstream");
  return { running, ready, blocked, failed, dispatch, hint };
}

try {
  requireFile(modulesFile, "run list-services first");
  requireFile(functionsFile, "run repowiki-l2 + merge-knowledge first");
  requireFile(schemaReportFile, "run merge-knowledge first");
  requireFile(completenessFile, "run merge-knowledge first");
  const schemaReport = readJson(schemaReportFile, null);
  if (!schemaReport || schemaReport.status !== "passed") {
    throw new Error(`L2 schema guard failed; fix ${schemaReportFile} before L3`);
  }
  if (Number(schemaReport.schemaVersion || 0) < CURRENT_FACT_SCHEMA_VERSION) {
    throw new Error(`L2 schema report is stale; rerun repowiki-l2.cjs --all and merge-knowledge to refresh ${schemaReportFile}`);
  }
  const completeness = readJson(completenessFile, null);
  if (!completeness || Number(completeness.schemaVersion || 0) < CURRENT_COMPLETENESS_SCHEMA_VERSION) {
    softOrThrowL2Completeness(`L2 completeness report is stale; rerun merge-knowledge to refresh ${completenessFile}`);
  }
  if (!completeness || completeness.status !== "passed") {
    softOrThrowL2Completeness(`L2 completeness failed; fix ${completenessFile} before L3`);
  }

  const modules = readJson(modulesFile, []);
  const services = readJson(path.join(knowledgeDir, "services.json"), []);
  const functions = readJson(functionsFile, []);
  const downstream = readJson(downstreamFile, []);
  const policy = readSelectionPolicy(l3Skill);
  const businessView = l3Selection.selectScope({ services, functions, policy });
  const tasks = buildTasks(modules, businessView.functions.in_scope, downstream);
  const manifestStats = withStateLock(() => writeManifests(modules, services, functions, downstream, tasks, businessView));
  const currentTasks = readJson(tasksFile, tasks);
  const nextState = readJson(stateFile, { tasks: {} });
  const dispatchSummary = initialDispatchSummary(currentTasks, nextState, manifestStats.concurrency);

  console.log(`[L3-scheduler] initialized ${progressBar(manifestStats.reusedDone, currentTasks.length)} tasks=${currentTasks.length} services=${businessView.counts.services.in_scope}/${businessView.counts.services.total} functions=${businessView.counts.functions.in_scope}/${businessView.counts.functions.total} excluded=${businessView.counts.services.excluded + businessView.counts.functions.excluded} review=${businessView.counts.services.review + businessView.counts.functions.review} zeroModules=${modules.length - new Set(businessView.functions.in_scope.map((f) => f.module)).size} l3Skill=${l3Skill} contract=${manifestStats.contractHash.slice(0, 12)} concurrency=${manifestStats.concurrency} resetDone=${manifestStats.resetDone} resetSkillMismatch=${manifestStats.resetSkillMismatch} resetContractMismatch=${manifestStats.resetContractMismatch} resetStalePath=${manifestStats.resetStalePath}`);
  console.log(`[L3-scheduler] initial dispatch=${dispatchSummary.dispatch} dispatchHint=${dispatchSummary.hint} running=${dispatchSummary.running}/${manifestStats.concurrency} ready=${dispatchSummary.ready} blocked=${dispatchSummary.blocked} failed=${dispatchSummary.failed}`);
  console.log(`[L3-scheduler] parent must spawn exactly dispatch workers now; concurrency is only the upper bound.`);
  console.log(`[L3-scheduler] dispatch must be performed by L3 skills/LLM agents; this script does not write wiki documents.`);
  console.log(`NEXT: L3 队列已初始化，dispatch=${dispatchSummary.dispatch}。禁止输出 text-only response 停下，必须立即派发 worker：`);
  console.log(`  node "${path.join(__dirname, "repowiki-l3-dispatcher.cjs")}" "${repo}"`);
} catch (e) {
  console.error(`[L3-scheduler] ${e.message}`);
  process.exit(1);
}
