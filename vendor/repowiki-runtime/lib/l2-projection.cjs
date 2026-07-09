function text(value) {
  return String(value || "");
}

function compact(values) {
  return values.map(text).join("#");
}

function routeKey(fn) {
  return text(fn.route || fn.path || fn.command_name || fn.event_type || fn.http_method || fn.entry_qn);
}

function functionKey(fn) {
  return compact([
    fn.module,
    fn.profile,
    fn.entry_type,
    fn.impl_qn,
    fn.method,
    fn.signature,
    fn.version,
    fn.group,
    routeKey(fn),
  ]);
}

function serviceKey(svc) {
  return compact([svc.module, svc.profile, svc.impl_qn, svc.iface_qn || svc.service_iface || svc.impl_qn, svc.service_iface || "", svc.version, svc.group]);
}

function modelKey(model) {
  return compact([model.module, model.profile, model.type]);
}

function relationId(kind, from, to, extra = "") {
  return compact([kind, from, to, extra]);
}

function supportedEntryPatterns(profile) {
  const fields = [
    profile.entry_patterns,
    profile.entry_annotations,
    profile.method_annotations,
    profile.service_annotations,
    profile.service_xml,
    profile.class_path_annotations,
  ];
  return [...new Set(fields.flatMap((x) => Array.isArray(x) ? x : []).filter(Boolean))];
}

function normalizeCandidate(candidate, profile, slug) {
  const base = {
    module: slug,
    profile: profile.name,
    entry_type: profile.entry_type || "",
    confidence: "high",
    source_mode: "profile-wide-scan-v1",
    evidence: {},
    ...candidate,
  };
  base.route = base.route || base.path || base.command_name || base.event_type || "";
  base.function_key = base.function_key || functionKey(base);
  base.candidate_id = base.candidate_id || `candidate#${base.function_key}`;
  return base;
}

function candidateFromFunction(fn, service, profile, slug) {
  return normalizeCandidate({
    module: slug,
    profile: profile.name,
    entry_type: fn.entry_type || profile.entry_type || "",
    impl_qn: fn.impl_qn || "",
    method: fn.method || "",
    signature: fn.signature || "",
    return_type: fn.return_type || "",
    params: fn.params || [],
    route: fn.route || fn.path || fn.command_name || fn.event_type || "",
    http_method: fn.http_method || "",
    command_name: fn.command_name || "",
    event_type: fn.event_type || "",
    service_iface: fn.service_iface || service?.service_iface || "",
    iface_qn: fn.iface_qn || service?.iface_qn || "",
    version: fn.version || service?.version || "",
    group: fn.group || service?.group || "",
    confidence: "high",
    source_mode: "profile-materialized-v1",
    evidence: {
      source_file: fn.source_file || service?.source_file || "",
      iface_file: fn.iface_file || "",
      annotation: fn.entry_annotation || "",
      route: fn.route || fn.path || "",
      signature: fn.signature || "",
    },
  }, profile, slug);
}

function entryEntityId(candidate) {
  return `entry#${candidate.function_key}`;
}

function methodEntityId(candidate) {
  return `method#${compact([candidate.module, candidate.profile, candidate.impl_qn, candidate.method, candidate.signature])}`;
}

function serviceEntityIdFromCandidate(candidate) {
  return `service#${compact([candidate.module, candidate.profile, candidate.impl_qn, candidate.iface_qn || candidate.service_iface || candidate.impl_qn, candidate.service_iface || "", candidate.version, candidate.group])}`;
}

function buildEntryGraphFromCandidates({ slug, profile, candidates, services }) {
  const entities = [];
  const relations = [];
  const entitySeen = new Set();
  const relationSeen = new Set();
  const serviceIds = new Map();

  function pushEntity(entity) {
    if (!entity.entity_id || entitySeen.has(entity.entity_id)) return;
    entitySeen.add(entity.entity_id);
    entities.push(entity);
  }

  function pushRelation(relation) {
    if (!relation.relation_id || relationSeen.has(relation.relation_id)) return;
    relationSeen.add(relation.relation_id);
    relations.push(relation);
  }

  for (const svc of services || []) {
    const id = `service#${serviceKey(svc)}`;
    serviceIds.set(compact([svc.impl_qn, svc.iface_qn || svc.service_iface || svc.impl_qn, svc.service_iface || "", svc.version || "", svc.group || ""]), id);
    serviceIds.set(compact([svc.impl_qn, "", svc.service_iface || "", svc.version || "", svc.group || ""]), id);
    pushEntity({
      entity_id: id,
      entity_type: "service",
      module: slug,
      profile: profile.name,
      name: svc.service_iface || svc.impl_qn || "",
      qn: svc.impl_qn || svc.iface_qn || "",
      source_file: svc.source_file || "",
      evidence: svc.evidence || {},
    });
    if (svc.iface_qn && svc.impl_qn && svc.iface_qn !== svc.impl_qn) {
      pushRelation({
        relation_id: relationId("implements", id, svc.iface_qn),
        relation_type: "implements",
        module: slug,
        profile: profile.name,
        from_entity: id,
        to_entity: svc.iface_qn,
        evidence: svc.evidence || {},
      });
    }
  }

  for (const candidate of candidates || []) {
    const entryId = entryEntityId(candidate);
    const methodId = methodEntityId(candidate);
    const svcId = serviceIds.get(compact([candidate.impl_qn, candidate.iface_qn || candidate.service_iface || candidate.impl_qn, candidate.service_iface || "", candidate.version || "", candidate.group || ""])) ||
      serviceIds.get(compact([candidate.impl_qn, "", candidate.service_iface || "", candidate.version || "", candidate.group || ""])) ||
      serviceEntityIdFromCandidate(candidate);

    pushEntity({
      entity_id: svcId,
      entity_type: "service",
      module: slug,
      profile: profile.name,
      name: candidate.service_iface || candidate.impl_qn || "",
      qn: candidate.impl_qn || "",
      evidence: candidate.evidence || {},
    });
    pushEntity({
      entity_id: entryId,
      entity_type: "entry",
      module: slug,
      profile: profile.name,
      entry_type: candidate.entry_type || profile.entry_type || "",
      impl_qn: candidate.impl_qn || "",
      method: candidate.method || "",
      signature: candidate.signature || "",
      version: candidate.version || "",
      group: candidate.group || "",
      route: candidate.route || "",
      candidate_id: candidate.candidate_id,
      function_key: candidate.function_key,
      source_mode: candidate.source_mode || "",
      confidence: candidate.confidence || "high",
      evidence: candidate.evidence || {},
    });
    pushEntity({
      entity_id: methodId,
      entity_type: "method",
      module: slug,
      profile: profile.name,
      impl_qn: candidate.impl_qn || "",
      method: candidate.method || "",
      signature: candidate.signature || "",
      return_type: candidate.return_type || "",
      params: candidate.params || [],
      evidence: candidate.evidence || {},
    });
    pushRelation({
      relation_id: relationId("service_exposes_entry", svcId, entryId),
      relation_type: "service_exposes_entry",
      module: slug,
      profile: profile.name,
      from_entity: svcId,
      to_entity: entryId,
      candidate_id: candidate.candidate_id,
      evidence: candidate.evidence || {},
    });
    pushRelation({
      relation_id: relationId("entry_resolves_to_method", entryId, methodId),
      relation_type: "entry_resolves_to_method",
      module: slug,
      profile: profile.name,
      from_entity: entryId,
      to_entity: methodId,
      candidate_id: candidate.candidate_id,
      evidence: candidate.evidence || {},
    });
    if (candidate.route || candidate.http_method || candidate.command_name || candidate.event_type || candidate.entry_annotation) {
      const triggerId = `trigger#${compact([candidate.function_key, candidate.route || candidate.command_name || candidate.event_type || candidate.entry_annotation])}`;
      pushEntity({
        entity_id: triggerId,
        entity_type: "entry_trigger",
        module: slug,
        profile: profile.name,
        trigger_type: candidate.http_method ? "http_route" : candidate.command_name ? "command" : candidate.event_type ? "event" : candidate.entry_annotation ? "annotation" : "entry",
        route: candidate.route || "",
        http_method: candidate.http_method || "",
        command_name: candidate.command_name || "",
        event_type: candidate.event_type || "",
        annotation: candidate.entry_annotation || candidate.evidence?.annotation || "",
        evidence: candidate.evidence || {},
      });
      pushRelation({
        relation_id: relationId("trigger_resolves_to_entry", triggerId, entryId),
        relation_type: "trigger_resolves_to_entry",
        module: slug,
        profile: profile.name,
        from_entity: triggerId,
        to_entity: entryId,
        candidate_id: candidate.candidate_id,
        evidence: candidate.evidence || {},
      });
    }
  }

  return { entities, relations };
}

function deriveExpectedFunctionsFromGraph({ slug, profile, candidates, entities, relations }) {
  const entries = new Map((entities || [])
    .filter((x) => x.entity_type === "entry" && x.module === slug && x.profile === profile.name)
    .map((x) => [x.entity_id, x]));
  const resolves = new Set((relations || [])
    .filter((x) => x.relation_type === "entry_resolves_to_method" && x.module === slug && x.profile === profile.name)
    .map((x) => x.from_entity));
  const exposes = new Set((relations || [])
    .filter((x) => x.relation_type === "service_exposes_entry" && x.module === slug && x.profile === profile.name)
    .map((x) => x.to_entity));
  const byCandidate = new Map((candidates || []).map((x) => [x.candidate_id, x]));
  const expected = [];

  for (const [entryId, entry] of entries) {
    const candidate = byCandidate.get(entry.candidate_id) || {};
    if (!resolves.has(entryId) || !exposes.has(entryId)) continue;
    const fn = {
      module: slug,
      profile: profile.name,
      entry_type: entry.entry_type || candidate.entry_type || profile.entry_type || "",
      impl_qn: entry.impl_qn || candidate.impl_qn || "",
      method: entry.method || candidate.method || "",
      signature: entry.signature || candidate.signature || "",
      route: entry.route || candidate.route || "",
      version: entry.version || candidate.version || "",
      group: entry.group || candidate.group || "",
      path: candidate.path || "",
      http_method: candidate.http_method || "",
      command_name: candidate.command_name || "",
      event_type: candidate.event_type || "",
    };
    const key = candidate.function_key || functionKey(fn);
    expected.push({
      expected_id: `expected#${key}`,
      candidate_id: entry.candidate_id || candidate.candidate_id || "",
      function_key: key,
      module: slug,
      profile: profile.name,
      entry_type: fn.entry_type,
      impl_qn: fn.impl_qn,
      method: fn.method,
      signature: fn.signature,
      version: fn.version,
      group: fn.group,
      route: fn.route,
      confidence: entry.confidence || candidate.confidence || "high",
      source_mode: "graph-derived-v1",
      expected_rule: `${profile.name}:service_exposes_entry+entry_resolves_to_method`,
      evidence: {
        ...(candidate.evidence || {}),
        entry_entity: entryId,
        graph_relations: ["service_exposes_entry", "entry_resolves_to_method"],
      },
    });
  }

  return expected;
}

function attachExpectedMetadata(functions, expectedFunctions) {
  const expectedByKey = new Map((expectedFunctions || []).map((x) => [x.function_key, x]));
  return (functions || []).map((fn) => {
    const key = fn.function_key || functionKey(fn);
    const expected = expectedByKey.get(key);
    return expected ? {
      ...fn,
      function_key: key,
      expected_id: expected.expected_id,
      candidate_id: expected.candidate_id,
      materialized_by: "l2-profile",
      materialized_from: "actual-functions",
    } : {
      ...fn,
      function_key: key,
      materialized_by: "l2-profile",
      materialized_from: "actual-functions",
    };
  });
}

function buildProjectionParts({ slug, profile, services, functions, downstream, models, entryCandidates = null }) {
  const servicesByImpl = new Map();
  for (const svc of services || []) {
    const list = servicesByImpl.get(svc.impl_qn) || [];
    list.push(svc);
    servicesByImpl.set(svc.impl_qn, list);
  }

  const rawCandidates = entryCandidates
    ? entryCandidates.map((x) => normalizeCandidate(x, profile, slug))
    : (functions || []).map((fn) => {
        const service = (servicesByImpl.get(fn.impl_qn) || []).find((svc) =>
          !fn.service_iface || svc.service_iface === fn.service_iface || svc.iface_qn === fn.iface_qn
        ) || (servicesByImpl.get(fn.impl_qn) || [])[0] || null;
        return candidateFromFunction(fn, service, profile, slug);
      });
  const candidates = [...new Map(rawCandidates.map((candidate) => [candidate.function_key, candidate])).values()];

  const entryGraph = buildEntryGraphFromCandidates({ slug, profile, candidates, services });
  const entities = [...entryGraph.entities];
  const relations = [...entryGraph.relations];
  const entitySeen = new Set(entities.map((x) => x.entity_id));
  const relationSeen = new Set(relations.map((x) => x.relation_id));
  const functionEntityByCallKey = new Map();

  function pushEntity(entity) {
    if (!entity.entity_id || entitySeen.has(entity.entity_id)) return;
    entitySeen.add(entity.entity_id);
    entities.push(entity);
  }

  function pushRelation(relation) {
    if (!relation.relation_id || relationSeen.has(relation.relation_id)) return;
    relationSeen.add(relation.relation_id);
    relations.push(relation);
  }

  const expectedFunctions = deriveExpectedFunctionsFromGraph({ slug, profile, candidates, entities, relations });
  const materializedFunctions = attachExpectedMetadata(functions || [], expectedFunctions);
  const expectedByKey = new Map(expectedFunctions.map((x) => [x.function_key, x]));

  for (const fn of materializedFunctions) {
    const key = fn.function_key || functionKey(fn);
    const expected = expectedByKey.get(key);
    const fnEntity = `function#${key}`;
    const callKey = compact([fn.module, fn.impl_qn, fn.method]);
    if (!functionEntityByCallKey.has(callKey)) functionEntityByCallKey.set(callKey, fnEntity);
    pushEntity({
      entity_id: fnEntity,
      entity_type: "function",
      module: slug,
      profile: profile.name,
      entry_type: fn.entry_type || expected?.entry_type || profile.entry_type || "",
      impl_qn: fn.impl_qn || "",
      method: fn.method || "",
      signature: fn.signature || "",
      version: fn.version || expected?.version || "",
      group: fn.group || expected?.group || "",
      route: fn.route || expected?.route || "",
      source_file: fn.source_file || "",
      iface_file: fn.iface_file || "",
      expected_id: expected?.expected_id || "",
      candidate_id: expected?.candidate_id || "",
      evidence: fn.evidence || expected?.evidence || {},
      confidence: fn.confidence || {},
    });
    if (expected) {
      pushRelation({
        relation_id: relationId("expected_materialized_as_function", expected.expected_id, fnEntity),
        relation_type: "expected_materialized_as_function",
        module: slug,
        profile: profile.name,
        from_entity: expected.expected_id,
        to_entity: fnEntity,
        evidence: expected.evidence || {},
      });
    }
    for (const type of fn.model_types || []) {
      const modelEntity = `model#${compact([slug, profile.name, type])}`;
      pushRelation({
        relation_id: relationId("uses_model", fnEntity, modelEntity),
        relation_type: "uses_model",
        module: slug,
        profile: profile.name,
        from_entity: fnEntity,
        to_entity: modelEntity,
        evidence: { type },
      });
    }
  }

  for (const model of models || []) {
    pushEntity({
      entity_id: `model#${modelKey(model)}`,
      entity_type: "model",
      module: slug,
      profile: profile.name,
      name: model.type || "",
      qn: model.type || "",
      fields: model.fields || [],
      evidence: { source: model.source || "" },
    });
  }

  for (const edge of downstream || []) {
    const from = functionEntityByCallKey.get(compact([edge.module, edge.from_impl, edge.from_method])) ||
      `function#${compact([edge.module, edge.profile, edge.entry_type, edge.from_impl, edge.from_method])}`;
    const to = text(edge.to_qn || `${edge.to_service || ""}.${edge.to_method || ""}`);
    pushRelation({
      relation_id: relationId("calls", from, to, edge.downstream_kind || ""),
      relation_type: "calls",
      module: slug,
      profile: profile.name,
      from_entity: from,
      to_entity: to,
      downstream_kind: edge.downstream_kind || "",
      evidence: {
        to_service: edge.to_service || "",
        to_method: edge.to_method || "",
        to_qn: edge.to_qn || "",
      },
    });
  }

  return {
    entryCandidates: {
      schemaVersion: 3,
      profile: profile.name,
      slug,
      source_mode: entryCandidates ? "profile-wide-scan-v1" : "profile-materialized-v1",
      expected_source_mode: "graph-derived-v1",
      supported_entry_patterns: supportedEntryPatterns(profile),
      candidates,
      coverage: {
        status: "passed",
        high_confidence_count: candidates.filter((x) => x.confidence === "high").length,
        unsupported_or_low_confidence_count: candidates.filter((x) => x.confidence !== "high").length,
        gaps: [],
        note: entryCandidates ? "profile-wide-scan-v1 candidates are converted into entry graph before deriving expected functions." : "profile-materialized-v1 is a compatibility path; add profile-wide candidates for independent coverage.",
      },
      unresolved_exposures: [],
    },
    entities,
    relations,
    expectedFunctions,
    materializedFunctions,
  };
}

function flattenCandidateDocs(candidateDocs) {
  return (candidateDocs || []).flatMap((doc) => Array.isArray(doc) ? doc : (doc.candidates || []));
}

function summarizeDiagnostics(items) {
  const out = { byType: {}, byLayer: {}, byProfile: {}, byModule: {}, bySeverity: {} };
  for (const item of items || []) {
    const type = item.type || "unknown";
    const layer = item.likely_layer || "unknown";
    const profile = item.profile || "unknown";
    const module = item.module || "unknown";
    const severity = item.severity || "medium";
    out.byType[type] = (out.byType[type] || 0) + 1;
    out.byLayer[layer] = (out.byLayer[layer] || 0) + 1;
    out.byProfile[profile] = (out.byProfile[profile] || 0) + 1;
    out.byModule[module] = (out.byModule[module] || 0) + 1;
    out.bySeverity[severity] = (out.bySeverity[severity] || 0) + 1;
  }
  return out;
}

function dependencyChain(layer) {
  const base = ["L1:codegraph", "L2:profile-scan", "L2:entry-candidates", "L2:entry-graph", "L2:expected-functions", "L2:actual-functions"];
  const idx = {
    l1_graph_suspect: 0,
    profile_entity_missing: 1,
    profile_candidate_missing: 1,
    profile_unsupported_pattern: 1,
    relation_missing: 3,
    graph_expected_rule_missing: 4,
    materialization_missing: 5,
    function_key_mismatch: 5,
    function_key_duplicate: 5,
  }[layer] ?? base.length - 1;
  return base.map((step, i) => ({ step, suspect: i === idx }));
}

function severityFor(layer, blocking = true) {
  if (!blocking) return "warning";
  if (["missing_actual", "function_key_mismatch", "materialization_missing"].includes(layer)) return "high";
  if (["function_key_duplicate", "relation_missing", "graph_expected_rule_missing"].includes(layer)) return "high";
  return "medium";
}

function fieldDiff(expected, actual) {
  const fields = ["module", "profile", "entry_type", "impl_qn", "method", "signature", "route", "function_key"];
  const diff = {};
  for (const field of fields) {
    const e = text(expected && expected[field]);
    const a = text(actual && actual[field]);
    if (e !== a) diff[field] = { expected: e, actual: a };
  }
  return diff;
}

function codegraphWarning(codegraphState) {
  if (!codegraphState) {
    return {
      type: "l1_warning",
      likely_layer: "l1_graph_suspect",
      severity: "warning",
      blocking: false,
      evidence: { reason: "missing .repowiki/codegraph-init.json" },
      dependency_chain: dependencyChain("l1_graph_suspect"),
      next_action: "Run repowiki-codegraph-init.cjs and ensure L1 status is done before trusting L2 coverage.",
    };
  }
  if (codegraphState.status !== "done") {
    return {
      type: "l1_warning",
      likely_layer: "l1_graph_suspect",
      severity: "warning",
      blocking: false,
      evidence: {
        status: codegraphState.status || "unknown",
        progress: codegraphState.progress ?? null,
        phase: codegraphState.phase || "",
        logFile: codegraphState.logFile || "",
      },
      dependency_chain: dependencyChain("l1_graph_suspect"),
      next_action: "Wait for L1 codegraph to finish, then rerun L2 and merge.",
    };
  }
  return null;
}

function diagnoseCompleteness({ modules, candidates, expectedFunctions, functions, entities, relations, coverageGaps, codegraphState, coverageLedgers = [] }) {
  const diagnostics = [];
  const warnings = [];
  const expectedByCandidate = new Set((expectedFunctions || []).map((x) => x.candidate_id));
  const functionKeyCounts = new Map();
  const functionsByImplMethod = new Map();
  const candidatesByModule = new Map();
  for (const candidate of candidates || []) {
    candidatesByModule.set(candidate.module, (candidatesByModule.get(candidate.module) || 0) + 1);
  }
  for (const fn of functions || []) {
    const key = fn.function_key || functionKey(fn);
    functionKeyCounts.set(key, (functionKeyCounts.get(key) || 0) + 1);
    const im = compact([fn.module, fn.profile, fn.entry_type, fn.impl_qn, fn.method]);
    const list = functionsByImplMethod.get(im) || [];
    list.push({ ...fn, function_key: key });
    functionsByImplMethod.set(im, list);
  }
  const entityIds = new Set((entities || []).map((x) => x.entity_id));
  const relationPairs = new Set((relations || []).map((x) => `${x.relation_type}|${x.from_entity}|${x.to_entity}`));

  const l1 = codegraphWarning(codegraphState);
  if (l1) warnings.push(l1);

  for (const ledger of coverageLedgers || []) {
    const counts = ledger.counts || {};
    if (Number(counts.unresolvedBindings || 0) > 0) {
      diagnostics.push({
        type: "coverage_gap",
        likely_layer: "binding_unresolved",
        severity: "high",
        blocking: true,
        module: ledger.module || "",
        profile: ledger.profile || "",
        evidence: {
          reason: "declared exposure could not be bound to implementation",
          unresolved_bindings: ledger.unresolved_bindings || [],
          counts,
        },
        dependency_chain: dependencyChain("profile_candidate_missing"),
        next_action: "Fix the mechanism interpreter binding path: interface/ref -> bean -> impl -> methods.",
      });
    }
    if (Number(counts.declaredExposures || 0) > 0 && Number(counts.resolvedBindings || 0) + Number(counts.unresolvedBindings || 0) !== Number(counts.declaredExposures || 0)) {
      diagnostics.push({
        type: "coverage_gap",
        likely_layer: "binding_ledger_mismatch",
        severity: "high",
        blocking: true,
        module: ledger.module || "",
        profile: ledger.profile || "",
        evidence: { counts },
        dependency_chain: dependencyChain("relation_missing"),
        next_action: "Declared exposure ledger must equal resolved + unresolved bindings.",
      });
    }
    if (Number(counts.unexplained || 0) > 0) {
      diagnostics.push({
        type: "coverage_gap",
        likely_layer: "l1_unexplained_symbols",
        severity: "medium",
        blocking: true,
        module: ledger.module || "",
        profile: ledger.profile || "",
        evidence: {
          reason: "L1 symbols remain unexplained by current mechanism/internal classifiers",
          unexplained_count: Number(counts.unexplained || 0),
          samples: (ledger.unexplained || []).slice(0, 20),
        },
        dependency_chain: dependencyChain("profile_unsupported_pattern"),
        next_action: "Classify these L1 symbols with evidence, or add a mechanism interpreter if they represent exposed entries.",
      });
    }
    if (Number(counts.methodUnresolvedServices || 0) > 0) {
      diagnostics.push({
        type: "coverage_gap",
        likely_layer: "method_enumeration_unresolved",
        severity: "high",
        blocking: true,
        module: ledger.module || "",
        profile: ledger.profile || "",
        evidence: {
          reason: "resolved service interfaces have no reliable L1 method denominator",
          method_unresolved_services: Number(counts.methodUnresolvedServices || 0),
          method_unresolved_methods: Number(counts.methodUnresolvedMethods || 0),
          samples: (ledger.method_enumeration || [])
            .filter((x) => x.status === "unresolved" || x.status === "fallback")
            .slice(0, 20),
        },
        dependency_chain: dependencyChain("profile_candidate_missing"),
        next_action: "Fix L2 method enumeration: interface node -> contains methods -> extends parents, or make unresolved explicit.",
      });
    }
    if (Number(counts.methodParseUnresolved || 0) > 0) {
      diagnostics.push({
        type: "coverage_gap",
        likely_layer: "method_parse_unresolved",
        severity: "high",
        blocking: true,
        module: ledger.module || "",
        profile: ledger.profile || "",
        evidence: {
          reason: "L1 method nodes were found but could not be materialized into L2 function facts",
          method_parse_unresolved: Number(counts.methodParseUnresolved || 0),
          samples: (ledger.method_enumeration || [])
            .flatMap((x) => x.parse_unresolved_methods || [])
            .slice(0, 20),
        },
        dependency_chain: dependencyChain("materialization_missing"),
        next_action: "Fix L2 CodeGraph signature parsing without dropping the raw method node.",
      });
    }
    if (Number(counts.methodLedgerMismatches || 0) > 0) {
      diagnostics.push({
        type: "coverage_gap",
        likely_layer: "method_ledger_mismatch",
        severity: "high",
        blocking: true,
        module: ledger.module || "",
        profile: ledger.profile || "",
        evidence: {
          reason: "L1 raw interface method denominator does not conserve into materialized/skipped/unresolved buckets",
          method_ledger_mismatches: Number(counts.methodLedgerMismatches || 0),
          samples: (ledger.method_enumeration || []).filter((x) => {
            const raw = Number(x.raw_reachable_method_nodes || 0);
            const materialized = Number(x.materialized_functions || 0);
            const parseUnresolved = (x.parse_unresolved_methods || []).length;
            const shadowed = (x.shadowed_inherited_methods || []).length;
            const skipped = (x.skipped_methods || []).length;
            return raw > 0 && raw !== materialized + parseUnresolved + shadowed + skipped;
          }).slice(0, 20),
        },
        dependency_chain: dependencyChain("relation_missing"),
        next_action: "Make every L1 raw method land in exactly one method enumeration bucket.",
      });
    }
  }

  for (const mod of modules || []) {
    if (candidatesByModule.get(mod.slug)) continue;
    diagnostics.push({
      type: "coverage_gap",
      likely_layer: "profile_candidate_missing",
      severity: "high",
      blocking: true,
      module: mod.slug || "",
      profile: mod.profile || "",
      evidence: {
        relPath: mod.relPath || "",
        absPath: mod.absPath || "",
        reason: "module is listed by list-services but has zero entry candidates",
      },
      dependency_chain: dependencyChain("profile_candidate_missing"),
      next_action: "Check whether list-services overmatched this module or extend the L2 profile extractor for this entry pattern.",
    });
  }

  for (const candidate of candidates || []) {
    const entryId = entryEntityId(candidate);
    const methodId = methodEntityId(candidate);
    const serviceId = serviceEntityIdFromCandidate(candidate);
    if (!entityIds.has(entryId) || !entityIds.has(methodId)) {
      diagnostics.push({
        type: "missing_expected",
        likely_layer: "profile_entity_missing",
        module: candidate.module,
        profile: candidate.profile,
        candidate_id: candidate.candidate_id,
        function_key: candidate.function_key,
        severity: "high",
        blocking: true,
        evidence: { missing_entry_entity: !entityIds.has(entryId), missing_method_entity: !entityIds.has(methodId), candidate },
        dependency_chain: dependencyChain("profile_entity_missing"),
        next_action: "Check profile wide-scan entry entity projection and candidate fields.",
      });
    } else if (!relationPairs.has(`service_exposes_entry|${serviceId}|${entryId}`) || !relationPairs.has(`entry_resolves_to_method|${entryId}|${methodId}`)) {
      diagnostics.push({
        type: "missing_expected",
        likely_layer: "relation_missing",
        module: candidate.module,
        profile: candidate.profile,
        candidate_id: candidate.candidate_id,
        function_key: candidate.function_key,
        severity: "high",
        blocking: true,
        evidence: {
          missing_service_exposes_entry: !relationPairs.has(`service_exposes_entry|${serviceId}|${entryId}`),
          missing_entry_resolves_to_method: !relationPairs.has(`entry_resolves_to_method|${entryId}|${methodId}`),
        },
        dependency_chain: dependencyChain("relation_missing"),
        next_action: "Check entry graph relation projection for this profile.",
      });
    } else if (!expectedByCandidate.has(candidate.candidate_id)) {
      diagnostics.push({
        type: "missing_expected",
        likely_layer: "graph_expected_rule_missing",
        module: candidate.module,
        profile: candidate.profile,
        candidate_id: candidate.candidate_id,
        function_key: candidate.function_key,
        severity: "high",
        blocking: true,
        evidence: { candidate },
        dependency_chain: dependencyChain("graph_expected_rule_missing"),
        next_action: "Check deriveExpectedFunctionsFromGraph profile rule.",
      });
    }
  }

  for (const expected of expectedFunctions || []) {
    if (functionKeyCounts.has(expected.function_key)) continue;
    const im = compact([expected.module, expected.profile, expected.entry_type, expected.impl_qn, expected.method]);
    const similar = functionsByImplMethod.get(im) || [];
    const layer = similar.length ? "function_key_mismatch" : (codegraphState && codegraphState.status !== "done" ? "l1_graph_suspect" : "materialization_missing");
    diagnostics.push({
      type: "missing_actual",
      likely_layer: layer,
      module: expected.module,
      profile: expected.profile,
      expected_id: expected.expected_id,
      candidate_id: expected.candidate_id,
      function_key: expected.function_key,
      severity: severityFor(layer),
      blocking: true,
      diff: similar.length ? fieldDiff(expected, similar[0]) : {},
      evidence: {
        expected,
        similar_actual_functions: similar.map((x) => ({
          function_key: x.function_key,
          signature: x.signature || "",
          route: x.route || "",
        })),
      },
      dependency_chain: dependencyChain(layer),
      next_action: layer === "l1_graph_suspect"
        ? "L1 codegraph is not done; rerun or complete L1, then rerun L2 and merge."
        : similar.length
        ? "Align functionKey fields between expected graph rule and actual function extraction."
        : "Check L2 profile extractor; graph says this entry exists but actual functions.json has no matching row.",
    });
  }

  for (const [function_key, count] of functionKeyCounts.entries()) {
    if (count <= 1) continue;
    diagnostics.push({
      type: "duplicate_actual",
      likely_layer: "function_key_duplicate",
      function_key,
      count,
      severity: "high",
      blocking: true,
      dependency_chain: dependencyChain("function_key_duplicate"),
      next_action: "Check profile extractor de-duplication key and module/profile slug.",
    });
  }

  for (const gap of coverageGaps || []) {
    const layer = gap.coverage?.likely_layer || "profile_unsupported_pattern";
    diagnostics.push({
      type: "coverage_gap",
      likely_layer: layer,
      module: gap.slug || "",
      profile: gap.profile || "",
      severity: gap.coverage?.severity || "medium",
      blocking: true,
      evidence: gap.coverage || {},
      dependency_chain: dependencyChain(layer),
      next_action: gap.coverage?.next_action || "Extend the matching profile or add a new profile for this entry pattern.",
    });
  }

  return { diagnostics, warnings, summary: summarizeDiagnostics([...diagnostics, ...warnings]) };
}

function computeCompleteness({ modules, functions, candidateDocs, expectedFunctions, entities = [], relations = [], coverageLedgers = [], codegraphState = null }) {
  const candidates = flattenCandidateDocs(candidateDocs);
  const candidateIdCounts = new Map();
  for (const candidate of candidates) {
    const id = candidate.candidate_id || `candidate#${functionKey(candidate)}`;
    candidateIdCounts.set(id, (candidateIdCounts.get(id) || 0) + 1);
  }
  const duplicateCandidateIds = [...candidateIdCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([candidate_id, count]) => ({ candidate_id, count }));
  const candidateModules = new Set(candidates.map((x) => x.module).filter(Boolean));
  const zeroCandidateModules = (modules || [])
    .filter((mod) => mod && mod.slug && !candidateModules.has(mod.slug))
    .map((mod) => ({
      slug: mod.slug || "",
      profile: mod.profile || "",
      relPath: mod.relPath || "",
      absPath: mod.absPath || "",
    }));
  const sourceModes = [...new Set((candidateDocs || []).map((doc) => doc.expected_source_mode || doc.source_mode || "unknown"))].sort();
  const scope = sourceModes.includes("graph-derived-v1")
    ? "graph_derived_expected_v1"
    : sourceModes.length === 1 && sourceModes[0] === "profile-wide-scan-v1"
      ? "profile_wide_scan_v1"
      : sourceModes.includes("profile-wide-scan-v1")
        ? "mixed_profile_scan_v1"
        : "profile_materialization_v1";
  const highCandidates = candidates.filter((x) => x.confidence === "high");
  const expectedByCandidate = new Set((expectedFunctions || []).map((x) => x.candidate_id));
  const functionKeyCounts = new Map();
  for (const fn of functions || []) {
    const key = fn.function_key || functionKey(fn);
    functionKeyCounts.set(key, (functionKeyCounts.get(key) || 0) + 1);
  }
  const expectedHigh = (expectedFunctions || []).filter((x) => x.confidence === "high");
  const missingExpected = highCandidates.filter((x) => !expectedByCandidate.has(x.candidate_id));
  const missingFunctions = expectedHigh.filter((x) => !functionKeyCounts.has(x.function_key));
  const duplicateFunctions = [...functionKeyCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([function_key, count]) => ({ function_key, count }));
  const coverageGaps = [];
  for (const doc of candidateDocs || []) {
    const coverage = doc.coverage || {};
    if (coverage.status && coverage.status !== "passed") {
      coverageGaps.push({ slug: doc.slug || "", profile: doc.profile || "", coverage });
    }
  }
  const diagnosis = diagnoseCompleteness({ modules, candidates, expectedFunctions, functions, entities, relations, coverageGaps, codegraphState, coverageLedgers });
  const diagnostics = diagnosis.diagnostics;
  const warnings = diagnosis.warnings;
  // diagnostics（l1_unexplained_symbols/method_enumeration_unresolved 等边界信号）记录供 review，但不阻塞 status——
  // 只真数据缺口（missing/duplicate/coverageGap）才 failed。避免边界信号挡死 L3 让大模型反复分析（completeness 分级）。
  const status = missingExpected.length || missingFunctions.length || duplicateFunctions.length || coverageGaps.length
    ? "failed"
    : "passed";
  return {
    schemaVersion: 3,
    status,
    scope,
    sourceModes,
    scope_note: scope === "graph_derived_expected_v1"
      ? "Checks graph-derived expected functions against actual functions.json."
      : "Checks candidate -> expected -> functions consistency for supported profile output.",
    modules: (modules || []).length,
    summary: {
      candidates: candidates.length,
      uniqueCandidates: candidateIdCounts.size,
      highConfidenceCandidates: highCandidates.length,
      expectedFunctions: (expectedFunctions || []).length,
      functions: (functions || []).length,
      duplicateCandidateIds: duplicateCandidateIds.length,
      zeroCandidateModules: zeroCandidateModules.length,
      missingExpected: missingExpected.length,
      missingFunctions: missingFunctions.length,
      duplicateFunctionKeys: duplicateFunctions.length,
      coverageGaps: coverageGaps.length,
      diagnostics: diagnostics.length,
      warnings: warnings.length,
      coverageLedgers: coverageLedgers.length,
      declaredExposures: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.declaredExposures || 0), 0),
      resolvedBindings: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.resolvedBindings || 0), 0),
      unresolvedBindings: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.unresolvedBindings || 0), 0),
      unexplainedSymbols: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.unexplained || 0), 0),
      reviewServices: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.reviewServices || 0), 0),
      lowExposureConfidence: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.lowExposureConfidence || 0), 0),
      rawReachableInterfaceMethods: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.rawReachableInterfaceMethods || 0), 0),
      materializedInterfaceFunctions: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.materializedInterfaceFunctions || 0), 0),
      methodUnresolvedServices: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.methodUnresolvedServices || 0), 0),
      methodUnresolvedMethods: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.methodUnresolvedMethods || 0), 0),
      methodFallbackServices: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.methodFallbackServices || 0), 0),
      methodLedgerMismatches: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.methodLedgerMismatches || 0), 0),
      methodParseUnresolved: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.methodParseUnresolved || 0), 0),
      shadowedInheritedMethods: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.shadowedInheritedMethods || 0), 0),
      skippedInterfaceMethods: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.skippedInterfaceMethods || 0), 0),
      emptyInterfaces: (coverageLedgers || []).reduce((n, x) => n + Number(x.counts?.emptyInterfaces || 0), 0),
    },
    duplicateCandidateIds,
    zeroCandidateModules,
    missingExpected,
    missingFunctions,
    duplicateFunctions,
    coverageGaps,
    diagnostics,
    warnings,
    diagnosisSummary: diagnosis.summary,
    updated_at: new Date().toISOString(),
  };
}

module.exports = {
  buildEntryGraphFromCandidates,
  buildProjectionParts,
  computeCompleteness,
  deriveExpectedFunctionsFromGraph,
  diagnoseCompleteness,
  flattenCandidateDocs,
  functionKey,
};
