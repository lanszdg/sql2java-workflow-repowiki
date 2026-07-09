"use strict";

const { validateFsdFacts } = require("./fsd-facts-schema.cjs");
const { classifyFsdMarkdownGate, visibleMarkdown } = require("./fsd-facts-gate.cjs");
const { FSD_MARKDOWN_SECTIONS, FSD_MARKDOWN_SUBSECTIONS } = require("./fsd-facts-renderer.cjs");
const { listFactTokens, transactionToken } = require("./fsd-fact-tokens.cjs");

const POLLUTION_IDENTIFIERS = new Set([
  "s",
  "src",
  "tgt",
  "rec",
  "row",
  "old_set",
  "new_set",
  "table",
]);

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function countTemplateRequiredItems(facts) {
  const signature = facts.signature || {};
  const deps = facts.dependencies || {};
  const controlFlow = facts.controlFlow || {};
  const depth = facts.templateDepth || {};
  const businessRules = depth.businessRules || {};
  const tables = asArray(depth.tableMappings).length ? asArray(depth.tableMappings) : asArray(facts.tableMappings);

  const sections = FSD_MARKDOWN_SECTIONS.length;
  const subsections = Object.values(FSD_MARKDOWN_SUBSECTIONS).reduce((sum, rows) => sum + rows.length, 0);
  const headers = 20 + (tables.length ? 1 : 0);
  const overviewAndSignatureRows = 4;
  const params = asArray(signature.params).length;
  const returns = signature.return && signature.return.oracleType ? 1 : 0;
  const tableRows = tables.length;
  const columnRows = tables.reduce((sum, row) => sum + asArray(row.columns).length, 0);
  const dependencyRows =
    asArray(depth.dependencyInjection).length
    + asArray(deps.calls).length
    + asArray(deps.calledBy).length
    + asArray(deps.sequences).length
    + asArray(deps.constants).length;
  const businessRuleRows =
    asArray(businessRules.validations).length
    + asArray(businessRules.calculations).length
    + asArray(businessRules.stateTransitions).length
    + asArray(businessRules.boundaries).length;
  const flowRows =
    asArray(controlFlow.nodes).length
    + asArray(controlFlow.branches).length
    + asArray(controlFlow.loops).length
    + asArray(facts.exceptions).length;
  const syntaxRows = asArray(facts.specialSyntax).length;
  const manualReviewRows = asArray(facts.manualReview).length;
  const transactionRows = 5;
  return sections + subsections + headers + overviewAndSignatureRows + params + returns + tableRows + columnRows + dependencyRows + businessRuleRows + flowRows + syntaxRows + manualReviewRows + transactionRows;
}

function computeFsdCoverage(facts, markdown, options = {}) {
  const text = visibleMarkdown(markdown);
  const schema = validateFsdFacts(facts);
  const gate = classifyFsdMarkdownGate(facts, markdown, options);
  const tokens = listFactTokens(facts);
  const covered = [];
  const tokenGaps = [];
  for (const token of tokens) {
    const needle = token.label || token.value;
    if (needle && text.includes(needle)) {
      covered.push(token);
    } else {
      tokenGaps.push({
        code: "FACT_NOT_RENDERED",
        token: needle,
        factCode: token.code,
        message: `Final FSD markdown does not expose diagnostic token ${token.code} ${needle}`,
      });
    }
  }
  const factsTotal = tokens.length;
  const factsCoveredByMarkdown = covered.length;
  const orphanMarkdownFacts = gate.errors
    .filter((err) => err.code === "MARKDOWN_FACT_WITHOUT_TRACE")
    .map((err) => ({ path: err.path || "", message: err.message || "", token: err.token || "" }));
  const templateDepthErrors = gate.errors
    .filter((err) => ["EXTRA_SECTION", "SUBSECTION_MISSING", "SUBSECTION_WRONG_SECTION", "TEMPLATE_TABLE_MISSING", "TEMPLATE_FACT_ROW_MISSING"].includes(err.code))
    .map((err) => ({ code: err.code, path: err.path || "", message: err.message || "" }));
  const templateRequiredItemsTotal = countTemplateRequiredItems(facts);
  const templateRequiredItemsCovered = Math.max(0, templateRequiredItemsTotal - templateDepthErrors.length);
  const templateDepthRatio = templateRequiredItemsTotal === 0 ? 1 : templateRequiredItemsCovered / templateRequiredItemsTotal;
  const markdownCoverage = {
    factsToMarkdown: covered.map((token) => ({ factCode: token.code, token: token.value, label: token.label })),
    markdownToFacts: covered.map((token) => ({ token: token.value, factCode: token.code })),
    orphanMarkdownFacts,
    unrenderedFacts: templateDepthErrors.map((err) => ({ factCode: err.code, token: err.path, message: err.message })),
    diagnosticTokenGaps: tokenGaps.map((gap) => ({ factCode: gap.factCode, token: gap.token, message: gap.message })),
  };
  return {
    ok: schema.ok && gate.hardOk,
    schema,
    gate,
    metrics: {
      factsTotal,
      factsCoveredByMarkdown,
      visibleFactsCoveredByMarkdown: factsCoveredByMarkdown,
      coverageRatio: factsTotal === 0 ? 1 : factsCoveredByMarkdown / factsTotal,
      templateRequiredItemsTotal,
      templateRequiredItemsCovered,
      templateDepthRatio,
    },
    templateDepth: {
      ok: templateDepthErrors.length === 0,
      gaps: templateDepthErrors,
      missingTemplateItems: templateDepthErrors,
      hardGaps: gate.hardErrors || [],
      advisoryGaps: gate.advisoryErrors || [],
      checked: true,
    },
    gaps: [],
    covered,
    markdownCoverage,
  };
}

function detectFsdPollution(facts) {
  const findings = [];
  const deps = facts.dependencies || {};
  for (const row of asArray(facts.tableMappings)) {
    if (POLLUTION_IDENTIFIERS.has(lower(row.tableName))) {
      findings.push({
        code: "SQL_ALIAS_POLLUTION",
        path: "tableMappings.tableName",
        value: row.tableName,
        message: `table mapping looks like SQL alias noise: ${row.tableName}`,
      });
    }
  }
  for (const row of asArray(deps.calls)) {
    const pkg = String(row.target || "").split(".")[0];
    if (POLLUTION_IDENTIFIERS.has(lower(pkg))) {
      findings.push({
        code: "SQL_ALIAS_POLLUTION",
        path: "dependencies.calls.target",
        value: row.target,
        message: `call target looks like SQL alias noise: ${row.target}`,
      });
    }
  }
  for (const row of asArray(deps.constants)) {
    const pkg = String(row.target || "").split(".")[0];
    if (POLLUTION_IDENTIFIERS.has(lower(pkg))) {
      findings.push({
        code: "SQL_ALIAS_POLLUTION",
        path: "dependencies.constants.target",
        value: row.target,
        message: `constant target looks like SQL alias noise: ${row.target}`,
      });
    }
  }
  return { ok: findings.length === 0, findings };
}

module.exports = {
  POLLUTION_IDENTIFIERS,
  listFactTokens,
  transactionToken,
  computeFsdCoverage,
  detectFsdPollution,
};
