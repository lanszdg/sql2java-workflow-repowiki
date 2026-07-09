"use strict";

const fs = require("fs");
const path = require("path");

const REQUIRED_TABLES = {
  nodes: ["id", "kind", "name", "qualified_name", "file_path", "language", "start_line", "end_line", "signature", "visibility", "is_abstract", "docstring"],
  edges: ["source", "target", "kind", "metadata", "line", "col", "provenance"],
  files: ["path", "language", "size", "node_count"],
  schema_versions: ["version", "description"],
};

function dbPathFor(repo) {
  return path.join(repo, ".codegraph", "codegraph.db");
}

function requireSqlite() {
  try {
    return require("node:sqlite").DatabaseSync;
  } catch (e) {
    throw new Error(`node:sqlite is required to read CodeGraph DB in offline mode: ${e.message}`);
  }
}

function openDb(repo) {
  const dbPath = dbPathFor(repo);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`missing CodeGraph DB: ${dbPath}`);
  }
  const DatabaseSync = requireSqlite();
  return new DatabaseSync(dbPath, { readOnly: true });
}

function tableColumns(db, table) {
  return db.prepare(`pragma table_info(${table})`).all().map((row) => row.name);
}

function schemaGuard(db) {
  const tables = new Set(db.prepare("select name from sqlite_master where type='table'").all().map((row) => row.name));
  const missingTables = Object.keys(REQUIRED_TABLES).filter((table) => !tables.has(table));
  const missingColumns = [];
  for (const [table, columns] of Object.entries(REQUIRED_TABLES)) {
    if (!tables.has(table)) continue;
    const actual = new Set(tableColumns(db, table));
    for (const column of columns) {
      if (!actual.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }
  const versions = tables.has("schema_versions")
    ? db.prepare("select version, description from schema_versions order by version").all()
    : [];
  const latestVersion = versions.length ? Number(versions[versions.length - 1].version || 0) : 0;
  return {
    ok: missingTables.length === 0 && missingColumns.length === 0 && latestVersion >= 1,
    backend: "codegraph.db/node:sqlite",
    latestVersion,
    versions,
    missingTables,
    missingColumns,
  };
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function normalizeNode(row) {
  return {
    id: row.id || "",
    kind: row.kind || "",
    name: row.name || "",
    qualified_name: row.qualified_name || "",
    file_path: row.file_path || "",
    language: row.language || "",
    start_line: Number(row.start_line || 0),
    end_line: Number(row.end_line || 0),
    signature: row.signature || "",
    visibility: row.visibility || "",
    is_abstract: !!row.is_abstract,
    docstring: row.docstring || "",
    decorators: parseJson(row.decorators, []),
    type_parameters: parseJson(row.type_parameters, []),
  };
}

function normalizeEdge(row) {
  return {
    id: String(row.id || ""),
    source: row.source || "",
    target: row.target || "",
    kind: row.kind || "",
    metadata: parseJson(row.metadata, {}),
    line: row.line == null ? null : Number(row.line),
    col: row.col == null ? null : Number(row.col),
    provenance: row.provenance || "",
  };
}

function inventory(repo, opts = {}) {
  const db = openDb(path.resolve(repo));
  try {
    const guard = schemaGuard(db);
    if (!guard.ok && !opts.allowInvalidSchema) {
      throw new Error(`unsupported CodeGraph DB schema: missingTables=${guard.missingTables.join(",") || "-"} missingColumns=${guard.missingColumns.join(",") || "-"}`);
    }
    const nodes = db.prepare("select * from nodes order by file_path, start_line, kind, qualified_name").all().map(normalizeNode);
    const files = db.prepare("select path, language, size, node_count from files order by path").all();
    const edges = opts.includeEdges
      ? db.prepare("select * from edges order by source, kind, target").all().map(normalizeEdge)
      : [];
    const nodesByKind = {};
    for (const node of nodes) nodesByKind[node.kind] = (nodesByKind[node.kind] || 0) + 1;
    const edgesByKind = {};
    if (opts.includeEdges) {
      for (const edge of edges) edgesByKind[edge.kind] = (edgesByKind[edge.kind] || 0) + 1;
    } else {
      for (const row of db.prepare("select kind, count(*) count from edges group by kind").all()) {
        edgesByKind[row.kind] = Number(row.count || 0);
      }
    }
    return {
      schema: guard,
      dbPath: dbPathFor(path.resolve(repo)),
      counts: {
        files: files.length,
        nodes: nodes.length,
        edges: Object.values(edgesByKind).reduce((n, x) => n + Number(x || 0), 0),
        nodesByKind,
        edgesByKind,
      },
      files,
      nodes,
      edges,
    };
  } finally {
    db.close();
  }
}

function symbol(repo, name, opts = {}) {
  const db = openDb(path.resolve(repo));
  try {
    const like = `%${String(name || "").replace(/[%_]/g, (x) => `\\${x}`)}%`;
    const limit = Math.max(1, Math.min(500, Number(opts.limit || 50)));
    return db.prepare(
      "select * from nodes where qualified_name like ? escape '\\' or name like ? escape '\\' order by kind, qualified_name limit ?"
    ).all(like, like, limit).map(normalizeNode);
  } finally {
    db.close();
  }
}

function edgesFor(repo, nodeIds, opts = {}) {
  const ids = [...new Set((nodeIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const db = openDb(path.resolve(repo));
  try {
    const placeholders = ids.map(() => "?").join(",");
    const limit = Math.max(1, Math.min(10000, Number(opts.limit || 1000)));
    return db.prepare(
      `select * from edges where source in (${placeholders}) or target in (${placeholders}) order by kind, source, target limit ?`
    ).all(...ids, ...ids, limit).map(normalizeEdge);
  } finally {
    db.close();
  }
}

module.exports = {
  dbPathFor,
  edgesFor,
  inventory,
  schemaGuard,
  symbol,
};
