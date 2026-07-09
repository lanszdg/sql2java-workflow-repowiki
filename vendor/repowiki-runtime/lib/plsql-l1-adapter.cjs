/*
 * plsql-l1-adapter.cjs — PL/SQL L1 事实底座读取器
 *
 * 读 {repo}/.repowiki/plsql-l1.json，返回与 l1-adapter.cjs 的 inventory() 同构结构。
 * L2 按 profile 选择读 codegraph.db (dubbo) 还是 plsql-l1.json (oracle-sp)。
 */
"use strict";

const fs = require("fs");
const path = require("path");

function plsqlInventory(repo, opts = {}) {
  const l1Path = path.join(repo, ".repowiki", "plsql-l1.json");
  if (!fs.existsSync(l1Path)) {
    return {
      error: "missing plsql-l1.json",
      schema: { ok: false },
      dbPath: l1Path,
      counts: { files: 0, nodes: 0, edges: 0, nodesByKind: {}, edgesByKind: {} },
      files: [],
      nodes: [],
      edges: [],
    };
  }
  const data = JSON.parse(fs.readFileSync(l1Path, "utf8"));
  return {
    schema: { ok: true, backend: data.schema ? data.schema.backend : "unknown" },
    dbPath: l1Path,
    counts: data.counts || { files: 0, nodes: 0, edges: 0, nodesByKind: {}, edgesByKind: {} },
    files: data.files || [],
    nodes: data.nodes || [],
    edges: opts.includeEdges ? (data.edges || []) : [],
  };
}

function plsqlSymbol(repo, name, opts = {}) {
  const inv = plsqlInventory(repo, { includeEdges: false });
  if (inv.error) return [];
  const like = String(name || "").toLowerCase();
  return inv.nodes.filter(n =>
    (n.qualified_name || "").toLowerCase().includes(like) ||
    (n.name || "").toLowerCase().includes(like)
  ).slice(0, Math.max(1, Math.min(500, Number(opts.limit || 50))));
}

module.exports = { plsqlInventory, plsqlSymbol };
