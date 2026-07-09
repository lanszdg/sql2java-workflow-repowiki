"use strict";

const fs = require("fs");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function ownerOfFunction(row) {
  const pkg = clean(row && (row.package_name || row.packageName || row.service_iface || row.impl_qn));
  const method = clean(row && (row.method || row.subprogramName || row.name));
  return pkg && method ? `${upper(pkg)}.${method}` : "";
}

function splitFact(fact) {
  return clean(fact).split("|").map((part) => part.trim());
}

function matchesOwner(fn, fact) {
  const owner = splitFact(fact)[0] || "";
  return owner && owner.toUpperCase() === ownerOfFunction(fn).toUpperCase();
}

function ensureObject(obj, key) {
  if (!obj[key] || typeof obj[key] !== "object" || Array.isArray(obj[key])) obj[key] = {};
  return obj[key];
}

function ensureArray(obj, key) {
  if (!Array.isArray(obj[key])) obj[key] = [];
  return obj[key];
}

function tableNameOf(row) {
  return upper(row && (row.table || row.tableName || row.name));
}

function findOrCreateTable(fn, tableName, operation) {
  const tableFacts = ensureArray(fn, "table_facts");
  const found = tableFacts.find((row) => tableNameOf(row) === upper(tableName));
  if (found) {
    if (operation && !found.operation && !found.op) found.operation = operation;
    return found;
  }
  const row = {
    table: tableName,
    operation: operation || "UNKNOWN",
    columns: [],
    sourceTrace: ["source-facts-repairs"],
  };
  tableFacts.push(row);
  return row;
}

function pushUnique(array, value, keyFn = (row) => JSON.stringify(row)) {
  const key = keyFn(value);
  if (!array.some((row) => keyFn(row) === key)) array.push(value);
}

function addRepair(fn, row) {
  const dimension = row.dimension;
  const parts = splitFact(row.fact);
  if (!matchesOwner(fn, row.fact)) return;
  if (dimension === "signatures") {
    fn.signature = parts.slice(1).join("|");
  } else if (dimension === "params") {
    const params = ensureArray(fn, "oracle_params");
    pushUnique(params, {
      name: parts[1] || "",
      direction: parts[2] || "IN",
      oracle_type: parts[3] || "",
      java_type: "",
      sourceTrace: ["source-facts-repairs"],
    }, (param) => `${upper(param.name)}|${upper(param.direction)}|${upper(param.oracle_type)}`);
  } else if (dimension === "returnTypes") {
    fn.return_type = parts[1] || "";
  } else if (dimension === "tables") {
    findOrCreateTable(fn, parts[1] || "", parts[2] || "UNKNOWN");
  } else if (dimension === "columns") {
    const table = findOrCreateTable(fn, parts[1] || "", "");
    const columns = ensureArray(table, "columns");
    const col = parts[2] || "";
    if (col && !columns.map(upper).includes(upper(col))) columns.push(col);
  } else if (dimension === "calls") {
    const calls = ensureArray(fn, "cross_package_calls");
    const target = parts[1] || "";
    const dot = target.lastIndexOf(".");
    pushUnique(calls, {
      target_package: dot >= 0 ? target.slice(0, dot) : target,
      target_member: dot >= 0 ? target.slice(dot + 1) : "",
      sourceTrace: ["source-facts-repairs"],
    }, (call) => `${upper(call.target_package)}.${clean(call.target_member)}`);
  } else if (dimension === "sequences") {
    const seqs = ensureArray(fn, "sequence_deps");
    pushUnique(seqs, { sequence: parts[1] || "", sourceTrace: ["source-facts-repairs"] }, (seq) => upper(seq.sequence || seq.name));
  } else if (dimension === "constants") {
    const constants = ensureArray(fn, "constant_deps");
    const target = parts[1] || "";
    const dot = target.lastIndexOf(".");
    pushUnique(constants, {
      target_package: dot >= 0 ? target.slice(0, dot) : target,
      target_member: dot >= 0 ? target.slice(dot + 1) : "",
      value: null,
      sourceTrace: ["source-facts-repairs"],
    }, (constant) => `${upper(constant.target_package)}.${upper(constant.target_member)}`);
  } else if (dimension === "controlFlow") {
    const flow = ensureObject(fn, "control_flow");
    const kind = upper(parts[1] || "NODE");
    if (kind === "BRANCH") {
      pushUnique(ensureArray(flow, "branches"), { id: `repair-branch-${ensureArray(flow, "branches").length + 1}`, condition: parts[2] || "", sourceTrace: ["source-facts-repairs"] }, (item) => item.condition);
    } else if (kind === "LOOP") {
      pushUnique(ensureArray(flow, "loops"), { id: `repair-loop-${ensureArray(flow, "loops").length + 1}`, type: parts[2] || "", sourceTrace: ["source-facts-repairs"] }, (item) => item.type);
    } else {
      pushUnique(ensureArray(flow, "nodes"), { id: `repair-node-${ensureArray(flow, "nodes").length + 1}`, label: parts.slice(1).join("|"), sourceTrace: ["source-facts-repairs"] }, (item) => item.label);
    }
  } else if (dimension === "exceptions") {
    const exceptions = ensureArray(fn, "exception_handlers");
    pushUnique(exceptions, { name: parts[1] || "", action: parts[2] || "", sourceTrace: ["source-facts-repairs"] }, (item) => `${upper(item.name)}|${upper(item.action)}`);
  } else if (dimension === "transactions") {
    const tx = ensureObject(fn, "transactions");
    const marker = upper(parts[1] || "");
    if (marker === "COMMIT") tx.hasCommit = true;
    if (marker === "ROLLBACK") tx.hasRollback = true;
    if (marker === "SAVEPOINT") tx.hasSavepoint = true;
    if (marker === "AUTONOMOUS_TRANSACTION") tx.autonomous = true;
  } else if (dimension === "specialSyntax") {
    const syntax = ensureArray(fn, "special_syntax");
    const type = parts[1] || "";
    pushUnique(syntax, {
      id: `${type.toLowerCase()}-repair-${syntax.length + 1}`,
      type,
      risk: "medium",
      sourceTrace: ["source-facts-repairs"],
    }, (item) => upper(item.type));
  }
}

function removeRepair(fn, row) {
  const dimension = row.dimension;
  const parts = splitFact(row.fact);
  if (!matchesOwner(fn, row.fact)) return;
  if (dimension === "tables") {
    fn.table_facts = asArray(fn.table_facts).filter((table) => !(tableNameOf(table) === upper(parts[1]) && upper(table.operation || table.op || "UNKNOWN") === upper(parts[2] || "UNKNOWN")));
  } else if (dimension === "columns") {
    for (const table of asArray(fn.table_facts)) {
      if (tableNameOf(table) === upper(parts[1])) {
        table.columns = asArray(table.columns).filter((col) => upper(col) !== upper(parts[2]));
      }
    }
  } else if (dimension === "calls") {
    fn.cross_package_calls = asArray(fn.cross_package_calls).filter((call) => `${upper(call.target_package || call.packageName || call.package)}.${clean(call.target_member || call.member || call.method || call.name)}` !== parts[1]);
  } else if (dimension === "sequences") {
    fn.sequence_deps = asArray(fn.sequence_deps).filter((seq) => upper(seq.sequence || seq.name) !== upper(parts[1]));
  } else if (dimension === "constants") {
    fn.constant_deps = asArray(fn.constant_deps).filter((constant) => `${upper(constant.target_package || constant.packageName || constant.package)}.${upper(constant.target_member || constant.member || constant.name)}` !== upper(parts[1]));
  } else if (dimension === "specialSyntax") {
    fn.special_syntax = asArray(fn.special_syntax).filter((syntax) => upper(syntax.type || syntax.kind || syntax.name || syntax.id) !== upper(parts[1]));
  }
}

function applySourceFactRepairsToFunction(l2Fact, overlay) {
  const repaired = clone(l2Fact);
  for (const row of asArray(overlay && overlay.adds)) addRepair(repaired, row);
  for (const row of asArray(overlay && overlay.removes)) removeRepair(repaired, row);
  return repaired;
}

function loadSourceFactRepairs(file) {
  if (!file || !fs.existsSync(file)) return { adds: [], removes: [] };
  const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  return {
    adds: asArray(data.adds),
    removes: asArray(data.removes),
  };
}

function overlayFromRepairTickets(repairTickets, sourceFile = "") {
  const adds = [];
  const removes = [];
  for (const ticket of asArray(repairTickets && repairTickets.tickets)) {
    if (ticket.repairType && ticket.repairType !== "l2-source-facts") continue;
    const row = {
      dimension: clean(ticket.dimension),
      fact: clean(ticket.fact),
      source: clean(ticket.id || "repair-ticket"),
      action: clean(ticket.action),
    };
    if (!row.dimension || !row.fact) continue;
    if (ticket.action === "add-missing-fact") {
      adds.push(row);
    } else if (ticket.action === "remove-extra-fact" || ticket.action === "remove-pollution") {
      removes.push(row);
    }
  }
  return {
    schemaVersion: 1,
    repairType: "l2-source-facts-overlay",
    generatedFromRepairTickets: true,
    sourceRepairTickets: sourceFile,
    adds,
    removes,
  };
}

module.exports = {
  applySourceFactRepairsToFunction,
  loadSourceFactRepairs,
  overlayFromRepairTickets,
};
