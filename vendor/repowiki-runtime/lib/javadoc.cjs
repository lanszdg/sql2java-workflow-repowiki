"use strict";
/**
 * javadoc.cjs — 从 Java 源码抽取 JavaDoc 首行（接口/实现类/方法）。
 * 旧工行 skill 依赖"注释优先"生成中文；新架构禁止 L3 读源码，故注释由 L2 固化为 facts。
 * 只取首行业务摘要，跳过 @param/@return 等标签行；非业务的 license 头不在声明前，不会被取到。
 */

function docFirstLine(raw) {
  const lines = String(raw || "")
    .replace(/^\s*\*\s?/gm, "")                 // 去每行前导 " * "
    .split(/\n/).map((s) => s.trim())
    .filter((l) => l && !l.startsWith("@"));     // 跳过 @param/@return 等标签行
  return lines[0] || "";
}

// 声明(interface X / class X)前最近的 /** */ 首行
function firstDocBeforeDecl(text, declRe) {
  const m = declRe.exec(String(text || ""));
  if (!m) return "";
  const before = text.slice(0, m.index);
  // (?:(?!\*\/)[\s\S])*? 禁止注释内容跨过 */，保证只取紧邻声明的那个 JavaDoc 块
  const dm = before.match(/\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*(?:@\w+(?:\([^)]*\))?\s*)*$/);
  return dm ? docFirstLine(dm[1]) : "";
}

// 方法名 -> 其声明前 JavaDoc 首行（在原始未去注释文本上扫描）
function methodDocMap(text) {
  const map = {};
  const re = /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:default\s+)?[\w.<>\[\],\s]+?\s+(\w+)\s*\([^)]*\)\s*(?:\{|;)/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const doc = docFirstLine(m[1]);
    const name = m[2];
    if (doc && !map[name]) map[name] = doc;
  }
  return map;
}

module.exports = { docFirstLine, firstDocBeforeDecl, methodDocMap };
