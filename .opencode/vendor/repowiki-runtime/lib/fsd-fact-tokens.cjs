"use strict";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function addToken(tokens, code, value, label) {
  if (value) tokens.push({ code, value: String(value), label: label || String(value) });
}

function transactionToken(transactions) {
  const tx = transactions || {};
  return `Transaction: commit=${Boolean(tx.hasCommit)}, rollback=${Boolean(tx.hasRollback)}, savepoint=${Boolean(tx.hasSavepoint)}, autonomous=${Boolean(tx.autonomous)}`;
}

function paramToken(param) {
  return `Param: ${param.name || ""} | ${param.direction || ""} | ${param.oracleType || ""} | ${param.javaType || ""}`;
}

function returnToken(ret) {
  if (!ret || !ret.oracleType) return "";
  return `Return: Oracle ${ret.oracleType || ""} -> Java ${ret.javaType || ""}`;
}

function columnToken(tableName, column) {
  const name = typeof column === "string" ? column : (column && (column.name || column.column || column.columnName));
  return tableName && name ? `Column: ${tableName}.${name}` : "";
}

function operationToken(tableName, operation) {
  return tableName && operation ? `Operation: ${tableName}.${operation}` : "";
}

function listFactTokens(facts) {
  const tokens = [];
  const deps = facts.dependencies || {};
  const identity = facts.identity || {};
  const signature = facts.signature || {};
  const controlFlow = facts.controlFlow || {};

  addToken(tokens, "IDENTITY_ID", identity.id, `FactId: ${identity.id}`);
  addToken(tokens, "IDENTITY_PACKAGE", identity.packageName, `Package: ${identity.packageName}`);
  addToken(tokens, "IDENTITY_SUBPROGRAM", identity.subprogramName, `Subprogram: ${identity.subprogramName}`);
  addToken(tokens, "IDENTITY_KIND", identity.kind, `Kind: ${identity.kind}`);
  addToken(tokens, "SIGNATURE_RAW", signature.raw, `Signature: ${signature.raw}`);
  for (const param of asArray(signature.params)) addToken(tokens, "SIGNATURE_PARAM", paramToken(param));
  addToken(tokens, "SIGNATURE_RETURN", returnToken(signature.return));

  for (const row of asArray(facts.tableMappings)) {
    addToken(tokens, "TABLE_MAPPING", row.tableName, `Table: ${row.tableName}`);
    for (const op of asArray(row.operations)) addToken(tokens, "TABLE_OPERATION", operationToken(row.tableName, op));
    for (const col of asArray(row.columns)) addToken(tokens, "TABLE_COLUMN", columnToken(row.tableName, col));
  }

  for (const row of asArray(deps.calls)) addToken(tokens, "DEPENDENCY_CALL", row.target, `Call: ${row.target}`);
  for (const row of asArray(deps.sequences)) addToken(tokens, "DEPENDENCY_SEQUENCE", row.name, `Sequence: ${row.name}`);
  for (const row of asArray(deps.constants)) addToken(tokens, "DEPENDENCY_CONSTANT", row.target, `Constant: ${row.target}`);
  for (const row of asArray(controlFlow.nodes)) addToken(tokens, "CONTROL_FLOW_NODE", `FlowNode: ${row.id || ""} | ${row.label || ""}`);
  for (const row of asArray(controlFlow.branches)) addToken(tokens, "CONTROL_FLOW_BRANCH", `Branch: ${row.id || ""} | ${row.condition || ""}`);
  for (const row of asArray(controlFlow.loops)) addToken(tokens, "CONTROL_FLOW_LOOP", `Loop: ${row.id || ""} | ${row.type || ""}`);
  for (const row of asArray(facts.exceptions)) addToken(tokens, "EXCEPTION_HANDLER", `Exception: ${row.name || ""} -> ${row.action || ""}`);
  addToken(tokens, "TRANSACTION_BOUNDARY", transactionToken(facts.transactions));
  for (const row of asArray(facts.manualReview)) addToken(tokens, "MANUAL_REVIEW", `${row.id} -> ${row.sourceId}`, `ManualReview: ${row.id} -> ${row.sourceId}`);
  for (const row of asArray(facts.specialSyntax)) {
    addToken(tokens, "SPECIAL_SYNTAX_ID", row.id, `Syntax: ${row.id}`);
    addToken(tokens, "SPECIAL_SYNTAX_TYPE", row.type, String(row.type || ""));
  }
  for (const row of asArray(facts.sourceTrace)) addToken(tokens, "SOURCE_TRACE", row.file, `SourceTrace: ${row.file}`);
  return tokens;
}

module.exports = {
  listFactTokens,
  transactionToken,
  paramToken,
  returnToken,
  columnToken,
  operationToken,
};
