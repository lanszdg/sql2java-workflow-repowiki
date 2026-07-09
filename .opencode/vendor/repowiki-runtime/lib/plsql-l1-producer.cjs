/*
 * plsql-l1-producer.cjs — PL/SQL L1 事实底座生产者
 *
 * 混合策略（实测验证）：
 *   - ANTLR (@griffithswaite/ts-plsql-parser)：spec/DDL 结构事实（包/过程/函数/参数/表/列）
 *   - regex：body 语义事实（killer/控制流/异常/表操作/调用图）
 *
 * 输出：{repo}/.repowiki/plsql-l1.json（节点+边，与 codegraph.db 同构但扩展 DB 字段）
 *
 * 用法：node plsql-l1-producer.cjs <repo>
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { repowikiWorkDir } = require("./repowiki-workdir.cjs");

// ---- vendor 路径解析 ----
// vendor 目录：config/skills/repowiki/vendor/node_modules
const VENDOR_NM = path.join(__dirname, "..", "vendor", "node_modules");
let antlrParser = null;
try {
  antlrParser = require(path.join(VENDOR_NM, "@griffithswaite", "ts-plsql-parser"));
} catch (e) {
  // 降级：纯 regex 模式（结构事实精度降低但仍可跑）
  console.error("[plsql-l1-producer] WARNING: @griffithswaite/ts-plsql-parser not found, falling back to regex-only mode");
}

// ---- 工具函数 ----

function stripSqlComments(txt) {
  return txt
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function relPath(repo, f) {
  return path.relative(repo, f).replace(/\\/g, "/");
}

function lineOf(txt, charOffset) {
  return txt.slice(0, charOffset).split("\n").length;
}

// ---- ANTLR 解析 ----

function getParser(sqlText) {
  if (!antlrParser) return null;
  try {
    return antlrParser.getParserFromInput(sqlText);
  } catch (e) {
    return null;
  }
}

// 递归遍历 AST
function walkTree(node, visitor) {
  if (!node) return;
  visitor(node);
  if (node.getChildCount) {
    const count = node.getChildCount();
    for (let i = 0; i < count; i++) {
      walkTree(node.getChild(i), visitor);
    }
  }
}

// 查找子节点中指定类型的第一个
function findChildByType(node, type) {
  if (!node) return null;
  if (node.constructor && node.constructor.name === type) return node;
  if (node.getChildCount) {
    for (let i = 0; i < node.getChildCount(); i++) {
      const r = findChildByType(node.getChild(i), type);
      if (r) return r;
    }
  }
  return null;
}

// 查找子节点中所有指定类型
function findAllChildrenByType(node, type, acc = []) {
  if (!node) return acc;
  if (node.constructor && node.constructor.name === type) acc.push(node);
  if (node.getChildCount) {
    for (let i = 0; i < node.getChildCount(); i++) {
      findAllChildrenByType(node.getChild(i), type, acc);
    }
  }
  return acc;
}

// ---- ANTLR: spec 解析 ----

function parseSpecWithAntlr(filePath, repo) {
  const raw = fs.readFileSync(filePath, "utf8");
  const txt = stripSqlComments(raw);
  const parser = getParser(txt);
  if (!parser) return parseSpecWithRegex(filePath, repo);

  const tree = parser.sql_script();
  const nodes = [];
  const edges = [];
  const relFile = relPath(repo, filePath);

  // 找包名
  let pkgName = null;
  const createPkg = findAllChildrenByType(tree, "Create_package_bodyContext");
  if (createPkg.length === 0) {
    // spec 没有 body 节点，找 package_name
    const pkgNameNodes = findAllChildrenByType(tree, "Package_nameContext");
    if (pkgNameNodes.length > 0) {
      pkgName = pkgNameNodes[0].getText().trim();
    }
  } else {
    const pkgNameNodes = findAllChildrenByType(createPkg[0], "Package_nameContext");
    if (pkgNameNodes.length > 0) pkgName = pkgNameNodes[0].getText().trim();
  }

  if (!pkgName) {
    // fallback to regex
    return parseSpecWithRegex(filePath, repo);
  }

  // package 节点
  const pkgNodeId = `${relFile}#package#${pkgName}`;
  nodes.push({
    id: pkgNodeId,
    kind: "package",
    name: pkgName,
    qualified_name: pkgName,
    file_path: relFile,
    language: "plsql",
    start_line: 1,
    end_line: txt.split("\n").length,
    signature: `PACKAGE ${pkgName}`,
    visibility: "public",
    is_abstract: false,
    docstring: "",
    decorators: [],
    type_parameters: [],
    oracle_type: "PACKAGE",
  });

  // 过程
  const procSpecs = findAllChildrenByType(tree, "Procedure_specContext");
  for (const ps of procSpecs) {
    const nameNode = findChildByType(ps, "Procedure_nameContext");
    const procName = nameNode ? nameNode.getText().trim() : "?";
    const params = extractParamsFromSpec(ps);
    const nodeId = `${relFile}#procedure#${pkgName}.${procName}`;
    nodes.push({
      id: nodeId,
      kind: "procedure",
      name: procName,
      qualified_name: `${pkgName}.${procName}`,
      file_path: relFile,
      language: "plsql",
      start_line: lineOf(txt, ps.start.startIndex),
      end_line: lineOf(txt, ps.stop ? ps.stop.stopIndex : ps.start.startIndex),
      signature: `PROCEDURE ${procName}(${params.map(p => `${p.direction} ${p.oracle_type} ${p.name}`).join(", ")})`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: "PROCEDURE",
      package_name: pkgName,
      params,
      return_type: null,
    });
    edges.push({
      id: `e_contains_${pkgNodeId}_${nodeId}`,
      source: pkgNodeId,
      target: nodeId,
      kind: "contains",
      metadata: {},
      line: null,
      col: null,
      provenance: "antlr",
    });
  }

  // 函数
  const funcSpecs = findAllChildrenByType(tree, "Function_specContext");
  for (const fs of funcSpecs) {
    const nameNode = findChildByType(fs, "Function_nameContext");
    const funcName = nameNode ? nameNode.getText().trim() : "?";
    const params = extractParamsFromSpec(fs);
    const retType = extractReturnType(fs);
    const nodeId = `${relFile}#function#${pkgName}.${funcName}`;
    nodes.push({
      id: nodeId,
      kind: "function",
      name: funcName,
      qualified_name: `${pkgName}.${funcName}`,
      file_path: relFile,
      language: "plsql",
      start_line: lineOf(txt, fs.start.startIndex),
      end_line: lineOf(txt, fs.stop ? fs.stop.stopIndex : fs.start.startIndex),
      signature: `FUNCTION ${funcName}(${params.map(p => `${p.direction} ${p.oracle_type} ${p.name}`).join(", ")}) RETURN ${retType}`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: "FUNCTION",
      package_name: pkgName,
      params,
      return_type: retType,
    });
    edges.push({
      id: `e_contains_${pkgNodeId}_${nodeId}`,
      source: pkgNodeId,
      target: nodeId,
      kind: "contains",
      metadata: {},
      line: null,
      col: null,
      provenance: "antlr",
    });
  }

  // 类型定义（record / table of）
  const typeSpecs = findAllChildrenByType(tree, "Type_specContext");
  for (const ts of typeSpecs) {
    const nameNode = findChildByType(ts, "Type_nameContext");
    const typeName = nameNode ? nameNode.getText().trim() : "?";
    const text = ts.getText();
    let kind = "TYPE";
    let fields = [];
    if (/IS\s+RECORD/i.test(text)) {
      kind = "RECORD";
      // 用 regex 抽 fields（ANTLR 对 record field 的规则名不稳定）
      const recMatch = text.match(/IS\s+RECORD\s*\(([\s\S]*?)\)/i);
      if (recMatch) {
        fields = recMatch[1].split(",").map(f => {
          const fm = f.trim().match(/^([A-Za-z_][\w#$]*)\s+(.+)$/);
          if (!fm) return null;
          return { name: fm[1], oracle_type: fm[2].trim() };
        }).filter(Boolean);
      }
    } else if (/IS\s+TABLE\s+OF/i.test(text)) {
      kind = "TABLE_OF";
      const tabMatch = text.match(/IS\s+TABLE\s+OF\s+([A-Za-z_][\w#$\.]*)/i);
      if (tabMatch) fields.push({ element_type: tabMatch[1] });
    }
    nodes.push({
      id: `${relFile}#type#${pkgName}.${typeName}`,
      kind: "type",
      name: typeName,
      qualified_name: `${pkgName}.${typeName}`,
      file_path: relFile,
      language: "plsql",
      start_line: lineOf(txt, ts.start.startIndex),
      end_line: lineOf(txt, ts.stop ? ts.stop.stopIndex : ts.start.startIndex),
      signature: `TYPE ${typeName} IS ${kind}`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: kind,
      package_name: pkgName,
      fields,
    });
  }

  return { nodes, edges, file: relFile, size: raw.length, pkgName };
}

function extractParamsFromSpec(ctx) {
  const params = [];
  const paramCtxs = findAllChildrenByType(ctx, "ParameterContext");
  for (const pc of paramCtxs) {
    const text = pc.getText();
    // 形如 p_linesINt_recv_tab 或 p_ok_countOUTNUMBER
    const m = text.match(/^([A-Za-z_][\w#$]*)(IN\s+OUT|IN|OUT)(.+)$/i);
    if (!m) continue;
    const direction = m[2].toUpperCase().trim();
    const typeRaw = m[3].trim();
    params.push({ name: m[1], direction, oracle_type: typeRaw });
  }
  return params;
}

function extractReturnType(funcCtx) {
  const retNode = findChildByType(funcCtx, "Type_specContext");
  if (retNode) return retNode.getText().trim();
  // fallback: regex
  const text = funcCtx.getText();
  const m = text.match(/RETURN\s+([A-Za-z_][\w#$%.]*(?:\([^)]*\))?)/i);
  return m ? m[1] : "";
}

// ---- regex fallback: spec 解析 ----

function parseSpecWithRegex(filePath, repo) {
  const raw = fs.readFileSync(filePath, "utf8");
  const txt = stripSqlComments(raw);
  const relFile = relPath(repo, filePath);
  const nodes = [];
  const edges = [];

  const pkgRe = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\s+([A-Za-z_][\w#$]*)\b/gi;
  let pm;
  let pkgName = null;
  if ((pm = pkgRe.exec(txt))) {
    pkgName = pm[1];
    const pkgNodeId = `${relFile}#package#${pkgName}`;
    nodes.push({
      id: pkgNodeId,
      kind: "package",
      name: pkgName,
      qualified_name: pkgName,
      file_path: relFile,
      language: "plsql",
      start_line: lineOf(txt, pm.index),
      end_line: txt.split("\n").length,
      signature: `PACKAGE ${pkgName}`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: "PACKAGE",
    });
  }

  if (!pkgName) return { nodes, edges, file: relFile, size: raw.length, pkgName: null };

  // 过程/函数
  const procRe = /\b(PROCEDURE|FUNCTION)\s+([A-Za-z_][\w#$]*)\s*\(([^)]*)\)(?:\s+RETURN\s+([A-Za-z_][\w#$%.]*(?:\([^)]*\))?))?\s*(?:IS|AS|;)/gi;
  let fm;
  while ((fm = procRe.exec(txt))) {
    const kind = fm[1].toUpperCase();
    const procName = fm[2];
    const paramStr = fm[3];
    const returnType = fm[4] || "";
    const params = parseParamsRegex(paramStr);
    const nodeId = `${relFile}#${kind.toLowerCase()}#${pkgName}.${procName}`;
    nodes.push({
      id: nodeId,
      kind: kind.toLowerCase(),
      name: procName,
      qualified_name: `${pkgName}.${procName}`,
      file_path: relFile,
      language: "plsql",
      start_line: lineOf(txt, fm.index),
      end_line: lineOf(txt, fm.index + fm[0].length),
      signature: `${kind} ${procName}(${paramStr.trim()})${returnType ? " RETURN " + returnType : ""}`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: kind,
      package_name: pkgName,
      params,
      return_type: returnType || null,
    });
    edges.push({
      id: `e_contains_${relFile}#package#${pkgName}_${nodeId}`,
      source: `${relFile}#package#${pkgName}`,
      target: nodeId,
      kind: "contains",
      metadata: {},
      line: null,
      col: null,
      provenance: "regex",
    });
  }

  return { nodes, edges, file: relFile, size: raw.length, pkgName };
}

function parseParamsRegex(paramStr) {
  if (!paramStr || !paramStr.trim()) return [];
  const params = [];
  let depth = 0, cur = "", inStr = false;
  for (let i = 0; i < paramStr.length; i++) {
    const ch = paramStr[i];
    if (ch === "'") inStr = !inStr;
    if (inStr) { cur += ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      params.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) params.push(cur.trim());
  return params.map(p => {
    const m = p.match(/^([A-Za-z_][\w#$]*)\s+(IN\s+OUT|IN|OUT)\s+(.+)$/i);
    if (!m) return { name: p, direction: "IN", oracle_type: "" };
    return { name: m[1], direction: m[2].toUpperCase().trim(), oracle_type: m[3].trim() };
  });
}

// ---- ANTLR: DDL 解析（CREATE TABLE） ----

function parseDdlWithAntlr(filePath, repo) {
  const raw = fs.readFileSync(filePath, "utf8");
  const txt = stripSqlComments(raw);
  const parser = getParser(txt);
  if (!parser) return parseDdlWithRegex(filePath, repo);

  const tree = parser.sql_script();
  const nodes = [];
  const edges = [];
  const relFile = relPath(repo, filePath);

  const createTables = findAllChildrenByType(tree, "Create_tableContext");
  for (const ct of createTables) {
    const nameNode = findChildByType(ct, "Table_nameContext");
    const tableName = nameNode ? nameNode.getText().trim() : "?";
    const tableNodeId = `${relFile}#table#${tableName}`;
    const startLine = lineOf(txt, ct.start.startIndex);
    const endLine = lineOf(txt, ct.stop ? ct.stop.stopIndex : ct.start.startIndex);

    // 列定义：用 AST 子节点抽取（getText() 去空格导致 regex 失效）
    const colDefs = findAllChildrenByType(ct, "Column_definitionContext");
    const columns = colDefs.map(cd => {
      const nameNode = findChildByType(cd, "Column_nameContext");
      const typeNode = findChildByType(cd, "DatatypeContext");
      const colName = nameNode ? nameNode.getText().trim() : "?";
      const colType = typeNode ? typeNode.getText().trim() : "";
      // Inline_constraint 可能多个（NOT NULL, DEFAULT 等）
      const inlineConstraints = findAllChildrenByType(cd, "Inline_constraintContext");
      const allConstraintText = inlineConstraints.map(c => c.getText()).join(" ");
      const isNotNull = /NOT\s*NULL/i.test(allConstraintText);
      const defaultMatch = allConstraintText.match(/DEFAULT\s+([^\s,]+)/i);
      return {
        name: colName,
        oracle_type: colType,
        nullable: !isNotNull,
        is_primary_key: false, // PK 从 out-of-line constraint 解析
        default_value: defaultMatch ? defaultMatch[1].trim() : null,
      };
    }).filter(col => {
      // 过滤 out-of-line constraint 被 ANTLR 误识别为列的情况：
      // - 列名是 CONSTRAINT/PRIMARY/FOREIGN/UNIQUE/CHECK 等关键字
      // - 列类型为空（伪列）
      const upper = String(col.name || "").toUpperCase();
      if (["CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "KEY"].includes(upper)) return false;
      if (!col.oracle_type) return false;
      return true;
    });

    // PK constraint：out-of-line constraint（CONSTRAINT pk_xxx PRIMARY KEY (...)）
    // ANTLR 中 out-of-line constraint 可能走 ConstraintContext 或 Table_constraintContext
    const outOfLineConstraints = findAllChildrenByType(ct, "Out_of_line_constraintContext");
    for (const c of outOfLineConstraints) {
      const cText = c.getText();
      if (/PRIMARY\s*KEY/i.test(cText)) {
        const pkMatch = cText.match(/PRIMARY\s*KEY\s*\(([^)]+)\)/i);
        if (pkMatch) {
          const pkCols = pkMatch[1].split(",").map(s => s.trim().toLowerCase());
          for (const col of columns) {
            if (pkCols.includes(col.name.toLowerCase())) {
              col.is_primary_key = true;
              col.nullable = false;
            }
          }
        }
      }
    }

    nodes.push({
      id: tableNodeId,
      kind: "table",
      name: tableName,
      qualified_name: tableName,
      file_path: relFile,
      language: "plsql",
      start_line: startLine,
      end_line: endLine,
      signature: `TABLE ${tableName}`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: "TABLE",
      columns,
    });

    // column 节点 + contains 边
    for (const col of columns) {
      const colNodeId = `${relFile}#column#${tableName}.${col.name}`;
      nodes.push({
        id: colNodeId,
        kind: "column",
        name: col.name,
        qualified_name: `${tableName}.${col.name}`,
        file_path: relFile,
        language: "plsql",
        start_line: startLine,
        end_line: endLine,
        signature: `${col.name} ${col.oracle_type}`,
        visibility: "public",
        is_abstract: false,
        docstring: "",
        decorators: [],
        type_parameters: [],
        oracle_type: col.oracle_type,
        table_name: tableName,
        nullable: col.nullable,
        is_primary_key: col.is_primary_key,
        default_value: col.default_value,
      });
      edges.push({
        id: `e_contains_${tableNodeId}_${colNodeId}`,
        source: tableNodeId,
        target: colNodeId,
        kind: "contains",
        metadata: {},
        line: null,
        col: null,
        provenance: "antlr",
      });
    }
  }

  // 序列
  const createSeqs = findAllChildrenByType(tree, "Create_sequenceContext");
  for (const cs of createSeqs) {
    const nameNode = findChildByType(cs, "Sequence_nameContext");
    const seqName = nameNode ? nameNode.getText().trim() : "?";
    nodes.push({
      id: `${relFile}#sequence#${seqName}`,
      kind: "sequence",
      name: seqName,
      qualified_name: seqName,
      file_path: relFile,
      language: "plsql",
      start_line: lineOf(txt, cs.start.startIndex),
      end_line: lineOf(txt, cs.stop ? cs.stop.stopIndex : cs.start.startIndex),
      signature: `SEQUENCE ${seqName}`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: "SEQUENCE",
    });
  }

  return { nodes, edges, file: relFile, size: raw.length };
}

// ---- regex fallback: DDL 解析 ----

function parseDdlWithRegex(filePath, repo) {
  const raw = fs.readFileSync(filePath, "utf8");
  const txt = stripSqlComments(raw);
  const relFile = relPath(repo, filePath);
  const nodes = [];
  const edges = [];

  const tblRe = /\bCREATE\s+TABLE\s+([A-Za-z_][\w#$]*)\s*\(([\s\S]*?)\)\s*(?:;|$)/gi;
  let tm;
  while ((tm = tblRe.exec(txt))) {
    const tableName = tm[1];
    const body = tm[2];
    const tableNodeId = `${relFile}#table#${tableName}`;
    const startLine = lineOf(txt, tm.index);

    // 列定义：列名 类型 [DEFAULT x] [NOT NULL]
    const lines = body.split(",").map(s => s.trim()).filter(Boolean);
    const columns = [];
    for (const line of lines) {
      if (/^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i.test(line)) {
        // PK constraint
        const pkMatch = line.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
        if (pkMatch) {
          const pkCols = pkMatch[1].split(",").map(s => s.trim().toLowerCase());
          for (const col of columns) {
            if (pkCols.includes(col.name.toLowerCase())) {
              col.is_primary_key = true;
              col.nullable = false;
            }
          }
        }
        continue;
      }
      const m = line.match(/^([A-Za-z_][\w#$]*)\s+([A-Za-z_][\w#$]*(?:\([^)]+\))?)/i);
      if (!m) continue;
      const colName = m[1];
      const colType = m[2];
      const isNotNull = /NOT\s+NULL/i.test(line);
      const defaultMatch = line.match(/DEFAULT\s+(\S+)/i);
      columns.push({
        name: colName,
        oracle_type: colType,
        nullable: !isNotNull,
        is_primary_key: false,
        default_value: defaultMatch ? defaultMatch[1].replace(/,$/, "") : null,
      });
    }

    nodes.push({
      id: tableNodeId,
      kind: "table",
      name: tableName,
      qualified_name: tableName,
      file_path: relFile,
      language: "plsql",
      start_line: startLine,
      end_line: startLine + body.split("\n").length,
      signature: `TABLE ${tableName}`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: "TABLE",
      columns,
    });

    for (const col of columns) {
      const colNodeId = `${relFile}#column#${tableName}.${col.name}`;
      nodes.push({
        id: colNodeId,
        kind: "column",
        name: col.name,
        qualified_name: `${tableName}.${col.name}`,
        file_path: relFile,
        language: "plsql",
        start_line: startLine,
        end_line: startLine,
        signature: `${col.name} ${col.oracle_type}`,
        visibility: "public",
        is_abstract: false,
        docstring: "",
        decorators: [],
        type_parameters: [],
        oracle_type: col.oracle_type,
        table_name: tableName,
        nullable: col.nullable,
        is_primary_key: col.is_primary_key,
        default_value: col.default_value,
      });
      edges.push({
        id: `e_contains_${tableNodeId}_${colNodeId}`,
        source: tableNodeId,
        target: colNodeId,
        kind: "contains",
        metadata: {},
        line: null,
        col: null,
        provenance: "regex",
      });
    }
  }

  // 序列
  const seqRe = /\bCREATE\s+SEQUENCE\s+([A-Za-z_][\w#$]*)/gi;
  let sm;
  while ((sm = seqRe.exec(txt))) {
    const seqName = sm[1];
    nodes.push({
      id: `${relFile}#sequence#${seqName}`,
      kind: "sequence",
      name: seqName,
      qualified_name: seqName,
      file_path: relFile,
      language: "plsql",
      start_line: lineOf(txt, sm.index),
      end_line: lineOf(txt, sm.index),
      signature: `SEQUENCE ${seqName}`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: "SEQUENCE",
    });
  }

  return { nodes, edges, file: relFile, size: raw.length };
}

// ---- regex: body 语义事实（killer/控制流/异常/表操作/调用图） ----

function parseBodyWithRegex(filePath, repo, l1Nodes) {
  const raw = fs.readFileSync(filePath, "utf8");
  const txt = stripSqlComments(raw);
  const relFile = relPath(repo, filePath);
  const edges = [];

  // 找 body 中的过程定义（package body 内的 PROCEDURE ... IS ... BEGIN ... END）
  const procRe = /\b(PROCEDURE|FUNCTION)\s+([A-Za-z_][\w#$]*)\s*(?:\(([^)]*)\))?\s*(?:RETURN\s+[A-Za-z_][\w#$%.]*(?:\([^)]*\))?)?\s*(?:IS|AS)\b/gi;
  let fm;
  while ((fm = procRe.exec(txt))) {
    const procName = fm[2];
    // 找过程体范围
    const afterDecl = txt.slice(fm.index);
    const isAsMatch = afterDecl.match(/\b(IS|AS)\b/i);
    let bodyStart = fm.index;
    let bodyEnd = txt.length;
    if (isAsMatch) {
      bodyStart = fm.index + isAsMatch.index + isAsMatch[0].length;
      const afterBody = txt.slice(bodyStart);
      const endMatch = afterBody.match(new RegExp(`\\bEND\\s+${procName}\\s*;`, "i"));
      if (endMatch) bodyEnd = bodyStart + endMatch.index;
    }
    const procBody = bodyEnd > bodyStart ? txt.slice(bodyStart, bodyEnd) : "";
    const bodyLineOffset = txt.slice(0, bodyStart).split("\n").length - 1;

    // 找 L1 中对应的 procedure/function 节点（同包同名）
    const matchingNode = l1Nodes.find(n =>
      (n.kind === "procedure" || n.kind === "function") &&
      n.name === procName
    );

    if (!matchingNode) continue;

    // 表操作 → calls 边
    const tblOps = parseTableOps(procBody);
    for (const t of tblOps) {
      const tblNode = l1Nodes.find(n => n.kind === "table" && n.name.toUpperCase() === t.table.toUpperCase());
      if (tblNode) {
        edges.push({
          id: `e_calls_${matchingNode.id}_${tblNode.id}_${t.op}`,
          source: matchingNode.id,
          target: tblNode.id,
          kind: "calls",
          metadata: { op: t.op },
          line: bodyLineOffset + 1,
          col: null,
          provenance: "regex",
        });
      }
    }

    // 跨包调用 → calls 边
    const pkgName = matchingNode.package_name || "";
    const crossCalls = parseCrossPackageCalls(procBody, pkgName);
    for (const c of crossCalls) {
      // 找目标节点（跨包的 procedure/function）
      const targetNode = l1Nodes.find(n =>
        (n.kind === "procedure" || n.kind === "function") &&
        n.package_name === c.target_package &&
        n.name === c.target_member
      );
      if (targetNode) {
        edges.push({
          id: `e_calls_${matchingNode.id}_${targetNode.id}`,
          source: matchingNode.id,
          target: targetNode.id,
          kind: "calls",
          metadata: {},
          line: bodyLineOffset + 1,
          col: null,
          provenance: "regex",
        });
      }
    }

    // 序列引用 → calls 边
    const seqRefs = parseSequenceRefs(procBody);
    for (const s of seqRefs) {
      const seqNode = l1Nodes.find(n => n.kind === "sequence" && n.name.toUpperCase() === s.sequence.toUpperCase());
      if (seqNode) {
        edges.push({
          id: `e_calls_${matchingNode.id}_${seqNode.id}_${s.usage}`,
          source: matchingNode.id,
          target: seqNode.id,
          kind: "calls",
          metadata: { usage: s.usage },
          line: bodyLineOffset + 1,
          col: null,
          provenance: "regex",
        });
      }
    }
  }

  return { edges, file: relFile };
}

function parseTableOps(txt) {
  const ops = [];
  const patterns = [
    { re: /\bINSERT\s+INTO\s+([A-Za-z_][\w#$]*)/gi, op: "INSERT" },
    { re: /\bUPDATE\s+([A-Za-z_][\w#$]*)\s+/gi, op: "UPDATE" },
    { re: /\bMERGE\s+INTO\s+([A-Za-z_][\w#$]*)/gi, op: "MERGE" },
    { re: /\bDELETE\s+FROM\s+([A-Za-z_][\w#$]*)/gi, op: "DELETE" },
    { re: /\bFROM\s+([A-Za-z_][\w#$]*)\b/gi, op: "SELECT" },
  ];
  for (const { re, op } of patterns) {
    let m;
    while ((m = re.exec(txt))) {
      const table = m[1].toUpperCase();
      if (["DUAL", "ALL", "WHERE", "SET", "VALUES"].includes(table)) continue;
      ops.push({ table, op });
    }
  }
  const seen = new Set();
  return ops.filter(o => {
    const k = `${o.table}|${o.op}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parseCrossPackageCalls(txt, currentPkg) {
  const refs = [];
  const re = /\b([A-Za-z_][\w#$]*)\.([A-Za-z_][\w#$]*)\s*\(/g;
  let m;
  while ((m = re.exec(txt))) {
    const pkg = m[1];
    const member = m[2];
    if (pkg.toUpperCase() === currentPkg.toUpperCase()) continue;
    if (["SQL", "DBMS", "UTL", "APEX"].includes(pkg.toUpperCase())) continue;
    refs.push({ target_package: pkg, target_member: member });
  }
  return refs;
}

function parseSequenceRefs(txt) {
  const refs = [];
  const re = /\b([A-Za-z_][\w#$]*)\.(NEXTVAL|CURRVAL)\b/gi;
  let m;
  while ((m = re.exec(txt))) {
    refs.push({ sequence: m[1].toUpperCase(), usage: m[2].toUpperCase() });
  }
  return refs;
}

// ---- 独立函数解析（func/*.sql） ----

function parseStandaloneFunc(filePath, repo) {
  const raw = fs.readFileSync(filePath, "utf8");
  const txt = stripSqlComments(raw);
  const relFile = relPath(repo, filePath);
  const nodes = [];

  const funcRe = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_][\w#$]*)\s*\(([^)]*)\)\s*RETURN\s+([A-Za-z_][\w#$%.]*(?:\([^)]*\))?)/gi;
  let fm;
  while ((fm = funcRe.exec(txt))) {
    const funcName = fm[1];
    const paramStr = fm[2];
    const returnType = fm[3];
    const params = parseParamsRegex(paramStr);
    nodes.push({
      id: `${relFile}#function#${funcName}`,
      kind: "function",
      name: funcName,
      qualified_name: funcName,
      file_path: relFile,
      language: "plsql",
      start_line: lineOf(txt, fm.index),
      end_line: lineOf(txt, fm.index + fm[0].length),
      signature: `FUNCTION ${funcName}(${paramStr.trim()}) RETURN ${returnType}`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: "FUNCTION",
      package_name: null,
      params,
      return_type: returnType,
    });
  }
  return { nodes, file: relFile, size: raw.length };
}

// ---- 触发器解析（trigger/*.sql） ----

function parseTrigger(filePath, repo) {
  const raw = fs.readFileSync(filePath, "utf8");
  const txt = stripSqlComments(raw);
  const relFile = relPath(repo, filePath);
  const nodes = [];

  const trgRe = /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+([A-Za-z_][\w#$]*)/gi;
  let tm;
  while ((tm = trgRe.exec(txt))) {
    const trgName = tm[1];
    // 判断是否复合触发器
    const isCompound = /COMPOUND\s+TRIGGER/i.test(txt.slice(tm.index, tm.index + 500));
    nodes.push({
      id: `${relFile}#trigger#${trgName}`,
      kind: "trigger",
      name: trgName,
      qualified_name: trgName,
      file_path: relFile,
      language: "plsql",
      start_line: lineOf(txt, tm.index),
      end_line: txt.split("\n").length,
      signature: `TRIGGER ${trgName}${isCompound ? " COMPOUND" : ""}`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: isCompound ? "COMPOUND TRIGGER" : "TRIGGER",
    });
  }
  return { nodes, file: relFile, size: raw.length };
}

// ---- 类型定义解析（type/*.sql） ----

function parseTypeDef(filePath, repo) {
  const raw = fs.readFileSync(filePath, "utf8");
  const txt = stripSqlComments(raw);
  const relFile = relPath(repo, filePath);
  const nodes = [];

  const typeRe = /\bCREATE\s+(?:OR\s+REPLACE\s+)?TYPE\s+([A-Za-z_][\w#$]*)\s+(?:FORCE\s+)?AS\s+OBJECT\s*\(([\s\S]*?)\)/gi;
  let tm;
  while ((tm = typeRe.exec(txt))) {
    const typeName = tm[1];
    const body = tm[2];
    const fields = body.split(",").map(f => {
      const fm = f.trim().match(/^([A-Za-z_][\w#$]*)\s+(.+)$/);
      if (!fm) return null;
      return { name: fm[1], oracle_type: fm[2].trim() };
    }).filter(Boolean);
    nodes.push({
      id: `${relFile}#type#${typeName}`,
      kind: "type",
      name: typeName,
      qualified_name: typeName,
      file_path: relFile,
      language: "plsql",
      start_line: lineOf(txt, tm.index),
      end_line: lineOf(txt, tm.index + tm[0].length),
      signature: `TYPE ${typeName} AS OBJECT`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: "OBJECT_TYPE",
      fields,
    });
  }

  // TYPE IS RECORD / TABLE OF
  const recTypeRe = /\bTYPE\s+([A-Za-z_][\w#$]*)\s+IS\s+RECORD\s*\(([\s\S]*?)\)/gi;
  let rm;
  while ((rm = recTypeRe.exec(txt))) {
    const typeName = rm[1];
    const body = rm[2];
    const fields = body.split(",").map(f => {
      const fm = f.trim().match(/^([A-Za-z_][\w#$]*)\s+(.+)$/);
      if (!fm) return null;
      return { name: fm[1], oracle_type: fm[2].trim() };
    }).filter(Boolean);
    nodes.push({
      id: `${relFile}#type#${typeName}`,
      kind: "type",
      name: typeName,
      qualified_name: typeName,
      file_path: relFile,
      language: "plsql",
      start_line: lineOf(txt, rm.index),
      end_line: lineOf(txt, rm.index + rm[0].length),
      signature: `TYPE ${typeName} IS RECORD`,
      visibility: "public",
      is_abstract: false,
      docstring: "",
      decorators: [],
      type_parameters: [],
      oracle_type: "RECORD",
      fields,
    });
  }

  return { nodes, file: relFile, size: raw.length };
}

// ---- 文件扫描 ----

function scanFiles(repo) {
  const result = {
    specs: [],
    bodies: [],
    ddl: [],
    funcs: [],
    triggers: [],
    types: [],
  };

  function scan(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        scan(p);
      } else if (e.name.endsWith(".sql")) {
        const lower = e.name.toLowerCase();
        if (lower.includes("_spec.sql") || lower.includes("_spec.")) {
          result.specs.push(p);
        } else if (lower.includes("_body.sql") || lower.includes("_body.")) {
          result.bodies.push(p);
        } else if (dir.includes("schema") || lower.includes("create") || /^(bom|dict|forecast|index|inventory|item|orders|partner|pricing|production|seed|sequence|sysctl|view|warehouse)\.sql$/i.test(lower)) {
          result.ddl.push(p);
        } else if (dir.includes("func") || lower.startsWith("fn_")) {
          result.funcs.push(p);
        } else if (dir.includes("trigger") || lower.startsWith("trg_")) {
          result.triggers.push(p);
        } else if (dir.includes("type") || lower.startsWith("obj_") || lower.startsWith("coll_")) {
          result.types.push(p);
        } else {
          // 默认归 DDL（含 install.sql 等）
          result.ddl.push(p);
        }
      } else if (e.name.endsWith(".pks")) {
        result.specs.push(p);
      } else if (e.name.endsWith(".pkb")) {
        result.bodies.push(p);
      }
    }
  }

  scan(repo);
  return result;
}

// ---- 主函数 ----

function produce(repo) {
  const files = scanFiles(repo);
  const allNodes = [];
  const allEdges = [];
  const allFiles = [];
  const backend = antlrParser ? "plsql-l1-producer/antlr+regex" : "plsql-l1-producer/regex-only";

  console.log(`[plsql-l1-producer] backend=${backend}`);
  console.log(`[plsql-l1-producer] scanning: specs=${files.specs.length} bodies=${files.bodies.length} ddl=${files.ddl.length} funcs=${files.funcs.length} triggers=${files.triggers.length} types=${files.types.length}`);

  // 1. spec → 包/过程/函数/类型
  for (const f of files.specs) {
    const result = parseSpecWithAntlr(f, repo);
    allNodes.push(...result.nodes);
    allEdges.push(...result.edges);
    allFiles.push({ path: result.file, language: "plsql", size: result.size, node_count: result.nodes.length });
  }

  // 2. DDL → 表/列/序列
  for (const f of files.ddl) {
    const result = parseDdlWithAntlr(f, repo);
    allNodes.push(...result.nodes);
    allEdges.push(...result.edges);
    allFiles.push({ path: result.file, language: "plsql", size: result.size, node_count: result.nodes.length });
  }

  // 3. 独立函数
  for (const f of files.funcs) {
    const result = parseStandaloneFunc(f, repo);
    allNodes.push(...result.nodes);
    allFiles.push({ path: result.file, language: "plsql", size: result.size, node_count: result.nodes.length });
  }

  // 4. 触发器
  for (const f of files.triggers) {
    const result = parseTrigger(f, repo);
    allNodes.push(...result.nodes);
    allFiles.push({ path: result.file, language: "plsql", size: result.size, node_count: result.nodes.length });
  }

  // 5. 类型定义
  for (const f of files.types) {
    const result = parseTypeDef(f, repo);
    allNodes.push(...result.nodes);
    allFiles.push({ path: result.file, language: "plsql", size: result.size, node_count: result.nodes.length });
  }

  // 6. body → 语义边（calls/contains）
  for (const f of files.bodies) {
    const result = parseBodyWithRegex(f, repo, allNodes);
    allEdges.push(...result.edges);
  }

  // 统计
  const nodesByKind = {};
  for (const n of allNodes) nodesByKind[n.kind] = (nodesByKind[n.kind] || 0) + 1;
  const edgesByKind = {};
  for (const e of allEdges) edgesByKind[e.kind] = (edgesByKind[e.kind] || 0) + 1;

  const output = {
    schema: { backend, version: 1 },
    counts: {
      files: allFiles.length,
      nodes: allNodes.length,
      edges: allEdges.length,
      nodesByKind,
      edgesByKind,
    },
    files: allFiles,
    nodes: allNodes,
    edges: allEdges,
  };

  // 写入 .repowiki/plsql-l1.json
  const repowikiDir = repowikiWorkDir(repo);
  if (!fs.existsSync(repowikiDir)) fs.mkdirSync(repowikiDir, { recursive: true });
  const outPath = path.join(repowikiDir, "plsql-l1.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`[plsql-l1-producer] output: ${outPath}`);
  console.log(`[plsql-l1-producer] nodes=${allNodes.length} edges=${allEdges.length}`);
  console.log(`[plsql-l1-producer] nodesByKind=${JSON.stringify(nodesByKind)}`);
  console.log(`[plsql-l1-producer] edgesByKind=${JSON.stringify(edgesByKind)}`);

  return output;
}

// ---- CLI ----
if (require.main === module) {
  const repo = process.argv[2];
  if (!repo) {
    console.error("usage: node plsql-l1-producer.cjs <repo>");
    process.exit(1);
  }
  produce(path.resolve(repo));
}

module.exports = { produce };
