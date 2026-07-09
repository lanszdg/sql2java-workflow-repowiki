"use strict";

const { FSD_MARKDOWN_SECTIONS, FSD_MARKDOWN_SUBSECTIONS } = require("./fsd-facts-renderer.cjs");
const { transactionToken } = require("./fsd-fact-tokens.cjs");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function addError(errors, code, path, message) {
  errors.push({ code, path, message });
}

function visibleMarkdown(markdown) {
  return String(markdown || "").replace(/<!--[\s\S]*?-->/g, "");
}

function cell(value) {
  const text = value === true ? "是" : value === false ? "否" : String(value == null || value === "" ? "无" : value);
  return text.replace(/\|/g, "/").replace(/\r?\n/g, " ").trim();
}

function isUnknownCell(value) {
  const raw = String(value == null ? "" : value).trim();
  const rendered = cell(value);
  return !raw || !rendered || /^UNKNOWN$/i.test(raw) || /^UNKNOWN$/i.test(rendered);
}

function requiredRenderedCells(cells) {
  return cells.map((item) => ({ raw: item, rendered: cell(item) }))
    .filter((item) => !isUnknownCell(item.raw))
    .map((item) => item.rendered);
}

function tableHeader(headers) {
  return `| ${headers.join(" | ")} |`;
}

function tableRows(markdown) {
  return String(markdown || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|") && !/^\|\s*-{3}/.test(line));
}

function hasTableHeader(markdown, headers) {
  return tableRows(markdown).includes(tableHeader(headers));
}

function hasTableRow(markdown, cells) {
  const expected = cells.map(cell).filter((item) => item && item !== "无");
  return tableRows(markdown).some((line) => expected.every((item) => line.includes(item)));
}

function hasVisibleLine(markdown, cells) {
  const expected = cells.map(cell).filter((item) => item && item !== "无");
  return String(markdown || "")
    .split(/\r?\n/)
    .some((line) => expected.every((item) => line.includes(item)));
}

function hasRequiredTableRow(markdown, cells) {
  const expected = requiredRenderedCells(cells);
  return tableRows(markdown).some((line) => expected.every((item) => line.includes(item)));
}

function hasRequiredVisibleLine(markdown, cells) {
  const expected = requiredRenderedCells(cells);
  return String(markdown || "")
    .split(/\r?\n/)
    .some((line) => expected.every((item) => line.includes(item)));
}

function normalizeBlock(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function hasVisibleBlock(markdown, value) {
  const expected = normalizeBlock(value);
  if (!expected || expected === "无") return true;
  return normalizeBlock(visibleMarkdown(markdown)).includes(expected);
}

function requireTableHeader(errors, markdown, path, headers) {
  if (!hasTableHeader(markdown, headers)) {
    addError(errors, "TEMPLATE_TABLE_MISSING", path, `missing template table header ${tableHeader(headers)}`);
  }
}

function requireTableRow(errors, markdown, path, cells, message) {
  if (!hasRequiredTableRow(markdown, cells)) {
    addError(errors, "TEMPLATE_FACT_ROW_MISSING", path, message || `missing template row ${cells.map(cell).join(" | ")}`);
  }
}

function requireVisibleLine(errors, markdown, path, cells, message) {
  if (!hasRequiredVisibleLine(markdown, cells)) {
    addError(errors, "TEMPLATE_FACT_ROW_MISSING", path, message || `missing visible template line ${cells.map(cell).join(" | ")}`);
  }
}

function requireVisibleBlock(errors, markdown, path, value, message) {
  if (!hasVisibleBlock(markdown, value)) {
    addError(errors, "TEMPLATE_FACT_ROW_MISSING", path, message || `missing visible template block ${cell(value)}`);
  }
}

function isHardTemplateFactPath(path) {
  const p = String(path || "");
  if (p.startsWith("template.identity.")) return true;
  if (["template.overview.subprogramName", "template.overview.kind", "template.overview.packageName", "template.signature.raw"].includes(p)) return true;
  if (p.startsWith("template.params.")) return true;
  if (p === "template.return") return true;
  if (p.startsWith("template.tables.")) return true;
  if (p.startsWith("template.columns.")) return true;
  if (p.startsWith("template.calls.")) return true;
  if (p.startsWith("template.sequences.")) return true;
  if (p.startsWith("template.constants.")) return true;
  if (p.startsWith("template.flowNodes.")) return true;
  if (p.startsWith("template.branches.")) return true;
  if (p.startsWith("template.loops.")) return true;
  if (p.startsWith("template.exceptions.")) return true;
  if (p.startsWith("template.transaction.")) return true;
  if (p.startsWith("template.syntax.")) return true;
  if (p.startsWith("template.manualReview.")) return true;
  return false;
}

function isHardFsdGateError(error) {
  const code = error && error.code || "";
  if ([
    "OUTPUT_PATH_MISMATCH",
    "EXTRA_SECTION",
    "SECTION_MISSING",
    "SECTION_ORDER_INVALID",
    "NUMBERED_SECTION_HEADING",
    "SUBSECTION_MISSING",
    "SUBSECTION_WRONG_SECTION",
    "TEMPLATE_TABLE_MISSING",
    "DEBUG_TOKEN_VISIBLE",
    "MARKDOWN_FACT_WITHOUT_TRACE",
  ].includes(code)) return true;
  if (code === "TEMPLATE_FACT_ROW_MISSING") return isHardTemplateFactPath(error && error.path);
  return true;
}

function classifyFsdGateErrors(errors) {
  const hardErrors = [];
  const advisoryErrors = [];
  for (const error of asArray(errors)) {
    if (isHardFsdGateError(error)) hardErrors.push(error);
    else advisoryErrors.push(error);
  }
  return {
    hardOk: hardErrors.length === 0,
    hardErrors,
    advisoryErrors,
  };
}

function expectedSubsectionOwner() {
  const owners = new Map();
  for (const [section, subsections] of Object.entries(FSD_MARKDOWN_SUBSECTIONS)) {
    for (const subsection of subsections) owners.set(subsection, section);
  }
  return owners;
}

function buildMarkdownIndex(markdown, errors) {
  const sectionSet = new Set(FSD_MARKDOWN_SECTIONS);
  const subsectionOwners = expectedSubsectionOwner();
  const sectionHeadings = [];
  const subsectionHeadings = [];
  const sections = new Map();
  const subsections = new Map();
  let currentSection = "";
  let currentSubsection = "";

  function append(map, key, line) {
    if (!key) return;
    map.set(key, `${map.get(key) || ""}${line}\n`);
  }

  for (const line of String(markdown || "").split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      currentSection = line.slice(3).trim();
      currentSubsection = "";
      sectionHeadings.push(currentSection);
      if (!sectionSet.has(currentSection)) {
        addError(errors, "EXTRA_SECTION", "sections", `unexpected section ${currentSection}`);
      }
      append(sections, currentSection, line);
      continue;
    }
    if (line.startsWith("### ")) {
      currentSubsection = line.slice(4).trim();
      subsectionHeadings.push(currentSubsection);
      const owner = subsectionOwners.get(currentSubsection);
      if (owner && owner !== currentSection) {
        addError(errors, "SUBSECTION_WRONG_SECTION", `sections.${currentSubsection}`, `${currentSubsection} appears under ${currentSection}, expected ${owner}`);
      }
      append(sections, currentSection, line);
      append(subsections, currentSubsection, line);
      continue;
    }
    append(sections, currentSection, line);
    append(subsections, currentSubsection, line);
  }

  return { sectionHeadings, subsectionHeadings, sections, subsections };
}

function subsectionText(index, name) {
  return index.subsections.get(name) || "";
}

function expectedStructuralKeys(facts) {
  const deps = facts.dependencies || {};
  const controlFlow = facts.controlFlow || {};
  const keys = new Set();
  if (facts.identity && facts.identity.packageName) keys.add(`Package:${facts.identity.packageName}`);
  if (facts.identity && facts.identity.subprogramName) keys.add(`Subprogram:${facts.identity.subprogramName}`);
  if (facts.identity && facts.identity.kind) keys.add(`Kind:${facts.identity.kind}`);
  for (const param of asArray(facts.signature && facts.signature.params)) keys.add(`Param:${param.name || ""} | ${param.direction || ""} | ${param.oracleType || ""} | ${param.javaType || ""}`);
  if (facts.signature && facts.signature.return && facts.signature.return.oracleType) {
    keys.add(`Return:Oracle ${facts.signature.return.oracleType || ""} -> Java ${facts.signature.return.javaType || ""}`);
  } else {
    keys.add("Return:None");
  }
  for (const row of asArray(facts.tableMappings)) keys.add(`Table:${row.tableName}`);
  for (const row of asArray(facts.tableMappings)) {
    for (const op of asArray(row.operations)) keys.add(`Operation:${row.tableName}.${op}`);
    for (const col of asArray(row.columns)) keys.add(`Column:${row.tableName}.${typeof col === "string" ? col : (col && (col.name || col.column || col.columnName))}`);
  }
  for (const row of asArray(deps.calls)) keys.add(`Call:${row.target}`);
  for (const row of asArray(deps.sequences)) keys.add(`Sequence:${row.name}`);
  for (const row of asArray(deps.constants)) keys.add(`Constant:${row.target}`);
  for (const row of asArray(controlFlow.nodes)) keys.add(`FlowNode:${row.id || ""} | ${row.label || ""}`);
  for (const row of asArray(controlFlow.branches)) keys.add(`Branch:${row.id || ""} | ${row.condition || ""}`);
  for (const row of asArray(controlFlow.loops)) keys.add(`Loop:${row.id || ""} | ${row.type || ""}`);
  for (const row of asArray(facts.exceptions)) keys.add(`Exception:${row.name || ""} -> ${row.action || ""}`);
  keys.add(`Transaction:${transactionToken(facts.transactions).slice("Transaction: ".length)}`);
  for (const row of asArray(facts.specialSyntax)) keys.add(`Syntax:${row.id}`);
  return keys;
}

function validateNoDebugTokens(markdown, errors) {
  const re = /^\s*- (FactId|Package|Subprogram|Kind|Signature|Param|Return|Table|Operation|Column|Call|Sequence|Constant|Syntax|FlowNode|Branch|Loop|Exception|Transaction|ManualReview|SourceTrace):/gm;
  let match;
  while ((match = re.exec(markdown))) {
    addError(errors, "DEBUG_TOKEN_VISIBLE", "markdown", `debug fact token must not appear in final FSD markdown: ${match[1]}`);
  }
}

function markdownStructuralKeys(markdown) {
  const keys = [];
  const re = /^\s*- (Package|Subprogram|Kind|Param|Return|Table|Operation|Column|Call|Sequence|Constant|Syntax|FlowNode|Branch|Loop|Exception|Transaction):\s*([^\n]+)/gm;
  let match;
  while ((match = re.exec(markdown))) {
    const prefix = match[1];
    const raw = match[2].trim();
    const value = ["Table", "Call", "Sequence", "Constant", "Syntax"].includes(prefix)
      ? raw.split("|")[0].trim()
      : raw;
    keys.push(`${prefix}:${value}`);
  }
  return keys;
}

function validateSections(markdown, errors, index) {
  if (/^##\s+\d+[.)]\s*/m.test(markdown)) {
    addError(errors, "NUMBERED_SECTION_HEADING", "sections", "FSD section headings must not be numbered");
  }
  const headings = index.sectionHeadings;
  for (const section of FSD_MARKDOWN_SECTIONS) {
    if (!headings.includes(section)) addError(errors, "SECTION_MISSING", "sections", `missing section ${section}`);
  }
  if (FSD_MARKDOWN_SECTIONS.every((section) => headings.includes(section))) {
    const actual = headings.filter((heading) => FSD_MARKDOWN_SECTIONS.includes(heading));
    if (actual.join("\n") !== FSD_MARKDOWN_SECTIONS.join("\n")) {
      addError(errors, "SECTION_ORDER_INVALID", "sections", "FSD sections are out of order");
    }
  }
}

function validateSubsections(index, errors) {
  const headings = index.subsectionHeadings;
  for (const [section, subsections] of Object.entries(FSD_MARKDOWN_SUBSECTIONS)) {
    for (const subsection of subsections) {
      if (!headings.includes(subsection)) {
        addError(errors, "SUBSECTION_MISSING", `sections.${section}.${subsection}`, `missing subsection ${section} / ${subsection}`);
      }
    }
  }
}

function depthTableMappings(facts) {
  const depth = facts.templateDepth || {};
  return asArray(depth.tableMappings).length ? asArray(depth.tableMappings) : asArray(facts.tableMappings);
}

function validateTemplateDepth(facts, markdown, errors, index) {
  const identity = facts.identity || {};
  const signature = facts.signature || {};
  const dependencies = facts.dependencies || {};
  const controlFlow = facts.controlFlow || {};
  const transactions = facts.transactions || {};
  const templateDepth = facts.templateDepth || {};
  const tables = depthTableMappings(facts);

  validateSubsections(index, errors);

  const overviewText = subsectionText(index, "存储过程功能");
  const paramsText = subsectionText(index, "参数清单与 Java 类型映射");
  const strategyText = subsectionText(index, "转换策略");
  const tablesText = subsectionText(index, "涉及的表清单");
  const columnsText = subsectionText(index, "列 → DO 字段映射");
  const relationsText = subsectionText(index, "跨表关系");
  const specialColumnsText = subsectionText(index, "特殊列处理");
  const callsText = subsectionText(index, "调用的其他子程序");
  const calledByText = subsectionText(index, "被其他子程序调用");
  const injectionText = subsectionText(index, "跨包调用 → Service 注入");
  const sequencesText = subsectionText(index, "序列依赖");
  const constantsText = subsectionText(index, "常量依赖");
  const validationsText = subsectionText(index, "校验规则");
  const calculationsText = subsectionText(index, "计算逻辑");
  const statesText = subsectionText(index, "状态流转");
  const boundariesText = subsectionText(index, "边界条件");
  const branchesText = subsectionText(index, "分支逻辑");
  const flowText = subsectionText(index, "流程图");
  const loopsText = subsectionText(index, "循环结构");
  const exceptionsText = subsectionText(index, "异常处理");
  const syntaxText = subsectionText(index, "转化映射");
  const txText = subsectionText(index, "事务边界");
  const manualReviewText = subsectionText(index, "需手动审查的构造");

  requireTableHeader(errors, overviewText, "template.overview", ["项目", "内容"]);
  requireTableHeader(errors, paramsText, "template.params", ["参数名", "方向", "Oracle 类型", "Java 类型", "说明"]);
  requireTableHeader(errors, strategyText, "template.strategy", ["项", "内容"]);
  requireTableHeader(errors, tablesText, "template.tables", ["表名", "操作类型", "DO 类名", "说明"]);
  if (tables.length) requireTableHeader(errors, columnsText, "template.columns", ["列名", "Oracle 类型", "Java 类型", "Java 字段名", "可空", "主键", "本 SP 使用"]);
  requireTableHeader(errors, relationsText, "template.relations", ["关系", "类型", "说明"]);
  requireTableHeader(errors, specialColumnsText, "template.specialColumns", ["表.列", "特殊类型", "处理方式"]);
  requireTableHeader(errors, callsText, "template.calls", ["Oracle 调用", "目标包", "目标子程序 (refName)", "功能"]);
  requireTableHeader(errors, calledByText, "template.calledBy", ["调用方", "入口"]);
  requireTableHeader(errors, injectionText, "template.dependencyInjection", ["字段", "类型", "来源包", "用途"]);
  requireTableHeader(errors, sequencesText, "template.sequences", ["序列名", "用途"]);
  requireTableHeader(errors, constantsText, "template.constants", ["常量名", "所属包", "值", "用途"]);
  requireTableHeader(errors, validationsText, "template.validations", ["规则 ID", "类别", "描述", "Oracle 位置", "Java 实现"]);
  requireTableHeader(errors, calculationsText, "template.calculations", ["逻辑 ID", "描述", "Oracle 表达式", "Java 实现"]);
  requireTableHeader(errors, statesText, "template.stateTransitions", ["转换", "条件", "操作"]);
  requireTableHeader(errors, boundariesText, "template.boundaries", ["条件", "处理方式", "Oracle 行为", "Java 映射"]);
  if (asArray(controlFlow.nodes).length) requireTableHeader(errors, flowText, "template.flowNodes", ["节点 ID", "步骤"]);
  requireTableHeader(errors, branchesText, "template.branches", ["分支 ID", "条件", "真分支", "假分支", "Oracle 行号"]);
  requireTableHeader(errors, loopsText, "template.loops", ["循环 ID", "类型", "Oracle 构造", "Java 映射", "退出条件"]);
  requireTableHeader(errors, exceptionsText, "template.exceptions", ["异常", "Oracle 处理", "Java 映射", "处理方式"]);
  requireTableHeader(errors, syntaxText, "template.syntax", ["Oracle 构造", "位置", "Java/MyBatis 等价", "风险"]);
  requireTableHeader(errors, manualReviewText, "template.manualReview", ["构造", "位置", "原因", "建议"]);

  requireTableRow(errors, overviewText, "template.overview.subprogramName", ["子程序名", identity.subprogramName || ""], "missing overview subprogram name row");
  requireTableRow(errors, overviewText, "template.overview.kind", ["类型", identity.kind || ""], "missing overview kind row");
  requireTableRow(errors, overviewText, "template.overview.packageName", ["所属包", identity.packageName || ""], "missing overview package row");
  requireVisibleLine(errors, markdown, "template.identity.id", [`# FSD - ${identity.id || ""}`], "missing FSD title identity");
  requireVisibleBlock(errors, subsectionText(index, "签名"), "template.signature.raw", signature.raw || "", "missing signature SQL block");

  for (const param of asArray(signature.params)) {
    requireTableRow(
      errors,
      paramsText,
      `template.params.${param.name || ""}`,
      [param.name || "", param.direction || "", param.oracleType || "", param.javaType || "UNKNOWN"],
      `missing parameter mapping row for ${param.name || ""}`
    );
  }

  if (signature.return && signature.return.oracleType) {
    requireTableRow(
      errors,
      paramsText,
      "template.return",
      [signature.return.oracleType || "", signature.return.javaType || "UNKNOWN", "Function 返回值映射"],
      "missing function return type mapping row"
    );
  }

  for (const row of tables) {
    requireTableRow(
      errors,
      tablesText,
      `template.tables.${row.tableName || ""}`,
      [row.tableName || "", asArray(row.operations).join(", "), row.doClassName || ""],
      `missing table mapping row for ${row.tableName || ""}`
    );
    for (const col of asArray(row.columns)) {
      if (typeof col === "string") {
        requireTableRow(errors, columnsText, `template.columns.${row.tableName || ""}.${col}`, [col], `missing column mapping row for ${row.tableName || ""}.${col}`);
      } else {
        const name = col.name || col.column || col.columnName || "";
        requireTableRow(
          errors,
          columnsText,
          `template.columns.${row.tableName || ""}.${name}`,
          [
            name,
            col.oracleType || col.oracle_type || "UNKNOWN",
            col.javaType || col.java_type || "UNKNOWN",
            col.javaFieldName || col.java_field_name || "",
            col.nullable || "UNKNOWN",
            col.primaryKey || col.primary_key || "",
            col.usedByCurrentSp,
          ],
          `missing column mapping row for ${row.tableName || ""}.${name}`
        );
      }
    }
  }

  for (const row of asArray(templateDepth.dependencyInjection)) {
    requireTableRow(
      errors,
      injectionText,
      `template.dependencyInjection.${row.fieldName || ""}`,
      [row.fieldName || "", row.serviceType || "", row.sourcePackage || "", row.usage || ""],
      `missing Service injection row for ${row.fieldName || ""}`
    );
  }

  for (const row of asArray(dependencies.calls)) {
    requireTableRow(errors, callsText, `template.calls.${row.target || ""}`, [row.target || ""], `missing dependency call row for ${row.target || ""}`);
  }
  for (const row of asArray(dependencies.calledBy)) {
    requireTableRow(
      errors,
      calledByText,
      `template.calledBy.${row.caller || ""}`,
      [row.caller || "", identity.refName || identity.subprogramName || ""],
      `missing calledBy row for ${row.caller || ""}`
    );
  }
  for (const row of asArray(dependencies.sequences)) {
    requireTableRow(errors, sequencesText, `template.sequences.${row.name || ""}`, [row.name || ""], `missing sequence dependency row for ${row.name || ""}`);
  }
  for (const row of asArray(dependencies.constants)) {
    const parts = String(row.target || "").split(".");
    requireTableRow(
      errors,
      constantsText,
      `template.constants.${row.target || ""}`,
      [parts.slice(1).join(".") || row.target || "", parts[0] || "", row.value ?? "UNKNOWN"],
      `missing constant dependency row for ${row.target || ""}`
    );
  }
  for (const row of asArray(templateDepth.businessRules && templateDepth.businessRules.validations)) {
    requireTableRow(
      errors,
      validationsText,
      `template.validations.${row.id || ""}`,
      [row.id || "", row.category || "", row.description || "", row.location || "", row.javaImplementation || ""],
      `missing validation business rule row for ${row.id || ""}`
    );
  }
  for (const row of asArray(templateDepth.businessRules && templateDepth.businessRules.calculations)) {
    requireTableRow(
      errors,
      calculationsText,
      `template.calculations.${row.id || ""}`,
      [row.id || "", row.description || "", row.oracleExpression || "", row.javaImplementation || ""],
      `missing calculation business rule row for ${row.id || ""}`
    );
  }
  for (const row of asArray(templateDepth.businessRules && templateDepth.businessRules.stateTransitions)) {
    requireTableRow(
      errors,
      statesText,
      `template.stateTransitions.${row.transition || ""}`,
      [row.transition || "", row.condition || "", row.action || ""],
      `missing state transition row for ${row.transition || ""}`
    );
  }
  for (const row of asArray(templateDepth.businessRules && templateDepth.businessRules.boundaries)) {
    requireTableRow(
      errors,
      boundariesText,
      `template.boundaries.${row.condition || ""}`,
      [row.condition || "", row.handling || "", row.oracleBehavior || "", row.javaMapping || ""],
      `missing boundary business rule row for ${row.condition || ""}`
    );
  }
  for (const row of asArray(controlFlow.branches)) {
    requireTableRow(errors, branchesText, `template.branches.${row.id || ""}`, [row.id || "", row.condition || ""], `missing branch row for ${row.id || ""}`);
  }
  for (const row of asArray(controlFlow.nodes)) {
    requireTableRow(errors, flowText, `template.flowNodes.${row.id || ""}`, [row.id || "", row.label || ""], `missing flow node row for ${row.id || ""}`);
  }
  for (const row of asArray(controlFlow.loops)) {
    requireTableRow(errors, loopsText, `template.loops.${row.id || ""}`, [row.id || "", row.type || ""], `missing loop row for ${row.id || ""}`);
  }
  for (const row of asArray(facts.exceptions)) {
    requireTableRow(errors, exceptionsText, `template.exceptions.${row.name || ""}`, [row.name || "", row.action || ""], `missing exception row for ${row.name || ""}`);
  }
  for (const row of asArray(facts.specialSyntax)) {
    requireTableRow(errors, syntaxText, `template.syntax.${row.id || ""}`, [row.type || "", row.line || "", row.risk || ""], `missing special syntax row for ${row.id || ""}`);
  }

  requireVisibleLine(errors, txText, "template.transaction.commit", ["显式 COMMIT", transactions.hasCommit ? "是" : "否"], "missing COMMIT transaction boundary");
  requireVisibleLine(errors, txText, "template.transaction.rollback", ["显式 ROLLBACK", transactions.hasRollback ? "是" : "否"], "missing ROLLBACK transaction boundary");
  requireVisibleLine(errors, txText, "template.transaction.savepoint", ["SAVEPOINT", transactions.hasSavepoint ? "是" : "否"], "missing SAVEPOINT transaction boundary");
  requireVisibleLine(errors, txText, "template.transaction.autonomous", ["自治事务", transactions.autonomous ? "是" : "否"], "missing autonomous transaction boundary");
  requireVisibleLine(errors, txText, "template.transaction.spring", ["Spring 等价"], "missing Spring transaction equivalent");
  for (const row of asArray(facts.manualReview)) {
    const syntax = asArray(facts.specialSyntax).find((syn) => syn.id === row.sourceId) || {};
    requireTableRow(
      errors,
      manualReviewText,
      `template.manualReview.${row.id || row.sourceId || ""}`,
      [syntax.type || row.sourceId || "", syntax.line || "", row.reason || ""],
      `missing manual review row for ${row.id || row.sourceId || ""}`
    );
  }
}

function validateFsdMarkdown(facts, markdown, options = {}) {
  const errors = [];
  const text = visibleMarkdown(markdown);
  if (options.outputPath && facts.identity && facts.identity.outputPath && options.outputPath !== facts.identity.outputPath) {
    addError(errors, "OUTPUT_PATH_MISMATCH", "identity.outputPath", "provided output path does not match facts identity");
  }

  const index = buildMarkdownIndex(text, errors);
  validateSections(text, errors, index);
  validateTemplateDepth(facts, text, errors, index);
  validateNoDebugTokens(text, errors);

  const expectedKeys = expectedStructuralKeys(facts);
  for (const key of markdownStructuralKeys(text)) {
    if (!expectedKeys.has(key)) {
      addError(errors, "MARKDOWN_FACT_WITHOUT_TRACE", "markdown", `orphan structural fact ${key}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function classifyFsdMarkdownGate(facts, markdown, options = {}) {
  const gate = validateFsdMarkdown(facts, markdown, options);
  return {
    ...gate,
    ...classifyFsdGateErrors(gate.errors),
  };
}

module.exports = {
  classifyFsdGateErrors,
  classifyFsdMarkdownGate,
  validateFsdMarkdown,
  visibleMarkdown,
};
