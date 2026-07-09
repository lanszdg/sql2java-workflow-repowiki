"use strict";
/**
 * entry.cjs — 功能入口的确定性渲染（merge enrich 与导出器共用）。
 * RPC:  <impl_qn>.<method>(<类型 参数名>, ...)   入参取 fn.params（含参数名），降级到 request_types（仅类型）。
 * HTTP: <HTTP_METHOD> <route|path>
 * 不生成业务语义，只把结构化事实格式化。
 */

function renderParams(fn) {
  const params = Array.isArray(fn && fn.params) ? fn.params : [];
  if (params.length) {
    return params
      .map((p) => `${(p && p.type) || ""}${p && p.name ? " " + p.name : ""}`.trim())
      .filter(Boolean)
      .join(", ");
  }
  // 降级：只有类型（老事实没有 params 时）
  const types = Array.isArray(fn && fn.request_types) ? fn.request_types : [];
  return types.filter(Boolean).join(", ");
}

function renderEntry(fn) {
  if (!fn) return "";
  if (fn.entry_type === "http") {
    const method = String(fn.http_method || "").trim();
    const route = String(fn.route || fn.path || "").trim();
    return [method, route].filter(Boolean).join(" ");
  }
  const owner = fn.impl_qn || fn.iface_qn || fn.service_iface || "";
  const method = fn.method || "";
  return `${owner}.${method}(${renderParams(fn)})`;
}

module.exports = { renderEntry, renderParams };
