#!/usr/bin/env node
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { repowikiWorkDir } = require(path.join(__dirname, "lib", "repowiki-workdir.cjs"));

const repo = path.resolve(process.argv[2] || ".");
const phase = (process.argv[3] || "").toLowerCase();
const verbose = process.argv.includes("--verbose");
const lineOnly = process.argv.includes("--line");
const repowikiDir = repowikiWorkDir(repo);
const knowledgeDir = path.join(repowikiDir, "knowledge");
const codegraphStateFile = path.join(repowikiDir, "codegraph-init.json");
const modulesFile = path.join(repowikiDir, "modules.json");
const functionsFile = path.join(knowledgeDir, "functions.json");
const servicesFile = path.join(knowledgeDir, "services.json");
const schemaReportFile = path.join(knowledgeDir, "l2-schema-report.json");
const completenessFile = path.join(knowledgeDir, "l2-completeness.json");
const diagnosisFile = path.join(knowledgeDir, "l2-diagnosis.json");
const schedulerDir = path.join(repowikiDir, "l3-scheduler");
const tasksFile = path.join(schedulerDir, "tasks.json");
const stateFile = path.join(schedulerDir, "state.json");
const fsdFactsDir = path.join(repowikiDir, "fsd-facts");
const fsdCoverageSummaryFile = path.join(schedulerDir, "metadata", "fsd-coverage.json");
const partsDir = path.join(knowledgeDir, "parts");
const CURRENT_FACT_SCHEMA_VERSION = 9;
const CURRENT_COMPLETENESS_SCHEMA_VERSION = 3;

function exists(file) {
  return fs.existsSync(file);
}

function readJson(file, defaultValue) {
  if (!exists(file)) return defaultValue;
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function fsdFactsPathForOutput(output) {
  const normalized = String(output || "").replace(/\\/g, "/");
  let rel = [];
  const docsFsd = path.join(repo, "docs", "fsd");
  const outputAbs = path.resolve(output || "");
  const relToDocsFsd = path.relative(docsFsd, outputAbs);
  if (relToDocsFsd && !relToDocsFsd.startsWith("..") && !path.isAbsolute(relToDocsFsd)) {
    rel = relToDocsFsd.split(/[\\/]+/).filter(Boolean);
  } else {
    const parts = normalized.split("/").filter(Boolean);
    if (parts[0] !== "fsd" || parts.length < 3) return "";
    rel = parts.slice(1);
  }
  const fileBase = path.basename(rel[rel.length - 1], path.extname(rel[rel.length - 1]));
  return path.join(fsdFactsDir, ...rel.slice(0, -1), `${fileBase}.json`);
}

function fsdCoverageStats(rows) {
  const fsdRows = rows.filter((row) => Boolean(fsdFactsPathForOutput(rowOutput(row))));
  const factsDone = fsdRows.filter((row) => exists(fsdFactsPathForOutput(rowOutput(row)))).length;
  const summary = readJson(fsdCoverageSummaryFile, { reports: [] });
  const reports = Array.isArray(summary.reports) ? summary.reports : [];
  const okReports = reports.filter((row) => row && row.ok).length;
  const warnReports = reports.filter((row) => row && row.ok && row.actualOk === false).length;
  return { total: fsdRows.length, factsDone, diagDone: okReports, warnReports };
}

function progressBar(done, total, width = 24) {
  const pct = total ? done / total : 1;
  const filled = Math.round(pct * width);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}] ${done}/${total} ${(pct * 100).toFixed(1)}%`;
}

function percentBar(progress, width = 24) {
  const pct = Math.max(0, Math.min(100, Number(progress) || 0));
  const filled = Math.round((pct / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}] ${pct}/100 ${pct.toFixed(1)}%`;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function readTail(file, bytes = 256 * 1024) {
  if (!file || !exists(file)) return "";
  const stat = fs.statSync(file);
  const size = Math.min(stat.size, bytes);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseCodegraphTail(file) {
  const clean = readTail(file).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const lines = clean.split(/[\r\n]+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  let progress = null;
  let phase = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = line.match(/\b(Scanning files|Parsing code|Resolving refs|Storing data|Indexing files|Indexed files)\b.*?\b(\d{1,3})%/i)
      || line.match(/\b(\d{1,3})%\b.*?\b(Scanning files|Parsing code|Resolving refs|Storing data|Indexing files|Indexed files)\b/i);
    if (!m) continue;
    const firstIsPercent = /^\d/.test(m[1]);
    progress = Number(firstIsPercent ? m[1] : m[2]);
    phase = firstIsPercent ? m[2] : m[1];
    break;
  }
  return { progress, phase };
}

function printRemain(modules) {
  console.log("# remaining modules: relPath | absPath | slug");
  for (const mod of modules) console.log(`REMAIN | ${mod.relPath} | ${mod.absPath} | ${mod.slug}`);
}

function l2Done(mod) {
  return ["services", "functions", "downstream", "models", "meta", "entry-candidates", "entities", "relations", "expected-functions", "coverage-ledger"]
    .every((kind) => exists(path.join(partsDir, `${kind}.part-${mod.slug}.json`)));
}

function docExists(file) {
  if (!file) return false;
  const output = path.isAbsolute(file) ? file : path.resolve(repo, file);
  return exists(output) && fs.statSync(output).isFile() && fs.statSync(output).size > 20;
}

function reportL1() {
  const state = readJson(codegraphStateFile, null);
  if (!state) {
    console.log("PHASE: L1");
    console.log(`PROGRESS l1 ${progressBar(0, 1)}`);
    console.log("NEXT: run repowiki-codegraph-init.cjs <repo> --interval 30");
    return;
  }
  const status = state.status || "unknown";
  const tail = status === "done" ? { progress: 100, phase: "Done" } : parseCodegraphTail(state.logFile);
  const live = isAlive(state.pid);
  const currentProgress = tail.progress !== null ? tail.progress : state.progress;
  const currentPhase = tail.phase || state.phase || "unknown";
  const progress = currentProgress === null || currentProgress === undefined ? "?" : `${currentProgress}%`;
  console.log(`# [L1] status=${status} progress=${progress} phase=${currentPhase} alive=${live ? "yes" : "no"} pid=${state.pid || "-"} files=${state.fileCount || 0} nodes=${state.nodeCount || 0}`);
  if (state.logFile) console.log(`# log=${path.basename(state.logFile)}`);
  if (status === "done") {
    console.log(`PROGRESS l1 ${progressBar(1, 1)}`);
    console.log("ALL_DONE l1");
  } else {
    console.log(`PROGRESS l1 ${currentProgress === null || currentProgress === undefined ? progressBar(0, 1) : percentBar(currentProgress)}`);
    if (live) console.log("WAIT: L1 codegraph is still running; do not start another command.");
    else console.log("NEXT: run repowiki-codegraph-init.cjs <repo> --interval 30");
  }
}

if (!phase) {
  const l1 = readJson(codegraphStateFile, null);
  if (l1 && l1.status && l1.status !== "done") {
    console.log("PHASE: L1");
    reportL1();
    process.exit(0);
  }
}

if (!exists(modulesFile)) {
  if (phase === "l1") {
    reportL1();
  } else {
    const l1 = readJson(codegraphStateFile, null);
    if (l1 && l1.status && l1.status !== "done") {
      console.log("PHASE: L1");
      reportL1();
    } else {
      console.log("PHASE: ENUMERATE");
      console.log("NEXT: run list-services.cjs <repo> --profile auto");
    }
  }
  process.exit(0);
}

const modules = readJson(modulesFile, []);
const functions = readJson(functionsFile, []);
function maybeReapL3() {
  if (phase !== "l3" && phase !== "") return;
  if (!exists(tasksFile) || !exists(stateFile)) return;
  const taskCli = path.join(__dirname, "repowiki-l3-task.cjs");
  if (!exists(taskCli)) return;
  try {
    childProcess.execFileSync(process.execPath, [taskCli, "reap", repo], { stdio: "ignore" });
  } catch (_) {
    // Progress must remain read-mostly; stale running repair is best effort.
  }
}

maybeReapL3();

const tasks = readJson(tasksFile, []);
const state = readJson(stateFile, { tasks: {} });
const l2Remaining = modules.filter((mod) => !l2Done(mod));

function completenessState() {
  if (!exists(schemaReportFile)) return "missing";
  const schema = readJson(schemaReportFile, {});
  if (schema.status !== "passed") return "failed";
  if (Number(schema.schemaVersion || 0) < CURRENT_FACT_SCHEMA_VERSION) return "schema-stale";
  if (!exists(completenessFile)) return "missing";
  const report = readJson(completenessFile, {});
  if (Number(report.schemaVersion || 0) < CURRENT_COMPLETENESS_SCHEMA_VERSION) return "completeness-stale";
  return report.status || "unknown";
}

function reportL2() {
  const done = modules.length - l2Remaining.length;
  const partServices = modules.filter((mod) => exists(path.join(partsDir, `services.part-${mod.slug}.json`))).length;
  const partFunctions = modules.filter((mod) => exists(path.join(partsDir, `functions.part-${mod.slug}.json`))).length;
  const partDownstream = modules.filter((mod) => exists(path.join(partsDir, `downstream.part-${mod.slug}.json`))).length;
  const partModels = modules.filter((mod) => exists(path.join(partsDir, `models.part-${mod.slug}.json`))).length;
  const partMeta = modules.filter((mod) => exists(path.join(partsDir, `meta.part-${mod.slug}.json`))).length;
  const partEntryCandidates = modules.filter((mod) => exists(path.join(partsDir, `entry-candidates.part-${mod.slug}.json`))).length;
  const partEntities = modules.filter((mod) => exists(path.join(partsDir, `entities.part-${mod.slug}.json`))).length;
  const partRelations = modules.filter((mod) => exists(path.join(partsDir, `relations.part-${mod.slug}.json`))).length;
  const partExpected = modules.filter((mod) => exists(path.join(partsDir, `expected-functions.part-${mod.slug}.json`))).length;
  const partCoverageLedger = modules.filter((mod) => exists(path.join(partsDir, `coverage-ledger.part-${mod.slug}.json`))).length;
  console.log(`# [L2] realParts services=${partServices}/${modules.length} functions=${partFunctions}/${modules.length} downstream=${partDownstream}/${modules.length} models=${partModels}/${modules.length} meta=${partMeta}/${modules.length} entryCandidates=${partEntryCandidates}/${modules.length} entities=${partEntities}/${modules.length} relations=${partRelations}/${modules.length} expected=${partExpected}/${modules.length} coverageLedger=${partCoverageLedger}/${modules.length} remaining=${l2Remaining.length}`);
  const srep = readJson(schemaReportFile, null);
  if (srep) {
    console.log(`# [L2-schema] status=${srep.status || "unknown"} schemaVersion=${srep.schemaVersion || "?"} modules=${srep.modules || 0} meta=${srep.metaParts || 0} valid=${srep.parts || 0} failed=${(srep.failed || []).length}`);
  }
  const crep = readJson(completenessFile, null);
  if (crep) {
    const sum = crep.summary || {};
    console.log(`# [L2-completeness] status=${crep.status || "unknown"} schemaVersion=${crep.schemaVersion || "?"} scope=${crep.scope || "unknown"} candidates=${sum.candidates || 0} unique=${sum.uniqueCandidates || 0} expected=${sum.expectedFunctions || 0} functions=${sum.functions || 0} declaredExposures=${sum.declaredExposures || 0} resolvedBindings=${sum.resolvedBindings || 0} unresolvedBindings=${sum.unresolvedBindings || 0} unexplained=${sum.unexplainedSymbols || 0} missing=${sum.missingFunctions || 0} duplicateFunctions=${sum.duplicateFunctionKeys || 0} duplicateCandidates=${sum.duplicateCandidateIds || 0} zeroCandidateModules=${sum.zeroCandidateModules || 0} diagnostics=${sum.diagnostics || 0} warnings=${sum.warnings || 0}`);
  }
  const drep = readJson(diagnosisFile, null);
  if (drep && Array.isArray(drep.diagnostics) && drep.diagnostics.length) {
    const byLayer = {};
    for (const item of drep.diagnostics) byLayer[item.likely_layer || "unknown"] = (byLayer[item.likely_layer || "unknown"] || 0) + 1;
    console.log(`# [L2-diagnosis] diagnostics=${drep.diagnostics.length} ${Object.keys(byLayer).sort().map((k) => `${k}=${byLayer[k]}`).join(" ")}`);
  }
  if (drep && Array.isArray(drep.warnings) && drep.warnings.length) {
    const byLayer = {};
    for (const item of drep.warnings) byLayer[item.likely_layer || "unknown"] = (byLayer[item.likely_layer || "unknown"] || 0) + 1;
    console.log(`# [L2-warnings] warnings=${drep.warnings.length} ${Object.keys(byLayer).sort().map((k) => `${k}=${byLayer[k]}`).join(" ")}`);
  }
  console.log(`PROGRESS l2 ${progressBar(done, modules.length)}`);
  const cstate = completenessState();
  if (!l2Remaining.length && cstate === "passed") console.log("ALL_DONE l2");
  else if (!l2Remaining.length && cstate === "failed") console.log(`NEXT: fix L2 completeness issues in ${completenessFile}`);
  else if (!l2Remaining.length && cstate === "schema-stale") console.log("NEXT: rerun repowiki-l2.cjs <repo> --all, then merge-knowledge.cjs to refresh stale L2 schema");
  else if (!l2Remaining.length && cstate === "completeness-stale") console.log(`NEXT: rerun merge-knowledge.cjs "${knowledgeDir}" to refresh stale L2 completeness report`);
  else if (!l2Remaining.length) console.log(`NEXT: run merge-knowledge.cjs "${knowledgeDir}"`);
  else if (verbose) printRemain(l2Remaining);
  else console.log(`NEXT: continue repowiki-l2.cjs; ${l2Remaining.length} modules still missing L2 parts. Use --verbose to list them.`);
}

function schedulerItems() {
  return Object.values(state.tasks || {});
}

function schedulerRows() {
  if (tasks.length) {
    return tasks.map((task) => ({
      task,
      item: (state.tasks && state.tasks[task.id]) || {
        id: task.id,
        kind: task.kind,
        relPath: task.relPath,
        output: task.output,
        status: "pending",
      },
    }));
  }
  return schedulerItems().map((item) => ({ task: item, item }));
}

function rowStatus(row) {
  return row.item && row.item.status ? row.item.status : "pending";
}

function rowOutput(row) {
  const item = row.item || {};
  const task = row.task || {};
  if ((item.kind || task.kind) === "function-list-scope") {
    return (item.facts && item.facts.rowsFile) || (task.facts && task.facts.rowsFile) || item.output || task.output || "";
  }
  if ((item.kind || task.kind) === "function-doc") {
    return item.boundOutput || item.finalOutput || task.boundOutput || task.finalOutput || item.output || task.output || "";
  }
  return item.output || task.output || "";
}

function rowDraftOutput(row) {
  const item = row.item || {};
  const task = row.task || {};
  if ((item.kind || task.kind) !== "function-doc") return "";
  const output = item.output || task.output || "";
  const normalized = String(output || "").replace(/\\/g, "/");
  const draftRoot = path.join(repowikiDir, "l3-drafts").replace(/\\/g, "/");
  return normalized.startsWith(draftRoot + "/") ? output : "";
}

function depsDone(task, currentState) {
  const deps = Array.isArray(task && task.deps) ? task.deps : [];
  return deps.every((d) => currentState.tasks && currentState.tasks[d] && currentState.tasks[d].status === "done");
}

function isControlPlaneOnly(task) {
  return !!(task && task.controlPlaneOnly);
}

function reportL3() {
  const rows = schedulerRows();
  const total = rows.length || functions.length;
  const stateDone = rows.filter((row) => rowStatus(row) === "done").length;
  const running = rows.filter((row) => rowStatus(row) === "running").length;
  const failed = rows.filter((row) => rowStatus(row) === "failed").length;
  const pending = rows.filter((row) => rowStatus(row) === "pending").length;
  const concurrency = Math.max(1, Math.floor(Number(state.concurrency) || 1));
  const ready = rows.filter((row) => !isControlPlaneOnly(row.task || row.item) && rowStatus(row) === "pending" && depsDone(row.task || row.item, state)).length;
  const blocked = rows.filter((row) => !isControlPlaneOnly(row.task || row.item) && rowStatus(row) === "pending" && !depsDone(row.task || row.item, state)).length;
  const dispatch = Math.max(0, Math.min(concurrency - running, ready));
  const outputDone = rows.filter((row) => docExists(rowOutput(row))).length;
  const draftDone = rows.filter((row) => docExists(rowDraftOutput(row))).length;
  const realDoneRows = rows.filter((row) => rowStatus(row) === "done" && docExists(rowOutput(row)));
  const fakeDoneRows = rows.filter((row) => rowStatus(row) === "done" && !docExists(rowOutput(row)));
  const realDone = realDoneRows.length;
  const fakeDone = fakeDoneRows.length;
  const fsdStats = fsdCoverageStats(rows);
  const fsdSummary = fsdStats.total > 0
    ? ` fsdFacts=${fsdStats.factsDone}/${fsdStats.total} fsdDiag=${fsdStats.diagDone}/${fsdStats.total}${fsdStats.warnReports ? ` fsdStrictWarn=${fsdStats.warnReports}/${fsdStats.total}` : ""}`
    : "";

  if (lineOnly) {
    const allDone = total > 0 && realDone === total && stateDone === total && failed === 0 && fakeDone === 0;
    const hint = allDone ? "none" : dispatch > 0 ? `spawn_exactly_${dispatch}` : (running > 0 ? "wait_running" : "wait_upstream");
    console.log(`PROGRESS l3 ${progressBar(realDone, total)} outputs=${outputDone}/${total} drafts=${draftDone}/${total}${fsdSummary} running=${running}/${concurrency} ready=${ready} blocked=${blocked} dispatch=${dispatch} dispatchHint=${hint} failed=${failed} pending=${pending} fakeDone=${fakeDone} l3Skill=${state.l3Skill || "unknown"}${allDone ? " status=ALL_DONE" : ""}`);
    return;
  }

  console.log(`# [L3] l3Skill=${state.l3Skill || "unknown"} realDone=${realDone}/${total} outputs=${outputDone}/${total} drafts=${draftDone}/${total}${fsdSummary} stateDone=${stateDone}/${total} running=${running}/${concurrency} ready=${ready} blocked=${blocked} dispatch=${dispatch} failed=${failed} pending=${pending} fakeDone=${fakeDone}`);
  // 滚动 DAG：按真实产物类型分别计数（service rows / function rows / function docs / exports）
  const byKind = {};
  for (const row of rows) {
    const k = (row.task && row.task.kind) || (row.item && row.item.kind) || "?";
    byKind[k] = byKind[k] || { done: 0, total: 0 };
    byKind[k].total++;
    if (rowStatus(row) === "done" && docExists(rowOutput(row))) byKind[k].done++;
  }
  console.log("# byKind " + Object.keys(byKind).sort().map((k) => `${k}=${byKind[k].done}/${byKind[k].total}`).join(" "));
  console.log(`PROGRESS l3 ${progressBar(realDone, total)} outputs=${outputDone}/${total} drafts=${draftDone}/${total}${fsdSummary}`);
  if (total > 0 && realDone === total && stateDone === total && failed === 0 && fakeDone === 0) console.log("ALL_DONE l3");
  else {
    if (dispatch > 0) {
      console.log(`NEXT: spawn exactly ${dispatch} L3 worker(s) now. Do not spawn by concurrency; concurrency is only the upper bound.`);
    } else if (running > 0) {
      console.log("NEXT: wait for running L3 worker(s) to finish; do not spawn more workers until dispatch becomes >0.");
    } else {
      console.log("NEXT: no ready L3 tasks; wait for upstream deps or inspect failed tasks.");
    }
    console.log("NOTE: each worker must finish through repowiki-l3-task.cjs done/fail.");
    if (!verbose) {
      const nonDone = fakeDone + pending + running + failed;
      if (nonDone > 0) console.log(`DETAILS hidden=${nonDone}; rerun with --verbose to list task ids.`);
      return;
    }
    for (const row of fakeDoneRows) {
      const task = row.task || row.item;
      const fn = task.function ? `${task.function.impl_qn}.${task.function.method}` : task.kind;
      console.log(`FAKE_DONE | ${task.relPath || "-"} | ${fn} | ${task.id} | ${rowOutput(row)}`);
    }
    for (const row of rows) {
      const status = rowStatus(row);
      if (status === "done") continue;
      const task = row.task || row.item;
      const fn = task.function ? `${task.function.impl_qn}.${task.function.method}` : task.kind;
      console.log(`${String(status || "pending").toUpperCase()} | ${task.relPath || "-"} | ${fn} | ${task.id}`);
    }
  }
}

if (phase === "l1") {
  reportL1();
} else if (phase === "l2") {
  reportL2();
} else if (phase === "l3") {
  reportL3();
} else if (l2Remaining.length) {
  console.log("PHASE: L2");
  reportL2();
  console.log("NEXT: run repowiki-l2.cjs <repo> --all");
} else if (!exists(servicesFile) || !exists(functionsFile)) {
  console.log("PHASE: MERGE");
  console.log(`PROGRESS merge ${progressBar(0, 1)}`);
  console.log(`NEXT: run merge-knowledge.cjs "${knowledgeDir}"`);
} else if (!exists(schemaReportFile) || !exists(completenessFile)) {
  console.log("PHASE: MERGE");
  console.log(`PROGRESS merge ${progressBar(0, 1)}`);
  console.log(`NEXT: run merge-knowledge.cjs "${knowledgeDir}"`);
} else if (exists(completenessFile) && completenessState() === "schema-stale") {
  console.log("PHASE: L2");
  reportL2();
  console.log("NEXT: rerun repowiki-l2.cjs <repo> --all, then merge-knowledge.cjs to refresh stale L2 schema");
} else if (exists(completenessFile) && completenessState() === "completeness-stale") {
  console.log("PHASE: MERGE");
  reportL2();
  console.log(`NEXT: rerun merge-knowledge.cjs "${knowledgeDir}" to refresh stale L2 completeness report`);
} else if (exists(completenessFile) && readJson(completenessFile, {}).status !== "passed") {
  console.log("PHASE: L2_COMPLETENESS_FAILED");
  reportL2();
  console.log(`NEXT: fix L2 completeness issues in ${completenessFile}`);
} else if (!exists(tasksFile) || !exists(stateFile)) {
  console.log("PHASE: L3_INIT");
  console.log(`PROGRESS l3 ${progressBar(0, functions.length)}`);
  console.log("NEXT: run repowiki-l3-scheduler.cjs <repo> --l3-skill wiki-l3-icbc --concurrency <N> (unless user explicitly selected another business skill)");
} else {
  console.log("PHASE: L3");
  reportL3();
}
