#!/usr/bin/env node
/**
 * merge-knowledge.cjs — 确定性合并 L2 分片产物，避免并行写同一文件的竞态。
 * 用法: node merge-knowledge.cjs "<项目根>/.repowiki/knowledge"
 *   读取 <knowledgeDir>/parts/{services,functions,downstream}.part-*.json
 *   去重合并写出 <knowledgeDir>/{services,functions,downstream}.json
 * 去重键：
 *   services   = impl_qn (+ iface_qn 兜底)
 *   functions  = impl_qn + signature
 *   downstream = from_impl + from_method + to_service + to_method
 */
const fs = require("fs");
const path = require("path");
const { renderEntry } = require(path.join(__dirname, "lib", "entry.cjs"));
const { computeCompleteness } = require(path.join(__dirname, "lib", "l2-projection.cjs"));
const { inventory: l1Inventory, edgesFor: l1EdgesFor } = require(path.join(__dirname, "lib", "l1-adapter.cjs"));

const kdir = process.argv[2];
if (!kdir) { console.error('usage: node merge-knowledge.cjs "<...>/.repowiki/knowledge"'); process.exit(2); }
fs.mkdirSync(kdir, { recursive: true });
const partsDir = path.join(kdir, "parts");
const repowikiDir = path.dirname(kdir);
const repoRoot = path.resolve(process.env.REPOWIKI_SOURCE_ROOT || path.dirname(repowikiDir));
const modulesFile = path.join(repowikiDir, "modules.json");
const codegraphStateFile = path.join(repowikiDir, "codegraph-init.json");
const EXPECTED_SCHEMA_VERSION = 11;
const EXPECTED_FEATURE_SET = {
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
};
const REQUIRED_PART_KINDS = ["services", "functions", "downstream", "models", "tables", "entry-candidates", "entities", "relations", "expected-functions", "coverage-ledger"];

// ★去重键带 module：多 app 同包同名(如 metrics-demo 与 shop 都有 CommentServiceImpl)是不同模块的不同服务，不能合掉；
//   同一模块内的真重复才合。单 app 仓 FQN 本就唯一，带不带 module 等价、无副作用。
const KEYS = {
  services: (x) => [x.module, x.profile, x.impl_qn || x.iface_qn || "", x.iface_qn || x.service_iface || "", x.service_iface || "", x.version || "", x.group || ""].join("#"),
  functions: (x) => [x.module, x.profile, x.entry_type || "", x.impl_qn || "", x.method || "", x.signature || "", x.version || "", x.group || ""].join("#"),
  downstream: (x) => [x.module, x.from_impl, x.from_method, x.to_service, x.to_method].join("#"),
  models: (x) => [x.module, x.profile, x.type].join("#"),
  tables: (x) => [x.module, x.profile, x.impl_qn, x.method, x.table, x.dao_qn || x.dao || "", x.dao_method || ""].join("#"),
  entities: (x) => x.entity_id || [x.module, x.profile, x.entity_type, x.qn || x.name].join("#"),
  relations: (x) => x.relation_id || [x.module, x.profile, x.relation_type, x.from_entity, x.to_entity].join("#"),
  "expected-functions": (x) => x.expected_id || x.function_key || [x.module, x.profile, x.impl_qn, x.method, x.signature].join("#"),
};

function loadParts(kind, allowedSlugs = null) {
  const out = [];
  const candidates = [];
  // Only merge current parts. Merged files are outputs, not inputs.
  if (fs.existsSync(partsDir)) {
    for (const f of fs.readdirSync(partsDir)) {
      const m = f.match(new RegExp("^" + kind + "\\.part-(.*)\\.json$"));
      if (!m) continue;
      if (allowedSlugs && !allowedSlugs.has(m[1])) continue;
      candidates.push(path.join(partsDir, f));
    }
  }
  for (const c of candidates) {
    try {
      const a = JSON.parse(fs.readFileSync(c, "utf8"));
      if (Array.isArray(a)) out.push(...a);
      else if (kind === "entry-candidates" && a && typeof a === "object") out.push(a);
      else if (kind === "coverage-ledger" && a && typeof a === "object") out.push(a);
    } catch (e) { console.error("跳过坏文件", c, e.message); }
  }
  return out;
}

function loadMetaParts() {
  const out = [];
  if (!fs.existsSync(partsDir)) return out;
  for (const f of fs.readdirSync(partsDir)) {
    if (!/^meta\.part-.*\.json$/.test(f)) continue;
    const file = path.join(partsDir, f);
    const slug = f.replace(/^meta\.part-/, "").replace(/\.json$/, "");
    try {
      const meta = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      out.push({ slug, file, meta });
    } catch (e) {
      out.push({ slug, file, error: e.message, meta: null });
    }
  }
  return out;
}

function loadModules() {
  if (!fs.existsSync(modulesFile)) return { modules: [], error: `missing modules file: ${modulesFile}` };
  try {
    const data = JSON.parse(fs.readFileSync(modulesFile, "utf8").replace(/^\uFEFF/, ""));
    if (!Array.isArray(data)) return { modules: [], error: "modules.json is not an array" };
    const modules = data.filter((m) => m && m.slug);
    if (!modules.length) return { modules, error: "modules.json has no modules" };
    return { modules, error: "" };
  } catch (e) {
    return { modules: [], error: `bad modules json: ${e.message}` };
  }
}

function loadCodegraphState() {
  if (!fs.existsSync(codegraphStateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(codegraphStateFile, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return { status: "unknown", error: e.message };
  }
}

function versionRepoName(x) {
  return x.repo_artifact_id || x.module_artifact_id || x.repo_name || "";
}

function normalizeRelPath(file) {
  return String(file || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function evidenceNodeIds(item) {
  const ev = item && item.evidence ? item.evidence : {};
  return [
    ev.l1_iface_node_id,
    ev.l1_impl_node_id,
    ev.l1_iface_method_node_id,
    ev.l1_impl_method_node_id,
  ].filter(Boolean);
}

function simpleName(value) {
  return String(value || "").split(".").pop();
}

function ownerName(qn) {
  const parts = String(qn || "").split("::");
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

function isPrivateOrObjectMethod(node) {
  const name = node.name || "";
  if (node.visibility === "private" || node.visibility === "protected") return true;
  if (/^(toString|hashCode|equals)$/.test(name)) return true;
  return Boolean(ownerName(node.qualified_name) && ownerName(node.qualified_name) === name);
}

function classifyInternalNode(node, scopeReason = "", extendedParentIds = new Set()) {
  const kind = node.kind || "";
  const name = node.name || "";
  const qn = node.qualified_name || "";
  const fp = normalizeRelPath(node.file_path).toLowerCase();
  if (kind === "method" && isPrivateOrObjectMethod(node)) return "private-or-object-method";
  if (kind === "method" && scopeReason === "impl-file-with-interface") return "impl-helper-not-on-interface";
  if ((kind === "interface" || kind === "method") && (/(Mapper|Dao|DAO|Repository)(::|$)/.test(qn || name) || fp.includes("/mapper/") || fp.includes("/dao/") || fp.includes("/mybatis/"))) return "dao-or-mapper";
  if (kind === "interface" && extendedParentIds.has(node.id)) return "service-parent-interface";
  if ((kind === "interface" || kind === "class" || kind === "method") && (fp.includes("/dto/") || fp.includes("/common/") || fp.includes("/model/") || fp.includes("/entity/") || fp.includes("/downstream/"))) return "data-or-common";
  if (fp.includes("/src/test/") || fp.startsWith("src/test/")) return "test-code";
  return "";
}

function buildRepoCoverageLedger({ services, functions, coverageLedgers }) {
  const sumCount = (name) => (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.[name] || 0), 0);
  let inv;
  try {
    inv = l1Inventory(repoRoot, { includeEdges: false });
  } catch (e) {
    return {
      schemaVersion: 1,
      scope: "repo",
      status: "unavailable",
      error: e.message,
      counts: {
        scopedSymbols: 0,
        exposedSymbols: 0,
        classifiedInternal: 0,
        unexplained: 0,
        declaredExposures: sumCount("declaredExposures"),
        resolvedBindings: sumCount("resolvedBindings"),
        unresolvedBindings: sumCount("unresolvedBindings"),
        services: (services || []).length,
        functions: (functions || []).length,
        candidates: (functions || []).length,
        reviewServices: sumCount("reviewServices"),
        lowExposureConfidence: sumCount("lowExposureConfidence"),
        rawReachableInterfaceMethods: sumCount("rawReachableInterfaceMethods"),
        materializedInterfaceFunctions: sumCount("materializedInterfaceFunctions"),
        methodParseUnresolved: sumCount("methodParseUnresolved"),
        methodUnresolvedServices: sumCount("methodUnresolvedServices"),
        methodUnresolvedMethods: sumCount("methodUnresolvedMethods"),
        methodFallbackServices: sumCount("methodFallbackServices"),
        methodLedgerMismatches: sumCount("methodLedgerMismatches"),
        shadowedInheritedMethods: sumCount("shadowedInheritedMethods"),
        skippedInterfaceMethods: sumCount("skippedInterfaceMethods"),
        emptyInterfaces: sumCount("emptyInterfaces"),
      },
      exposed: [],
      classified_internal: [],
      unexplained: [],
      unresolved_bindings: (coverageLedgers || []).flatMap((x) => x.unresolved_bindings || []),
    };
  }

  const exposedSymbolIds = new Set();
  const nodeById = new Map((inv.nodes || []).map((node) => [node.id, node]));
  const interfaceIds = (inv.nodes || []).filter((n) => n.kind === "interface").map((n) => n.id);
  const interfaceIdSet = new Set(interfaceIds);
  const extendedParentIds = new Set();
  if (interfaceIds.length) {
    try {
      const extEdges = l1EdgesFor(repoRoot, interfaceIds, { limit: 10000 })
        .filter((e) => e.kind === "extends" && interfaceIdSet.has(e.source));
      for (const e of extEdges) extendedParentIds.add(e.target);
    } catch (_) {}
  }
  const entryScope = new Map();
  const nodesByFileKindName = new Map();
  const nodesByFile = new Map();
  for (const node of inv.nodes || []) {
    const relFile = normalizeRelPath(node.file_path);
    const key = `${relFile}#${node.kind || ""}#${node.name || ""}`;
    const list = nodesByFileKindName.get(key) || [];
    list.push(node);
    nodesByFileKindName.set(key, list);
    const byFile = nodesByFile.get(relFile) || [];
    byFile.push(node);
    nodesByFile.set(relFile, byFile);
  }
  function markScope(nodeId, reason) {
    if (!nodeId) return;
    const node = nodeById.get(nodeId);
    if (!node || !["class", "interface", "method"].includes(node.kind)) return;
    if (!entryScope.has(nodeId)) entryScope.set(nodeId, reason || "entry-evidence");
  }
  function markFileScope(file, reason) {
    const relFile = normalizeRelPath(file);
    if (!relFile) return;
    for (const node of nodesByFile.get(relFile) || []) {
      if (["class", "interface", "method"].includes(node.kind)) markScope(node.id, reason);
    }
  }
  function markClassByFile(file, qn, reason) {
    const relFile = normalizeRelPath(file);
    const cls = simpleName(qn);
    if (!relFile || !cls) return;
    for (const node of nodesByFileKindName.get(`${relFile}#class#${cls}`) || []) {
      exposedSymbolIds.add(node.id);
      markScope(node.id, reason || "class-evidence");
    }
  }
  for (const svc of services || []) {
    for (const nodeId of evidenceNodeIds(svc)) {
      exposedSymbolIds.add(nodeId);
      markScope(nodeId, "service-evidence");
    }
    markClassByFile(svc.evidence?.impl_file || svc.source_file || "", svc.impl_qn || "", "service-class");
    markFileScope(svc.evidence?.iface_file || svc.iface_file || "", "iface-file");
    markFileScope(svc.evidence?.impl_file || svc.source_file || "", svc.iface_qn ? "impl-file-with-interface" : "impl-file");
  }
  const svcKey = (x) => [x.module, x.profile, x.impl_qn, x.service_iface, x.version || "", x.group || ""].join("#");
  const svcByKey = new Map((services || []).map((svc) => [svcKey(svc), svc]));
  function addMethodNodes(filePath, method) {
    if (!filePath || !method) return;
    const list = nodesByFileKindName.get(`${normalizeRelPath(filePath)}#method#${method}`) || [];
    for (const node of list) {
      exposedSymbolIds.add(node.id);
      markScope(node.id, "function-method");
    }
  }
  for (const fn of functions || []) {
    for (const nodeId of evidenceNodeIds(fn)) {
      exposedSymbolIds.add(nodeId);
      markScope(nodeId, "function-evidence");
    }
    markClassByFile(fn.source_file || fn.evidence?.impl_file || fn.evidence?.source_file || "", fn.impl_qn || "", "function-class");
    markFileScope(fn.iface_file || fn.evidence?.iface_file || "", "iface-file");
    markFileScope(fn.source_file || fn.evidence?.impl_file || "", fn.iface_qn ? "impl-file-with-interface" : "impl-file");
    addMethodNodes(fn.iface_file || fn.evidence?.iface_file || "", fn.method);
    addMethodNodes(fn.source_file || fn.evidence?.impl_file || "", fn.method);
    const svc = svcByKey.get(svcKey(fn));
    const ifaceNode = svc && svc.evidence?.l1_iface_node_id ? nodeById.get(svc.evidence.l1_iface_node_id) : null;
    addMethodNodes(ifaceNode?.file_path || "", fn.method);
  }
  for (const ledger of coverageLedgers || []) {
    for (const item of ledger.exposed || []) {
      exposedSymbolIds.add(item.node_id);
      markScope(item.node_id, "part-exposed");
    }
  }
  for (const ledger of coverageLedgers || []) {
    for (const item of ledger.method_enumeration || []) {
      for (const bucketName of ["parse_unresolved_methods", "shadowed_inherited_methods", "skipped_methods"]) {
        for (const method of item[bucketName] || []) {
          if (method.node_id) {
            exposedSymbolIds.add(method.node_id);
            markScope(method.node_id, `method-${bucketName.replace(/_methods$/, "").replace(/_/g, "-")}`);
          }
          const ifaceFile = normalizeRelPath(method.iface_file || "");
          if (ifaceFile) {
            for (const node of nodesByFile.get(ifaceFile) || []) {
              if (node.kind === "interface") {
                exposedSymbolIds.add(node.id);
                markScope(node.id, "method-enumeration-interface");
              }
            }
          }
        }
      }
    }
  }

  const classifiedInternal = [];
  const unexplained = [];
  const scopedNodes = [...entryScope.keys()].map((id) => nodeById.get(id)).filter(Boolean);
  for (const node of scopedNodes) {
    const kind = node.kind || "";
    const name = node.name || "";
    const qn = node.qualified_name || "";
    const record = { node_id: node.id, kind, name, qualified_name: qn, file_path: node.file_path, scope_reason: entryScope.get(node.id) || "" };
    if (exposedSymbolIds.has(node.id)) continue;
    const internalReason = classifyInternalNode(node, entryScope.get(node.id) || "", extendedParentIds);
    if (internalReason) {
      classifiedInternal.push({ ...record, reason: internalReason });
    } else {
      unexplained.push(record);
    }
  }

  const unresolvedBindings = (coverageLedgers || []).flatMap((x) => x.unresolved_bindings || []);
  const declaredExposures = sumCount("declaredExposures");
  const resolvedBindings = sumCount("resolvedBindings");
  const methodEnumeration = (coverageLedgers || []).flatMap((x) => x.method_enumeration || []);
  const methodUnresolvedServices = sumCount("methodUnresolvedServices");
  const methodParseUnresolved = sumCount("methodParseUnresolved");
  const methodLedgerMismatches = sumCount("methodLedgerMismatches");
  return {
    schemaVersion: 1,
    scope: "repo",
    status: unresolvedBindings.length || unexplained.length || methodUnresolvedServices || methodParseUnresolved || methodLedgerMismatches ? "partial" : "passed",
    l1: {
      status: "available",
      schema: inv.schema || {},
      counts: inv.counts || {},
      denominator: "entry-relevant-symbols",
    },
    counts: {
      scopedSymbols: scopedNodes.length,
      exposedSymbols: exposedSymbolIds.size,
      classifiedInternal: classifiedInternal.length,
      unexplained: unexplained.length,
      declaredExposures,
      resolvedBindings,
      unresolvedBindings: unresolvedBindings.length,
      services: (services || []).length,
      functions: (functions || []).length,
      candidates: (functions || []).length,
      reviewServices: sumCount("reviewServices"),
      lowExposureConfidence: sumCount("lowExposureConfidence"),
      rawReachableInterfaceMethods: sumCount("rawReachableInterfaceMethods"),
      materializedInterfaceFunctions: sumCount("materializedInterfaceFunctions"),
      methodParseUnresolved,
      methodUnresolvedServices,
      methodUnresolvedMethods: sumCount("methodUnresolvedMethods"),
      methodFallbackServices: sumCount("methodFallbackServices"),
      methodLedgerMismatches,
      shadowedInheritedMethods: sumCount("shadowedInheritedMethods"),
      skippedInterfaceMethods: sumCount("skippedInterfaceMethods"),
      emptyInterfaces: sumCount("emptyInterfaces"),
    },
    exposed: [...exposedSymbolIds].map((node_id) => ({ node_id })),
    classified_internal: classifiedInternal,
    unexplained,
    unresolved_bindings: unresolvedBindings,
    method_enumeration: methodEnumeration,
  };
}

function hasRequiredPart(slug, kind) {
  return fs.existsSync(path.join(partsDir, `${kind}.part-${slug}.json`));
}

function validateMeta(item, mod = null) {
  const slug = (mod && mod.slug) || (item && item.slug) || "";
  const failed = [];
  if (!item) return [{ slug, reason: "missing meta" }];
  if (item.error) return [{ slug, reason: `bad meta json: ${item.error}` }];
  const meta = item.meta || {};
  if (meta.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    failed.push({ slug, reason: `schema ${meta.schemaVersion || "none"} != ${EXPECTED_SCHEMA_VERSION}` });
  }
  if (mod && mod.profile && meta.profile && meta.profile !== mod.profile) {
    failed.push({ slug, reason: `profile ${meta.profile} != ${mod.profile}` });
  }
  const fsx = meta.featureSet || {};
  for (const k of Object.keys(EXPECTED_FEATURE_SET)) {
    if (fsx[k] !== EXPECTED_FEATURE_SET[k]) failed.push({ slug, reason: `feature ${k} mismatch` });
  }
  for (const kind of REQUIRED_PART_KINDS) {
    if (!hasRequiredPart(slug, kind)) failed.push({ slug, reason: `missing ${kind} part` });
  }
  return failed;
}

function schemaReport() {
  const metas = loadMetaParts();
  const moduleState = loadModules();
  const modules = moduleState.modules;
  const metaBySlug = new Map(metas.map((item) => [item.slug, item]));
  const expectedSlugs = new Set(modules.map((m) => m.slug));
  const failed = [];
  const validSlugs = [];
  if (moduleState.error) failed.push({ slug: "", reason: moduleState.error });
  if (modules.length) {
    for (const mod of modules) {
      const reasons = validateMeta(metaBySlug.get(mod.slug) || null, mod);
      if (reasons.length) failed.push(...reasons);
      else validSlugs.push(mod.slug);
    }
    for (const item of metas) {
      if (!expectedSlugs.has(item.slug)) failed.push({ slug: item.slug, reason: "orphan meta not listed in modules.json" });
    }
  } else {
    for (const item of metas) {
      const reasons = validateMeta(item, null);
      if (reasons.length) failed.push(...reasons);
      else validSlugs.push(item.slug);
    }
  }
  return {
    status: failed.length ? "failed" : "passed",
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    modules: modules.length,
    metaParts: metas.length,
    parts: validSlugs.length,
    validSlugs,
    failed,
    updated_at: new Date().toISOString(),
  };
}

let report = [];
const srep = schemaReport();
fs.writeFileSync(path.join(kdir, "l2-schema-report.json"), JSON.stringify(srep, null, 2), "utf8");
const validPartSlugs = new Set(srep.validSlugs || []);
report.push(`schema: ${srep.status} version=${srep.schemaVersion} modules=${srep.modules} meta=${srep.metaParts} valid=${srep.parts} failed=${srep.failed.length}`);
if (srep.status !== "passed") {
  console.error("[merge-knowledge] " + report.join(" | "));
  console.error(`[merge-knowledge] L2 schema guard failed; rerun repowiki-l2.cjs --all before L3. report=${path.join(kdir, "l2-schema-report.json")}`);
  process.exit(5);
}
const mergedByKind = {};
for (const kind of ["services", "functions", "downstream", "models", "tables", "entities", "relations", "expected-functions"]) {
  const all = loadParts(kind, validPartSlugs);
  const seen = new Map();
  for (const x of all) { const k = KEYS[kind](x); if (!seen.has(k)) seen.set(k, x); }
  const merged = [...seen.values()];
  mergedByKind[kind] = merged;
  // ★enrich：functions 是事实主表，但缺 iface_qn/version/entry。
  //   iface_qn/version 从已写出的 services.json join 补齐；entry 由结构化事实确定性派生（含完整入参名）。
  //   只补确定性事实，不生成任何业务语义。
  if (kind === "functions") {
    let services = mergedByKind.services || [];
    if (!services.length) {
      try { services = JSON.parse(fs.readFileSync(path.join(kdir, "services.json"), "utf8").replace(/^﻿/, "")); } catch (e) {}
    }
    const svcKey = (x) => [x.module || "", x.impl_qn || "", x.iface_qn || "", x.service_iface || "", x.version || "", x.group || ""].join("#");
    const svcByKey = new Map();
    for (const s of services) {
      svcByKey.set(svcKey(s), s);
      svcByKey.set([s.module || "", s.impl_qn || "", "", s.service_iface || "", s.version || "", s.group || ""].join("#"), s);
    }
    let enriched = 0;
    for (const fn of merged) {
      const s = svcByKey.get(svcKey(fn));
      if (s) {
        if (!fn.iface_qn && s.iface_qn) fn.iface_qn = s.iface_qn;
        if (!fn.version && s.version) fn.version = s.version;
        if (!fn.repo_artifact_id && s.repo_artifact_id) fn.repo_artifact_id = s.repo_artifact_id;
        if (!fn.module_artifact_id && s.module_artifact_id) fn.module_artifact_id = s.module_artifact_id;
        if (!fn.repo_name && s.repo_name) fn.repo_name = s.repo_name;
      }
      if (!fn.version_repo_name) fn.version_repo_name = versionRepoName(fn);
      if (!fn.entry) { fn.entry = renderEntry(fn); enriched++; }
    }
    report.push(`functions-enrich: entry 派生 ${enriched}`);
  }
  fs.writeFileSync(path.join(kdir, kind + ".json"), JSON.stringify(merged, null, 2), "utf8");
  report.push(`${kind}: 分片合计 ${all.length} → 去重后 ${merged.length}`);
}

const entryCandidateDocs = loadParts("entry-candidates", validPartSlugs);
fs.writeFileSync(path.join(kdir, "entry-candidates.json"), JSON.stringify(entryCandidateDocs, null, 2), "utf8");
report.push(`entry-candidates: 分片 ${entryCandidateDocs.length} candidates ${entryCandidateDocs.reduce((n, x) => n + ((x.candidates || []).length), 0)}`);

const coverageLedgers = loadParts("coverage-ledger", validPartSlugs);
const repoCoverageLedger = buildRepoCoverageLedger({
  services: mergedByKind.services || [],
  functions: mergedByKind.functions || [],
  coverageLedgers,
});
const effectiveCoverageLedgers = [repoCoverageLedger];
fs.writeFileSync(path.join(kdir, "coverage-ledger.json"), JSON.stringify({
  schemaVersion: 1,
  modules: coverageLedgers.length,
  scope: "repo",
  counts: effectiveCoverageLedgers.reduce((acc, item) => {
    const c = item.counts || {};
    for (const key of [
      "scopedSymbols", "exposedSymbols", "classifiedInternal", "unexplained",
      "declaredExposures", "resolvedBindings", "unresolvedBindings",
      "services", "functions", "candidates",
      "rawReachableInterfaceMethods", "materializedInterfaceFunctions",
      "methodParseUnresolved", "methodUnresolvedServices", "methodUnresolvedMethods",
      "methodFallbackServices", "methodLedgerMismatches",
      "shadowedInheritedMethods", "skippedInterfaceMethods", "emptyInterfaces",
    ]) {
      acc[key] = (acc[key] || 0) + Number(c[key] || 0);
    }
    return acc;
  }, {}),
  repo_ledger: repoCoverageLedger,
  ledgers: coverageLedgers,
  updated_at: new Date().toISOString(),
}, null, 2), "utf8");
report.push(`coverage-ledger: repo unresolved=${repoCoverageLedger.counts?.unresolvedBindings || 0} unexplained=${repoCoverageLedger.counts?.unexplained || 0} scoped=${repoCoverageLedger.counts?.scopedSymbols || 0} | parts=${coverageLedgers.length}`);

const completeness = computeCompleteness({
  modules: loadModules().modules,
  functions: mergedByKind.functions || [],
  candidateDocs: entryCandidateDocs,
  expectedFunctions: mergedByKind["expected-functions"] || [],
  entities: mergedByKind.entities || [],
  relations: mergedByKind.relations || [],
  coverageLedgers: effectiveCoverageLedgers,
  codegraphState: loadCodegraphState(),
});
fs.writeFileSync(path.join(kdir, "l2-completeness.json"), JSON.stringify(completeness, null, 2), "utf8");
fs.writeFileSync(path.join(kdir, "l2-diagnosis.json"), JSON.stringify({
  schemaVersion: completeness.schemaVersion || 3,
  status: completeness.status,
  summary: completeness.summary || {},
  diagnosisSummary: completeness.diagnosisSummary || {},
  diagnostics: completeness.diagnostics || [],
  warnings: completeness.warnings || [],
  updated_at: new Date().toISOString(),
}, null, 2), "utf8");
report.push(`completeness: ${completeness.status} candidates=${completeness.summary.candidates} unique=${completeness.summary.uniqueCandidates} expected=${completeness.summary.expectedFunctions} functions=${completeness.summary.functions} missing=${completeness.summary.missingFunctions} duplicateFunctions=${completeness.summary.duplicateFunctionKeys} duplicateCandidates=${completeness.summary.duplicateCandidateIds} zeroCandidateModules=${completeness.summary.zeroCandidateModules} diagnostics=${completeness.summary.diagnostics} warnings=${completeness.summary.warnings}`);
if (completeness.status !== "passed") {
  console.error("[merge-knowledge] " + report.join(" | "));
  console.error(`[merge-knowledge] L2 completeness failed; report=${path.join(kdir, "l2-completeness.json")} diagnosis=${path.join(kdir, "l2-diagnosis.json")}`);
  process.exit(6);
}
// ★派生关系图产物(确定性, 0 LLM)：callgraph(正/反向邻接) + topology(服务级 RPC 边/度数)
//   供 ②拓扑可视化 / ③grounding 子图 / ①增量影响面。不生成业务语义。
try {
  const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(kdir, f), "utf8").replace(/^\uFEFF/, "")); } catch (e) { return []; } };
  const services = rd("services.json"), downstream = rd("downstream.json");
  const svcOfImpl = new Map(services.map((s) => [s.impl_qn, s.service_iface]));
  const callees = {}, callers = {};
  for (const d of downstream) {
    const fromKey = `${d.module || ""}#${d.from_impl}#${d.from_method}`;
    (callees[fromKey] = callees[fromKey] || []).push({ to_service: d.to_service, to_method: d.to_method, kind: d.downstream_kind });
    const toKey = `${d.module || ""}#${d.to_service}#${d.to_method}`;
    (callers[toKey] = callers[toKey] || []).push({ from_impl: d.from_impl, from_method: d.from_method, from_service: svcOfImpl.get(d.from_impl) || "" });
  }
  fs.writeFileSync(path.join(kdir, "callgraph.json"), JSON.stringify({ callees, callers }, null, 2), "utf8");
  const edgeMap = new Map(); const deg = {};
  for (const d of downstream) {
    const from = svcOfImpl.get(d.from_impl) || d.from_impl.split(".").pop();
    const to = d.to_service;
    if (!from || !to || from === to) continue;
    const ek = from + "->" + to;
    edgeMap.set(ek, (edgeMap.get(ek) || 0) + 1);
    (deg[from] = deg[from] || { in: 0, out: 0 }).out++;
    (deg[to] = deg[to] || { in: 0, out: 0 }).in++;
  }
  const edges = [...edgeMap.entries()].map(([k, count]) => { const i = k.indexOf("->"); return { from_svc: k.slice(0, i), to_svc: k.slice(i + 2), count }; });
  fs.writeFileSync(path.join(kdir, "topology.json"), JSON.stringify({ edges, degrees: deg }, null, 2), "utf8");
  report.push(`relations: callgraph(callees ${Object.keys(callees).length}/callers ${Object.keys(callers).length}) topology(edges ${edges.length})`);
} catch (e) { report.push("relations: 派生失败 " + e.message); }

console.log("[merge-knowledge] " + report.join(" | "));
console.log(`[merge-knowledge] NEXT: L3 scheduler init. Run: node "${path.join(__dirname, "repowiki-l3-scheduler.cjs")}" "${repoRoot}" --concurrency 20`);
