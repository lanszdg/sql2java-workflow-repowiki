"use strict";

/**
 * L3 business-view selection.
 *
 * This module is intentionally business-agnostic. Business rules live in each
 * L3 skill's selection-policy.json; this engine only applies declared rules,
 * produces three mutually-exclusive buckets, and records an auditable ledger.
 */

function text(v) {
  return String(v == null ? "" : v).trim();
}

function simpleName(qn) {
  return text(qn).split(".").filter(Boolean).pop() || "";
}

function normalizedDefault(v) {
  const s = text(v);
  return !s || s === "默认" || /^default$/i.test(s) ? "" : s;
}

function compact(parts) {
  return parts.map(text).filter(Boolean).join("#");
}

function canonicalModule(s) {
  const parts = text(s).split("__").filter(Boolean);
  if (parts.length > 2 && /^(dubbo|spring-rest|mq-listener|scheduled-job|batch-job|go-cli|go-http|k8s-controller)$/i.test(parts[0])) {
    return parts.slice(2).join("__");
  }
  return parts.join("__");
}

function moduleMatches(a, b) {
  const left = text(a);
  const right = text(b);
  if (!left || !right || left === right) return true;
  const cl = canonicalModule(left);
  const cr = canonicalModule(right);
  return cl === cr || left.endsWith(`__${right}`) || right.endsWith(`__${left}`);
}

function serviceKey(service) {
  return compact([
    service && service.module,
    service && service.profile,
    service && service.entry_type,
    service && service.impl_qn,
    service && (service.iface_qn || service.service_iface),
    service && service.version,
    service && service.group,
  ]) || compact([service && service.impl_qn, service && service.iface_qn]);
}

function functionKey(fn) {
  return text(fn && (fn.function_key || fn.expected_id)) || compact([
    fn && fn.module,
    fn && fn.profile,
    fn && fn.entry_type,
    fn && fn.impl_qn,
    fn && fn.method,
    fn && fn.signature,
    fn && fn.version,
    fn && fn.group,
  ]);
}

function regexFrom(pattern) {
  const raw = text(pattern);
  if (!raw) return null;
  let flags = "";
  let source = raw;
  if (source.startsWith("(?i)")) {
    flags += "i";
    source = source.slice(4);
  }
  return new RegExp(source, flags);
}

function testRegex(value, pattern) {
  const re = regexFrom(pattern);
  return re ? re.test(text(value)) : false;
}

function positiveInt(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function paramTypes(fn) {
  if (Array.isArray(fn && fn.params)) return fn.params.map((p) => text(p && p.type)).filter(Boolean);
  const sig = text(fn && fn.signature);
  const m = sig.match(/\(([^)]*)\)/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function sharedImplCount(service, context) {
  const impl = text(service && service.impl_qn);
  if (!impl || !context || !context.implCounts) return 0;
  return context.implCounts.get(impl) || 0;
}

function matchesServiceRule(service, when, context) {
  const w = when || {};
  if (w.iface_simple_regex && !testRegex(simpleName(service && (service.iface_qn || service.service_iface)), w.iface_simple_regex)) return false;
  if (w.iface_qn_regex && !testRegex(service && service.iface_qn, w.iface_qn_regex)) return false;
  if (w.service_iface_regex && !testRegex(service && service.service_iface, w.service_iface_regex)) return false;
  if (w.impl_qn_regex && !testRegex(service && service.impl_qn, w.impl_qn_regex)) return false;
  if (w.service_name_regex && !testRegex(service && service.service_name, w.service_name_regex)) return false;
  if (w.config_regex && !testRegex(service && service.config, w.config_regex)) return false;
  const implSharedMin = positiveInt(w.impl_shared_min || w.shared_impl_min);
  if (implSharedMin && sharedImplCount(service, context) < implSharedMin) return false;
  return true;
}

function matchesFunctionRule(fn, when) {
  const w = when || {};
  if (Object.prototype.hasOwnProperty.call(w, "method") && text(fn && fn.method) !== text(w.method)) return false;
  if (Object.prototype.hasOwnProperty.call(w, "inherited")) {
    const inherited = !!text(fn && fn.inherited_from);
    if (!!w.inherited !== inherited) return false;
  }
  if (w.inherited_from_regex && !testRegex(fn && fn.inherited_from, w.inherited_from_regex)) return false;
  if (w.impl_qn_regex && !testRegex(fn && fn.impl_qn, w.impl_qn_regex)) return false;
  if (w.iface_qn_regex && !testRegex(fn && fn.iface_qn, w.iface_qn_regex)) return false;
  if (w.signature_regex && !testRegex(fn && fn.signature, w.signature_regex)) return false;
  if (Array.isArray(w.param_types)) {
    const got = paramTypes(fn);
    const expected = w.param_types.map(text);
    if (got.length !== expected.length || got.some((x, i) => x !== expected[i])) return false;
  }
  return true;
}

function functionBelongsToService(fn, service) {
  if (!fn || !service) return false;
  if (normalizedDefault(fn.version) && normalizedDefault(service.version) && normalizedDefault(fn.version) !== normalizedDefault(service.version)) return false;
  if (normalizedDefault(fn.group) && normalizedDefault(service.group) && normalizedDefault(fn.group) !== normalizedDefault(service.group)) return false;

  const fnIfaceQn = text(fn.iface_qn);
  const serviceIfaceQn = text(service.iface_qn);
  const fnIface = text(fn.service_iface) || simpleName(fnIfaceQn);
  const serviceIface = text(service.service_iface) || simpleName(serviceIfaceQn);

  if (fnIfaceQn && serviceIfaceQn && fnIfaceQn === serviceIfaceQn) return true;
  if (fnIface && serviceIface && fnIface === serviceIface) return true;
  if (fnIfaceQn && serviceIface && simpleName(fnIfaceQn) === serviceIface) return true;
  if (serviceIfaceQn && fnIface && simpleName(serviceIfaceQn) === fnIface) return true;

  if (fn.impl_qn && service.impl_qn && fn.impl_qn === service.impl_qn && moduleMatches(fn.module, service.module)) return true;
  return false;
}

function cloneWithSelection(fact, selection) {
  const next = { ...(fact || {}) };
  next._selection = selection;
  if (selection && selection.review_reasons && selection.review_reasons.length) {
    next.review_required = true;
    next.review_reasons = selection.review_reasons.slice();
  }
  return next;
}

function emptyView(services = [], functions = []) {
  const serviceInScope = services.map((svc) => cloneWithSelection(svc, {
    fact_key: serviceKey(svc),
    bucket: "in_scope",
    reason: "default",
    review_reasons: [],
  }));
  const functionInScope = functions.map((fn) => cloneWithSelection(fn, {
    fact_key: functionKey(fn),
    bucket: "in_scope",
    reason: "default",
    review_reasons: [],
  }));
  return {
    schemaVersion: 1,
    policyVersion: 0,
    services: { in_scope: serviceInScope, excluded: [], review: [] },
    functions: { in_scope: functionInScope, excluded: [], review: [] },
    ledger: [
      ...serviceInScope.map((fact) => ({ kind: "service", fact_key: fact._selection.fact_key, bucket: "in_scope", reason: "default" })),
      ...functionInScope.map((fact) => ({ kind: "function", fact_key: fact._selection.fact_key, bucket: "in_scope", reason: "default" })),
    ],
    counts: {
      services: { total: services.length, in_scope: services.length, excluded: 0, review: 0 },
      functions: { total: functions.length, in_scope: functions.length, excluded: 0, review: 0 },
    },
    conservation: { servicesOk: true, functionsOk: true },
  };
}

function addBucket(out, kind, bucket, fact, reason, reviewReasons = []) {
  const key = kind === "service" ? serviceKey(fact) : functionKey(fact);
  const selection = { fact_key: key, bucket, reason: reason || "default", review_reasons: reviewReasons.filter(Boolean) };
  const cloned = cloneWithSelection(fact, selection);
  if (bucket === "in_scope") {
    out[kind === "service" ? "services" : "functions"].in_scope.push(cloned);
  } else {
    out[kind === "service" ? "services" : "functions"][bucket].push({ fact_key: key, reason: selection.reason, fact: cloned });
  }
  out.ledger.push({ kind, fact_key: key, bucket, reason: selection.reason, review_reasons: selection.review_reasons });
}

function firstMatchingRule(fact, rules, matcher) {
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (matcher(fact, rule && rule.when)) return rule || {};
  }
  return null;
}

function buildSelectionContext(services) {
  const implCounts = new Map();
  for (const service of services || []) {
    const impl = text(service && service.impl_qn);
    if (impl) implCounts.set(impl, (implCounts.get(impl) || 0) + 1);
  }
  return { implCounts };
}

function selectScope({ services = [], functions = [], policy = {} } = {}) {
  if (!policy || (!Array.isArray(policy.service_rules) && !Array.isArray(policy.function_rules))) {
    return emptyView(services, functions);
  }
  const out = {
    schemaVersion: 1,
    policyVersion: Number(policy.schemaVersion || policy.schema_version || 1),
    default_bucket: text(policy.default_bucket) || "in_scope",
    services: { in_scope: [], excluded: [], review: [] },
    functions: { in_scope: [], excluded: [], review: [] },
    ledger: [],
  };

  const context = buildSelectionContext(services);
  const serviceBucketByKey = new Map();
  for (const service of services) {
    const rule = firstMatchingRule(service, policy.service_rules, (fact, when) => matchesServiceRule(fact, when, context));
    let bucket = text(rule && rule.bucket) || out.default_bucket || "in_scope";
    const reason = text(rule && rule.reason) || (rule ? "matched_rule" : "default");
    let reviewReasons = rule && rule.mark_review ? [text(rule.mark_review)] : [];
    // 尊重 L2 事实层 review_required(如 exposure 置信=none 的结构候选)：策略未排除/复核时不得静默 in_scope，
    // 下沉 review(可见不丢)。这是 fact 级不确定性, 非业务规则; 业务排除仍由 policy 决定。
    if (bucket !== "excluded" && bucket !== "review" && service && service.review_required) {
      bucket = "review";
      reviewReasons = [...reviewReasons, ...(Array.isArray(service.review_reasons) ? service.review_reasons.map(text) : [])];
    }
    const normalized = bucket === "excluded" || bucket === "review" ? bucket : "in_scope";
    const key = serviceKey(service);
    serviceBucketByKey.set(key, { bucket: normalized, reason, reviewReasons, service });
    addBucket(out, "service", normalized, service, reason, reviewReasons);
  }

  for (const fn of functions) {
    const parent = [...serviceBucketByKey.values()].find((item) => functionBelongsToService(fn, item.service));
    if (parent && parent.bucket !== "in_scope") {
      addBucket(out, "function", parent.bucket, fn, `service_${parent.reason || parent.bucket}`);
      continue;
    }

    const rule = firstMatchingRule(fn, policy.function_rules, matchesFunctionRule);
    const bucket = text(rule && rule.bucket) || out.default_bucket || "in_scope";
    const reason = text(rule && rule.reason) || (rule ? "matched_rule" : "default");
    const normalized = bucket === "excluded" || bucket === "review" ? bucket : "in_scope";
    const reviewReasons = [];
    if (rule && rule.mark_review) reviewReasons.push(text(rule.mark_review));
    addBucket(out, "function", normalized, fn, reason, reviewReasons);
  }

  out.counts = {
    services: {
      total: services.length,
      in_scope: out.services.in_scope.length,
      excluded: out.services.excluded.length,
      review: out.services.review.length,
    },
    functions: {
      total: functions.length,
      in_scope: out.functions.in_scope.length,
      excluded: out.functions.excluded.length,
      review: out.functions.review.length,
    },
  };
  out.conservation = {
    servicesOk: out.counts.services.total === out.counts.services.in_scope + out.counts.services.excluded + out.counts.services.review,
    functionsOk: out.counts.functions.total === out.counts.functions.in_scope + out.counts.functions.excluded + out.counts.functions.review,
  };
  return out;
}

module.exports = {
  selectScope,
  emptyView,
  serviceKey,
  functionKey,
};
