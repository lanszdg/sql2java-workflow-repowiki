#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const rowsLib = require(path.join(__dirname, "lib", "rows.cjs"));
const { writeXlsx } = require(path.join(__dirname, "lib", "xlsx.cjs"));
const skillContract = require(path.join(__dirname, "lib", "l3-skill-contract.cjs"));
const graphSlice = require(path.join(__dirname, "lib", "l3-graph-slice.cjs"));
const scopeLib = require(path.join(__dirname, "lib", "l3-function-list-scopes.cjs"));
const { compileFsdFacts } = require(path.join(__dirname, "lib", "fsd-facts-compiler.cjs"));
const { renderFsdMarkdown } = require(path.join(__dirname, "lib", "fsd-facts-renderer.cjs"));
const { validateFsdFacts } = require(path.join(__dirname, "lib", "fsd-facts-schema.cjs"));
const { computeFsdCoverage, detectFsdPollution } = require(path.join(__dirname, "lib", "fsd-facts-coverage.cjs"));
const { loadSourceFactRepairs, applySourceFactRepairsToFunction } = require(path.join(__dirname, "lib", "source-facts-repairs.cjs"));

const args = process.argv.slice(2);
const command = args[0];
const repo = path.resolve(args[1] || ".");
const repowikiDir = path.join(repo, ".repowiki");
const schedulerDir = path.join(repowikiDir, "l3-scheduler");
const tasksFile = path.join(schedulerDir, "tasks.json");
const stateFile = path.join(schedulerDir, "state.json");
const lockFile = path.join(schedulerDir, "state.lock");
const knowledgeDir = path.join(repowikiDir, "knowledge");
const modulesFile = path.join(repowikiDir, "modules.json");
const servicesFile = path.join(knowledgeDir, "services.json");
const functionsFile = path.join(knowledgeDir, "functions.json");
const businessViewFile = path.join(schedulerDir, "business-view.json");
const downstreamFile = path.join(knowledgeDir, "downstream.json");
const modelsFile = path.join(knowledgeDir, "models.json");
const tablesFile = path.join(knowledgeDir, "tables.json");
const callgraphFile = path.join(knowledgeDir, "callgraph.json");
const entitiesFile = path.join(knowledgeDir, "entities.json");
const relationsFile = path.join(knowledgeDir, "relations.json");
const expectedFunctionsFile = path.join(knowledgeDir, "expected-functions.json");
const topologyFile = path.join(knowledgeDir, "topology.json");
const sourceFactRepairsFile = path.join(knowledgeDir, "source-facts-repairs.json");
const metadataDir = path.join(schedulerDir, "metadata");
const diagnosticsDir = path.join(schedulerDir, "diagnostics");
const fsdFactsDir = path.join(repowikiDir, "fsd-facts");
const l3DraftsDir = path.join(repowikiDir, "l3-drafts");
const fsdCoverageDir = path.join(metadataDir, "fsd-coverage");
const fsdCoverageSummaryFile = path.join(metadataDir, "fsd-coverage.json");
const MIN_OUTPUT_BYTES = 20;
const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 30000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const RUNNING_STALE_MS = Math.max(60 * 1000, Math.floor(Number(process.env.REPOWIKI_L3_RUNNING_STALE_MS || 10 * 60 * 1000)));

function argValue(name, fallback = "") {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx >= 0 ? (args[idx + 1] || fallback) : fallback;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function requireScheduler() {
  if (!fs.existsSync(tasksFile) || !fs.existsSync(stateFile)) {
    throw new Error("missing L3 scheduler files; run repowiki-l3-scheduler.cjs first");
  }
}

function load() {
  requireScheduler();
  return {
    tasks: readJson(tasksFile, []),
    state: readJson(stateFile, { tasks: {} }),
  };
}

function save(state) {
  state.updated_at = new Date().toISOString();
  writeJson(stateFile, state);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  requireScheduler();
  const fd = acquireStateLock();
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(lockFile); } catch (_) {}
  }
}

function resolveOutput(file) {
  if (!file) return "";
  return path.isAbsolute(file) ? file : path.resolve(repo, file);
}

function outputStatus(file) {
  const output = resolveOutput(file);
  if (!output) return { ok: false, output, reason: "missing output path" };
  if (!fs.existsSync(output)) return { ok: false, output, reason: "output file does not exist" };
  const stat = fs.statSync(output);
  if (!stat.isFile()) return { ok: false, output, reason: "output path is not a file" };
  if (stat.size <= MIN_OUTPUT_BYTES) {
    return { ok: false, output, reason: `output file is too small (${stat.size} bytes)` };
  }
  return { ok: true, output, size: stat.size };
}

function taskCompletionOutput(item) {
  if (item && item.kind === "function-list-scope" && item.facts && item.facts.rowsFile) return item.facts.rowsFile;
  if (item && item.kind === "function-doc" && isFunctionFactsMode(item)) {
    return item.boundOutput || item.finalOutput || item.output || "";
  }
  return item && item.output || "";
}

function isWithinDir(file, dir) {
  if (!file || !dir) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function progressSnapshot(state, tasks = []) {
  const items = Object.values((state && state.tasks) || {});
  const total = items.length;
  const stateDone = items.filter((item) => item.status === "done").length;
  const running = items.filter((item) => item.status === "running").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const pending = items.filter((item) => isClaimableStatus(item.status)).length;
  const realDone = items.filter((item) => item.status === "done" && outputStatus(taskCompletionOutput(item)).ok).length;
  const outputs = items.filter((item) => outputStatus(taskCompletionOutput(item)).ok).length;
  const concurrency = Math.max(1, Math.floor(Number(state.concurrency) || 1));
  const ready = tasks.filter((task) => {
    if (isControlPlaneOnly(task)) return false;
    const item = state.tasks && state.tasks[task.id];
    const status = item && item.status ? item.status : "pending";
    return isClaimableStatus(status) && depsDone(task, state);
  }).length;
  const blocked = tasks.filter((task) => {
    if (isControlPlaneOnly(task)) return false;
    const item = state.tasks && state.tasks[task.id];
    const status = item && item.status ? item.status : "pending";
    return isClaimableStatus(status) && !depsDone(task, state);
  }).length;
  const dispatch = Math.max(0, Math.min(concurrency - running, ready));
  return { total, realDone, outputs, stateDone, running, failed, pending, ready, blocked, concurrency, dispatch };
}

function requireAgent(rawAgent) {
  const agent = String(rawAgent || "").trim();
  if (!agent) throw new Error("missing --agent <name>");
  if (/^agent-\d{8,}$/.test(agent)) throw new Error(`invalid auto-generated agent name: ${agent}`);
  return agent;
}

function runningItems(state) {
  return Object.values(state.tasks || {}).filter((item) => item.status === "running");
}

function repairFakeDone(tasks, state) {
  let changed = false;
  for (const task of tasks) {
    const item = state.tasks && state.tasks[task.id];
    if (!item || item.status !== "done") continue;
    const checked = outputStatus(item.output || task.output);
    if (checked.ok) continue;
    state.tasks[task.id] = {
      ...item,
      output: item.output || task.output || "",
      status: "pending",
      agent: "",
      completed_by: "",
      started_at: "",
      finished_at: "",
      error: `reset fake done: ${checked.reason}`,
    };
    changed = true;
  }
  return changed;
}

function shellQuote(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

function commandSet(task, agent) {
  const done = `node ${shellQuote(__filename)} done ${shellQuote(repo)} --id ${shellQuote(task.id)} --agent ${shellQuote(agent)}`;
  const fail = `node ${shellQuote(__filename)} fail ${shellQuote(repo)} --id ${shellQuote(task.id)} --agent ${shellQuote(agent)} --error ${shellQuote("<ERROR>")}`;
  return { done, fail };
}

function safeName(s) {
  return String(s || "item").replace(/[\\/:*?"<>|#\r\n]+/g, "_").slice(0, 120);
}

function safePathParts(s, fallback = "未分类") {
  const raw = String(s || "").trim() || fallback;
  return raw
    .split(/[\\/]+/)
    .map((part) => safeName(part).trim())
    .filter(Boolean);
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

function metadataPath(task) {
  return path.join(metadataDir, `${safeName(task.id)}.json`);
}

function evidencePath(task) {
  return path.join(metadataDir, `${safeName(task.id)}.evidence.json`);
}

function diagnosticPath(id) {
  return path.join(diagnosticsDir, `${safeName(id)}.validation.json`);
}

function skillDir(l3Skill) {
  return skillContract.skillDir(__dirname, l3Skill || "wiki-l3-icbc");
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (e) { return fallback; }
}

function businessContext(l3Skill) {
  const dir = skillDir(l3Skill);
  const manifest = skillContract.loadManifest(__dirname, l3Skill);
  return {
    l3Skill: l3Skill || "wiki-l3-icbc",
    skillDir: dir,
    skillFile: path.join(dir, "SKILL.md"),
    templatesDir: path.join(dir, "templates"),
    rulesDir: path.join(dir, "rules"),
    manifest,
    // 语义校验口径由 skill 声明（不写死中文）：default 为空；wiki-l3-icbc 声明 {localeRequire:"zh"}
    validation: readJsonSafe(path.join(dir, "validation.json"), {}),
    templateByKind: {
      "service-list": "服务清单.columns.conf",
      "function-list": "功能清单.columns.conf",
      "function-doc": "功能文档.md",
      "function-doc-guide": "功能文档说明.md",
    },
    instruction: "Read these business skill files and apply their templates/rules when generating the claimed task.",
  };
}

function appName() {
  return skillContract.appName(repo, skillContract.loadManifest(__dirname, ""));
}

function manifestForSkill(l3Skill) {
  return skillContract.loadManifest(__dirname, l3Skill);
}

function docsDirForSkill(l3Skill) {
  return skillContract.docsDir(repo, manifestForSkill(l3Skill));
}

function serviceListColumns(l3Skill) {
  return path.join(skillDir(l3Skill), "templates", "服务清单.columns.conf");
}

function functionListColumns(l3Skill) {
  return path.join(skillDir(l3Skill), "templates", "功能清单.columns.conf");
}

function inferSkillFromRowsFile(rowsFile) {
  const resolved = path.resolve(String(rowsFile || ""));
  const tasks = readJson(tasksFile, []);
  const hit = Array.isArray(tasks)
    ? tasks.find((task) => task && path.resolve(String(task.output || "")) === resolved)
    : null;
  return (hit && hit.l3Skill) || "";
}

function serviceRowsFileFrom(tasks) {
  const sl = (tasks || []).find((t) => t.id === "l3__service-list");
  return sl ? resolveOutput(sl.output) : "";
}

function functionListAnchor(tasks) {
  return (tasks || []).find((t) => t.id === "l3__function-list") || null;
}

function functionListScopeTasks(tasks) {
  return (tasks || []).filter((t) => t && t.kind === "function-list-scope");
}

function isControlPlaneOnly(task) {
  return !!(task && task.controlPlaneOnly);
}

function serviceRowsFrom(tasks) {
  const rowsFile = serviceRowsFileFrom(tasks);
  return readJsonSafe(rowsFile, null);
}

function businessView() {
  return readJsonSafe(businessViewFile, null);
}

function scopedServices(view, services) {
  return view && view.services && Array.isArray(view.services.in_scope) ? view.services.in_scope : services;
}

function scopedFunctions(view, functions) {
  const inScope = view && view.functions && Array.isArray(view.functions.in_scope) ? view.functions.in_scope : functions;
  if (!Array.isArray(inScope)) return inScope;
  const seen = new Set();
  return inScope.filter((fn) => {
    if (!fn || !fn.impl_qn || !fn.method) return true;
    const key = `${fn.impl_qn}::${fn.method}::${fn.signature}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findServiceRowForFunction(row, serviceRows) {
  if (!Array.isArray(serviceRows)) return null;
  if (row && row.service_id) {
    const byId = serviceRows.find((svc) => svc && svc.service_id && svc.service_id === row.service_id);
    if (byId) return byId;
  }
  const matches = serviceRows.filter((svc) =>
    svc &&
    row &&
    moduleMatches(row.module, svc.module) &&
    row.impl_qn === svc.impl_qn &&
    (!row.iface_qn || !svc.iface_qn || row.iface_qn === svc.iface_qn)
  );
  if (matches.length === 1) return matches[0];
  const byIface = serviceRows.filter((svc) =>
    svc &&
    row &&
    moduleMatches(row.module, svc.module) &&
    row.iface_qn &&
    svc.iface_qn &&
    row.iface_qn === svc.iface_qn
  );
  return byIface.length === 1 ? byIface[0] : null;
}

function exportRows(rowsFile, columnsFile, titleFallback, baseName) {
  if (!fs.existsSync(columnsFile)) return { ok: false, reason: `missing columns.conf: ${columnsFile}` };
  const rows = readJsonSafe(rowsFile, null);
  if (!Array.isArray(rows)) return { ok: false, reason: "rows file is not a JSON array" };
  const columnsConf = fs.readFileSync(columnsFile, "utf8");
  const l3Skill = inferSkillFromRowsFile(rowsFile);
  const manifest = manifestForSkill(l3Skill);
  const app = skillContract.appName(repo, manifest);
  const proj = rowsLib.projectRows(rows, columnsConf, app);
  const dir = path.dirname(rowsFile);
  const outBase = skillContract.outputBaseName(baseName === "服务清单" ? "service-list" : "function-list", app, manifest) || `${app}-${baseName}`;
  const outMd = path.join(dir, `${outBase}.md`);
  const outCsv = path.join(dir, `${outBase}.csv`);
  const outXlsx = path.join(dir, `${outBase}.xlsx`);
  fs.writeFileSync(outMd, rowsLib.toMarkdown(proj.title || titleFallback, proj.headers, proj.matrix), "utf8");
  fs.writeFileSync(outCsv, rowsLib.toCsv(proj.headers, proj.matrix), "utf8");
  try { writeXlsx(outXlsx, proj.title || titleFallback, proj.headers, proj.matrix); } catch (e) { /* xlsx 失败不阻塞 MD/CSV */ }
  return { ok: true, md: outMd, csv: outCsv, xlsx: outXlsx, rows: rows.length };
}

function scriptResidueTargets() {
  return [
    repo,
    skillContract.docsDir(repo, manifestForSkill("")),
  ];
}

function scriptLooksGenerated(file) {
  const name = path.basename(file);
  if (/(generate|gen|function|func|service|list|rows|csv|xlsx)/i.test(name)) return true;
  try {
    const text = fs.readFileSync(file, "utf8").slice(0, 8192);
    return /(generate|gen|function|func|service|list|rows|csv|xlsx)/i.test(text);
  } catch (_) {
    return false;
  }
}

function rejectStrayGenerationScript(item) {
  const started = Date.parse(item && item.started_at || "");
  if (!Number.isFinite(started)) return "";
  const exts = new Set([".js", ".cjs", ".mjs", ".py"]);
  for (const dir of scriptResidueTargets()) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      let stat = null;
      try { stat = fs.statSync(file); } catch (_) { continue; }
      if (!stat.isFile() || !exts.has(path.extname(name).toLowerCase())) continue;
      if (stat.mtimeMs + 1000 < started) continue;
      if (scriptLooksGenerated(file)) {
        return `stray generation script after task start: ${path.relative(repo, file)}`;
      }
    }
  }
  return "";
}

// service-list 闸门 + 确定性导出：校验 service canonical rows，再投影 MD/CSV（同源）。
function finalizeServiceList(item) {
  const rowsFile = resolveOutput(item.output);
  const rows = readJsonSafe(rowsFile, null);
  if (!Array.isArray(rows)) return { ok: false, reason: "service rows file is not a JSON array" };

  const services = readJson(servicesFile, []);
  const view = businessView();
  const inScopeServices = scopedServices(view, services);
  const columnsFile = serviceListColumns(item.l3Skill || "");
  const validation = readJsonSafe(path.join(skillDir(item.l3Skill || ""), "validation.json"), {});
  const v = rowsLib.validateServiceRows(rows, { servicesCount: inScopeServices.length, services: inScopeServices, allServices: services, allFunctions: readJson(functionsFile, []), view, validation });
  if (!v.ok) {
    const head = v.errors.slice(0, 3).join(" | ");
    return { ok: false, reason: `service rows invalid: ${head}${v.errors.length > 3 ? ` (+${v.errors.length - 3} more)` : ""}` };
  }
  const reviewed = applyServiceReviewReasons(rows, v.softByRow, inScopeServices);
  if (reviewed.changed) writeJson(rowsFile, reviewed.rows);
  const stray = rejectStrayGenerationScript(item);
  if (stray) return { ok: false, reason: stray };
  return exportRows(rowsFile, columnsFile, "服务清单", "服务清单");
}

// function-list 闸门 + 确定性导出：校验 canonical rows，再投影 MD/CSV（同源）。脚本不产语义，只投影。
function finalizeFunctionList(item, tasks) {
  const rowsFile = resolveOutput(item.output);
  const rows = readJsonSafe(rowsFile, null);
  if (!Array.isArray(rows)) return { ok: false, reason: "function rows file is not a JSON array" };

  const functions = readJson(functionsFile, []);
  const services = readJson(servicesFile, []);
  const view = businessView();
  const inScopeFunctions = scopedFunctions(view, functions);
  const columnsFile = functionListColumns(item.l3Skill || "");
  if (!fs.existsSync(columnsFile)) return { ok: false, reason: `missing columns.conf: ${columnsFile}` };
  const validation = readJsonSafe(path.join(skillDir(item.l3Skill || ""), "validation.json"), {});
  const serviceRows = serviceRowsFrom(tasks);
  if (validation.requireServiceRowReference && !Array.isArray(serviceRows)) {
    return { ok: false, reason: "service rows file is unreadable; function-list must wait for service-list gate" };
  }

  const v = rowsLib.validateFunctionRows(rows, { functionsCount: inScopeFunctions.length, functions: inScopeFunctions, allServices: services, allFunctions: functions, view, serviceRows, validation });
  if (!v.ok) {
    const maxErrors = Math.max(1, Math.floor(Number(validation.maxValidationErrors || 20)));
    const shown = v.errors.slice(0, maxErrors);
    const head = shown.slice(0, 3).join(" | ");
    return {
      ok: false,
      reason: `rows invalid: ${head}${v.errors.length > 3 ? ` (+${v.errors.length - 3} more)` : ""}`,
      errors: shown,
      totalErrors: v.errors.length,
      maxAttempts: Math.max(1, Math.floor(Number(validation.maxAttempts || 2))),
    };
  }

  const reviewed = applyReviewReasons(rows, v.softByRow, inScopeFunctions);
  if (reviewed.changed) {
    writeJson(rowsFile, reviewed.rows);
  }
  const stray = rejectStrayGenerationScript(item);
  if (stray) return { ok: false, reason: stray };
  return exportRows(rowsFile, columnsFile, "功能清单", "功能清单");
}

function finalizeFunctionListScope(item) {
  const evidenceFile = item.facts && item.facts.evidenceFile || "";
  const evidence = readJsonSafe(evidenceFile, null);
  if (!evidence || !Array.isArray(evidence.functions)) return { ok: false, reason: `function-list-scope evidence is unreadable: ${evidenceFile}` };
  const assembled = assembleScopeRows(item, evidence);
  if (!assembled.ok) return assembled;
  const rowsFile = assembled.rowsFile;
  const rows = assembled.rows;
  const validation = readJsonSafe(path.join(skillDir(item.l3Skill || ""), "validation.json"), {});
  const serviceRowsFile = evidence.serviceRowsFile || serviceRowsFileFrom(readJson(tasksFile, []));
  const serviceRows = readJsonSafe(serviceRowsFile, []);
  if (validation.requireServiceRowReference && !Array.isArray(serviceRows)) {
    return { ok: false, reason: "service rows file is unreadable; function-list-scope must wait for service-list gate" };
  }
  const result = rowsLib.validateFunctionRows(rows, {
    functionsCount: evidence.functions.length,
    functions: evidence.functions,
    serviceRows,
    validation,
  });
  if (!result.ok) {
    const maxErrors = Math.max(1, Math.floor(Number(validation.maxValidationErrors || 20)));
    const shown = result.errors.slice(0, maxErrors);
    return {
      ok: false,
      reason: `scope rows invalid: ${shown.slice(0, 3).join(" | ")}${result.errors.length > 3 ? ` (+${result.errors.length - 3} more)` : ""}`,
      errors: shown,
      totalErrors: result.errors.length,
      maxAttempts: Math.max(1, Math.floor(Number(validation.maxAttempts || 2))),
    };
  }
  const reviewed = applyReviewReasons(rows, result.softByRow, evidence.functions);
  if (reviewed.changed) writeJson(rowsFile, reviewed.rows);
  const stray = rejectStrayGenerationScript(item);
  if (stray) return { ok: false, reason: stray, maxAttempts: Math.max(1, Math.floor(Number(validation.maxAttempts || 2))) };
  return { ok: true, rows: rows.length };
}

function scopeRowsOutputFile(item, evidence) {
  const explicit = item && item.facts && item.facts.rowsFile || evidence && evidence.outputContract && evidence.outputContract.assembledRowsFile || "";
  if (explicit) return resolveOutput(explicit);
  const namesFile = resolveOutput(item && item.output || "");
  if (/\.names\.json$/i.test(namesFile)) return namesFile.replace(/\.names\.json$/i, ".rows.json");
  return namesFile;
}

function safeUnlinkOutput(file, item) {
  const output = resolveOutput(file || "");
  if (!output || !/\.json$/i.test(output)) return false;
  if (!isWithinDir(output, docsDirForSkill(item && item.l3Skill || ""))) return false;
  try {
    if (fs.existsSync(output)) {
      fs.unlinkSync(output);
      return true;
    }
  } catch (_) {
    return false;
  }
  return false;
}

function cleanupScopeRowsSidecar(item, evidence) {
  const rowsFile = scopeRowsOutputFile(item, evidence);
  if (!/\.rows\.json$/i.test(rowsFile || "")) return false;
  return safeUnlinkOutput(rowsFile, item);
}

function readScopeNamesMap(item) {
  const file = resolveOutput(item && item.output || "");
  const data = readJsonSafe(file, null);
  if (!data || Array.isArray(data) || typeof data !== "object") {
    return { ok: false, names: null, errors: ["names file must be a JSON object keyed by function_id"] };
  }
  if (data.names && typeof data.names === "object") {
    return { ok: false, names: null, errors: ["names file must not wrap entries in a names field"] };
  }
  return { ok: true, names: data, errors: [] };
}

function semanticPatchFromValue(value) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    function_name: String(v.function_name || "").trim(),
    summary: String(v.summary || "").trim(),
    business_domain: String(v.business_domain || "").trim(),
    review_required: !!v.review_required,
    review_reasons: mergeReviewReasons(v.review_reasons, []),
  };
}

function validateNamesMap(names, skeletons) {
  const errors = [];
  const allowed = new Set(["function_name", "summary", "business_domain", "review_required", "review_reasons"]);
  const expected = new Set((skeletons || []).map((row) => row.function_id).filter(Boolean));
  if (names && typeof names === "object") {
    for (const key of Object.keys(names)) {
      if (!expected.has(key)) errors.push(`unexpected names key ${key}`);
      const value = names[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${key}: value must be an object with function_name and summary`);
        continue;
      }
      for (const field of Object.keys(value)) {
        if (!allowed.has(field)) errors.push(`${key}: field ${field} is not allowed in names map`);
      }
      const functionName = String(value.function_name || "").trim();
      if (functionName && !/[\u4e00-\u9fff]/.test(functionName)) {
        errors.push(`${key}: function_name contains raw English identifier`);
      }
    }
  }
  for (const id of expected) {
    if (!Object.prototype.hasOwnProperty.call(names || {}, id)) errors.push(`missing names key ${id}`);
  }
  return errors;
}

function semanticPatchForSkeleton(names, skeleton) {
  return semanticPatchFromValue(names && names[skeleton.function_id] || null);
}

function assembleScopeRows(item, evidence) {
  const namesRead = readScopeNamesMap(item);
  const skeletons = Array.isArray(evidence.rowSkeletons) && evidence.rowSkeletons.length === evidence.functions.length
    ? evidence.rowSkeletons
    : scopeRowSkeletons(evidence.functions, item.l3Skill || "");
  if (!namesRead.ok) {
    return {
      ok: false,
      reason: namesRead.errors[0] || "function-list-scope names file is invalid",
      errors: namesRead.errors,
      totalErrors: namesRead.errors.length,
      maxAttempts: Math.max(1, Math.floor(Number(readJsonSafe(path.join(skillDir(item.l3Skill || ""), "validation.json"), {}).maxAttempts || 2))),
    };
  }
  const names = namesRead.names;
  const shapeErrors = validateNamesMap(names, skeletons);
  if (shapeErrors.length) {
    return {
      ok: false,
      reason: `names map invalid: ${shapeErrors.slice(0, 3).join(" | ")}${shapeErrors.length > 3 ? ` (+${shapeErrors.length - 3} more)` : ""}`,
      errors: shapeErrors,
      totalErrors: shapeErrors.length,
      maxAttempts: Math.max(1, Math.floor(Number(readJsonSafe(path.join(skillDir(item.l3Skill || ""), "validation.json"), {}).maxAttempts || 2))),
    };
  }
  const missing = [];
  const rows = skeletons.map((skeleton, index) => {
    const semantic = semanticPatchForSkeleton(names, skeleton);
    if (!semantic.function_name || !semantic.summary) missing.push(skeleton.function_id || `${index}`);
    const reviewReasons = mergeReviewReasons(skeleton.review_reasons, semantic.review_reasons);
    return {
      ...skeleton,
      business_domain: semantic.business_domain || skeleton.business_domain || "",
      function_name: semantic.function_name,
      summary: semantic.summary,
      review_required: !!(skeleton.review_required || semantic.review_required || reviewReasons.length),
      review_reasons: reviewReasons,
      semantic_hints: undefined,
    };
  });
  if (missing.length) {
    return {
      ok: false,
      reason: `names map missing function_name/summary for ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ""}`,
      errors: missing.map((id) => `missing semantic fields for ${id}`),
      totalErrors: missing.length,
      maxAttempts: Math.max(1, Math.floor(Number(readJsonSafe(path.join(skillDir(item.l3Skill || ""), "validation.json"), {}).maxAttempts || 2))),
    };
  }
  const rowsFile = scopeRowsOutputFile(item, evidence);
  fs.mkdirSync(path.dirname(rowsFile), { recursive: true });
  writeJson(rowsFile, rows);
  return { ok: true, rows, rowsFile };
}

function duplicateErrorsOnly(fin) {
  const errors = Array.isArray(fin && fin.errors) ? fin.errors : [];
  return errors.length > 0 && errors.every((e) => String(e).includes("duplicate function doc name"));
}

function fallbackSuffixForRow(row, index) {
  const sig = String(row && row.signature || "");
  const params = sig.includes("(") ? sig.slice(sig.indexOf("(") + 1, sig.lastIndexOf(")")) : "";
  const firstParam = params.split(",").map((x) => x.trim()).filter(Boolean)[0] || "";
  const simple = simpleName(firstParam.split(/\s+/)[0] || "");
  if (simple) return `（入参${simple}）`;
  return `（签名${shortHash(sig || `${row && row.impl_qn}.${row && row.method}.${index}`)}）`;
}

function applyDeterministicDedupeFallback(rows) {
  const groups = new Map();
  const next = (Array.isArray(rows) ? rows : []).map((row) => ({ ...(row || {}) }));
  next.forEach((row, index) => {
    const key = `${String(row.business_name || "").trim()}\\${String(row.function_name || "").trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });
  let changed = false;
  for (const indexes of groups.values()) {
    if (indexes.length <= 1) continue;
    indexes.forEach((rowIndex, groupIndex) => {
      if (groupIndex === 0) return;
      const row = next[rowIndex];
      row.function_name = `${String(row.function_name || row.method || "功能").trim()}${fallbackSuffixForRow(row, rowIndex)}`;
      row.review_required = true;
      row.review_reasons = mergeReviewReasons(row.review_reasons, ["deterministic_dedupe_fallback"]);
      changed = true;
    });
  }
  return { rows: next, changed };
}

function writeScopeNamesMapFromRows(item, rows) {
  const current = readScopeNamesMap(item);
  if (!current.ok) return { ok: false, reason: current.errors[0] || "names map is unreadable" };
  const names = { ...(current.names || {}) };
  for (const row of rows || []) {
    const id = row && row.function_id || "";
    if (!id || !names[id]) continue;
    names[id] = {
      ...(names[id] || {}),
      function_name: row.function_name || names[id].function_name || "",
      summary: row.summary || names[id].summary || "",
      business_domain: row.business_domain || names[id].business_domain || "",
      review_required: !!(row.review_required || names[id].review_required),
      review_reasons: mergeReviewReasons(names[id].review_reasons, row.review_reasons),
    };
  }
  writeJson(resolveOutput(item && item.output || ""), names);
  return { ok: true };
}

function tryDedupeFallbackForScope(item, fin) {
  if (!duplicateErrorsOnly(fin)) return null;
  const maxAttempts = Math.max(1, Math.floor(Number((fin && fin.maxAttempts) || 2)));
  const attempts = Math.max(0, Math.floor(Number((item && item.attempts) || 0)));
  if (attempts < maxAttempts) return null;
  const evidence = readJsonSafe(item && item.facts && item.facts.evidenceFile || "", null);
  const rowsFile = scopeRowsOutputFile(item, evidence);
  const rows = readJsonSafe(rowsFile, null);
  if (!Array.isArray(rows)) return null;
  const patched = applyDeterministicDedupeFallback(rows);
  if (!patched.changed) return null;
  const namesWritten = writeScopeNamesMapFromRows(item, patched.rows);
  if (!namesWritten.ok) return null;
  writeJson(rowsFile, patched.rows);
  const retry = finalizeFunctionListScope(item);
  return retry.ok ? { ok: true, fallbackApplied: true } : null;
}

function completeScopeByControlPlane(state, task, item) {
  state.tasks[task.id] = {
    ...item,
    status: "done",
    agent: item.agent || "control-plane",
    completed_by: "control-plane",
    finished_at: new Date().toISOString(),
    error: "",
  };
}

function finalizeScopeWithFallback(item) {
  const fin = finalizeFunctionListScope(item);
  if (fin.ok) return { ok: true, fin };
  const fallback = tryDedupeFallbackForScope(item, fin);
  if (fallback && fallback.ok) return { ok: true, fin, fallbackApplied: true };
  return { ok: false, fin };
}

function repairFailedFunctionListScopes(tasks, state) {
  let changed = false;
  for (const task of functionListScopeTasks(tasks)) {
    const item = state.tasks && state.tasks[task.id];
    if (!item || item.status !== "failed") continue;
    const mergedItem = { ...task, ...item, facts: { ...(task.facts || {}), ...(item.facts || {}) } };
    const result = finalizeScopeWithFallback(mergedItem);
    if (!result.ok) {
      cleanupScopeRowsSidecar(mergedItem, readJsonSafe(mergedItem.facts && mergedItem.facts.evidenceFile || "", null));
      continue;
    }
    completeScopeByControlPlane(state, task, item);
    changed = true;
  }
  if (changed) tryFinalizeFunctionListMerge(tasks, state);
  return changed;
}

function tryFinalizeFunctionListMerge(tasks, state) {
  const anchorTask = functionListAnchor(tasks);
  if (!anchorTask) return { changed: false, ok: false, reason: "function-list anchor missing" };
  const anchorItem = state.tasks && state.tasks["l3__function-list"];
  if (!anchorItem || anchorItem.status === "done") return { changed: false, ok: true };
  const scopes = functionListScopeTasks(tasks);
  if (!scopes.length) return { changed: false, ok: false, reason: "function-list scopes not materialized" };
  const notDone = scopes.filter((task) => {
    const item = state.tasks && state.tasks[task.id];
    return !item || item.status !== "done";
  });
  if (notDone.length) return { changed: false, ok: false, reason: `waiting for ${notDone.length} function-list-scope task(s)` };

  const allRows = [];
  const rowScopeIds = [];
  for (const task of scopes.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const item = state.tasks && state.tasks[task.id];
    const evidence = readJsonSafe(task && task.facts && task.facts.evidenceFile || item && item.facts && item.facts.evidenceFile || "", null);
    const rowsFile = scopeRowsOutputFile({ ...task, ...item, facts: { ...(task.facts || {}), ...(item && item.facts || {}) } }, evidence);
    const rows = readJsonSafe(rowsFile, null);
    if (!Array.isArray(rows)) {
      state.tasks[task.id] = {
        ...item,
        status: "pending",
        agent: "",
        completed_by: "",
        started_at: "",
        finished_at: "",
        error: "reset by function-list merge: scope rows missing or invalid",
      };
      return { changed: true, ok: false, reason: `scope rows missing: ${task.id}` };
    }
    for (const row of rows) {
      allRows.push(row);
      rowScopeIds.push(task.id);
    }
  }

  const rowsFile = resolveOutput(anchorTask.output || anchorItem.output);
  fs.mkdirSync(path.dirname(rowsFile), { recursive: true });
  writeJson(rowsFile, allRows);
  const fin = finalizeFunctionList({ ...anchorTask, ...anchorItem, output: rowsFile }, tasks);
  if (!fin.ok) {
    const rowIndexes = [];
    for (const error of fin.errors || []) {
      const m = String(error).match(/row\[(\d+)\]/);
      if (m) rowIndexes.push(Number(m[1]));
    }
    const resetScopeIds = Array.from(new Set(rowIndexes.map((i) => rowScopeIds[i]).filter(Boolean)));
    for (const scopeId of resetScopeIds) {
      const scopeItem = state.tasks && state.tasks[scopeId];
      if (!scopeItem) continue;
      state.tasks[scopeId] = {
        ...scopeItem,
        status: "pending",
        agent: "",
        completed_by: "",
        started_at: "",
        finished_at: "",
        error: `reset by function-list merge gate: ${fin.reason}`,
      };
    }
    state.tasks["l3__function-list"] = {
      ...anchorItem,
      status: "pending",
      agent: "",
      completed_by: "",
      started_at: "",
      finished_at: "",
      error: `merge rejected: ${fin.reason}`,
    };
    writeValidationDiagnostic("l3__function-list", anchorItem, fin, "pending");
    return { changed: true, ok: false, reason: fin.reason };
  }
  state.tasks["l3__function-list"] = {
    ...anchorItem,
    id: "l3__function-list",
    kind: "function-list",
    role: "function-list-merge",
    controlPlaneOnly: true,
    output: rowsFile,
    status: "done",
    agent: "control-plane",
    completed_by: "control-plane",
    started_at: anchorItem.started_at || "",
    finished_at: new Date().toISOString(),
    error: "",
  };
  return { changed: true, ok: true };
}

function parseIsoMs(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? t : 0;
}

function reaperNextState(item, fin, reasonPrefix) {
  return {
    ...item,
    status: "pending",
    agent: "",
    completed_by: "",
    started_at: "",
    finished_at: "",
    error: `${reasonPrefix}: ${fin && fin.reason || "running task did not complete"}`,
  };
}

function reapStaleFunctionListScopes(tasks, state) {
  let changed = false;
  const now = Date.now();
  for (const task of functionListScopeTasks(tasks)) {
    const item = state.tasks && state.tasks[task.id];
    if (!item || item.status !== "running") continue;
    const started = parseIsoMs(item.started_at);
    if (!started || now - started < RUNNING_STALE_MS) continue;
    const mergedItem = { ...task, ...item, facts: { ...(task.facts || {}), ...(item.facts || {}) } };
    const fin = finalizeFunctionListScope(mergedItem);
    if (fin.ok) {
      state.tasks[task.id] = {
        ...item,
        status: "done",
        agent: item.agent || "control-plane",
        completed_by: "control-plane",
        finished_at: new Date().toISOString(),
        error: "",
      };
      changed = true;
      continue;
    }
    const fallback = tryDedupeFallbackForScope(mergedItem, fin);
    if (fallback && fallback.ok) {
      state.tasks[task.id] = {
        ...item,
        status: "done",
        agent: item.agent || "control-plane",
        completed_by: "control-plane",
        finished_at: new Date().toISOString(),
        error: "",
      };
      changed = true;
      continue;
    }
    const nextItem = reaperNextState(item, fin, "reaper reset stale running function-list-scope");
    const mergedItemForCleanup = { ...task, ...item, facts: { ...(task.facts || {}), ...(item.facts || {}) } };
    cleanupScopeRowsSidecar(mergedItemForCleanup, readJsonSafe(mergedItemForCleanup.facts && mergedItemForCleanup.facts.evidenceFile || "", null));
    state.tasks[task.id] = nextItem;
    writeValidationDiagnostic(task.id, item, fin, "pending");
    changed = true;
  }
  if (changed) tryFinalizeFunctionListMerge(tasks, state);
  return changed;
}

function reapStaleFunctionDocs(tasks, state) {
  let changed = false;
  const now = Date.now();
  for (const task of tasks) {
    if (!task || task.kind !== "function-doc") continue;
    const item = state.tasks && state.tasks[task.id];
    if (!item || item.status !== "running") continue;
    const started = parseIsoMs(item.started_at);
    if (!started || now - started < RUNNING_STALE_MS) continue;
    const boundTask = bindFunctionDocOutput(task, item, tasks);
    const mergedItem = {
      ...item,
      output: boundTask.output || item.output || "",
      boundOutput: boundTask.boundOutput || item.boundOutput || "",
      needs_review: !!(boundTask.needs_review || item.needs_review),
    };
    const fin = finalizeFunctionDoc(mergedItem, boundTask, tasks);
    if (fin.ok) {
      let published = null;
      if (isFunctionFactsMode(mergedItem)) {
        published = publishFunctionDocDraft(mergedItem, boundTask);
        if (!published.ok) {
          const finPublish = { ok: false, reason: published.reason || "publish final output failed" };
          state.tasks[task.id] = {
            ...item,
            output: mergedItem.output,
            boundOutput: mergedItem.boundOutput,
            needs_review: !!mergedItem.needs_review,
            status: "pending",
            agent: "",
            completed_by: "",
            started_at: "",
            finished_at: "",
            error: `reaper publish failed for stale running function-doc: ${finPublish.reason}`,
          };
          writeValidationDiagnostic(task.id, item, finPublish, "pending");
          changed = true;
          continue;
        }
      }
      state.tasks[task.id] = {
        ...item,
        output: mergedItem.output,
        boundOutput: (published && published.finalOutput) || mergedItem.boundOutput,
        finalOutput: (published && published.finalOutput) || mergedItem.finalOutput || mergedItem.boundOutput,
        needs_review: false,
        status: "done",
        agent: item.agent || "control-plane",
        completed_by: "control-plane",
        finished_at: new Date().toISOString(),
        error: "",
      };
      changed = true;
      continue;
    }
    state.tasks[task.id] = {
      ...item,
      output: mergedItem.output,
      boundOutput: mergedItem.boundOutput,
      needs_review: !!mergedItem.needs_review,
      status: "pending",
      agent: "",
      completed_by: "",
      started_at: "",
      finished_at: "",
      error: `reaper reset stale running function-doc: ${fin.reason || "output invalid or missing"}`,
    };
    writeValidationDiagnostic(task.id, item, fin, "pending");
    changed = true;
  }
  return changed;
}

function repairFakeDoneFunctionDocs(tasks, state) {
  let changed = false;
  for (const task of tasks) {
    if (!task || task.kind !== "function-doc") continue;
    const item = state.tasks && state.tasks[task.id];
    if (!item || item.status !== "done") continue;
    const boundTask = bindFunctionDocOutput(task, item, tasks);
    const mergedItem = {
      ...item,
      output: boundTask.output || item.output || "",
      boundOutput: boundTask.boundOutput || item.boundOutput || "",
      finalOutput: boundTask.finalOutput || boundTask.boundOutput || item.finalOutput || item.boundOutput || "",
      needs_review: !!(boundTask.needs_review || item.needs_review),
    };
    const finalOutput = finalOutputForFunctionDoc(mergedItem, boundTask);
    if (finalOutput && outputStatus(finalOutput).ok) continue;
    if (!isFunctionFactsMode(mergedItem)) continue;

    const fin = finalizeFunctionDoc(mergedItem, boundTask, tasks);
    if (!fin.ok) {
      state.tasks[task.id] = {
        ...item,
        output: mergedItem.output,
        boundOutput: mergedItem.boundOutput,
        finalOutput: mergedItem.finalOutput,
        status: "pending",
        agent: "",
        completed_by: "",
        started_at: "",
        finished_at: "",
        error: `reaper repaired fake-done to pending: ${fin.reason || "output invalid or missing"}`,
      };
      writeValidationDiagnostic(task.id, item, fin, "pending");
      changed = true;
      continue;
    }

    const published = publishFunctionDocDraft(mergedItem, boundTask);
    if (!published.ok) {
      const finPublish = { ok: false, reason: published.reason || "publish final output failed" };
      state.tasks[task.id] = {
        ...item,
        output: mergedItem.output,
        boundOutput: mergedItem.boundOutput,
        finalOutput: mergedItem.finalOutput,
        status: "pending",
        agent: "",
        completed_by: "",
        started_at: "",
        finished_at: "",
        error: `reaper failed to repair fake-done publish: ${finPublish.reason}`,
      };
      writeValidationDiagnostic(task.id, item, finPublish, "pending");
      changed = true;
      continue;
    }

    state.tasks[task.id] = {
      ...item,
      output: mergedItem.output,
      boundOutput: published.finalOutput,
      finalOutput: published.finalOutput,
      needs_review: false,
      status: "done",
      agent: item.agent || "control-plane",
      completed_by: item.completed_by || "control-plane",
      finished_at: item.finished_at || new Date().toISOString(),
      error: "",
    };
    changed = true;
  }
  return changed;
}

function buildFunctionListEvidencePackForScopes(tasks) {
  const functions = readJson(functionsFile, []);
  const services = readJson(servicesFile, []);
  const view = businessView();
  const inScopeFunctions = scopedFunctions(view, functions);
  const inScopeServices = scopedServices(view, services);
  const serviceRowsFile = serviceRowsFileFrom(tasks);
  const serviceRows = readJsonSafe(serviceRowsFile, []);
  const downstream = readJson(downstreamFile, []);
  const models = readJson(modelsFile, []);
  const tables = readJson(tablesFile, []);
  const callgraph = readJson(callgraphFile, { callees: {}, callers: {} });
  const graphFacts = {
    entities: readJson(entitiesFile, []),
    relations: readJson(relationsFile, []),
    expected: readJson(expectedFunctionsFile, []),
    topology: readJson(topologyFile, {}),
  };
  return {
    serviceRows,
    serviceRowsFile,
    evidence: buildFunctionListEvidence(inScopeFunctions, inScopeServices, serviceRows, downstream, models, tables, callgraph, graphFacts),
  };
}

function writeTasks(tasks) {
  writeJson(tasksFile, tasks);
}

function scopeUsesNamesMapContract(task, state) {
  const item = state && state.tasks && state.tasks[task.id] || {};
  const mergedFacts = { ...(task.facts || {}), ...(item.facts || {}) };
  const output = resolveOutput((item && item.output) || (task && task.output) || "");
  if (!/\.names\.json$/i.test(output)) return false;
  if (!mergedFacts.rowsFile || !/\.rows\.json$/i.test(resolveOutput(mergedFacts.rowsFile))) return false;
  const evidence = readJsonSafe(mergedFacts.evidenceFile || "", null);
  if (!evidence || !evidence.outputContract || evidence.outputContract.kind !== "names-map") return false;
  if (!Array.isArray(evidence.rowSkeletons) || !Array.isArray(evidence.functions)) return false;
  return true;
}

function scopesUseCurrentContract(scopes, state, serviceHash) {
  if (!scopes.length) return false;
  return scopes.every((task) => {
    const item = state && state.tasks && state.tasks[task.id] || {};
    const taskHash = task.serviceRowsHash || item.serviceRowsHash || "";
    return taskHash === serviceHash && scopeUsesNamesMapContract(task, state);
  });
}

function reusableScopeDone(taskId, old, namesOutput, rowsOutput, evidenceFile, serviceHash, l3Skill) {
  if (!old || old.status !== "done" || old.serviceRowsHash !== serviceHash) return false;
  if (resolveOutput(old.output || "") !== resolveOutput(namesOutput)) return false;
  if (!outputStatus(namesOutput).ok) return false;
  const candidate = {
    ...old,
    id: taskId,
    kind: "function-list-scope",
    l3Skill: l3Skill || "",
    output: namesOutput,
    facts: { ...(old.facts || {}), evidenceFile, rowsFile: rowsOutput },
    serviceRowsHash: serviceHash,
  };
  return !!finalizeFunctionListScope(candidate).ok;
}

function materializeFunctionListScopesIfReady(tasks, state) {
  const anchor = functionListAnchor(tasks);
  const serviceItem = state.tasks && state.tasks["l3__service-list"];
  if (!anchor || !serviceItem || serviceItem.status !== "done") return { changed: false, tasks };
  const serviceRows = serviceRowsFrom(tasks);
  if (!Array.isArray(serviceRows)) return { changed: false, tasks };
  const serviceHash = scopeLib.serviceRowsHash(serviceRows);
  const existingScopes = functionListScopeTasks(tasks);
  if (scopesUseCurrentContract(existingScopes, state, serviceHash)) return { changed: false, tasks };

  const { evidence, serviceRowsFile } = buildFunctionListEvidencePackForScopes(tasks);
  const packs = scopeLib.buildScopePacks(evidence);
  const manifest = manifestForSkill(anchor.l3Skill || "");
  const docsDir = skillContract.docsDir(repo, manifest);
  const nextTasks = tasks.filter((task) => task.kind !== "function-list-scope");
  const nextScopeIds = new Set();

  for (const pack of packs) {
    const taskId = scopeLib.scopeTaskId(pack);
    nextScopeIds.add(taskId);
    const namesOutput = scopeLib.scopeNamesFile(docsDir, pack);
    const rowsOutput = scopeLib.scopeRowsFile(docsDir, pack);
    const evidenceFile = scopeLib.scopeEvidenceFile(schedulerDir, pack);
    fs.mkdirSync(path.dirname(namesOutput), { recursive: true });
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
    const rowSkeletons = scopeRowSkeletons(pack.functions, anchor.l3Skill || "");
    writeJson(evidenceFile, {
      schemaVersion: 2,
      generated_at: new Date().toISOString(),
      repo,
      serviceRowsHash: serviceHash,
      serviceRowsFile,
      count: pack.functions.length,
      scopeKeys: pack.scopeKeys,
      scopes: pack.scopes,
      uniquenessScopes: pack.scopes.map((scope) => ({
        key: scope.key,
        business_name: scope.key,
        count: scope.count,
        functions: pack.functions.filter((fn) => scopeLib.functionScopeKey(fn) === scope.key).map(scopeFunctionSummary),
      })),
      outputContract: {
        kind: "names-map",
        outputNamesFile: namesOutput,
        assembledRowsFile: rowsOutput,
        requiredShape: {
          "<function_id>": {
            function_name: "中文业务功能名",
            summary: "中文功能概述",
            business_domain: "可选，缺省继承服务分类",
          },
        },
      },
      rowSkeletons,
      functions: pack.functions,
    });
    nextTasks.push({
      id: taskId,
      kind: "function-list-scope",
      role: "function-list-scope",
      status: "pending",
      l3Skill: anchor.l3Skill || "",
      module: "",
      relPath: scopeLib.scopeDisplayName(pack),
      deps: ["l3__service-list"],
      output: namesOutput,
      facts: { contextFile: "", evidenceFile, rowsFile: rowsOutput },
      scopeKeys: pack.scopeKeys,
      serviceRowsHash: serviceHash,
    });
    const old = state.tasks && state.tasks[taskId];
    const reusable = reusableScopeDone(taskId, old, namesOutput, rowsOutput, evidenceFile, serviceHash, anchor.l3Skill || "");
    state.tasks[taskId] = {
      id: taskId,
      kind: "function-list-scope",
      role: "function-list-scope",
      module: "",
      relPath: scopeLib.scopeDisplayName(pack),
      deps: ["l3__service-list"],
      output: namesOutput,
      facts: { contextFile: "", evidenceFile, rowsFile: rowsOutput },
      scopeKeys: pack.scopeKeys,
      serviceRowsHash: serviceHash,
      l3Skill: anchor.l3Skill || "",
      contractHash: state.contractHash || "",
      status: reusable ? "done" : "pending",
      attempts: reusable ? (old.attempts || 0) : 0,
      agent: reusable ? (old.agent || "") : "",
      completed_by: reusable ? (old.completed_by || "l3-skill") : "",
      started_at: reusable ? (old.started_at || "") : "",
      finished_at: reusable ? (old.finished_at || "") : "",
      error: "",
    };
  }

  for (const [taskId, item] of Object.entries(state.tasks || {})) {
    if (item && item.kind === "function-list-scope" && !nextScopeIds.has(taskId)) {
      delete state.tasks[taskId];
    }
  }

  const anchorItem = state.tasks && state.tasks["l3__function-list"];
  if (anchorItem) {
    state.tasks["l3__function-list"] = {
      ...anchorItem,
      status: "pending",
      agent: "",
      completed_by: "",
      started_at: "",
      finished_at: "",
      error: "pending function-list-scope merge",
    };
  }
  writeTasks(nextTasks);
  return { changed: true, tasks: nextTasks };
}

function validateCurrentFunctionRows(tasks) {
  const functionListTask = (tasks || []).find((t) => t.id === "l3__function-list");
  if (!functionListTask) return { ok: false, reason: "function-list task missing" };
  const rowsFile = resolveOutput(functionListTask.output);
  const rows = readJsonSafe(rowsFile, null);
  if (!Array.isArray(rows)) return { ok: false, reason: "function rows file is not a JSON array" };

  const evidenceFile = path.join(metadataDir, "l3__function-list.evidence.json");
  const evidence = readJsonSafe(evidenceFile, null);
  const evidenceModuleMap = {};
  if (evidence && Array.isArray(evidence.uniquenessScopes)) {
    for (const scope of evidence.uniquenessScopes) {
      if (Array.isArray(scope.functions)) {
        for (const fn of scope.functions) {
          if (fn.impl_qn && fn.method) {
            evidenceModuleMap[`${fn.impl_qn}::${fn.method}`] = fn.module || "";
          }
        }
      }
    }
  }

  const flattenedRows = rows.map((row) => {
    const metaModule = row.metadata?.module || "";
    const evidenceKey = `${row.impl_qn}::${row.method}`;
    const evModule = evidenceModuleMap[evidenceKey] || "";
    return {
      ...row,
      business_name: row.business_name || row.metadata?.business_name || "",
      function_name: row.function_name || row.metadata?.function_name || "",
      summary: row.summary || row.metadata?.summary || "",
      function_type: row.function_type || row.metadata?.function_type || "",
      module: row.module || metaModule || evModule || "",
    };
  });

  const functions = readJson(functionsFile, []);
  const services = readJson(servicesFile, []);
  const view = businessView();
  const inScopeFunctions = scopedFunctions(view, functions);
  const validation = readJsonSafe(path.join(skillDir(functionListTask.l3Skill || ""), "validation.json"), {});
  const serviceRows = serviceRowsFrom(tasks);
  if (validation.requireServiceRowReference && !Array.isArray(serviceRows)) {
    return { ok: false, reason: "service rows file is unreadable; function-list gate is not stable" };
  }

  const result = rowsLib.validateFunctionRows(flattenedRows, {
    functionsCount: inScopeFunctions.length,
    functions: inScopeFunctions,
    allServices: services,
    allFunctions: functions,
    view,
    serviceRows,
    validation,
  });
  if (!result.ok) {
    const maxErrors = Math.max(1, Math.floor(Number(validation.maxValidationErrors || 20)));
    const shown = result.errors.slice(0, maxErrors);
    return {
      ok: false,
      reason: `function rows invalid before function-doc claim: ${shown.slice(0, 3).join(" | ")}${result.errors.length > 3 ? ` (+${result.errors.length - 3} more)` : ""}`,
      errors: shown,
      totalErrors: result.errors.length,
    };
  }
  return { ok: true, rows, softByRow: result.softByRow || {} };
}

function writeValidationDiagnostic(id, item, fin, nextStatus) {
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  writeJson(diagnosticPath(id), {
    task_id: id,
    kind: item && item.kind || "",
    output: item && item.output || "",
    agent: item && item.agent || "",
    attempts: item && item.attempts || 0,
    maxAttempts: fin && fin.maxAttempts || null,
    nextStatus,
    reason: fin && fin.reason || "",
    totalErrors: fin && fin.totalErrors || (fin && Array.isArray(fin.errors) ? fin.errors.length : 0),
    errors: fin && Array.isArray(fin.errors) ? fin.errors : [],
    repairContext: fin && fin.repairContext || null,
    updated_at: new Date().toISOString(),
  });
}

function rejectDoneState(item, fin) {
  const maxAttempts = Math.max(1, Math.floor(Number((fin && fin.maxAttempts) || 2)));
  const attempts = Math.max(0, Math.floor(Number((item && item.attempts) || 0)));
  const failed = attempts >= maxAttempts;
  const repairPending = !failed && item && item.kind === "function-doc" && fin && fin.repairContext;
  return {
    ...item,
    status: failed ? "failed" : (repairPending ? "repair_pending" : "pending"),
    agent: "",
    completed_by: "",
    started_at: "",
    finished_at: failed ? new Date().toISOString() : "",
    error: `done rejected: ${fin.reason}`,
    repairContext: fin && fin.repairContext || item && item.repairContext || null,
  };
}

// 滚动 DAG：task 的 deps 全部 done 才可领取
function rejectedStatusText(item) {
  if (item && item.status === "failed") return "failed";
  if (item && item.status === "repair_pending") return "moved to repair_pending";
  return "reset to pending";
}

function depsDone(task, state) {
  const deps = Array.isArray(task.deps) ? task.deps : [];
  return deps.every((d) => state.tasks && state.tasks[d] && state.tasks[d].status === "done");
}

function isClaimableStatus(status) {
  return status === "pending" || status === "repair_pending";
}

function functionRowsFileFrom(tasks) {
  const fl = (tasks || []).find((t) => t.id === "l3__function-list");
  return fl ? resolveOutput(fl.output) : "";
}

function rowsForTask(tasks) {
  const rowsFile = functionRowsFileFrom(tasks);
  return readJsonSafe(rowsFile, null);
}

function normalizeSignatureForMatch(sig) {
  const parenIdx = sig.indexOf("(");
  if (parenIdx < 0) return sig;
  let prefix = sig.slice(0, parenIdx).trim();
  const paramsRaw = sig.slice(parenIdx + 1, sig.indexOf(")")).trim();
  const parts = prefix.split(/\s+/);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (/^[a-z]/.test(last)) prefix = last;
    else if (parts.length >= 2 && /^[A-Z]/.test(parts[parts.length - 1]) && /^[a-z]/.test(parts[parts.length - 2])) {
      prefix = parts.slice(-2).join(" ");
    }
  }
  if (!paramsRaw) return prefix + "()";
  const types = paramsRaw.split(",").map((p) => {
    const trimmed = p.trim();
    const spaceIdx = trimmed.indexOf(" ");
    return spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
  });
  return prefix + "(" + types.join(",") + ")";
}

function rowMatchesTask(row, info) {
  if (!row || !info) return false;
  if (row.module && info.module && !moduleMatches(row.module, info.module)) return false;
  if (row.impl_qn !== info.impl_qn) return false;
  if (row.method !== info.method) return false;
  if (info.signature && row.signature) {
    const normRow = normalizeSignatureForMatch(row.signature);
    const normInfo = normalizeSignatureForMatch(info.signature);
    if (normRow !== normInfo) return false;
  }
  return true;
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

function sameMethodSignature(row, info) {
  return row &&
    info &&
    row.impl_qn === info.impl_qn &&
    row.method === info.method;
}

function findFunctionRow(task, tasks) {
  const rows = rowsForTask(tasks);
  if (!Array.isArray(rows)) return { rows, row: null };
  const info = (task && task.function) || {};
  const exact = rows.find((r) => rowMatchesTask(r, info));
  if (exact) return { rows, row: exact };
  const candidates = rows.filter((r) => sameMethodSignature(r, info));
  return { rows, row: candidates.length === 1 ? candidates[0] : null };
}

function rowBusinessName(row) { return row.business_name || row["业务功能名称"] || row.metadata?.business_name || ""; }
function rowFunctionName(row) { return row.function_name || row["功能名称"] || row.metadata?.function_name || ""; }
function rowEntry(row) { return row.entry || row["功能入口"] || row.metadata?.entry || ""; }

function preferredFunctionDocOutput(task, tasks) {
  const manifest = manifestForSkill((task && task.l3Skill) || "");
  const source = manifest && manifest.capabilities && manifest.capabilities.docPathSource;
  // oracle-sp 等 function-facts 模式：直接从 L2 facts（impl_qn/method）派生路径，不依赖 function-list canonical rows
  if (source === "function-facts") {
    return preferredFunctionDocOutputByFacts(task);
  }
  // 默认 function-rows 模式：从 function-list canonical rows 派生路径（icbc 等）
  const { rows, row } = findFunctionRow(task, tasks);
  const docsDir = skillContract.docsDir(repo, manifest);
  if (Array.isArray(rows) && row) {
    const bn = rowBusinessName(row);
    const fn = rowFunctionName(row);
    const dirParts = safePathParts(bn, "未分类");
    if (!bn || !fn) {
      return { output: "", row: null, needsReview: true, reused: false, reason: "matching function row is not canonical (missing business_name/function_name)" };
    }
    const base = safeName(fn);
    const suffix = skillContract.functionDocSuffix(manifest);
    const file = suffix ? `${base}_${suffix}.md` : `${base}.md`;
    const output = path.join(docsDir, ...dirParts, file);
    return { output, row, needsReview: false, reused: false };
  }
  return { output: "", row: null, needsReview: true, reused: false, reason: "no matching canonical function row" };
}

// oracle-sp function-facts 模式：路径契约 fsd/{PKG大写}/{subprogram_snake_case}.md
// 重载：fsd/{PKG}/{subprogram}__{seq}.md（序号按 functions.json 中同 PKG 同 method 的出现序，1-based 全带序号）
function preferredFunctionDocOutputByFacts(task) {
  const manifest = manifestForSkill((task && task.l3Skill) || "");
  const docsDir = skillContract.docsDir(repo, manifest);
  const info = (task && task.function) || {};
  const pkg = info.impl_qn || "";        // oracle-sp: PKG 名（大写原名）
  const proc = info.method || "";         // oracle-sp: subprogram 名
  if (!pkg || !proc) {
    return { output: "", row: null, needsReview: true, reused: false, reason: "missing impl_qn(PKG)/method(subprogram) in L2 facts" };
  }

  // 重载序号判定：functions.json 中同 PKG 同 method 的出现次数
  const functions = readJson(functionsFile, []);
  const samePkgSameName = Array.isArray(functions)
    ? functions.filter((fn) => fn && fn.impl_qn === pkg && fn.method === proc)
    : [];
  const isOverload = samePkgSameName.length > 1;
  let seq = 0;
  if (isOverload) {
    const idx = samePkgSameName.findIndex((fn) =>
      fn.module === (info.module || "") && fn.signature === (info.signature || "")
    );
    seq = idx >= 0 ? idx + 1 : 1;
  }

  // 路径：fsd/{PKG大写}/{subprogram}.md 或 fsd/{PKG}/{subprogram}__{seq}.md
  const dirPart = safeName(String(pkg).toUpperCase());
  const baseName = safeName(String(proc).toLowerCase());
  const suffix = skillContract.functionDocSuffix(manifest);  // oracle-sp 为 ""
  const fileBase = isOverload ? `${baseName}__${seq}` : baseName;
  const file = suffix ? `${fileBase}_${suffix}.md` : `${fileBase}.md`;
  const output = path.join(docsDir, dirPart, file);
  return { output, row: null, needsReview: false, reused: false };
}

function functionDocDraftOutput(task, finalOutput) {
  const id = safeName((task && task.id) || path.basename(finalOutput || "function-doc", path.extname(finalOutput || "")));
  return path.join(l3DraftsDir, `${id}.md`);
}

function finalOutputForFunctionDoc(item, task) {
  const explicit = (item && (item.boundOutput || item.finalOutput)) || (task && (task.boundOutput || task.finalOutput)) || "";
  if (explicit) return resolveOutput(explicit);
  const bound = preferredFunctionDocOutputByFacts({ ...(task || {}), ...(item || {}), function: (task && task.function) || (item && item.function) || {} });
  return bound.output ? resolveOutput(bound.output) : "";
}

function ensureFsdDraftSkeleton(task) {
  if (!isFunctionFactsMode(task)) return { ok: true };
  const draft = resolveOutput(task && task.output || "");
  if (!draft) return { ok: false, reason: "missing draft output path" };
  if (!isWithinDir(draft, l3DraftsDir)) return { ok: false, reason: "draft output path is outside .repowiki/l3-drafts" };
  const existing = outputStatus(draft);
  if (existing.ok) return { ok: true, draftOutput: draft };
  const ctx = fsdContextForTask(task);
  if (!ctx.ok || !ctx.renderedSkeleton) return { ok: false, reason: ctx.reason || ctx.compileError || "FSD skeleton unavailable" };
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, ctx.renderedSkeleton, "utf8");
  return { ok: true, draftOutput: draft };
}

function publishFunctionDocDraft(item, task) {
  const draft = resolveOutput(item && item.output || "");
  const finalOutput = finalOutputForFunctionDoc(item, task);
  if (!draft || !isWithinDir(draft, l3DraftsDir)) {
    return { ok: false, reason: "draft output path is outside .repowiki/l3-drafts" };
  }
  if (!finalOutput) return { ok: false, reason: "missing final output path" };
  if (!isWithinDir(finalOutput, docsDirForSkill((item && item.l3Skill) || (task && task.l3Skill) || ""))) {
    return { ok: false, reason: "final output path is outside skill docsDir" };
  }
  fs.mkdirSync(path.dirname(finalOutput), { recursive: true });
  const tmp = `${finalOutput}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(draft, tmp);
  fs.renameSync(tmp, finalOutput);
  return { ok: true, finalOutput };
}

function removeUnpublishedFunctionDocFinal(item, task) {
  const finalOutput = finalOutputForFunctionDoc(item, task);
  if (!finalOutput || !isWithinDir(finalOutput, docsDirForSkill((item && item.l3Skill) || (task && task.l3Skill) || ""))) return false;
  try {
    if (fs.existsSync(finalOutput)) {
      fs.unlinkSync(finalOutput);
      return true;
    }
  } catch (_) {
    return false;
  }
  return false;
}

function isFunctionFactsMode(taskOrSkill) {
  const l3Skill = typeof taskOrSkill === "string" ? taskOrSkill : ((taskOrSkill && taskOrSkill.l3Skill) || "");
  const manifest = manifestForSkill(l3Skill || "");
  return manifest && manifest.capabilities && manifest.capabilities.docPathSource === "function-facts";
}

function fsdFactsInfoForTask(task) {
  const bound = preferredFunctionDocOutputByFacts(task);
  const finalOutput = (task && (task.boundOutput || task.finalOutput)) || bound.output;
  if (!finalOutput) return { ok: false, reason: bound.reason || "missing output path" };
  const manifest = manifestForSkill((task && task.l3Skill) || "");
  const docsRoot = path.resolve(skillContract.docsDir(repo, manifest) || path.join(repo, "fsd"));
  const outputAbs = path.resolve(finalOutput);
  const relToDocs = path.relative(docsRoot, outputAbs);
  const relParts = relToDocs && !relToDocs.startsWith("..") && !path.isAbsolute(relToDocs)
    ? relToDocs.split(/[\\/]+/).filter(Boolean)
    : String(bound.output).replace(/\\/g, "/").split("/").filter(Boolean).slice(1);
  if (relParts.length < 2) return { ok: false, reason: "cannot derive fsd-facts path from output" };
  const fileBase = path.basename(relParts[relParts.length - 1], path.extname(relParts[relParts.length - 1]));
  const factDirParts = relParts.slice(0, -1);
  const fsdFactsFile = path.join(fsdFactsDir, ...factDirParts, `${fileBase}.json`);
  const coverageReportFile = path.join(fsdCoverageDir, `${safeName(task.id || fileBase)}.json`);
  return {
    ok: true,
    output: finalOutput,
    fsdFactsFile,
    coverageReportFile,
    relativeFsdFactsFile: path.relative(repo, fsdFactsFile),
    relativeCoverageReportFile: path.relative(repo, coverageReportFile),
  };
}

function compiledFsdFactsForTask(task) {
  const functions = readJson(functionsFile, []);
  const info = (task && task.function) || {};
  const fn = Array.isArray(functions)
    ? (functions.find((row) => sameFunction(row, { ...info, module: info.module || task.module || "" })) || info)
    : info;
  const repairs = loadSourceFactRepairs(sourceFactRepairsFile);
  return compileFsdFacts(applySourceFactRepairsToFunction(fn, repairs));
}

function fsdContextForTask(task) {
  const info = fsdFactsInfoForTask(task);
  if (!info.ok) return { ...info, renderedSkeleton: "" };
  try {
    const facts = compiledFsdFactsForTask(task);
    return {
      ...info,
      schemaVersion: facts.schemaVersion,
      identity: facts.identity,
      renderedSkeleton: renderFsdMarkdown(facts),
    };
  } catch (err) {
    return {
      ...info,
      renderedSkeleton: "",
      compileError: err && err.message ? err.message : String(err),
    };
  }
}

function materializeFsdFactsForTask(task) {
  const info = fsdFactsInfoForTask(task);
  if (!info.ok) return info;
  try {
    const facts = compiledFsdFactsForTask(task);
    const schemaCheck = validateFsdFacts(facts);
    if (!schemaCheck.ok) {
      const first = schemaCheck.errors[0] || {};
      return { ok: false, reason: `fsd-facts schema invalid: ${first.code || "UNKNOWN"} ${first.path || ""}`.trim() };
    }
    fs.mkdirSync(path.dirname(info.fsdFactsFile), { recursive: true });
    writeJson(info.fsdFactsFile, facts);
    return { ...info, ok: true };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

function writeFsdCoverageReport(task, facts, coverage) {
  const info = fsdFactsInfoForTask(task);
  if (!info.ok) return;
  const pollutionOk = !coverage.pollution || coverage.pollution.ok;
  const actualOk = coverage.ok && pollutionOk;
  const blocking = coverage.blocking !== false;
  const reportOk = blocking ? actualOk : true;
  const agent = argValue("--agent", "");
  const replayCommand = `${process.execPath} ${__filename} done ${repo} --id ${task.id}${agent ? ` --agent ${agent}` : ""}`;
  const report = {
    schemaVersion: 1,
    reportType: "fsd-coverage",
    status: actualOk ? "PASS" : (blocking ? "FAIL" : "WARN"),
    strict: blocking,
    blocking,
    actualOk,
    command: replayCommand,
    cwd: process.cwd(),
    inputs: {
      outputFile: task.boundOutput || task.finalOutput || info.output || "",
      draftOutputFile: task.output || "",
      fsdFactsFile: info.relativeFsdFactsFile,
      coverageReportFile: info.relativeCoverageReportFile,
    },
    summary: {
      taskId: task.id,
      identity: facts.identity && facts.identity.id || "",
      failuresTotal: (
        coverage.schema.errors.length
        + coverage.gate.errors.length
        + coverage.gaps.length
        + (((coverage.pollution && coverage.pollution.findings) || []).length)
      ),
    },
    ok: reportOk,
    taskId: task.id,
    identity: facts.identity || {},
    metrics: coverage.metrics,
    failures: [
      ...coverage.schema.errors.map((err) => ({ error_code: err.code, path: err.path, message: err.message })),
      ...coverage.gate.errors.map((err) => ({ error_code: err.code, path: err.path, message: err.message })),
      ...coverage.gaps.map((gap) => ({ error_code: gap.code, path: gap.factCode, message: gap.message, token: gap.token })),
      ...((coverage.pollution && coverage.pollution.findings) || []).map((finding) => ({ error_code: finding.code, path: finding.path, message: finding.message, value: finding.value })),
    ],
    cases: [{ case_id: (facts.identity && facts.identity.id) || task.id, ok: reportOk }],
  };
  fs.mkdirSync(path.dirname(info.coverageReportFile), { recursive: true });
  writeJson(info.coverageReportFile, report);

  const current = readJsonSafe(fsdCoverageSummaryFile, { ok: true, reports: [] });
  const reports = Array.isArray(current.reports) ? current.reports.filter((row) => row.taskId !== task.id) : [];
  reports.push({
    taskId: task.id,
    ok: reportOk,
    actualOk,
    status: actualOk ? "PASS" : (blocking ? "FAIL" : "WARN"),
    fsdFactsFile: info.relativeFsdFactsFile,
    coverageReportFile: info.relativeCoverageReportFile,
    metrics: coverage.metrics,
  });
  const summaryOk = reports.every((row) => row.ok);
  const actualSummaryOk = reports.every((row) => row.actualOk !== false);
  const reportsOk = reports.filter((row) => row.ok).length;
  fs.mkdirSync(path.dirname(fsdCoverageSummaryFile), { recursive: true });
  writeJson(fsdCoverageSummaryFile, {
    schemaVersion: 1,
    reportType: "fsd-coverage-summary",
    status: actualSummaryOk ? "PASS" : (summaryOk ? "WARN" : "FAIL"),
    strict: blocking,
    blocking,
    actualOk: actualSummaryOk,
    command: replayCommand,
    cwd: process.cwd(),
    inputs: {
      coverageReportsDir: path.relative(repo, fsdCoverageDir),
      summaryFile: path.relative(repo, fsdCoverageSummaryFile),
    },
    summary: {
      reportsTotal: reports.length,
      reportsOk,
    },
    ok: summaryOk,
    metrics: {
      reportsTotal: reports.length,
      reportsOk,
    },
    reports,
  });
}

function isFsdSoftGateEnabled() {
  return String(process.env.REPOWIKI_FSD_GATE_MODE || "soft").toLowerCase() !== "strict";
}

function fsdRepairContextForTask(task, facts, coverage, reason) {
  const info = fsdFactsInfoForTask(task);
  const unrenderedFacts = coverage && coverage.markdownCoverage && Array.isArray(coverage.markdownCoverage.unrenderedFacts)
    ? coverage.markdownCoverage.unrenderedFacts
    : [];
  const gaps = coverage && Array.isArray(coverage.gaps) ? coverage.gaps : [];
  const gapFacts = unrenderedFacts.length ? unrenderedFacts : gaps.map((gap) => ({
    factCode: gap.factCode || "",
    token: gap.token || "",
    message: gap.message || "",
  }));
  return {
    repairType: "l3-fsd-markdown",
    taskId: task && task.id || "",
    identity: facts && facts.identity && facts.identity.id || "",
    fsdFactsFile: info.ok ? info.relativeFsdFactsFile : "",
    outputFile: task && (task.boundOutput || task.finalOutput) || (info.ok ? info.output : ""),
    draftOutputFile: task && task.output || "",
    reason: reason || "",
    schemaErrors: coverage && coverage.schema && Array.isArray(coverage.schema.errors) ? coverage.schema.errors : [],
    gateErrors: coverage && coverage.gate && Array.isArray(coverage.gate.errors) ? coverage.gate.errors : [],
    unrenderedFacts: gapFacts,
    pollution: coverage && coverage.pollution && Array.isArray(coverage.pollution.findings) ? coverage.pollution.findings : [],
    instruction: "Repair only the missing or polluted FSD markdown coverage for this task. Do not rerun from scratch. Do not modify fsdFacts; render the listed facts into the existing output document.",
  };
}

function bindFunctionDocOutput(task, item, tasks) {
  if (!task || task.kind !== "function-doc") return task;
  const bound = preferredFunctionDocOutput({ ...task, ...item, function: task.function }, tasks);
  if (isFunctionFactsMode(task)) {
    const finalOutput = bound.output || item && (item.boundOutput || item.finalOutput) || "";
    const existingDraft = item && item.output && isWithinDir(resolveOutput(item.output), l3DraftsDir) ? item.output : "";
    const draftOutput = finalOutput ? (existingDraft || functionDocDraftOutput(task, finalOutput)) : "";
    return {
      ...task,
      output: draftOutput,
      finalOutput,
      boundOutput: finalOutput,
      needs_review: bound.needsReview,
    };
  }
  const next = { ...task, output: bound.output, boundOutput: bound.output, needs_review: bound.needsReview };
  return next;
}

function sameOutputPath(a, b) {
  return path.resolve(String(a || "")).toLowerCase() === path.resolve(String(b || "")).toLowerCase();
}

function repairStaleFunctionDocBindings(tasks, state) {
  let changed = false;
  for (const task of tasks) {
    if (!task || task.kind !== "function-doc") continue;
    const item = state.tasks && state.tasks[task.id];
    if (!item) continue;
    const bound = preferredFunctionDocOutput({ ...task, ...item, function: task.function }, tasks);
    // function-facts 模式 bound.row 为 null（合法），用 bound.output 判断；function-rows 模式仍按 row+output 判断
    const manifest = manifestForSkill((task && task.l3Skill) || "");
    const isFactsMode = manifest && manifest.capabilities && manifest.capabilities.docPathSource === "function-facts";
    const boundInvalid = isFactsMode ? !bound.output : (!bound.row || !bound.output);
    if (boundInvalid) {
      const mustReset = item.status === "running" || item.status === "done" || item.output || item.boundOutput;
      if (!mustReset) continue;
      state.tasks[task.id] = {
        ...item,
        output: "",
        boundOutput: "",
        needs_review: true,
        status: "pending",
        agent: "",
        completed_by: "",
        started_at: "",
        finished_at: "",
        error: `reset function-doc: ${bound.reason || "canonical function row unavailable"}`,
      };
      changed = true;
      continue;
    }
    if (isFactsMode) {
      const rebound = bindFunctionDocOutput(task, item, tasks);
      const sameFinal = sameOutputPath(item.boundOutput || item.finalOutput || "", rebound.boundOutput || "");
      const sameDraft = item.output && rebound.output && sameOutputPath(item.output, rebound.output);
      if (sameFinal && sameDraft && item.needs_review === false) continue;
      const resetRunning = item.status === "running" || item.status === "failed";
      state.tasks[task.id] = {
        ...item,
        output: rebound.output || "",
        boundOutput: rebound.boundOutput || "",
        finalOutput: rebound.finalOutput || rebound.boundOutput || "",
        needs_review: false,
        status: resetRunning ? "pending" : (item.status || "pending"),
        agent: resetRunning ? "" : item.agent,
        completed_by: resetRunning ? "" : item.completed_by,
        started_at: resetRunning ? "" : item.started_at,
        finished_at: resetRunning ? "" : item.finished_at,
        error: resetRunning ? "reset running function-doc: output path rebound to draft/final protocol" : item.error || "",
      };
      changed = true;
      continue;
    }
    if (item.status === "running" && sameOutputPath(item.output || task.output, bound.output) && item.boundOutput) continue;
    const sameOutput = sameOutputPath(item.output || task.output, bound.output);
    let invalidDoneReason = "";
    // 仅 function-rows 模式在 repair 阶段用 validateFunctionDocContent 重校；facts 模式由 finalizeFunctionDocByFacts 在 done 时校验
    if (!isFactsMode && item.status === "done" && sameOutput && bound.row) {
      const output = resolveOutput(bound.output);
      const doc = fs.existsSync(output) ? fs.readFileSync(output, "utf8").replace(/^\uFEFF/, "") : "";
      invalidDoneReason = validateFunctionDocContent({ ...item, output: bound.output }, task, bound.row, doc);
    }
    if (sameOutput && item.boundOutput && item.needs_review === false && !invalidDoneReason) continue;
    const reset = item.status === "done" && (!sameOutput || invalidDoneReason);
    state.tasks[task.id] = {
      ...item,
      output: bound.output,
      boundOutput: bound.output,
      needs_review: false,
      status: reset || item.status === "failed" || item.status === "running" ? "pending" : item.status,
      agent: reset || item.status === "failed" || item.status === "running" ? "" : item.agent,
      completed_by: reset ? "" : item.completed_by,
      started_at: reset || item.status === "failed" || item.status === "running" ? "" : item.started_at,
      finished_at: reset || item.status === "failed" || item.status === "running" ? "" : item.finished_at,
      error: reset ? (invalidDoneReason ? `reset invalid function-doc content: ${invalidDoneReason}` : "reset stale function-doc path after function rows became available") :
        (item.status === "running" ? "reset running function-doc: output path rebound to canonical rows" : ""),
    };
    changed = true;
  }
  return changed;
}

function validationForTask(item) {
  return readJsonSafe(path.join(skillDir((item && item.l3Skill) || ""), "validation.json"), {});
}

function markdownSections(doc) {
  const sections = [];
  const re = /^##\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(doc))) sections.push({ title: m[1].trim(), index: m.index, end: re.lastIndex });
  return sections;
}

function sectionBody(doc, sections, title) {
  const idx = sections.findIndex((s) => s.title === title);
  if (idx < 0) return "";
  const start = sections[idx].end;
  const end = idx + 1 < sections.length ? sections[idx + 1].index : doc.length;
  return doc.slice(start, end).trim();
}

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function pathContainsParts(file, parts) {
  const normalized = path.resolve(file).replace(/\\/g, "/");
  return (parts || []).every((p) => normalized.includes(`/${safeName(p)}/`) || normalized.includes(`/${safeName(p)}_`));
}

function hasTemplateResidue(doc) {
  // 先剔除 mermaid 代码块（```mermaid ... ```），避免 mermaid 判定节点 {text} 被误判为模板残留
  const stripped = String(doc || "").replace(/```mermaid[\s\S]*?```/g, "");
  return /\{[^}\n]+\}|<!--|模板是生成规则|不要把说明句复制|目标模板示例|字段写法示例/.test(stripped);
}

function validateFunctionDocContent(item, task, row, doc) {
  const validation = validationForTask(item);
  const expected = Array.isArray(validation.functionDocSections) ? validation.functionDocSections : [];
  const fields = validation.functionDocFieldNames || {};
  const sections = markdownSections(doc);
  if (sections.some((s) => /^\d+\.\s*/.test(s.title))) return "numbered section title is not allowed";
  const titles = sections.map((s) => s.title.replace(/^\d+\.\s*/, ""));
  if (expected.length && (titles.length !== expected.length || expected.some((x, i) => titles[i] !== x))) {
    return `sections invalid: expected ${expected.join("/")} got ${titles.join("/")}`;
  }
  if (hasTemplateResidue(doc)) return "template residue found";
  if (rowFunctionName(row) && !doc.includes(String(rowFunctionName(row)))) {
    return `doc inconsistent with function row (expected 功能名称 "${rowFunctionName(row)}")`;
  }
  const titleLine = (doc.match(/^#\s+(.+?)\s*$/m) || [])[1] || "";
  if (rowFunctionName(row) && !titleLine.replace(/\s+/g, "").includes(String(rowFunctionName(row)).replace(/\s+/g, ""))) return `title missing function_name ${rowFunctionName(row)}`;
  const rawImpl = simpleName(row.impl_qn || "");
  const rawMethod = String(row.method || "");
  if (rawImpl && titleLine.includes(rawImpl)) return `title contains raw class name ${rawImpl}`;
  if (rawMethod && /[A-Za-z]/.test(rawMethod) && titleLine.includes(rawMethod)) return `title contains raw method name ${rawMethod}`;
  const outputBase = path.basename(resolveOutput(item.output), path.extname(resolveOutput(item.output)));
  if (rawImpl && outputBase.includes(rawImpl)) return `filename contains raw class name ${rawImpl}`;
  if (rawMethod && /[A-Za-z]/.test(rawMethod) && outputBase.includes(rawMethod)) return `filename contains raw method name ${rawMethod}`;
  const introTitle = fields.intro || "";
  const intro = introTitle ? sectionBody(doc, sections, introTitle) : "";
  if (introTitle && (!intro || (Array.isArray(validation.emptyDocSectionValues) && validation.emptyDocSectionValues.includes(intro)))) return `${introTitle} empty`;
  if (introTitle && rawImpl && intro.includes(rawImpl)) return `${introTitle} contains raw class name ${rawImpl}`;
  if (introTitle && rawMethod && /[A-Za-z]/.test(rawMethod) && intro.includes(rawMethod)) return `${introTitle} contains raw method name ${rawMethod}`;
  const typeTitle = fields.type || "";
  const typeBody = typeTitle ? normalizeText(sectionBody(doc, sections, typeTitle)) : "";
  const expectedType = rowsLib.expectedFunctionType(row, validation);
  if (typeTitle && expectedType && typeBody !== expectedType) return `${typeTitle} invalid: expected ${expectedType}, got ${typeBody || "<empty>"}`;
  const entryTitle = fields.entry || "";
  const entryBody = entryTitle ? normalizeText(sectionBody(doc, sections, entryTitle)) : "";
  const entryType = String(row.entry_type || "").toLowerCase();
  if (entryTitle && (entryType === "rpc" || entryType === "dubbo")) {
    if (entryBody !== normalizeText(rowEntry(row))) return `${entryTitle} invalid for rpc: expected ${rowEntry(row)}`;
  } else if (entryTitle && (entryType === "http" || entryType === "spring-rest")) {
    const allowed = [row.impl_qn, row.entry, row.controller_qn].filter(Boolean).map(normalizeText);
    if (!allowed.includes(entryBody)) return `${entryTitle} invalid for http: expected class or entry`;
  }
  for (const title of [fields.tables, fields.downstream].filter(Boolean)) {
    const body = sectionBody(doc, sections, title);
    if (!body) return `${title} empty`;
  }
  const codeIndexTitle = fields.codeIndex || "";
  const codeIndex = codeIndexTitle ? sectionBody(doc, sections, codeIndexTitle) : "";
  if (codeIndexTitle && (!codeIndex || (!codeIndex.includes(row.impl_qn || "") && !/###\s+\S+/.test(codeIndex)))) {
    return "代码索引 missing class grouping or impl_qn";
  }
  const output = resolveOutput(item.output);
  if (rowBusinessName(row) && !pathContainsParts(output, String(rowBusinessName(row)).split(/[\\/]+/))) {
    return `output path does not contain business_name ${rowBusinessName(row)}`;
  }
  if (rowFunctionName(row) && !path.basename(output).includes(safeName(rowFunctionName(row)))) {
    return `output filename does not contain function_name ${rowFunctionName(row)}`;
  }
  return "";
}

// function-doc 闸门(boundary 2)：文档存在 + 引用 function row + 按当前 L3 skill validation 校验章节/路径/入口/类型。
function finalizeFunctionDoc(item, task, tasks) {
  const manifest = manifestForSkill(item.l3Skill || task.l3Skill || "");
  const source = manifest && manifest.capabilities && manifest.capabilities.docPathSource;
  // oracle-sp 等 function-facts 模式：不依赖 function canonical rows，直接按 facts 校验
  if (source === "function-facts") {
    return finalizeFunctionDocByFacts(item, task);
  }
  // 默认 function-rows 模式
  const { rows, row } = findFunctionRow(task, tasks);
  const info = (task && task.function) || {};
  if (!Array.isArray(rows)) return { ok: false, reason: "function rows file is unreadable" };
  const bound = preferredFunctionDocOutput({ ...task, ...item, function: task.function }, tasks);
  if (!bound.row || !bound.output) return { ok: false, reason: bound.reason || `no matching canonical function row for ${info.impl_qn}.${info.method}` };
  if (!sameOutputPath(item.output, bound.output)) return { ok: false, reason: `output path is not canonical for function row: expected ${bound.output}` };
  if (!isWithinDir(bound.output, docsDirForSkill(item.l3Skill || task.l3Skill || ""))) {
    return { ok: false, reason: "output path is outside skill docsDir" };
  }
  const output = resolveOutput(item.output);
  const doc = fs.existsSync(output) ? fs.readFileSync(output, "utf8").replace(/^\uFEFF/, "") : "";
  if (!row) {
    return { ok: false, reason: `no matching function row for ${info.impl_qn}.${info.method}` };
  }
  const reason = validateFunctionDocContent(item, task, row, doc);
  if (reason) return { ok: false, reason };
  return { ok: true };
}

// oracle-sp function-facts 闸门：文档存在 + 路径契约 + FSD 6 板块 + 板块6 收尾 + PKG/subprogram 一致性
function finalizeFunctionDocByFacts(item, task) {
  const docsDir = docsDirForSkill(item.l3Skill || task.l3Skill || "");
  const bound = preferredFunctionDocOutputByFacts(task);
  if (!bound.output) return { ok: false, reason: bound.reason || "missing output path" };
  const finalOutput = item.boundOutput || item.finalOutput || bound.output;
  if (!sameOutputPath(finalOutput, bound.output)) {
    return { ok: false, reason: `output path is not canonical: expected ${bound.output}` };
  }
  if (!isWithinDir(finalOutput, docsDir)) {
    return { ok: false, reason: "output path is outside skill docsDir" };
  }
  if (!isWithinDir(item.output, l3DraftsDir)) {
    return { ok: false, reason: "draft output path is outside .repowiki/l3-drafts" };
  }
  const output = resolveOutput(item.output);
  if (!fs.existsSync(output)) return { ok: false, reason: "output file does not exist" };
  const stat = fs.statSync(output);
  if (!stat.isFile()) return { ok: false, reason: "output path is not a file" };
  if (stat.size <= MIN_OUTPUT_BYTES) {
    return { ok: false, reason: `output file is too small (${stat.size} bytes)` };
  }
  const doc = fs.readFileSync(output, "utf8").replace(/^\uFEFF/, "");
  if (hasTemplateResidue(doc)) return { ok: false, reason: "template residue found" };

  const fsdInfo = fsdFactsInfoForTask(task);
  if (!fsdInfo.ok) return { ok: false, reason: fsdInfo.reason || "fsd-facts path unavailable" };
  if (!fs.existsSync(fsdInfo.fsdFactsFile)) {
    return { ok: false, reason: `fsd-facts contract missing: ${fsdInfo.relativeFsdFactsFile}` };
  }
  const fsdFacts = readJsonSafe(fsdInfo.fsdFactsFile, null);
  const schemaCheck = validateFsdFacts(fsdFacts);
  if (!schemaCheck.ok) {
    const coverage = {
      ok: false,
      schema: schemaCheck,
      gate: { ok: true, errors: [] },
      metrics: { factsTotal: 0, factsCoveredByMarkdown: 0, coverageRatio: 0 },
      gaps: [],
    };
    const reportTask = { ...task, output: item.output, boundOutput: finalOutput, finalOutput };
    writeFsdCoverageReport(reportTask, fsdFacts || {}, coverage);
    const first = schemaCheck.errors[0] || {};
    const reason = `fsd-facts schema invalid: ${first.code || "UNKNOWN"} ${first.path || ""}`.trim();
    return {
      ok: false,
      reason,
      repairContext: fsdRepairContextForTask(reportTask, fsdFacts || {}, coverage, reason),
    };
  }
  const coverage = computeFsdCoverage(fsdFacts, doc, { outputPath: fsdFacts.identity && fsdFacts.identity.outputPath });
  const pollution = detectFsdPollution(fsdFacts);
  coverage.pollution = pollution;
  coverage.blocking = !isFsdSoftGateEnabled();
  const reportTask = { ...task, output: item.output, boundOutput: finalOutput, finalOutput };
  writeFsdCoverageReport(reportTask, fsdFacts, coverage);
  if (!pollution.ok && !isFsdSoftGateEnabled()) {
    const first = pollution.findings[0] || {};
    const reason = `fsd pollution invalid: ${first.code || "SQL_ALIAS_POLLUTION"} ${first.path || ""}`.trim();
    return {
      ok: false,
      reason,
      repairContext: fsdRepairContextForTask(reportTask, fsdFacts, coverage, reason),
    };
  }
  if (!coverage.ok && !isFsdSoftGateEnabled()) {
    const first = coverage.schema.errors[0] || coverage.gate.errors[0] || coverage.gaps[0] || {};
    const reason = `fsd coverage invalid: ${first.code || first.error_code || "UNKNOWN"} ${first.path || first.factCode || ""}`.trim();
    return {
      ok: false,
      reason,
      repairContext: fsdRepairContextForTask(reportTask, fsdFacts, coverage, reason),
    };
  }

  // FSD 6 板块结构校验（validation.json 的 functionDocSections）
  const validation = validationForTask(item);
  const expected = Array.isArray(validation.functionDocSections) ? validation.functionDocSections : [];
  const sections = markdownSections(doc);
  if (sections.some((s) => /^\d+\.\s*/.test(s.title))) {
    return { ok: false, reason: "numbered section title is not allowed" };
  }
  const titles = sections.map((s) => s.title.replace(/^\d+\.\s*/, ""));
  if (expected.length && (titles.length !== expected.length || expected.some((x, i) => titles[i] !== x))) {
    return { ok: false, reason: `sections invalid: expected ${expected.join("/")} got ${titles.join("/")}` };
  }

  // 子节校验：validation.requireSubsections=true 时，每板块下的 ### 子节必须齐全
  if (validation.requireSubsections && validation.functionDocSubsections) {
    for (const [sectionName, subs] of Object.entries(validation.functionDocSubsections)) {
      const body = sectionBody(doc, sections, sectionName);
      if (!body) continue;  // 板块本身缺失由 sections 校验处理
      for (const sub of subs) {
        if (!body.includes(`### ${sub}`)) {
          return { ok: false, reason: `${sectionName} 缺少子节：${sub}` };
        }
      }
    }
  }

  // 板块6 固定收尾校验："需手动审查的构造" 必须出现
  const fields = validation.functionDocFieldNames || {};
  const specialSyntaxTitle = fields.specialSyntax || "特殊语法转化规约";
  const specialSyntaxBody = sectionBody(doc, sections, specialSyntaxTitle);
  if (!specialSyntaxBody) return { ok: false, reason: `${specialSyntaxTitle} 板块缺失` };
  if (!/需手动审查/.test(specialSyntaxBody)) {
    return { ok: false, reason: "板块6 缺少需手动审查的构造表" };
  }

  // 路径与 PKG/subprogram 一致性
  const info = (task && task.function) || {};
  const pkg = info.impl_qn || "";
  const proc = info.method || "";
  const titleLine = (doc.match(/^#\s+(.+?)\s*$/m) || [])[1] || "";
  // 标题应包含 PKG 名（oracle-sp 的 FSD 标题契约）
  if (pkg && !titleLine.toUpperCase().includes(String(pkg).toUpperCase())) {
    return { ok: false, reason: `title missing package ${pkg}` };
  }
  // 文件名应包含 subprogram 名
  const outputBase = path.basename(resolveOutput(finalOutput), path.extname(resolveOutput(finalOutput)));
  if (proc && !outputBase.toLowerCase().includes(String(proc).toLowerCase())) {
    return { ok: false, reason: `filename missing subprogram ${proc}` };
  }
  return { ok: true };
}

function sameFunction(row, fn) {
  return row &&
    row.module === fn.module &&
    row.impl_qn === fn.impl_qn &&
    row.method === fn.method &&
    (!fn.signature || !row.signature || row.signature === fn.signature);
}

function downstreamFor(fn, downstream) {
  return downstream.filter((d) =>
    d.module === fn.module &&
    d.from_impl === fn.impl_qn &&
    d.from_method === fn.method
  );
}

function modelsFor(fn, models) {
  const types = new Set(fn && Array.isArray(fn.model_types) ? fn.model_types : []);
  if (!types.size) return [];
  return models.filter((m) => m.module === fn.module && types.has(m.type));
}

function callgraphFor(fn, graph) {
  const key = `${fn.module || ""}#${fn.impl_qn || ""}#${fn.method || ""}`;
  const g = graph || {};
  const callees = g.callees && g.callees[key] ? g.callees[key] : [];
  const callers = g.callers && g.callers[key] ? g.callers[key] : [];
  return { key, callees, callers };
}

function tablesFor(fn, tables) {
  const explicit = new Set(Array.isArray(fn && fn.tables) ? fn.tables : []);
  return (tables || []).filter((t) =>
    t.module === fn.module &&
    (((!t.impl_qn || t.impl_qn === fn.impl_qn) && (!t.method || t.method === fn.method)) ||
      (explicit.size && explicit.has(t.table)))
  );
}

function slimModel(model) {
  const fields = Array.isArray(model && model.fields) ? model.fields : [];
  return {
    type: model && model.type || "",
    module: model && model.module || "",
    profile: model && model.profile || "",
    fields: fields.slice(0, 50).map((field) => ({
      name: field && field.name || "",
      type: field && field.type || "",
      source: field && field.source || "",
    })),
    field_overflow: Math.max(0, fields.length - 50),
  };
}

function slimDownstream(edge) {
  return {
    to_service: edge && edge.to_service || "",
    to_method: edge && edge.to_method || "",
    to_qn: edge && edge.to_qn || "",
    downstream_kind: edge && edge.downstream_kind || "",
    entry_type: edge && edge.entry_type || "",
  };
}

function slimTable(table) {
  return {
    table: table && table.table || "",
    impl_qn: table && table.impl_qn || "",
    method: table && table.method || "",
    dao_qn: table && (table.dao_qn || table.dao || "") || "",
    dao_method: table && table.dao_method || "",
    dynamic: !!(table && table.dynamic),
  };
}

function slimService(service) {
  return {
    service_id: service && service.service_id || "",
    service_name: service && service.service_name || "",
    service_category: service && service.service_category || "",
    impl_qn: service && service.impl_qn || "",
    iface_qn: service && service.iface_qn || "",
    service_iface: service && service.service_iface || "",
    config: service && service.config || "",
    version: service && service.version || "",
    group: service && service.group || "",
    module: service && service.module || "",
    profile: service && service.profile || "",
    entry_type: service && service.entry_type || "",
    review_required: !!(service && service.review_required),
    review_reasons: Array.isArray(service && service.review_reasons) ? service.review_reasons : [],
  };
}

function paramsFor(fn) {
  if (Array.isArray(fn && fn.params)) {
    return fn.params.map((p) => ({
      type: p && p.type || "",
      name: p && p.name || "",
      annotations: Array.isArray(p && p.annotations) ? p.annotations : [],
    }));
  }
  return [];
}

function serviceRowForFunction(fn, serviceRows, services) {
  const row = findServiceRowForFunction(fn, serviceRows);
  if (row) return row;
  const svc = (services || []).find((s) =>
    s &&
    fn &&
    moduleMatches(fn.module, s.module) &&
    (s.impl_qn === fn.impl_qn || (fn.iface_qn && s.iface_qn === fn.iface_qn) || (fn.service_iface && s.service_iface === fn.service_iface))
  );
  if (!svc) return null;
  return {
    service_id: svc.service_id || "",
    service_name: svc.service_name || svc.service_iface || svc.iface_qn || "",
    service_category: svc.service_category || "",
    impl_qn: svc.impl_qn || "",
    iface_qn: svc.iface_qn || "",
    service_iface: svc.service_iface || "",
    config: svc.config || "",
    version: svc.version || "",
    module: svc.module || "",
    review_required: true,
  };
}

function serviceBusinessName(row) {
  if (!row) return "";
  const category = String(row.service_category || "").trim();
  const name = String(row.service_name || "").trim();
  return category && name ? `${category}/${name}` : (name || category || "");
}

function expectedFunctionTypeForFact(fn, l3Skill) {
  const validation = readJsonSafe(path.join(skillDir(l3Skill || ""), "validation.json"), {});
  const map = validation.functionTypeByEntryType || {};
  const entryType = String((fn && (fn.entry_type || fn.profile)) || "").toLowerCase();
  return map[entryType] || map["*"] || "";
}

function serviceIdForRow(row, index) {
  if (row && row.service_id) return row.service_id;
  const base = [
    row && row.module || "",
    row && row.impl_qn || "",
    row && row.iface_qn || row && row.service_iface || "",
    row && row.version || "",
    row && row.group || "",
  ].join("#");
  return `svc-${shortHash(base || `service-${index + 1}`)}`;
}

function functionIdForFact(fn, index) {
  return fn && (fn.function_key || fn.expected_id || fn.candidate_id) || `fn-${shortHash([
    fn && fn.module || "",
    fn && fn.impl_qn || "",
    fn && fn.method || "",
    fn && fn.signature || "",
    fn && fn.version || "",
    fn && fn.group || "",
    index,
  ].join("#"))}`;
}

function semanticSeedFromFunction(fn) {
  const doc = String(fn && fn.method_doc || "").trim();
  const parts = doc.split(/[:：]/).map((s) => s.trim()).filter(Boolean);
  return {
    function_name_hint: parts[0] || "",
    summary_hint: parts.length > 1 ? parts.join("，") : doc,
  };
}

function scopeRowSkeleton(fn, index, l3Skill) {
  const serviceRow = fn && fn.service_row || null;
  const businessName = fn && fn.service_business_name || serviceBusinessName(serviceRow);
  const serviceCategory = serviceRow && serviceRow.service_category || String(businessName || "").split(/[\\/]/)[0] || "";
  const seed = semanticSeedFromFunction(fn);
  return {
    function_id: functionIdForFact(fn, index),
    app: appName(),
    business_name: businessName,
    business_domain: serviceCategory,
    function_type: expectedFunctionTypeForFact(fn, l3Skill),
    function_name: "",
    summary: "",
    service_id: serviceIdForRow(serviceRow || {}, index),
    entry_type: fn && (fn.entry_type || fn.profile) || "",
    iface_qn: fn && fn.iface_qn || "",
    version: fn && fn.version || "",
    group: fn && fn.group || "",
    entry: fn && fn.entry || "",
    method: fn && fn.method || "",
    module: fn && fn.module || "",
    impl_qn: fn && fn.impl_qn || "",
    signature: fn && fn.signature || "",
    review_required: !!(fn && fn.review_required),
    review_reasons: Array.isArray(fn && fn.review_reasons) ? fn.review_reasons : [],
    semantic_hints: seed,
  };
}

function scopeRowSkeletons(functions, l3Skill) {
  return (Array.isArray(functions) ? functions : []).map((fn, index) => scopeRowSkeleton(fn, index, l3Skill));
}

function mergeReviewReasons(existing, extra) {
  const out = [];
  const add = (value) => {
    if (value == null || value === false) return;
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    const text = String(value).trim();
    if (text && !out.includes(text)) out.push(text);
  };
  add(existing);
  add(extra);
  return out;
}

function selectionReasonsForRow(row, scopedFacts) {
  const source = Array.isArray(scopedFacts) ? scopedFacts : [];
  const hits = source.filter((fact) => sameFunction(row, fact));
  if (hits.length !== 1) return [];
  const selection = hits[0] && hits[0]._selection || {};
  return Array.isArray(selection.review_reasons) ? selection.review_reasons : [];
}

function serviceSelectionReasonsForRow(row, scopedServices) {
  const source = Array.isArray(scopedServices) ? scopedServices : [];
  const hits = source.filter((svc) =>
    row &&
    svc &&
    moduleMatches(row.module, svc.module) &&
    row.impl_qn === svc.impl_qn &&
    (!row.iface_qn || !svc.iface_qn || row.iface_qn === svc.iface_qn) &&
    (!row.version || !svc.version || row.version === svc.version) &&
    (!row.group || !svc.group || row.group === svc.group)
  );
  if (hits.length !== 1) return [];
  const selection = hits[0] && hits[0]._selection || {};
  return Array.isArray(selection.review_reasons) ? selection.review_reasons : [];
}

function applyReviewReasons(rows, softByRow, scopedFacts) {
  let changed = false;
  const next = (Array.isArray(rows) ? rows : []).map((row, index) => {
    const reasons = mergeReviewReasons(row && row.review_reasons, [
      ...(softByRow && softByRow[index] ? softByRow[index] : []),
      ...selectionReasonsForRow(row, scopedFacts),
    ]);
    if (!reasons.length) return row;
    changed = true;
    return { ...row, review_required: true, review_reasons: reasons };
  });
  return { rows: next, changed };
}

function applyServiceReviewReasons(rows, softByRow, scopedServices) {
  let changed = false;
  const next = (Array.isArray(rows) ? rows : []).map((row, index) => {
    const reasons = mergeReviewReasons(row && row.review_reasons, [
      ...(softByRow && softByRow[index] ? softByRow[index] : []),
      ...serviceSelectionReasonsForRow(row, scopedServices),
    ]);
    if (!reasons.length) return row;
    changed = true;
    return { ...row, review_required: true, review_reasons: reasons };
  });
  return { rows: next, changed };
}

function collisionKeyFor(fn, serviceRow) {
  return [
    serviceBusinessName(serviceRow),
    String(fn && fn.method || "").toLowerCase(),
  ].join("#");
}

function uniquenessScopeKey(serviceRow) {
  return serviceBusinessName(serviceRow) || "未分类";
}

function scopeFunctionSummary(fn) {
  return {
    function_key: fn.function_key || fn.expected_id || "",
    module: fn.module || "",
    impl_qn: fn.impl_qn || "",
    iface_qn: fn.iface_qn || "",
    method: fn.method || "",
    signature: fn.signature || "",
    inherited_from: fn.inherited_from || "",
    entry: fn.entry || "",
    entry_type: fn.entry_type || fn.profile || "",
    return_type: fn.return_type || "",
    params: paramsFor(fn),
    method_doc: fn.method_doc || "",
    iface_doc: fn.iface_doc || "",
    impl_doc: fn.impl_doc || "",
    review_required: !!(fn.review_required || (fn._selection && Array.isArray(fn._selection.review_reasons) && fn._selection.review_reasons.length)),
    review_reasons: Array.isArray(fn.review_reasons) ? fn.review_reasons :
      (fn._selection && Array.isArray(fn._selection.review_reasons) ? fn._selection.review_reasons : []),
  };
}

function buildFunctionListEvidence(functions, services, serviceRows, downstream, models, tables, callgraph, graphFacts) {
  const rows = Array.isArray(functions) ? functions : [];
  const serviceByIndex = rows.map((fn) => serviceRowForFunction(fn, serviceRows, services));
  const groups = new Map();
  const uniquenessGroups = new Map();
  rows.forEach((fn, index) => {
    const serviceRow = serviceByIndex[index];
    const key = collisionKeyFor(fn, serviceRow);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ fn, index });
    const scopeKey = uniquenessScopeKey(serviceRow);
    if (!uniquenessGroups.has(scopeKey)) uniquenessGroups.set(scopeKey, { key: scopeKey, business_name: scopeKey, functions: [] });
    uniquenessGroups.get(scopeKey).functions.push(scopeFunctionSummary(fn));
  });

  const uniquenessScopes = Array.from(uniquenessGroups.values()).map((scope) => ({
    ...scope,
    count: scope.functions.length,
  }));

  const evidence = rows.map((fn, index) => {
    const serviceRow = serviceByIndex[index];
    const key = collisionKeyFor(fn, serviceRow);
    const siblings = (groups.get(key) || []).map(({ fn: item }) => ({
      function_key: item.function_key || item.expected_id || "",
      module: item.module || "",
      impl_qn: item.impl_qn || "",
      method: item.method || "",
      signature: item.signature || "",
      inherited_from: item.inherited_from || "",
      entry: item.entry || "",
      version: item.version || "",
      group: item.group || "",
      entry_type: item.entry_type || item.profile || "",
      params: paramsFor(item),
      model_types: Array.isArray(item.model_types) ? item.model_types : [],
    }));
    return {
      function_key: fn.function_key || fn.expected_id || "",
      expected_id: fn.expected_id || "",
      candidate_id: fn.candidate_id || "",
      module: fn.module || "",
      profile: fn.profile || "",
      impl_qn: fn.impl_qn || "",
      iface_qn: fn.iface_qn || "",
      service_iface: fn.service_iface || "",
      method: fn.method || "",
      signature: fn.signature || "",
      inherited_from: fn.inherited_from || "",
      return_type: fn.return_type || "",
      entry: fn.entry || "",
      entry_type: fn.entry_type || fn.profile || "",
      version: fn.version || "",
      group: fn.group || "",
      review_required: !!(fn.review_required || (fn._selection && Array.isArray(fn._selection.review_reasons) && fn._selection.review_reasons.length)),
      review_reasons: Array.isArray(fn.review_reasons) ? fn.review_reasons :
        (fn._selection && Array.isArray(fn._selection.review_reasons) ? fn._selection.review_reasons : []),
      params: paramsFor(fn),
      method_doc: fn.method_doc || "",
      iface_doc: fn.iface_doc || "",
      impl_doc: fn.impl_doc || "",
      model_types: Array.isArray(fn.model_types) ? fn.model_types : [],
      models: modelsFor(fn, models).map(slimModel),
      downstream: downstreamFor(fn, downstream).map(slimDownstream),
      tables: tablesFor(fn, tables).map(slimTable),
      callgraph: callgraphFor(fn, callgraph),
      graph_trace: graphSlice.graphSummary(graphSlice.graphSliceFor(fn, graphFacts)),
      source: sourceFor(fn),
      service_row: serviceRow || null,
      service_business_name: serviceBusinessName(serviceRow),
      uniqueness_scope_key: uniquenessScopeKey(serviceRow),
      collision_group: {
        key,
        size: siblings.length,
        siblings,
      },
    };
  });

  return {
    schemaVersion: 1,
    generated_at: new Date().toISOString(),
    repo,
    count: evidence.length,
    instruction: "Facts only. L3 business skill generates function_name/summary/business_domain from these facts; do not write these facts back with modifications.",
    uniquenessScopes,
    functions: evidence,
  };
}

function writeFunctionListEvidence(task, functions, services, serviceRows, downstream, models, tables, callgraph, graphFacts) {
  fs.mkdirSync(metadataDir, { recursive: true });
  const file = evidencePath(task);
  const pack = buildFunctionListEvidence(functions, services, serviceRows, downstream, models, tables, callgraph, graphFacts);
  writeJson(file, pack);
  return file;
}

function sourceFor(fn) {
  return {
    source_file: fn.source_file || "",
    iface_file: fn.iface_file || "",
    evidence: fn.evidence || {},
    confidence: fn.confidence || {},
  };
}

function codeIndexFor(fn, callgraph) {
  const items = [];
  if (fn && fn.impl_qn && fn.method) {
    items.push({
      class_qn: fn.impl_qn,
      method: fn.method,
      signature: fn.signature || "",
      role: "entry",
      description: `${fn.method} 方法入口，签名：${fn.signature || fn.method}`,
    });
  }
  const graph = callgraphFor(fn, callgraph);
  for (const callee of graph.callees || []) {
    items.push({
      class_qn: callee.to_impl || callee.impl_qn || callee.class_qn || "",
      method: callee.to_method || callee.method || "",
      signature: callee.signature || "",
      role: "callee",
      description: "一跳下游调用，职责需结合命名复核",
    });
  }
  return items.filter((item) => item.class_qn || item.method);
}

function factContext(task) {
  const modules = readJson(modulesFile, []);
  const services = readJson(servicesFile, []);
  const functions = readJson(functionsFile, []);
  const view = businessView();
  const inScopeServices = scopedServices(view, services);
  const inScopeFunctions = scopedFunctions(view, functions);
  const downstream = readJson(downstreamFile, []);
  const models = readJson(modelsFile, []);
  const tables = readJson(tablesFile, []);
  const callgraph = readJson(callgraphFile, { callees: {}, callers: {} });
  const graphFacts = {
    entities: readJson(entitiesFile, []),
    relations: readJson(relationsFile, []),
    expected: readJson(expectedFunctionsFile, []),
    topology: readJson(topologyFile, {}),
  };
  const moduleInfo = task.module ? (modules.find((m) => m.slug === task.module || m.relPath === task.relPath) || null) : null;
  const base = {
    repo,
    task: {
      id: task.id,
      kind: task.kind,
      module: task.module || "",
      relPath: task.relPath || "",
      output: task.output || "",
      finalOutput: task.boundOutput || task.finalOutput || "",
      metadataOutput: metadataPath(task),
    },
    module: moduleInfo,
    facts: {},
    requiredFacts: [],
  };

  if (task.kind === "function-doc") {
    const factsMode = isFunctionFactsMode(task);
    const functionKey = { ...(task.function || {}), module: (task.function && task.function.module) || task.module || "" };
    const fn = inScopeFunctions.find((row) => sameFunction(row, functionKey)) || functions.find((row) => sameFunction(row, functionKey)) || functionKey || {};
    const functionRow = findFunctionRow(task, readJson(tasksFile, [])).row;
    base.facts.function = fn;
    base.facts.functionRow = functionRow || null;
    base.facts.repairContext = task.repairContext || null;
    if (factsMode) base.facts.fsd = fsdContextForTask({ ...task, function: fn });
    base.facts.service = inScopeServices.find((s) =>
      s.module === fn.module &&
      (s.impl_qn === fn.impl_qn || s.service_iface === fn.service_iface || s.iface_qn === fn.iface_qn)
    ) || services.find((s) =>
      s.module === fn.module &&
      (s.impl_qn === fn.impl_qn || s.service_iface === fn.service_iface || s.iface_qn === fn.iface_qn)
    ) || null;
    base.facts.downstream = downstreamFor(fn, downstream);
    base.facts.models = modelsFor(fn, models);
    base.facts.tables = tablesFor(fn, tables);
    base.facts.callgraph = callgraphFor(fn, callgraph);
    base.facts.graph = graphSlice.graphSliceFor(fn, graphFacts);
    base.facts.codeIndex = codeIndexFor(fn, callgraph);
    base.facts.source = sourceFor(fn);
    base.facts.repo = {
      repo_artifact_id: fn.repo_artifact_id || base.facts.service?.repo_artifact_id || "",
      module_artifact_id: fn.module_artifact_id || base.facts.service?.module_artifact_id || "",
      repo_name: fn.repo_name || base.facts.service?.repo_name || path.basename(repo),
      version_repo_name: fn.version_repo_name || fn.repo_artifact_id || base.facts.service?.repo_artifact_id || fn.module_artifact_id || base.facts.service?.module_artifact_id || fn.repo_name || base.facts.service?.repo_name || path.basename(repo),
    };
    base.requiredFacts = factsMode ? [
      { field: "facts.function.impl_qn", required: true },
      { field: "facts.function.method", required: true },
      { field: "facts.function.signature", required: true },
      { field: "facts.fsd.fsdFactsFile", required: true, instruction: "Oracle-SP function-facts 模式必须先生成此 fsd-facts 合同；Markdown 只是投影。" },
      { field: "facts.fsd.renderedSkeleton", required: true, instruction: "优先以控制面渲染骨架为 FSD 输出基础，不得自由生成结构事实。" },
      { field: "facts.service", required: false, instruction: "服务事实缺失时按当前 Oracle-SP FSD 规则处理。" },
      { field: "facts.tables", required: false, instruction: "表事实只允许来自此数组；为空时按当前 Oracle-SP FSD 规则处理。" },
      { field: "facts.source", required: false, instruction: "仅作为源码路径引用和事实可信度判断，不允许读取这些文件。" },
    ] : [
      { field: "facts.function.impl_qn", required: true },
      { field: "facts.function.method", required: true },
      { field: "facts.function.signature", required: true },
      { field: "facts.functionRow", required: true, instruction: "功能文档的标题、文件名、简介类字段、类型类字段、入口类字段必须优先使用这条 function canonical row；具体命名禁忌按当前业务 skill 的 rules/validation 执行。" },
      { field: "facts.service", required: false, instruction: "服务事实缺失时按当前业务 skill 的缺失值规则处理。" },
      { field: "facts.downstream", required: false, instruction: "下游事实只允许来自此数组；为空时按当前业务 skill 的缺失值规则处理。" },
      { field: "facts.models", required: false, instruction: "入参/出参对象字段只允许来自此数组；为空时按当前业务 skill 的缺失值规则处理。" },
      { field: "facts.tables", required: false, instruction: "表事实只允许来自此数组；为空时按当前业务 skill 的缺失值规则处理。" },
      { field: "facts.callgraph", required: false, instruction: "功能概述和调用说明可参考此 1 跳调用事实，不得编造。" },
      { field: "facts.graph", required: false, instruction: "这是控制面按当前 task 裁剪的 L2 实体关系图切片；可用于解释服务-入口-方法-模型-调用关系，不要读取全量图文件。" },
      { field: "facts.codeIndex", required: false, instruction: "代码索引只允许来自此数组；不要读取源码补充。" },
      { field: "facts.source", required: false, instruction: "仅作为源码路径引用和事实可信度判断，不允许读取这些文件。" },
      { field: "facts.repo", required: false, instruction: "版本库名优先 repo_artifact_id，其次 module_artifact_id/repo_name。" },
    ];
    if (base.facts.repairContext) {
      base.requiredFacts.push({
        field: "facts.repairContext",
        required: true,
        instruction: "Previous done was rejected. Repair only the listed FSD markdown gaps/pollution for this task. Do not rerun from scratch and do not modify fsdFacts.",
      });
    }
  } else {
    base.facts.aggregate = {
      businessViewFile,
      metadataDir,
      instruction: "Aggregate tasks must use task-scoped facts below. businessViewFile is read-only audit context; do not read full knowledge services/functions files or generate rows from excluded/review facts.",
    };
    base.requiredFacts = [
      { field: "facts.aggregate.businessViewFile", required: true },
    ];
    if (task.kind === "function-list-scope") {
      const serviceRowsFile = serviceRowsFileFrom(readJson(tasksFile, []));
      const evidenceFile = task.facts && task.facts.evidenceFile || path.join(metadataDir, "function-list-scope", `${safeName(task.id)}.evidence.json`);
      const evidence = readJsonSafe(evidenceFile, {});
      const rowsFile = evidence && evidence.outputContract && evidence.outputContract.assembledRowsFile || (task.facts && task.facts.rowsFile) || "";
      base.facts.functionRows = {
        outputNamesFile: task.output,
        outputRowsFile: rowsFile,
        columnsConf: functionListColumns(task.l3Skill || ""),
        serviceRowsFile,
        evidenceFile,
        count: Number(evidence.count || (Array.isArray(evidence.functions) ? evidence.functions.length : 0)),
        scopeKeys: Array.isArray(evidence.scopeKeys) ? evidence.scopeKeys : [],
        outputContract: evidence.outputContract || {
          kind: "names-map",
          outputNamesFile: task.output,
          assembledRowsFile: rowsFile,
        },
        evidenceSchema: {
          file: evidenceFile,
          topLevel: ["schemaVersion", "count", "scopeKeys", "scopes", "uniquenessScopes", "rowSkeletons", "functions"],
          functionFields: [
            "function_key", "module", "impl_qn", "iface_qn", "method", "signature", "entry",
            "entry_type", "version", "group", "params", "inherited_from", "method_doc", "iface_doc", "impl_doc",
            "model_types", "models", "downstream", "tables", "service_row", "service_business_name",
            "uniqueness_scope_key", "collision_group", "graph_trace",
          ],
        },
        rowSchema: [
          "function_id", "app", "business_name", "business_domain", "function_type",
          "function_name", "summary", "service_id", "entry_type", "iface_qn", "version", "entry",
          "method", "module", "impl_qn", "signature", "review_required", "review_reasons",
        ],
        namesMapSchema: {
          "<function_id>": ["function_name", "summary", "business_domain?"],
        },
        instruction: [
          "This is a function-list-scope task. Only generate a names map for evidenceFile.functions and write outputNamesFile.",
          "Do not generate canonical rows. The control plane assembles rows from evidence.rowSkeletons plus your function_name/summary.",
          "Do not read full knowledge files or businessViewFile to expand scope.",
          "business_name must inherit the matching service row; function_name must be unique within each scopeKey.",
          "Do not write Markdown/CSV/XLSX or helper scripts.",
        ].join(" "),
      };
      base.requiredFacts.push({ field: "facts.functionRows.outputNamesFile", required: true });
      base.requiredFacts.push({ field: "facts.functionRows.outputRowsFile", required: false, instruction: "控制面组装后的 rows 文件，worker 不要直接写。" });
      base.requiredFacts.push({ field: "facts.functionRows.serviceRowsFile", required: true });
      base.requiredFacts.push({ field: "facts.functionRows.evidenceFile", required: true });
    } else if (task.kind === "function-list") {
      // function-list 产出"过渡 function canonical rows"(JSON 数组)，不直接写 MD/CSV(由控制面确定性导出)。
      const serviceRowsFile = serviceRowsFileFrom(readJson(tasksFile, []));
      const serviceRows = readJsonSafe(serviceRowsFile, []);
      const evidenceFile = writeFunctionListEvidence(task, inScopeFunctions, inScopeServices, serviceRows, downstream, models, tables, callgraph, graphFacts);
      base.facts.functionRows = {
        outputRowsFile: task.output,
        columnsConf: functionListColumns(task.l3Skill || ""),
        serviceRowsFile,
        evidenceFile,
        evidenceSchema: {
          file: evidenceFile,
          topLevel: ["schemaVersion", "count", "uniquenessScopes", "functions"],
          functionFields: [
            "function_key", "module", "impl_qn", "iface_qn", "method", "signature", "entry",
            "entry_type", "version", "group", "params", "inherited_from", "method_doc", "iface_doc", "impl_doc",
            "model_types", "models", "downstream", "tables", "service_row", "service_business_name",
            "uniqueness_scope_key", "collision_group", "graph_trace",
          ],
        },
        rowSchema: [
          "function_id", "app", "business_name", "business_domain", "function_type",
          "function_name", "summary", "service_id", "entry_type", "iface_qn", "version", "entry",
          "method", "module", "impl_qn", "signature", "review_required", "review_reasons",
        ],
        instruction: [
          "优先读取 evidenceFile；为 evidenceFile.functions 每个 in-scope 功能生成一行 canonical row，组成 JSON 数组写入 outputRowsFile（行数必须等于 evidenceFile.count/functions 数）。",
          "必须读取 serviceRowsFile；business_name 必须继承匹配 service row 的 service_category/service_name，格式为 service_category/service_name，不要重新生成服务名或服务分类。",
          "业务语义(function_name/summary/business_domain)只能依据 evidenceFile 中的 method_doc/iface_doc/impl_doc/params/models/downstream/tables/collision_group/graph_trace 与 businessContext 的 rules/validation 生成。",
          "必须读取 evidenceFile.uniquenessScopes；同一 business_name/uniqueness_scope_key 内 function_name 不能重复。写 rows 前先在本地检查重复，若候选名重复，必须根据 method_doc/method/params/signature/return_type 加中文业务限定词区分。",
          "collision_group 只用于提示可能重名；不得把 module/profile/artifactId/英文 slug 拼进 function_name。",
          "function_type 必须按 businessContext.validation.functionTypeByEntryType 根据 entry_type 映射；禁止输出裸 rpc/http/controller 等技术 profile。",
          "事实字段(service_id/entry_type/iface_qn/version/group/entry/method/impl_qn/module/signature)直接取自 evidenceFile 中的对应功能事实；entry 已是派生好的完整入口，原样使用。",
          "禁止写 .md/.csv（控制面会从 rows 确定性导出），禁止写任何生成脚本(generate-*.js 等)。",
        ].join(" "),
      };
      base.requiredFacts.push({ field: "facts.functionRows.outputRowsFile", required: true });
      base.requiredFacts.push({ field: "facts.functionRows.serviceRowsFile", required: true });
      base.requiredFacts.push({ field: "facts.functionRows.evidenceFile", required: true });
    } else if (task.kind === "service-list") {
      base.facts.serviceRows = {
        outputRowsFile: task.output,
        columnsConf: serviceListColumns(task.l3Skill || ""),
        businessViewFile,
        services: inScopeServices.map(slimService),
        count: inScopeServices.length,
        rowSchema: [
          "service_id", "service_name", "service_category", "impl_qn", "iface_qn",
          "service_iface", "config", "version", "module", "review_required",
        ],
        instruction: [
          "优先使用 factContext.facts.serviceRows.services；为每个 in-scope 服务生成一行 service canonical row，组成 JSON 数组写入 outputRowsFile（行数必须等于 serviceRows.count）。",
          "事实字段(impl_qn/iface_qn/service_iface/config/version/module)直接取自 factContext.facts.serviceRows.services。",
          "服务名称和服务分类按 businessContext 的 rules/validation 生成。",
          "禁止写 .md/.csv（控制面会从 rows 确定性导出），禁止写任何生成脚本(generate-*.js 等)。",
        ].join(" "),
      };
      base.requiredFacts.push({ field: "facts.serviceRows.outputRowsFile", required: true });
    }
  }

  return base;
}

function claimOnce(agent, kind) {
  return withStateLock(() => {
    let { tasks, state } = load();
    let repaired = repairFakeDone(tasks, state);
    if (repairStaleFunctionDocBindings(tasks, state)) repaired = true;
    const scoped = materializeFunctionListScopesIfReady(tasks, state);
    if (scoped.changed) {
      tasks = scoped.tasks;
      repaired = true;
    }
    if (reapStaleFunctionListScopes(tasks, state)) repaired = true;
    if (reapStaleFunctionDocs(tasks, state)) repaired = true;
    if (repairFailedFunctionListScopes(tasks, state)) repaired = true;
    const merged = tryFinalizeFunctionListMerge(tasks, state);
    if (merged.changed) repaired = true;
    const functionListItem = state.tasks && state.tasks["l3__function-list"];
    const mustValidateFunctionRows = functionListItem && functionListItem.status === "done";
    const rowsCheck = mustValidateFunctionRows ? validateCurrentFunctionRows(tasks) : { ok: true };
    if (mustValidateFunctionRows && !rowsCheck.ok) {
      for (const task of tasks) {
        if (!task || task.kind !== "function-doc") continue;
        const item = state.tasks && state.tasks[task.id];
        if (!item) continue;
        const status = item.status || "pending";
        if (status !== "pending" && status !== "running") continue;
        state.tasks[task.id] = {
          ...item,
          output: "",
          boundOutput: "",
          needs_review: true,
          status: "pending",
          agent: "",
          completed_by: "",
          started_at: "",
          finished_at: "",
          error: rowsCheck.reason,
        };
        repaired = true;
      }
      if (functionListItem && functionListItem.status === "done") {
        state.tasks["l3__function-list"] = {
          ...functionListItem,
          status: "pending",
          agent: "",
          completed_by: "",
          started_at: "",
          finished_at: "",
          error: rowsCheck.reason,
        };
        repaired = true;
      }
    }
    if (repaired) save(state);
    if (mustValidateFunctionRows && !rowsCheck.ok && kind === "function-doc") {
      writeValidationDiagnostic("l3__function-list", state.tasks && state.tasks["l3__function-list"] || {}, rowsCheck, "pending");
      return { type: "message", text: `NO_READY_TASK ${rowsCheck.reason}` };
    }

    const existing = runningItems(state).find((item) => item.agent === agent);
    if (existing) {
      const existingTask = tasks.find((t) => t.id === existing.id);
      return existingTask ? { type: "task", task: bindFunctionDocOutput(existingTask, existing, tasks) } : { type: "message", text: `ALREADY_RUNNING id=${existing.id} agent=${agent}` };
    }
    const concurrency = Math.max(1, Math.floor(Number(state.concurrency) || 1));
    const running = runningItems(state).length;
    if (running >= concurrency) return { type: "message", text: `NO_SLOT running=${running} concurrency=${concurrency}` };

    const task = tasks.find((t) => {
      if (isControlPlaneOnly(t)) return false;
      const item = state.tasks && state.tasks[t.id];
      const status = item && item.status ? item.status : "pending";
      return status === "repair_pending" && (!kind || t.kind === kind) && depsDone(t, state);
    }) || tasks.find((t) => {
      if (isControlPlaneOnly(t)) return false;
      const item = state.tasks && state.tasks[t.id];
      const status = item && item.status ? item.status : "pending";
      return status === "pending" && (!kind || t.kind === kind) && depsDone(t, state);
    });

    if (!task) {
      // 区分"无 pending"与"有 pending 但上游未就绪"，便于滚动 DAG 排障
      const blocked = tasks.some((t) => {
        if (isControlPlaneOnly(t)) return false;
        const item = state.tasks && state.tasks[t.id];
        const status = item && item.status ? item.status : "pending";
        return isClaimableStatus(status) && (!kind || t.kind === kind) && !depsDone(t, state);
      });
      if (blocked && running === 0) return { type: "message", text: "NO_READY_TASK blocked_without_running" };
      return { type: "message", text: blocked ? "NO_READY_TASK waiting_on_upstream_deps" : "NO_TASK" };
    }

    const item = state.tasks[task.id] || {};
    const claimTask = bindFunctionDocOutput(task, item, tasks);
    if (item.repairContext) claimTask.repairContext = item.repairContext;
    if (claimTask.kind === "function-doc") {
      const docsDir = docsDirForSkill(claimTask.l3Skill || "");
      const factsMode = isFunctionFactsMode(claimTask);
      const outputPathOk = factsMode
        ? isWithinDir(claimTask.output, l3DraftsDir) && isWithinDir(claimTask.boundOutput, docsDir)
        : isWithinDir(claimTask.output, docsDir);
      if (!claimTask.output || !claimTask.boundOutput || claimTask.needs_review || !outputPathOk) {
        state.tasks[task.id] = {
          ...item,
          output: "",
          boundOutput: "",
          needs_review: true,
          status: "pending",
          agent: "",
          completed_by: "",
          started_at: "",
          finished_at: "",
          error: "function-doc claim blocked: canonical function row/output unavailable",
        };
        save(state);
        return { type: "message", text: "NO_READY_TASK function_doc_binding_unavailable" };
      }
      if (factsMode) {
        const fsdMaterialized = materializeFsdFactsForTask(claimTask);
        if (!fsdMaterialized.ok) {
          state.tasks[task.id] = {
            ...item,
            output: claimTask.output || "",
            boundOutput: claimTask.boundOutput || item.boundOutput || "",
            needs_review: true,
            status: "pending",
            agent: "",
            completed_by: "",
            started_at: "",
            finished_at: "",
            error: `function-doc claim blocked: ${fsdMaterialized.reason || "fsd-facts materialization failed"}`,
          };
          save(state);
          return { type: "message", text: `NO_READY_TASK fsd_facts_materialization_failed ${fsdMaterialized.reason || ""}`.trim() };
        }
        const draftReady = ensureFsdDraftSkeleton(claimTask);
        if (!draftReady.ok) {
          state.tasks[task.id] = {
            ...item,
            output: claimTask.output || "",
            boundOutput: claimTask.boundOutput || item.boundOutput || "",
            finalOutput: claimTask.finalOutput || claimTask.boundOutput || item.finalOutput || "",
            needs_review: true,
            status: "pending",
            agent: "",
            completed_by: "",
            started_at: "",
            finished_at: "",
            error: `function-doc claim blocked: ${draftReady.reason || "draft skeleton failed"}`,
          };
          save(state);
          return { type: "message", text: `NO_READY_TASK fsd_draft_skeleton_failed ${draftReady.reason || ""}`.trim() };
        }
        removeUnpublishedFunctionDocFinal({ ...item, status: "pending", output: claimTask.output, boundOutput: claimTask.boundOutput, l3Skill: claimTask.l3Skill }, claimTask);
      }
    }
    state.tasks[task.id] = {
      ...item,
      id: claimTask.id,
      kind: claimTask.kind,
      module: claimTask.module || "",
      relPath: claimTask.relPath || "",
      output: claimTask.output || "",
      boundOutput: claimTask.boundOutput || item.boundOutput || "",
      finalOutput: claimTask.finalOutput || claimTask.boundOutput || item.finalOutput || "",
      needs_review: !!(claimTask.needs_review || item.needs_review),
      l3Skill: claimTask.l3Skill || state.l3Skill || "",
      status: "running",
      attempts: (item.attempts || 0) + 1,
      agent,
      completed_by: "",
      started_at: new Date().toISOString(),
      finished_at: "",
      error: "",
    };
    save(state);
    return { type: "task", task: claimTask };
  });
}

function claim() {
  const agent = requireAgent(argValue("--agent", ""));
  const kind = argValue("--kind", "");
  const result = claimOnce(agent, kind);

  if (result.type === "message") {
    console.log(result.text);
    return;
  }
  const task = result.task;
  const l3Skill = task.l3Skill || "";
  console.log(JSON.stringify({
    id: task.id,
    kind: task.kind,
    l3Skill,
    module: task.module || "",
    relPath: task.relPath || "",
    output: task.output || "",
    finalOutput: task.boundOutput || task.finalOutput || "",
    businessContext: businessContext(l3Skill),
    factContext: factContext(task),
    commands: commandSet(task, agent),
    workerContract: [
      "Use businessContext as the business rule context: read SKILL.md, templates, and rules from those paths.",
      "Use factContext as the current task fact context.",
      "Generate only factContext.task.output. If factContext.task.finalOutput exists, it is read-only and will be published by the control plane after done passes.",
      "Do not read tasks.json.",
      "Function-doc tasks must use only factContext.facts; aggregate tasks may read files listed in factContext.facts.aggregate.",
      "Do not scan source code or call codegraph.",
      "Do not read source files referenced by facts.source; use facts.codeIndex/source paths only as facts.",
      "After writing output, run commands.done. If commands.done is rejected, stop after reporting the rejection; the next claim will include repairContext.",
    ],
  }, null, 2));
}

function reapCommand() {
  withStateLock(() => {
    let { tasks, state } = load();
    let changed = false;
    const scoped = materializeFunctionListScopesIfReady(tasks, state);
    if (scoped.changed) {
      tasks = scoped.tasks;
      changed = true;
    }
    if (reapStaleFunctionListScopes(tasks, state)) changed = true;
    if (reapStaleFunctionDocs(tasks, state)) changed = true;
    if (repairFakeDoneFunctionDocs(tasks, state)) changed = true;
    if (repairFailedFunctionListScopes(tasks, state)) changed = true;
    if (tryFinalizeFunctionListMerge(tasks, state).changed) changed = true;
    if (changed) save(state);
    const snapshot = progressSnapshot(state, tasks);
    console.log(`[L3-reaper] changed=${changed ? 1 : 0} running=${snapshot.running}/${snapshot.concurrency} ready=${snapshot.ready} blocked=${snapshot.blocked} dispatch=${snapshot.dispatch} failed=${snapshot.failed} pending=${snapshot.pending}`);
  });
}

function complete(status) {
  const id = argValue("--id");
  const agent = requireAgent(argValue("--agent", ""));
  const error = argValue("--error", "");
  if (!id) throw new Error("missing --id <task-id>");
  let output = "";
  let snapshot = null;
  withStateLock(() => {
    const { tasks, state } = load();
    const item = state.tasks && state.tasks[id];
    if (!item) throw new Error(`unknown task ${id}`);
    if (item.status !== "running") throw new Error(`task ${id} is not running; current status=${item.status || "pending"}`);
    if (item.agent && item.agent !== agent) throw new Error(`task ${id} is claimed by ${item.agent}, not ${agent}`);
    const taskDef = tasks.find((t) => t.id === id) || {};
    const factsModeFunctionDoc = item.kind === "function-doc" && isFunctionFactsMode(item);
    let doneExtra = {};

    if (status === "done") {
      const checked = outputStatus(item.output);
      if (!checked.ok) {
        state.tasks[id] = {
          ...item,
          status: "pending",
          agent: "",
          completed_by: "",
          started_at: "",
          finished_at: "",
          error: `done rejected: ${checked.reason}`,
        };
        save(state);
        throw new Error(`done rejected id=${id}: ${checked.reason}; task reset to pending`);
      }
      const outputAllowedDir = factsModeFunctionDoc ? l3DraftsDir : docsDirForSkill(item.l3Skill || "");
      if (!isWithinDir(checked.output, outputAllowedDir)) {
        state.tasks[id] = {
          ...item,
          status: "pending",
          agent: "",
          completed_by: "",
          started_at: "",
          finished_at: "",
          error: factsModeFunctionDoc ? "done rejected: draft output path is outside .repowiki/l3-drafts" : "done rejected: output path is outside skill docsDir",
        };
        save(state);
        throw new Error(`done rejected id=${id}: ${factsModeFunctionDoc ? "draft output path is outside .repowiki/l3-drafts" : "output path is outside skill docsDir"}; task reset to pending`);
      }
      // service-list：校验 canonical rows 并确定性导出 MD/CSV；不合格则打回 pending。
      if (item.kind === "service-list") {
        const fin = finalizeServiceList(item);
        if (!fin.ok) {
          state.tasks[id] = {
            ...item, status: "pending", agent: "", completed_by: "", started_at: "", finished_at: "",
            error: `done rejected: ${fin.reason}`,
          };
          save(state);
          throw new Error(`done rejected id=${id}: ${fin.reason}; task reset to pending`);
        }
      }
      // function-list：校验 canonical rows 并确定性导出 MD/CSV；不合格则打回 pending（堵假完成/脚本伪造）
      if (item.kind === "function-list") {
        const fin = finalizeFunctionList(item, tasks);
        if (!fin.ok) {
          const nextItem = rejectDoneState(item, fin);
          state.tasks[id] = nextItem;
          writeValidationDiagnostic(id, item, fin, nextItem.status);
          save(state);
          throw new Error(`done rejected id=${id}: ${fin.reason}; task ${rejectedStatusText(nextItem)}`);
        }
      }
      if (item.kind === "function-list-scope") {
        const fin = finalizeFunctionListScope(item);
        if (!fin.ok) {
          const fallback = tryDedupeFallbackForScope(item, fin);
          if (fallback && fallback.ok) {
            // Continue to mark the scope done below; fallback rows are review-tagged.
          } else {
          cleanupScopeRowsSidecar(item, readJsonSafe(item.facts && item.facts.evidenceFile || "", null));
          const nextItem = rejectDoneState(item, fin);
          state.tasks[id] = nextItem;
          writeValidationDiagnostic(id, item, fin, nextItem.status);
          save(state);
          throw new Error(`done rejected id=${id}: ${fin.reason}; task ${rejectedStatusText(nextItem)}`);
          }
        }
      }
      // function-doc：校验与 function row 的一致性（boundary 2），不重复产语义字段
      if (item.kind === "function-doc") {
        const fin = finalizeFunctionDoc(item, taskDef, tasks);
        if (!fin.ok) {
          if (factsModeFunctionDoc) removeUnpublishedFunctionDocFinal(item, taskDef);
          const nextItem = rejectDoneState(item, fin);
          state.tasks[id] = nextItem;
          writeValidationDiagnostic(id, item, fin, nextItem.status);
          save(state);
          throw new Error(`done rejected id=${id}: ${fin.reason}; task ${rejectedStatusText(nextItem)}`);
        }
        if (factsModeFunctionDoc) {
          const published = publishFunctionDocDraft(item, taskDef);
          if (!published.ok) {
            const finPublish = { ok: false, reason: published.reason || "publish final output failed" };
            const nextItem = rejectDoneState(item, finPublish);
            state.tasks[id] = nextItem;
            writeValidationDiagnostic(id, item, finPublish, nextItem.status);
            save(state);
            throw new Error(`done rejected id=${id}: ${finPublish.reason}; task ${rejectedStatusText(nextItem)}`);
          }
          doneExtra = {
            boundOutput: published.finalOutput,
            finalOutput: published.finalOutput,
            needs_review: false,
          };
          output = published.finalOutput;
        }
      }
    }

    state.tasks[id] = {
      ...item,
      ...doneExtra,
      status,
      agent,
      completed_by: status === "done" ? "l3-skill" : "",
      finished_at: new Date().toISOString(),
      error: status === "failed" ? error : "",
      repairContext: status === "done" ? null : (item.repairContext || null),
    };
    if (status === "done" && item.kind === "service-list") {
      const scoped = materializeFunctionListScopesIfReady(tasks, state);
      if (scoped.changed) tasks.splice(0, tasks.length, ...scoped.tasks);
    }
    if (status === "done" && item.kind === "function-list-scope") {
      tryFinalizeFunctionListMerge(tasks, state);
    }
    if (!output) output = doneExtra.finalOutput || item.boundOutput || item.finalOutput || item.output || "";
      snapshot = progressSnapshot(state, tasks);
      save(state);
  });
  const progress = snapshot ? ` progress=${snapshot.realDone}/${snapshot.total} running=${snapshot.running}/${snapshot.concurrency} ready=${snapshot.ready} blocked=${snapshot.blocked} dispatch=${snapshot.dispatch} failed=${snapshot.failed} pending=${snapshot.pending}` : "";
  console.log(`[L3-task] ${status} id=${id}${progress} output=${output}`);
}

try {
  if (command === "claim") claim();
  else if (command === "reap") reapCommand();
  else if (command === "done") complete("done");
  else if (command === "fail") complete("failed");
  else {
    console.error("usage:");
    console.error("  node repowiki-l3-task.cjs claim <repo> --agent <name> [--kind <kind>]");
    console.error("  node repowiki-l3-task.cjs reap <repo>");
    console.error("  node repowiki-l3-task.cjs done <repo> --id <task-id> [--agent <name>]");
    console.error("  node repowiki-l3-task.cjs fail <repo> --id <task-id> --error <message> [--agent <name>]");
    process.exit(2);
  }
} catch (e) {
  console.error(`[L3-task] ${e.message}`);
  process.exit(1);
}
