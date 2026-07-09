"use strict";

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
  if (fn && fn.function_key) return fn.function_key;
  const profile = (fn && fn.profile) || ((fn && fn.entry_type) === "rpc" ? "dubbo" : "");
  return compact([
    fn && fn.module,
    profile,
    fn && fn.entry_type,
    fn && fn.impl_qn,
    fn && fn.method,
    fn && fn.signature,
    fn && fn.version,
    fn && fn.group,
    routeKey(fn || {}),
  ]);
}

function expectedId(fn) {
  if (fn && fn.expected_id) return fn.expected_id;
  const key = functionKey(fn || {});
  return key ? `expected#${key}` : "";
}

function candidateId(fn) {
  if (fn && fn.candidate_id) return fn.candidate_id;
  const key = functionKey(fn || {});
  return key ? `candidate#${key}` : "";
}

function functionEntityId(fn) {
  const key = functionKey(fn || {});
  return key ? `function#${key}` : "";
}

function entryEntityId(fn) {
  const key = functionKey(fn || {});
  return key ? `entry#${key}` : "";
}

function methodEntityId(fn) {
  return `method#${compact([fn && fn.module, fn && fn.profile, fn && fn.impl_qn, fn && fn.method, fn && fn.signature])}`;
}

function slimEntity(entity) {
  if (!entity) return null;
  const out = {
    entity_id: entity.entity_id || "",
    entity_type: entity.entity_type || "",
    module: entity.module || "",
    profile: entity.profile || "",
    name: entity.name || "",
    qn: entity.qn || "",
    impl_qn: entity.impl_qn || "",
    method: entity.method || "",
    signature: entity.signature || "",
    entry_type: entity.entry_type || "",
    version: entity.version || "",
    group: entity.group || "",
    route: entity.route || "",
    source_file: entity.source_file || "",
    confidence: entity.confidence || "",
    source_mode: entity.source_mode || "",
    candidate_id: entity.candidate_id || "",
    function_key: entity.function_key || "",
  };
  if (entity.params) out.params = entity.params;
  if (entity.evidence) out.evidence = entity.evidence;
  return out;
}

function slimRelation(relation) {
  if (!relation) return null;
  return {
    relation_id: relation.relation_id || "",
    relation_type: relation.relation_type || "",
    module: relation.module || "",
    profile: relation.profile || "",
    from_entity: relation.from_entity || "",
    to_entity: relation.to_entity || "",
    candidate_id: relation.candidate_id || "",
    evidence: relation.evidence || {},
  };
}

function slimExpected(expected) {
  if (!expected) return null;
  return {
    expected_id: expected.expected_id || "",
    candidate_id: expected.candidate_id || "",
    function_key: expected.function_key || "",
    module: expected.module || "",
    profile: expected.profile || "",
    entry_type: expected.entry_type || "",
    impl_qn: expected.impl_qn || "",
    method: expected.method || "",
    signature: expected.signature || "",
    version: expected.version || "",
    group: expected.group || "",
    confidence: expected.confidence || "",
    source_mode: expected.source_mode || "",
    expected_rule: expected.expected_rule || "",
    evidence: expected.evidence || {},
  };
}

function serviceNamesFor(fn, entities, relations) {
  const entryId = entryEntityId(fn);
  const serviceIds = new Set((relations || [])
    .filter((rel) => rel.relation_type === "service_exposes_entry" && rel.to_entity === entryId)
    .map((rel) => rel.from_entity));
  return (entities || [])
    .filter((entity) => serviceIds.has(entity.entity_id))
    .map((entity) => entity.name || entity.qn || entity.entity_id)
    .filter(Boolean);
}

function topologyFor(fn, entities, relations, topology) {
  const names = new Set(serviceNamesFor(fn, entities, relations));
  if (!names.size) {
    if (fn && fn.service_iface) names.add(fn.service_iface);
    if (fn && fn.iface_qn) names.add(String(fn.iface_qn).split(".").pop());
  }
  const edges = Array.isArray(topology && topology.edges)
    ? topology.edges.filter((edge) => names.has(edge.from_svc) || names.has(edge.to_svc))
    : [];
  const degrees = {};
  const sourceDegrees = topology && topology.degrees || {};
  for (const name of names) {
    if (sourceDegrees[name]) degrees[name] = sourceDegrees[name];
  }
  for (const edge of edges) {
    if (sourceDegrees[edge.from_svc]) degrees[edge.from_svc] = sourceDegrees[edge.from_svc];
    if (sourceDegrees[edge.to_svc]) degrees[edge.to_svc] = sourceDegrees[edge.to_svc];
  }
  return { service_names: Array.from(names), edges, degrees };
}

function graphSliceFor(fn, graphFacts) {
  const facts = graphFacts || {};
  const entities = Array.isArray(facts.entities) ? facts.entities : [];
  const relations = Array.isArray(facts.relations) ? facts.relations : [];
  const expected = Array.isArray(facts.expected) ? facts.expected : [];
  const topology = facts.topology || {};

  const ids = new Set([
    entryEntityId(fn),
    methodEntityId(fn),
    functionEntityId(fn),
    expectedId(fn),
  ].filter(Boolean));
  const candidates = new Set([candidateId(fn)].filter(Boolean));
  const key = functionKey(fn);

  const primaryRelations = relations.filter((rel) =>
    ids.has(rel.from_entity) ||
    ids.has(rel.to_entity) ||
    candidates.has(rel.candidate_id || "") ||
    (key && (String(rel.from_entity || "").includes(key) || String(rel.to_entity || "").includes(key)))
  );
  for (const rel of primaryRelations) {
    if (rel.from_entity) ids.add(rel.from_entity);
    if (rel.to_entity) ids.add(rel.to_entity);
  }
  const contextRelations = relations.filter((rel) =>
    rel.relation_type === "implements" &&
    (ids.has(rel.from_entity) || ids.has(rel.to_entity))
  );
  for (const rel of contextRelations) {
    if (rel.from_entity) ids.add(rel.from_entity);
    if (rel.to_entity) ids.add(rel.to_entity);
  }
  const selectedRelations = Array.from(new Map([...primaryRelations, ...contextRelations].map((rel) => [rel.relation_id, rel])).values());
  const selectedEntities = entities.filter((entity) => ids.has(entity.entity_id));
  const selectedExpected = expected.filter((item) =>
    item.expected_id === expectedId(fn) ||
    item.candidate_id === candidateId(fn) ||
    item.function_key === key
  );

  const relationTypes = Array.from(new Set(selectedRelations.map((rel) => rel.relation_type).filter(Boolean))).sort();
  return {
    schemaVersion: 1,
    function_key: key,
    expected_id: expectedId(fn),
    candidate_id: candidateId(fn),
    entity_ids: selectedEntities.map((entity) => entity.entity_id),
    relation_ids: selectedRelations.map((rel) => rel.relation_id),
    relation_types: relationTypes,
    entities: selectedEntities.map(slimEntity).filter(Boolean),
    relations: selectedRelations.map(slimRelation).filter(Boolean),
    expected: selectedExpected.map(slimExpected).filter(Boolean),
    topology: topologyFor(fn, entities, relations, topology),
  };
}

function graphSummary(slice) {
  const s = slice || {};
  return {
    entities: Array.isArray(s.entities) ? s.entities.length : 0,
    relations: Array.isArray(s.relations) ? s.relations.length : 0,
    expected: Array.isArray(s.expected) ? s.expected.length : 0,
    relation_types: Array.isArray(s.relation_types) ? s.relation_types : [],
    topology_edges: s.topology && Array.isArray(s.topology.edges) ? s.topology.edges.length : 0,
  };
}

module.exports = {
  graphSliceFor,
  graphSummary,
};
