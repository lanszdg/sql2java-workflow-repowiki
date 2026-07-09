"use strict";

const {
  FSD_FACTS_SCHEMA_VERSION,
  SECTION_IDS,
  validateFsdFacts,
} = require("./fsd-facts-schema.cjs");
const { listFactTokens } = require("./fsd-fact-tokens.cjs");

const SQL_ALIAS_NOISE = new Set([
  "OLD_SET",
  "NEW_SET",
  "TABLE",
  "S",
  "TGT",
  "SRC",
  "REC",
  "ROW",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanName(value) {
  return String(value || "").trim();
}

function pascalCaseName(value) {
  return cleanName(value)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function camelCaseName(value) {
  const pascal = pascalCaseName(value);
  return pascal ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : "";
}

function doClassName(tableName) {
  const base = pascalCaseName(tableName);
  return base ? `${base}DO` : "";
}

function serviceTypeName(packageName) {
  const base = pascalCaseName(packageName.replace(/_PKG$/i, ""));
  return base ? `${base}PkgService` : "";
}

function serviceFieldName(packageName) {
  const type = serviceTypeName(packageName);
  return type ? type.charAt(0).toLowerCase() + type.slice(1) : "";
}

function isNoiseName(value) {
  const name = cleanName(value);
  return !name || SQL_ALIAS_NOISE.has(name.toUpperCase());
}

function traceOf(row, fallback) {
  if (row && Array.isArray(row.sourceTrace) && row.sourceTrace.length) return row.sourceTrace;
  return [fallback];
}

function dotName(pkg, member) {
  const left = cleanName(pkg);
  const right = cleanName(member);
  return left && right ? `${left}.${right}` : "";
}

function columnNameOf(col) {
  return typeof col === "string" ? cleanName(col) : cleanName(col && (col.name || col.column || col.columnName));
}

function columnMappingOf(tableName, col) {
  const name = columnNameOf(col);
  if (!name) return null;
  const row = typeof col === "string" ? {} : (col || {});
  return {
    name,
    oracleType: cleanName(row.oracle_type || row.oracleType || row.type),
    javaType: cleanName(row.java_type || row.javaType),
    javaFieldName: cleanName(row.java_field_name || row.javaFieldName) || camelCaseName(name),
    nullable: cleanName(row.nullable || row.is_nullable || row.isNullable) || "UNKNOWN",
    primaryKey: cleanName(row.primary_key || row.primaryKey || row.pk || row.is_primary_key || row.isPrimaryKey) || "",
    usedByCurrentSp: row.used_by_current_sp !== undefined ? Boolean(row.used_by_current_sp)
      : row.usedByCurrentSp !== undefined ? Boolean(row.usedByCurrentSp)
        : "UNKNOWN",
    sourceTrace: traceOf(row, `table:${tableName}.columns`),
  };
}

function riskOf(row) {
  const risk = String(row && row.risk || row && row.severity || "").toLowerCase();
  if (risk === "high" || risk === "medium" || risk === "low") return risk;
  return "";
}

function compileIdentity(l2Fact) {
  const packageName = cleanName(l2Fact.package_name || l2Fact.packageName || l2Fact.service_iface || l2Fact.impl_qn);
  const subprogramName = cleanName(l2Fact.method || l2Fact.subprogramName || l2Fact.name);
  const overloadRaw = l2Fact.overload_index ?? l2Fact.overloadIndex ?? null;
  const overloadIndex = overloadRaw === undefined || overloadRaw === null || overloadRaw === "" ? null : Number(overloadRaw);
  const overloadSuffix = overloadIndex === null ? "" : `#${overloadIndex}`;
  const pathSuffix = overloadIndex === null ? "" : `__overload_${overloadIndex}`;
  return {
    id: `${packageName}.${subprogramName}${overloadSuffix}`,
    packageName,
    subprogramName,
    refName: overloadIndex === null ? subprogramName : `${subprogramName}${overloadSuffix}`,
    kind: cleanName(l2Fact.procedure_type || l2Fact.kind || "PROCEDURE").toUpperCase(),
    overloadIndex,
    outputPath: `fsd/${packageName}/${subprogramName}${pathSuffix}.md`,
  };
}

function compileSignature(l2Fact) {
  return {
    raw: cleanName(l2Fact.signature),
    params: asArray(l2Fact.oracle_params || l2Fact.params).map((param) => ({
      name: cleanName(param.name),
      direction: cleanName(param.direction || param.mode || "IN").toUpperCase(),
      oracleType: cleanName(param.oracle_type || param.oracleType || param.type),
      javaType: cleanName(param.java_type || param.javaType),
    })),
    return: l2Fact.return_type ? {
      oracleType: cleanName(l2Fact.return_type),
      javaType: cleanName(l2Fact.return_java_type || l2Fact.response_type),
    } : null,
  };
}

function compileTableMappings(l2Fact) {
  return asArray(l2Fact.table_facts).filter((row) => !isNoiseName(row.table || row.tableName)).map((row, index) => ({
    tableName: cleanName(row.table || row.tableName),
    operations: [cleanName(row.operation || row.op || row.action || "UNKNOWN").toUpperCase()].filter(Boolean),
    columns: asArray(row.columns).map((col) => typeof col === "string" ? col : cleanName(col.name || col.column || col.columnName)).filter(Boolean),
    sourceTrace: traceOf(row, `table_facts[${index}]`),
  }));
}

function compileDependencies(l2Fact, context = {}) {
  const calls = asArray(l2Fact.cross_package_calls)
    .filter((row) => !isNoiseName(row.target_package || row.packageName))
    .map((row, index) => ({
      target: dotName(row.target_package || row.packageName, row.target_member || row.member || row.method),
      targetPackage: cleanName(row.target_package || row.packageName),
      targetMember: cleanName(row.target_member || row.member || row.method),
      sourceTrace: traceOf(row, `cross_package_calls[${index}]`),
    }))
    .filter((row) => row.target);

  const sequences = asArray(l2Fact.sequence_deps).map((row, index) => ({
    name: cleanName(row.sequence || row.name),
    sourceTrace: traceOf(row, `sequence_deps[${index}]`),
  })).filter((row) => row.name && !isNoiseName(row.name));

  const constants = asArray(l2Fact.constant_deps)
    .filter((row) => !isNoiseName(row.target_package || row.packageName))
    .map((row, index) => ({
      target: dotName(row.target_package || row.packageName, row.target_member || row.member || row.name),
      value: row.value ?? null,
      sourceTrace: traceOf(row, `constant_deps[${index}]`),
    }))
    .filter((row) => row.target);

  const calledBy = asArray(context.calledBy || l2Fact.called_by || l2Fact.calledBy)
    .map((row, index) => ({
      caller: cleanName(row.caller || row.source || row.from || row.target || row.name),
      sourceTrace: traceOf(row, `calledBy[${index}]`),
    }))
    .filter((row) => row.caller);

  return { calls, calledBy, sequences, constants };
}

function compileControlFlow(l2Fact) {
  if (Array.isArray(l2Fact.control_flow)) {
    const branches = [];
    const loops = [];
    const nodes = [];
    for (const [index, row] of l2Fact.control_flow.entries()) {
      const construct = cleanName(row.construct || row.type || row.kind).toUpperCase();
      const common = {
        id: cleanName(row.id || `${construct.toLowerCase() || "node"}-${index + 1}`),
        sourceTrace: traceOf(row, `control_flow[${index}]`),
        line: row.line || row.startLine || null,
      };
      if (construct === "IF" || construct === "ELSIF" || construct === "CASE") {
        branches.push({ ...common, condition: cleanName(row.condition || row.text || row.statement || construct) });
      } else if (construct.includes("LOOP") || construct === "FOR" || construct === "FORALL" || construct === "WHILE" || construct === "CURSOR") {
        loops.push({ ...common, type: construct, oracleConstruct: cleanName(row.text || row.statement || construct) });
      } else {
        nodes.push({ ...common, label: cleanName(row.label || row.text || row.statement || construct) });
      }
    }
    return { nodes, branches, loops, mermaidHint: "" };
  }
  const flow = isObject(l2Fact.control_flow) ? l2Fact.control_flow : {};
  return {
    nodes: asArray(flow.nodes),
    branches: asArray(flow.branches),
    loops: asArray(flow.loops),
    mermaidHint: cleanName(flow.mermaidHint || flow.mermaid || ""),
  };
}

function compileExceptions(l2Fact) {
  return asArray(l2Fact.exception_handlers).map((row, index) => ({
    name: cleanName(row.name || row.exception || row.when),
    action: cleanName(row.action || row.handler || row.statement),
    sourceTrace: traceOf(row, `exception_handlers[${index}]`),
  })).filter((row) => row.name || row.action);
}

function compileTransactions(l2Fact, specialSyntax) {
  const tx = isObject(l2Fact.transactions) ? l2Fact.transactions : {};
  const syntaxTypes = specialSyntax.map((row) => String(row.type || "").toUpperCase());
  return {
    hasCommit: Boolean(tx.hasCommit || tx.has_commit || syntaxTypes.includes("COMMIT")),
    hasRollback: Boolean(tx.hasRollback || tx.has_rollback || syntaxTypes.includes("ROLLBACK")),
    hasSavepoint: Boolean(tx.hasSavepoint || tx.has_savepoint || syntaxTypes.includes("SAVEPOINT")),
    autonomous: Boolean(tx.autonomous || syntaxTypes.includes("AUTONOMOUS_TRANSACTION")),
    springEquivalent: cleanName(tx.springEquivalent || tx.spring_equivalent),
  };
}

function compileSpecialSyntax(l2Fact) {
  return asArray(l2Fact.special_syntax).map((row, index) => {
    const type = cleanName(row.type || row.kind || row.construct || "special");
    return {
      id: cleanName(row.id || `${type.toLowerCase()}-${index + 1}`),
      type,
      risk: riskOf(row),
      mapping: cleanName(row.mapping || row.javaMapping || row.target || row.java_equivalent || ""),
      line: row.line || row.startLine || null,
      sourceTrace: traceOf(row, `special_syntax[${index}]`),
    };
  });
}

function compileManualReview(specialSyntax) {
  return specialSyntax
    .filter((row) => row.risk === "high" || row.risk === "medium")
    .map((row) => ({
      id: `review-${row.id}`,
      sourceId: row.id,
      severity: row.risk,
      reason: `${row.type} requires migration review`,
    }));
}

function compileSourceTrace(l2Fact) {
  return [{
    file: cleanName(l2Fact.source_file || l2Fact.sourceFile || l2Fact.file || "<l2-facts>"),
    startLine: Number(l2Fact.start_line || l2Fact.startLine || 1),
    endLine: Number(l2Fact.end_line || l2Fact.endLine || l2Fact.start_line || l2Fact.startLine || 1),
    fact: "subprogram",
  }];
}

function compileTemplateDepth(l2Fact, identity, signature, tableMappings, dependencies, controlFlow, exceptions, transactions, specialSyntax, manualReview) {
  const rawTables = asArray(l2Fact.table_facts);
  const tableDepth = tableMappings.map((table) => {
    const raw = rawTables.find((row) => cleanName(row.table || row.tableName) === table.tableName) || {};
    const columns = asArray(raw.columns)
      .map((col) => columnMappingOf(table.tableName, col))
      .filter(Boolean);
    return {
      tableName: table.tableName,
      operations: table.operations,
      doClassName: doClassName(table.tableName),
      description: "",
      columns,
      relations: [],
      specialColumns: [],
      sourceTrace: table.sourceTrace,
    };
  });

  const dependencyInjection = dependencies.calls
    .map((call) => ({
      fieldName: serviceFieldName(call.targetPackage || call.target.split(".")[0]),
      serviceType: serviceTypeName(call.targetPackage || call.target.split(".")[0]),
      sourcePackage: call.targetPackage || call.target.split(".")[0],
      usage: call.targetMember || call.target,
      sourceTrace: call.sourceTrace,
    }))
    .filter((row) => row.sourcePackage && !isNoiseName(row.sourcePackage));

  return {
    overview: {
      summary: "",
      translationStrategy: [],
      serviceMapping: `${identity.subprogramName} -> ${pascalCaseName(identity.packageName.replace(/_PKG$/i, "")) || identity.packageName}Service.${camelCaseName(identity.subprogramName)}()`,
      parameterPackaging: signature.params.length > 1 ? "DTO" : "single parameter",
      returnMapping: signature.return ? `${signature.return.oracleType} -> ${signature.return.javaType || "UNKNOWN"}` : "void / OUT params",
      designPattern: "Service + MyBatis Mapper",
      exceptionStrategy: exceptions.length ? "Map Oracle exception handlers to Java exceptions" : "Use transactional rollback policy",
    },
    tableMappings: tableDepth,
    dependencyInjection,
    businessRules: {
      validations: [],
      calculations: [],
      stateTransitions: [],
      boundaries: [],
    },
    controlFlow: {
      mermaid: controlFlow.mermaidHint || "",
      branches: controlFlow.branches,
      loops: controlFlow.loops,
      exceptions,
    },
    specialSyntax: {
      mappings: specialSyntax,
      transactionBoundary: [{
        commit: transactions.hasCommit,
        rollback: transactions.hasRollback,
        savepoint: transactions.hasSavepoint,
        autonomous: transactions.autonomous,
        springEquivalent: transactions.springEquivalent || "",
      }],
      manualReview,
    },
  };
}

function compileFsdFacts(l2Fact, context = {}) {
  if (!isObject(l2Fact)) throw new Error("compileFsdFacts requires an L2 Oracle fact object");
  const identity = compileIdentity(l2Fact);
  const signature = compileSignature(l2Fact);
  const tableMappings = compileTableMappings(l2Fact);
  const dependencies = compileDependencies(l2Fact, context);
  const controlFlow = compileControlFlow(l2Fact);
  const exceptions = compileExceptions(l2Fact);
  const specialSyntax = compileSpecialSyntax(l2Fact);
  const manualReview = compileManualReview(specialSyntax);
  const sourceTrace = compileSourceTrace(l2Fact);
  const transactions = compileTransactions(l2Fact, specialSyntax);
  const fact = {
    schemaVersion: FSD_FACTS_SCHEMA_VERSION,
    identity,
    signature,
    tableMappings,
    dependencies,
    controlFlow,
    exceptions,
    transactions,
    specialSyntax,
    manualReview,
    templateDepth: compileTemplateDepth(l2Fact, identity, signature, tableMappings, dependencies, controlFlow, exceptions, transactions, specialSyntax, manualReview),
    sourceTrace,
    coverage: {
      requiredSections: SECTION_IDS,
      factsTotal: 0,
      factsCoveredByMarkdown: 0,
      gaps: [],
    },
  };
  fact.coverage.factsTotal = listFactTokens(fact).length;
  const result = validateFsdFacts(fact);
  if (!result.ok) {
    const error = new Error(`compiled fsd-facts failed validation: ${result.errors.map((row) => `${row.code}:${row.path}`).join(", ")}`);
    error.validation = result;
    throw error;
  }
  return fact;
}

module.exports = {
  compileFsdFacts,
  SQL_ALIAS_NOISE,
};
