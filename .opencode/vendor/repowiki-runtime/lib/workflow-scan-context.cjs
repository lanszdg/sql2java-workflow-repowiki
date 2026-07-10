"use strict";

const fs = require("fs");
const path = require("path");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return String(value || "").trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function readJsonSafe(file, fallback = null) {
  if (!file || !fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (_) {
    return fallback;
  }
}

function listJsonFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .map((name) => path.join(dir, name));
}

function firstExisting(candidates) {
  return candidates.find((file) => file && fs.existsSync(file)) || "";
}

function targetFromFact(fact) {
  return {
    packageName: upper(fact && (fact.impl_qn || fact.package_name || fact.packageName || fact.service_iface)),
    method: upper(fact && (fact.method || fact.subprogramName || fact.name || fact.refName)),
  };
}

function loadSubprogram(artifactsDir, target) {
  const dir = path.join(artifactsDir, "subprograms");
  const candidates = [
    path.join(dir, `${target.packageName}.${target.method}.json`),
    path.join(dir, `${target.packageName}.${target.method.toLowerCase()}.json`),
  ];
  const exact = firstExisting(candidates);
  if (exact) return readJsonSafe(exact, null);

  for (const file of listJsonFiles(dir)) {
    const row = readJsonSafe(file, null);
    if (!row) continue;
    if (upper(row.belongToPackage) === target.packageName && upper(row.name) === target.method) return row;
  }
  return null;
}

function loadPackage(artifactsDir, packageName) {
  const dir = path.join(artifactsDir, "packages");
  const exact = firstExisting([
    path.join(dir, `${packageName}.json`),
    path.join(dir, `${packageName.toLowerCase()}.json`),
  ]);
  if (exact) return readJsonSafe(exact, null);
  for (const file of listJsonFiles(dir)) {
    const row = readJsonSafe(file, null);
    if (upper(row && (row.name || row.packageName)) === packageName) return row;
  }
  return null;
}

function tableNamesFromFact(fact) {
  const names = [];
  for (const row of asArray(fact && fact.table_facts)) {
    const name = clean(row && (row.table || row.tableName || row.name));
    if (name) names.push(name);
  }
  for (const name of asArray(fact && fact.tables)) {
    const text = clean(name);
    if (text) names.push(text);
  }
  return [...new Set(names.map((name) => upper(name)))];
}

function loadTable(artifactsDir, tableName) {
  const dir = path.join(artifactsDir, "tables");
  const exact = firstExisting([
    path.join(dir, `${tableName}.json`),
    path.join(dir, `${tableName.toLowerCase()}.json`),
  ]);
  if (exact) return readJsonSafe(exact, null);
  for (const file of listJsonFiles(dir)) {
    const row = readJsonSafe(file, null);
    if (upper(row && row.name) === tableName) return row;
  }
  return null;
}

function loadWorkflowScanContextForFact(fact, options = {}) {
  const artifactsDir = clean(options.artifactsDir || process.env.REPOWIKI_WORKFLOW_ARTIFACTS_DIR);
  if (!artifactsDir) return null;
  const target = targetFromFact(fact || {});
  if (!target.packageName || !target.method) return null;

  const subprogram = loadSubprogram(artifactsDir, target);
  const packageInfo = loadPackage(artifactsDir, target.packageName);
  const tables = tableNamesFromFact(fact || {})
    .map((name) => loadTable(artifactsDir, name))
    .filter(Boolean);

  if (!subprogram && !packageInfo && tables.length === 0) return null;
  return {
    artifactsDir: path.resolve(artifactsDir),
    target,
    subprogram,
    package: packageInfo,
    tables,
  };
}

module.exports = {
  loadWorkflowScanContextForFact,
};
