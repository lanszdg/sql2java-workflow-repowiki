"use strict";
/**
 * l2-callees.cjs — 进程内复用 codegraph getCallees，替代 repowiki-l2.cjs 的 per-function spawnSync CLI。
 *
 * 等价性（见 .guard/goal.md + repowiki-l2-downstream进程内复用方案-v3.md §4.2）：
 *  - 复用 codegraph 同一 getCallees(traversal.js:213)，edge kinds=['calls','references','imports']/maxDepth=1/按 node.id 去重 封装在内
 *  - R3 契约：_pick4 只返回 {name,kind,filePath,startLine}，**禁透传 node/edge/qualified_name**
 *    （getCallees 原始 node 含 qualified_name，透传则 4 路径 to_qn 从 ""/n.name/javaClassByName构造 变真实 qn → relations.to_entity 全变）
 *  - slice(0,20) 复现 codegraph.js:1218
 *
 * 两个入口：
 *  - calleesForByNodeId(nodeId, cg)：dubbo 用（L2 已有 l1_impl_method_node_id，最快，差分台已证等价）
 *  - calleesForBySymbol(symbol, cg)：go/spring-rest/job 用（复现旧 CLI codegraph.js:1191-1218 的 node 选择）
 */
const path = require("path");

let _CodeGraphCtor = null;
function _loadCodeGraph() {
  if (_CodeGraphCtor) return _CodeGraphCtor;
  // __dirname = LINGXI/config/skills/repowiki/lib → 4 个 .. 回到 LINGXI
  const LINGXI = path.resolve(__dirname, "..", "..", "..", "..");
  const mod = require(path.join(LINGXI, "config", "bin", "codegraph", "dist", "index.js"));
  _CodeGraphCtor = mod.default || mod.CodeGraph || mod;
  return _CodeGraphCtor;
}

/**
 * 同步打开 codegraph（getCallees 只读 DB，openSync 不需 initGrammars）。
 * 失败返回 null + 打 error（不静默；调用方 downstream 将为空）。
 */
function openCodegraphSync(repo) {
  try {
    return _loadCodeGraph().openSync(repo);
  } catch (e) {
    console.error(`[L2-callees] CodeGraph.openSync 失败: ${e && e.message ? e.message : e}（downstream 将为空）`);
    return null;
  }
}

// R3 契约：与 codegraph.js:1206 一致，只 pick 4 字段。★ 不得加 qualified_name/qualifiedName。
function _pick4(node) {
  return { name: node.name, kind: node.kind, filePath: node.filePath, startLine: node.startLine };
}

/**
 * byNodeId：dubbo 路径用。复现 getCallees + 去重(by node.id) + slice(0,limit)。
 * 等价 codegraph.js:1203-1208（单 match 路径，dubbo exactMatch 永不命中走 fallback matches[0]==l1_impl_method_node_id）。
 */
function calleesForByNodeId(nodeId, cg, opts) {
  if (!nodeId || !cg) return [];
  const limit = opts && opts.limit != null ? opts.limit : 20;
  const seen = new Set();
  const out = [];
  for (const c of cg.getCallees(nodeId)) {
    if (!c || !c.node || seen.has(c.node.id)) continue;
    seen.add(c.node.id);
    out.push(_pick4(c.node));
  }
  return out.slice(0, limit);
}

/**
 * bySymbol：go/spring-rest/job 路径用。复现旧 CLI codegraph.js:1191-1218 完整 node 选择：
 * searchNodes(symbol,{limit:50}) → exactMatch 过滤 → 多 match 无 exact 则 fallback matches[0] →
 * 对每个 used match 调 getCallees → 按 node.id 去重 → slice(0,limit)。
 */
function calleesForBySymbol(symbol, cg, opts) {
  if (!symbol || !cg) return [];
  const limit = opts && opts.limit != null ? opts.limit : 20;
  let matches = [];
  try { matches = cg.searchNodes(symbol, { limit: 50 }) || []; }
  catch (_) { matches = []; }
  if (!matches.length) return [];
  const exact = matches.filter((m) => m.node && (
    m.node.name === symbol ||
    m.node.name.endsWith(`.${symbol}`) ||
    m.node.name.endsWith(`::${symbol}`)
  ));
  // codegraph.js:1199-1208: 对每个 match，若 !exactMatch && matches.length>1 则 continue
  const used = [];
  for (const m of matches) {
    if (!exact.includes(m) && matches.length > 1) continue;
    used.push(m);
  }
  // codegraph.js:1210-1216: allCallees 空 且 matches[0] 存在 → fallback matches[0]
  if (!used.length && matches[0]) used.push(matches[0]);
  const seen = new Set();
  const all = [];
  for (const m of used) {
    for (const c of cg.getCallees(m.node.id)) {
      if (!c || !c.node || seen.has(c.node.id)) continue;
      seen.add(c.node.id);
      all.push(_pick4(c.node));
    }
  }
  return all.slice(0, limit);
}

module.exports = { openCodegraphSync, calleesForByNodeId, calleesForBySymbol };
