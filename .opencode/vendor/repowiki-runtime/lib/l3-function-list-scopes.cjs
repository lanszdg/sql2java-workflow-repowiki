"use strict";

const crypto = require("crypto");
const path = require("path");

function text(v) {
  return String(v == null ? "" : v).trim();
}

function safeName(s, fallback = "scope") {
  const raw = text(s) || fallback;
  return raw.replace(/[\\/:*?"<>|#\r\n]+/g, "_").slice(0, 120) || fallback;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha1(value, len = 12) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, len);
}

function serviceRowsHash(serviceRows) {
  const rows = Array.isArray(serviceRows) ? serviceRows : [];
  const normalized = rows.map((row) => ({
    service_id: row && row.service_id || "",
    service_name: row && row.service_name || "",
    service_category: row && row.service_category || "",
    business_name: row && row.business_name || "",
    impl_qn: row && row.impl_qn || "",
    iface_qn: row && row.iface_qn || "",
    service_iface: row && row.service_iface || "",
    version: row && row.version || "",
    group: row && row.group || "",
    module: row && row.module || "",
  }));
  return sha1(stableJson(normalized), 16);
}

function functionScopeKey(fn) {
  return text(fn && fn.uniqueness_scope_key) ||
    text(fn && fn.service_business_name) ||
    text(fn && fn.business_name) ||
    "未分类";
}

function functionRowMatchKey(rowOrFact) {
  const x = rowOrFact || {};
  return text(x.function_key || x.expected_id || x.function_id) || [
    x.module || "",
    x.impl_qn || "",
    x.method || "",
    x.signature || "",
    x.version || "",
    x.group || "",
  ].map(text).join("#");
}

function scopeHash(scopeKeys) {
  return sha1((scopeKeys || []).map(text).sort().join("\n"), 12);
}

function buildScopePacks(evidencePack, opts = {}) {
  const minFunctions = Math.max(1, Math.floor(Number(opts.minFunctions || 8)));
  const maxFunctions = Math.max(minFunctions, Math.floor(Number(opts.maxFunctions || 20)));
  const functions = Array.isArray(evidencePack && evidencePack.functions) ? evidencePack.functions : [];
  const byScope = new Map();
  for (const fn of functions) {
    const key = functionScopeKey(fn);
    if (!byScope.has(key)) byScope.set(key, []);
    byScope.get(key).push(fn);
  }

  const scopes = Array.from(byScope.entries())
    .map(([key, items]) => ({ key, functions: items }))
    .sort((a, b) => a.key.localeCompare(b.key, "zh-Hans-CN"));
  const packs = [];
  let current = [];
  let currentCount = 0;

  const flush = () => {
    if (!current.length) return;
    const scopeKeys = current.map((s) => s.key);
    const packedFunctions = current.flatMap((s) => s.functions);
    const hash = scopeHash(scopeKeys);
    packs.push({
      id: `function-list-scope__${hash}`,
      hash,
      scopeKeys,
      count: packedFunctions.length,
      scopes: current.map((s) => ({ key: s.key, count: s.functions.length })),
      functions: packedFunctions,
    });
    current = [];
    currentCount = 0;
  };

  for (const scope of scopes) {
    const count = scope.functions.length;
    if (count >= maxFunctions) {
      flush();
      current = [scope];
      currentCount = count;
      flush();
      continue;
    }
    if (current.length && currentCount >= minFunctions && currentCount + count > maxFunctions) flush();
    current.push(scope);
    currentCount += count;
    if (currentCount >= maxFunctions) flush();
  }
  flush();
  return packs;
}

function scopeTaskId(pack) {
  const hash = text(pack && pack.hash) || scopeHash(pack && pack.scopeKeys || []);
  return `l3__function-list-scope__${hash}`;
}

function scopeRowsFile(docsDir, pack) {
  const hash = text(pack && pack.hash) || scopeHash(pack && pack.scopeKeys || []);
  return path.join(docsDir, ".parts", "function-list", `${hash}.rows.json`);
}

function scopeNamesFile(docsDir, pack) {
  const hash = text(pack && pack.hash) || scopeHash(pack && pack.scopeKeys || []);
  return path.join(docsDir, ".parts", "function-list", `${hash}.names.json`);
}

function scopeEvidenceFile(schedulerDir, pack) {
  const hash = text(pack && pack.hash) || scopeHash(pack && pack.scopeKeys || []);
  return path.join(schedulerDir, "metadata", "function-list-scope", `${hash}.evidence.json`);
}

function scopeDisplayName(pack) {
  const keys = Array.isArray(pack && pack.scopeKeys) ? pack.scopeKeys : [];
  if (!keys.length) return "未分类";
  if (keys.length === 1) return keys[0];
  return `${keys[0]} 等${keys.length}个scope`;
}

module.exports = {
  buildScopePacks,
  functionRowMatchKey,
  functionScopeKey,
  safeName,
  scopeDisplayName,
  scopeEvidenceFile,
  scopeNamesFile,
  scopeRowsFile,
  scopeTaskId,
  serviceRowsHash,
  sha1,
  stableJson,
};
