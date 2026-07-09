"use strict";
const l3Selection = require("./l3-selection.cjs");
/**
 * rows.cjs — service/function canonical rows 的解析/投影/校验，导出器与 done 闸门共用。
 * - parseColumns: 解析 columns.conf 的 `中文列名 = token` 与 @title
 * - resolveCell : token -> 单元格值（index 序号 / app / metadata.x -> row.x / 裸字段 -> row.x）
 * - projectRows : rows + columns -> { title, headers, matrix }
 * - validateServiceRows : 服务清单行级语义/数量校验
 * - validateFunctionRows: 功能清单行级语义/入口/数量/服务继承校验
 * 注意：本库只做确定性投影与校验，不生成任何业务语义。
 */

function parseColumns(text) {
  const lines = String(text || "").split(/\r?\n/);
  let title = "";
  const columns = [];
  for (const raw of lines) {
    const line = raw.replace(/^﻿/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(.+?)\s*=\s*(.+)$/);
    if (!m) continue;
    const left = m[1].trim();
    const right = m[2].trim();
    if (left === "@title") { title = right; continue; }
    columns.push({ name: left, token: right });
  }
  return { title, columns };
}

function resolveCell(token, row, idx, app) {
  if (token === "index") return String(idx + 1);
  if (token === "app") return String((row && row.app) || app || "");
  const key = String(token).replace(/^metadata\./, "");
  const v = row ? row[key] : "";
  return v == null ? "" : String(v);
}

function projectRows(rows, columnsConf, app) {
  const { title, columns } = typeof columnsConf === "string" ? parseColumns(columnsConf) : columnsConf;
  const headers = columns.map((c) => c.name);
  const matrix = (rows || []).map((row, i) => columns.map((c) => resolveCell(c.token, row, i, app)));
  return { title: String(title || "").replace(/\{app\}/g, app || ""), headers, matrix };
}

function hasZh(s) {
  return /[\u4e00-\u9fff]/.test(String(s || ""));
}

function rawIdentifierEnabledForField(validation, field) {
  const v = validation || {};
  if (!field || !Array.isArray(v.rawIdentifierFields)) return true;
  return v.rawIdentifierFields.includes(field);
}

function rawIdentifierResidue(s, validation, field) {
  const v = validation || {};
  if (!rawIdentifierEnabledForField(v, field)) return false;
  if (!v.rejectRawIdentifierResidue && !v.rawIdentifierRejectPattern) return false;
  if (v.rejectRawIdentifierResidue === false) return false;
  if (Array.isArray(v.rawIdentifierAllowList) && v.rawIdentifierAllowList.includes(String(s || ""))) return false;
  if (v.rawIdentifierRejectPattern) return new RegExp(v.rawIdentifierRejectPattern).test(String(s || ""));
  const tokens = String(s || "").match(/[A-Za-z][A-Za-z0-9_]*/g) || [];
  return tokens.some((token) => {
    if (/^[A-Z0-9]{2,8}$/.test(token)) return false;
    return /[A-Za-z][A-Za-z0-9_]{2,}/.test(token);
  });
}

function matchesConfiguredPatterns(s, patterns) {
  const text = String(s || "").trim();
  return (patterns || []).some((pattern) => new RegExp(pattern, "i").test(text));
}

function firstConfiguredPatternMatch(s, patterns) {
  const text = String(s || "").trim();
  for (const pattern of patterns || []) {
    if (new RegExp(pattern, "i").test(text)) return pattern;
  }
  return "";
}

function allowedAcronyms(validation, field) {
  const cfg = validation && validation.allowedAcronymsByField || {};
  return new Set((cfg[field] || []).map((x) => String(x || "").toUpperCase()));
}

function disallowedAsciiToken(s, validation, field) {
  const allow = allowedAcronyms(validation, field);
  const tokens = String(s || "").match(/[A-Za-z][A-Za-z0-9_-]*/g) || [];
  for (const token of tokens) {
    if (/^[A-Z0-9]{2,16}$/.test(token)) continue;
    if (allow.has(token.toUpperCase())) continue;
    return token;
  }
  return "";
}

function technicalSlug(s, validation) {
  return firstConfiguredPatternMatch(s, validation && validation.technicalSlugPatterns || []);
}

function configuredFieldReject(s, validation, key) {
  return firstConfiguredPatternMatch(s, validation && validation[key] || []);
}

function configuredHardFieldReject(s, validation, field) {
  const v = validation || {};
  const byField = v.hardRejectPatternsByField && typeof v.hardRejectPatternsByField === "object" ? v.hardRejectPatternsByField : {};
  return firstConfiguredPatternMatch(s, [
    ...(Array.isArray(v.hardRejectPatterns) ? v.hardRejectPatterns : []),
    ...(Array.isArray(byField[field]) ? byField[field] : []),
  ]);
}

function chineseBigrams(s) {
  const text = String(s || "").replace(/[#_].*$/, "").replace(/[^\u4e00-\u9fff]/g, "");
  const skip = new Set(["服务", "业务", "功能", "操作", "方法", "接口"]);
  const out = [];
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    if (!skip.has(gram)) out.push(gram);
  }
  return out;
}

function fieldQualityOk(value, validation, field, patternKey) {
  const text = String(value || "").trim();
  const pattern = configuredFieldReject(text, validation, patternKey);
  if (pattern) return `${field} rejected by pattern ${pattern}`;
  if (rawIdentifierEnabledForField(validation, field)) {
    const slug = technicalSlug(text, validation);
    if (slug) return `${field} contains technical slug (${slug})`;
    const ascii = disallowedAsciiToken(text, validation, field);
    if (ascii) return `${field} contains disallowed English token "${ascii}"`;
  }
  return "";
}

function softCheckSet(validation) {
  return new Set((validation && validation.softCheckTypes || []).map((x) => String(x || "")));
}

function pushIssue(out, validation, type, message, fallbackSeverity = "hard") {
  if (!message) return;
  const severity = softCheckSet(validation).has(type) ? "soft" : fallbackSeverity;
  out[severity].push({ type, message });
}

function hasDedupeFallback(row) {
  const reasons = Array.isArray(row && row.review_reasons) ? row.review_reasons : [];
  return !!(row && row.review_required && reasons.includes("deterministic_dedupe_fallback"));
}

function issueMessages(issues) {
  if (!issues) return [];
  if (Array.isArray(issues)) return issues;
  return [...(issues.hard || []), ...(issues.soft || [])].map((item) => item.message || String(item));
}

function localizedBusinessPartIssues(part, validation, field, patternKey) {
  const v = validation || {};
  const text = String(part || "").trim();
  const out = { hard: [], soft: [] };
  if (!text) {
    out.hard.push({ type: "required", message: `${field} empty` });
    return out;
  }
  const hardPattern = configuredHardFieldReject(text, v, field);
  if (hardPattern) {
    out.hard.push({ type: "hard_reject", message: `${field} rejected by hard pattern ${hardPattern}` });
  }
  if (v.localeRequire === "zh" && !hasZh(text)) {
    pushIssue(out, v, "locale_zh", `${field} not localized (zh required)`, "hard");
  }
  const fq = fieldQualityOk(text, v, field, patternKey || `${field}RejectPatterns`);
  if (fq) pushIssue(out, v, "raw_identifier", fq, "hard");
  if (rawIdentifierResidue(text, v, field)) {
    pushIssue(out, v, "raw_identifier", `${field} contains raw English identifier`, "hard");
  }
  return out;
}

// 功能行语义合格：非空 + 非占位 + 非裸方法名直出；语言/概述质量由 validation 注入。
function functionSemErrors(row, validation) {
  const v = validation || {};
  const errors = { hard: [], soft: [] };
  const required = Array.isArray(v.functionRequiredFields) ? v.functionRequiredFields : ["business_name", "function_name", "summary"];
  for (const k of required) {
    if (!row[k] || !String(row[k]).trim()) errors.hard.push({ type: "required", message: `field ${k} empty` });
  }
  if (errors.hard.length) return errors;
  if (/RPC方法，参数:|RPC方法。/.test(String(row.summary || ""))) errors.hard.push({ type: "summary_placeholder", message: "summary is placeholder" });
  if (row.function_name && row.method &&
      String(row.function_name).trim() === String(row.method).trim()) errors.hard.push({ type: "raw_method_name", message: "function_name is raw method" });
  if (rawIdentifierResidue(row.function_name, v, "function_name")) {
    pushIssue(errors, v, "raw_identifier", "function_name contains raw English identifier", hasDedupeFallback(row) ? "soft" : "hard");
  }
  const fnQuality = fieldQualityOk(row.function_name, v, "function_name", "functionNameRejectPatterns");
  if (fnQuality) pushIssue(errors, v, "raw_identifier", fnQuality, hasDedupeFallback(row) ? "soft" : "hard");
  if ((v.weakFunctionNameValues || []).includes(String(row.function_name || "").trim())) {
    pushIssue(errors, v, "weak_name", "function_name is too weak", "hard");
  }
  if (Array.isArray(v.emptySummaryValues) && v.emptySummaryValues.includes(String(row.summary || "").trim())) {
    pushIssue(errors, v, "summary_short", "summary not localized or too empty", "hard");
  }
  if (rawIdentifierResidue(row.summary, v, "summary")) {
    pushIssue(errors, v, "raw_identifier", "summary contains raw English identifier", "hard");
  }
  const summaryQuality = fieldQualityOk(row.summary, v, "summary", "summaryFieldRejectPatterns");
  if (summaryQuality) pushIssue(errors, v, "raw_identifier", summaryQuality, "hard");
  const minSummaryChars = Number(v.minSummaryChars || 0);
  if (minSummaryChars > 0 && String(row.summary || "").trim().length < minSummaryChars) {
    pushIssue(errors, v, "summary_short", `summary too short (<${minSummaryChars})`, "hard");
  }
  const summaryPatterns = [
    ...(Array.isArray(v.rejectSummaryPatterns) ? v.rejectSummaryPatterns : []),
    ...(Array.isArray(v.summaryRejectPatterns) ? v.summaryRejectPatterns : []),
  ];
  if (summaryPatterns.length && matchesConfiguredPatterns(row.summary, summaryPatterns)) {
    pushIssue(errors, v, "summary_short", "summary is generic", "hard");
  }
  if (v.summaryRequireFunctionNameCore) {
    const grams = chineseBigrams(row.function_name);
    if (grams.length && !grams.some((gram) => String(row.summary || "").includes(gram))) {
      pushIssue(errors, v, "summary_name_consistency", "summary inconsistent with function_name", "hard");
    }
  }
  if (v.localeRequire === "zh") {
    const businessParts = String(row.business_name || "").split(/[\\/]+/).filter(Boolean);
    if (!businessParts.length) errors.hard.push({ type: "required", message: "business_name empty" });
    for (const part of businessParts) {
      const issues = localizedBusinessPartIssues(part, v, "business_name", "businessNameRejectPatterns");
      errors.hard.push(...issues.hard);
      errors.soft.push(...issues.soft);
    }
    if (!hasZh(row.function_name)) {
      pushIssue(errors, v, "locale_zh", "function_name not localized (zh required)", "hard");
    }
    if (!hasZh(row.summary)) {
      pushIssue(errors, v, "locale_zh", "summary not localized or too empty (zh required)", "hard");
    }
  }
  return errors;
}

function functionSemOk(row, validation) {
  return issueMessages(functionSemErrors(row, validation))[0] || "";
}

function serviceSemErrors(row, validation) {
  const v = validation || {};
  const errors = { hard: [], soft: [] };
  const required = Array.isArray(v.serviceRequiredFields) ? v.serviceRequiredFields : ["service_name", "service_category"];
  for (const k of required) {
    if (!row[k] || !String(row[k]).trim()) errors.hard.push({ type: "required", message: `field ${k} empty` });
  }
  if (errors.hard.length) return errors;
  if (v.localeRequire === "zh") {
    for (const [k, field, patternKey] of [["service_name", "service_name", "serviceNameRejectPatterns"], ["service_category", "service_category", "serviceCategoryRejectPatterns"]]) {
      const issues = localizedBusinessPartIssues(row[k], v, field, patternKey);
      errors.hard.push(...issues.hard);
      errors.soft.push(...issues.soft);
    }
  }
  return errors;
}

function serviceSemOk(row, validation) {
  return issueMessages(serviceSemErrors(row, validation))[0] || "";
}

const PROJECTED_FUNCTION_COLUMNS = [
  "序号", "应用名", "业务功能名称", "功能类型", "功能名称", "功能概述", "服务接口全限定名", "功能入口",
];
const PROJECTED_SERVICE_COLUMNS = [
  "序号", "应用名", "服务名", "服务类型", "服务接口", "服务实现", "服务版本",
];

function projectedColumnErrors(rows, columns, kind) {
  const errors = [];
  if (!Array.isArray(rows)) return errors;
  rows.forEach((row, i) => {
    const keys = Object.keys(row || {}).filter((key) => columns.includes(key));
    if (keys.length) {
      errors.push(`row[${i}] contains projected ${kind} columns (${keys.slice(0, 5).join(", ")}); rows.json must use canonical fields`);
    }
  });
  return errors;
}

function entryOk(row) {
  const e = String(row.entry || "").trim();
  if (!e) return "entry empty";
  const rpc = /\)\s*$/.test(e);                 // ...method(...)
  const http = /^[A-Z]+(\|[A-Z]+)*\s+\S/.test(e); // GET /path
  if (!rpc && !http) return "entry not formatted (need impl.method(...) or METHOD route)";
  return "";
}

function expectedFunctionType(row, validation) {
  const map = (validation && validation.functionTypeByEntryType) || {};
  const entryType = String((row && row.entry_type) || "").toLowerCase();
  return map[entryType] || map["*"] || "";
}

function functionTypeOk(row, validation) {
  const v = validation || {};
  if (!v.functionTypeByEntryType) return "";
  const got = String(row.function_type || "").trim();
  if (!got) return "function_type empty";
  if ((v.rejectFunctionTypeValues || []).some((x) => String(x).toLowerCase() === got.toLowerCase())) {
    return "function_type is raw technical profile";
  }
  const expected = expectedFunctionType(row, v);
  if (!expected) return "";
  if (got !== expected) return `function_type expected ${expected}`;
  return "";
}

function duplicateFunctionDocNames(rows, validation) {
  const v = validation || {};
  if (!v.uniqueFunctionDocName) return [];
  const groups = new Map();
  rows.forEach((row, i) => {
    const key = `${String((row && row.business_name) || "").trim()}\\${String((row && row.function_name) || "").trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, index: i });
  });
  return Array.from(groups.entries())
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => {
      const detail = items
        .slice(0, 5)
        .map(({ row, index }) => `row[${index}] ${((row && row.impl_qn) || "?")}.${((row && row.method) || "?")}`)
        .join("; ");
      return `duplicate function doc name "${key}" (${items.length} rows): ${detail}`;
    });
}

function moduleMatches(rowModule, factModule) {
  const r = String(rowModule || "");
  const f = String(factModule || "");
  if (!r || !f || r === f) return true;
  const strip = (s) => {
    const parts = String(s || "").split("__").filter(Boolean);
    if (parts.length > 2 && /^(dubbo|spring-rest|mq-listener|scheduled-job|batch-job|go-cli|go-http|k8s-controller)$/i.test(parts[0])) {
      return parts.slice(2).join("__");
    }
    return parts.join("__");
  };
  const cr = strip(r);
  const cf = strip(f);
  return cr === cf || f.endsWith(`__${r}`) || r.endsWith(`__${f}`);
}

function sameFunction(row, fn) {
  return row && fn &&
    moduleMatches(row.module, fn.module) &&
    row.impl_qn === fn.impl_qn &&
    row.method === fn.method &&
    (!fn.signature || !row.signature || row.signature === fn.signature) &&
    (!fn.version || !row.version || row.version === fn.version) &&
    (!fn.group || !row.group || row.group === fn.group);
}

function sameService(row, svc) {
  return row && svc &&
    moduleMatches(row.module, svc.module) &&
    row.impl_qn === svc.impl_qn &&
    (!row.iface_qn || !svc.iface_qn || row.iface_qn === svc.iface_qn) &&
    (!row.version || !svc.version || row.version === svc.version) &&
    (!row.group || !svc.group || row.group === svc.group);
}

function findServiceRowForFunction(row, serviceRows) {
  if (!Array.isArray(serviceRows)) return null;
  if (row.service_id) {
    const byId = serviceRows.find((svc) => svc && svc.service_id && svc.service_id === row.service_id);
    if (byId) return byId;
  }
  const exact = serviceRows.filter((svc) =>
    sameService(row, svc) ||
    (moduleMatches(row.module, svc.module) && row.iface_qn && svc.iface_qn && row.iface_qn === svc.iface_qn)
  );
  return exact.length === 1 ? exact[0] : null;
}

function serviceCoverageErrors(rows, services) {
  const errors = [];
  const source = Array.isArray(services) ? services : [];
  for (const svc of source) {
    const hits = rows.filter((row) => sameService(row, svc));
    if (hits.length !== 1) {
      errors.push(`service coverage ${svc.impl_qn || "?"}: expected 1 row, got ${hits.length}`);
    }
  }
  for (const [i, row] of rows.entries()) {
    const hits = source.filter((svc) => sameService(row, svc));
    if (source.length && hits.length !== 1) {
      errors.push(`row[${i}] (${row.service_name || row.impl_qn || "?"}): service fact match count ${hits.length}`);
    }
  }
  return errors;
}

function conservationErrors(view, allServices, allFunctions) {
  const errors = [];
  if (!view || typeof view !== "object") return errors;
  const factKey = (kind, item) => {
    const fact = item && item.fact ? item.fact : item;
    const selected = fact && fact._selection && fact._selection.fact_key;
    if (selected) return selected;
    if (item && item.fact_key) return item.fact_key;
    return kind === "services" ? l3Selection.serviceKey(fact || {}) : l3Selection.functionKey(fact || {});
  };
  const check = (kind, all) => {
    const section = view[kind] || {};
    const inScope = Array.isArray(section.in_scope) ? section.in_scope : [];
    const excluded = Array.isArray(section.excluded) ? section.excluded : [];
    const review = Array.isArray(section.review) ? section.review : [];
    const total = Array.isArray(all) ? all.length : 0;
    const got = inScope.length + excluded.length + review.length;
    if (got !== total) errors.push(`${kind} conservation failed: in_scope ${inScope.length} + excluded ${excluded.length} + review ${review.length} != facts ${total}`);
    for (const [i, item] of excluded.entries()) {
      if (!item || !item.reason) errors.push(`${kind}.excluded[${i}] missing reason`);
    }
    for (const [i, item] of review.entries()) {
      if (!item || !item.reason) errors.push(`${kind}.review[${i}] missing reason`);
    }
    const expected = new Map((Array.isArray(all) ? all : []).map((fact) => [factKey(kind, fact), fact]));
    const seen = new Map();
    for (const [bucket, items] of [["in_scope", inScope], ["excluded", excluded], ["review", review]]) {
      for (const [i, item] of items.entries()) {
        const key = factKey(kind, item);
        if (!key) {
          errors.push(`${kind}.${bucket}[${i}] missing fact_key`);
          continue;
        }
        if (!expected.has(key)) errors.push(`${kind}.${bucket}[${i}] unknown fact_key ${key}`);
        if (seen.has(key)) {
          const prev = seen.get(key);
          errors.push(`${kind} fact ${key} appears in both ${prev.bucket}[${prev.index}] and ${bucket}[${i}]`);
        } else {
          seen.set(key, { bucket, index: i });
        }
      }
    }
    for (const key of expected.keys()) {
      if (!seen.has(key)) errors.push(`${kind} fact ${key} missing from business view buckets`);
    }
  };
  check("services", allServices);
  check("functions", allFunctions);
  return errors;
}

function functionCoverageErrors(rows, functions) {
  const errors = [];
  const source = Array.isArray(functions) ? functions : [];
  for (const fn of source) {
    const hits = rows.filter((row) => sameFunction(row, fn));
    if (hits.length !== 1) {
      errors.push(`function coverage ${fn.impl_qn || "?"}.${fn.method || "?"}: expected 1 row, got ${hits.length}`);
    }
  }
  for (const [i, row] of rows.entries()) {
    const hits = source.filter((fn) => sameFunction(row, fn));
    if (source.length && hits.length !== 1) {
      errors.push(`row[${i}] (${row.function_name || row.method || "?"}): function fact match count ${hits.length}`);
    }
  }
  return errors;
}

function pickFactForRow(row, functions) {
  const source = Array.isArray(functions) ? functions : [];
  const candidates = source.filter((fn) =>
    row && fn &&
    moduleMatches(row.module, fn.module) &&
    row.impl_qn === fn.impl_qn &&
    row.method === fn.method
  );
  if (candidates.length === 0) return null;
  const exactSignature = candidates.filter((fn) => String(row.signature || "") === String(fn.signature || ""));
  if (exactSignature.length === 1) return exactSignature[0];
  const exactEntry = candidates.filter((fn) => String(row.entry || "") === String(fn.entry || ""));
  if (exactEntry.length === 1) return exactEntry[0];
  return candidates.length === 1 ? candidates[0] : null;
}

function factInheritanceErrors(rows, functions) {
  const errors = [];
  const source = Array.isArray(functions) ? functions : [];
  if (!source.length || !Array.isArray(rows)) return errors;
  const fields = ["module", "impl_qn", "method", "signature", "entry", "iface_qn", "version", "group"];
  rows.forEach((row, i) => {
    const tag = `row[${i}] (${(row && (row.function_name || row.method)) || "?"})`;
    const fact = pickFactForRow(row || {}, source);
    if (!fact) {
      errors.push(`${tag}: no unique function fact for inheritance check`);
      return;
    }
    for (const field of fields) {
      const expected = String(fact[field] || "");
      const got = String((row && row[field]) || "");
      if (!expected && !got) continue;
      if (got !== expected) {
        errors.push(`${tag}: ${field} must inherit L2 fact exactly (expected "${expected}", got "${got}")`);
      }
    }
  });
  return errors;
}

function validateServiceRows(rows, opts) {
  const o = opts || {};
  const errors = [];
  const softByRow = {};
  if (!Array.isArray(rows)) return { ok: false, errors: ["rows is not an array"], softByRow };
  errors.push(...projectedColumnErrors(rows, PROJECTED_SERVICE_COLUMNS, "service-list"));
  const scopedServices = (o.view && o.view.services && Array.isArray(o.view.services.in_scope)) ? o.view.services.in_scope : (o.services || []);
  const expectedCount = typeof o.servicesCount === "number" ? o.servicesCount : scopedServices.length;
  if (typeof expectedCount === "number" && rows.length !== expectedCount) {
    errors.push(`row count ${rows.length} != services count ${expectedCount}`);
  }
  rows.forEach((row, i) => {
    const tag = `row[${i}] (${(row && (row.service_name || row.impl_qn)) || "?"})`;
    const sem = serviceSemErrors(row || {}, o.validation);
    for (const s of sem.hard || []) errors.push(`${tag}: ${s.message || s}`);
    if ((sem.soft || []).length) softByRow[i] = (sem.soft || []).map((s) => s.message || String(s));
  });
  errors.push(...serviceCoverageErrors(rows, scopedServices));
  errors.push(...conservationErrors(o.view, o.allServices, o.allFunctions));
  return { ok: errors.length === 0, errors, softByRow };
}

function validateFunctionRows(rows, opts) {
  const o = opts || {};
  const errors = [];
  const softByRow = {};
  if (!Array.isArray(rows)) return { ok: false, errors: ["rows is not an array"], softByRow };
  errors.push(...projectedColumnErrors(rows, PROJECTED_FUNCTION_COLUMNS, "function-list"));
  const scopedFunctionsRaw = (o.view && o.view.functions && Array.isArray(o.view.functions.in_scope)) ? o.view.functions.in_scope : (o.functions || []);
  const scopedFunctionsSeen = new Set();
  const scopedFunctions = Array.isArray(scopedFunctionsRaw) ? scopedFunctionsRaw.filter((fn) => {
    if (!fn || !fn.impl_qn || !fn.method) return true;
    const key = `${fn.impl_qn}::${fn.method}::${fn.signature}`;
    if (scopedFunctionsSeen.has(key)) return false;
    scopedFunctionsSeen.add(key);
    return true;
  }) : scopedFunctionsRaw;
  const expectedCount = typeof o.functionsCount === "number" ? o.functionsCount : scopedFunctions.length;
  if (typeof expectedCount === "number" && rows.length !== expectedCount) {
    errors.push(`row count ${rows.length} != functions count ${expectedCount}`);
  }
  rows.forEach((row, i) => {
    const tag = `row[${i}] (${(row && (row.function_name || row.method)) || "?"})`;
    const sem = functionSemErrors(row || {}, o.validation);
    for (const s of sem.hard || []) errors.push(`${tag}: ${s.message || s}`);
    if ((sem.soft || []).length) softByRow[i] = (sem.soft || []).map((s) => s.message || String(s));
    const e = entryOk(row || {});
    if (e) errors.push(`${tag}: ${e}`);
    const ft = functionTypeOk(row || {}, o.validation);
    if (ft) errors.push(`${tag}: ${ft}`);
    if (o.validation && o.validation.requireServiceRowReference) {
      const svc = findServiceRowForFunction(row || {}, o.serviceRows || []);
      if (!svc) {
        errors.push(`${tag}: no matching service canonical row`);
      } else {
        const expectedBusinessName = `${svc.service_category}/${svc.service_name}`;
        if (String(row.business_name || "").trim() !== expectedBusinessName) {
          errors.push(`${tag}: business_name must inherit service row (${expectedBusinessName})`);
        }
      }
    }
  });
  errors.push(...functionCoverageErrors(rows, scopedFunctions));
  errors.push(...factInheritanceErrors(rows, scopedFunctions));
  errors.push(...conservationErrors(o.view, o.allServices, o.allFunctions));
  errors.push(...duplicateFunctionDocNames(rows, o.validation));
  return { ok: errors.length === 0, errors, softByRow };
}

function validateRows(rows, opts) {
  return validateFunctionRows(rows, opts);
}

// ---- 确定性渲染（导出器 CLI 与 done 闸门共用，保证 MD/CSV 同源）----
function csvCell(v) { return `"${String(v == null ? "" : v).replace(/"/g, '""')}"`; }
function mdCell(v) { return String(v == null ? "" : v).replace(/\|/g, "\\|").replace(/\r?\n/g, " "); }

function toCsv(headers, matrix) {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of matrix) lines.push(r.map(csvCell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

function toMarkdown(title, headers, matrix) {
  const out = [];
  if (title) out.push(`# ${title}`, "");
  out.push(`| ${headers.join(" | ")} |`);
  out.push(`|${headers.map(() => "---").join("|")}|`);
  for (const r of matrix) out.push(`| ${r.map(mdCell).join(" | ")} |`);
  return out.join("\n") + "\n";
}

module.exports = {
  parseColumns,
  resolveCell,
  projectRows,
  serviceSemOk,
  functionSemOk,
  functionSemErrors,
  serviceSemErrors,
  entryOk,
  expectedFunctionType,
  functionTypeOk,
  rawIdentifierResidue,
  conservationErrors,
  validateServiceRows,
  validateFunctionRows,
  validateRows,
  toCsv,
  toMarkdown,
};
