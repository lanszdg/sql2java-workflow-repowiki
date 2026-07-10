"use strict";

const FSD_MARKDOWN_SECTIONS = [
  "概览",
  "表结构映射",
  "依赖分析",
  "业务规则",
  "控制流与异常",
  "特殊语法转化规约",
];

const FSD_MARKDOWN_SUBSECTIONS = {
  "概览": ["存储过程功能", "参数清单与 Java 类型映射", "转换策略", "签名", "输入类型定义"],
  "表结构映射": ["涉及的表清单", "列 → DO 字段映射", "跨表关系", "特殊列处理"],
  "依赖分析": ["调用的其他子程序", "被其他子程序调用", "跨包调用 → Service 注入", "序列依赖", "常量依赖"],
  "业务规则": ["校验规则", "计算逻辑", "状态流转", "边界条件"],
  "控制流与异常": ["流程图", "分支逻辑", "循环结构", "异常处理"],
  "特殊语法转化规约": ["转化映射", "事务边界", "需手动审查的构造"],
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pushNone(lines) {
  lines.push("- None");
}

function pushSectionHeadings(lines, name) {
  lines.push(`## ${name}`);
  for (const sub of FSD_MARKDOWN_SUBSECTIONS[name] || []) {
    lines.push(`### ${sub}`);
  }
}

function pushSection(lines, name) {
  lines.push(`## ${name}`);
}

function pushSubsection(lines, name) {
  lines.push(`### ${name}`);
}

function cell(value) {
  const text = value === true ? "是" : value === false ? "否" : String(value == null || value === "" ? "无" : value);
  return text.replace(/\|/g, "/").replace(/\r?\n/g, " ").trim();
}

function pushTable(lines, headers, rows) {
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  const safeRows = rows.length ? rows : [headers.map(() => "（无）")];
  for (const row of safeRows) lines.push(`| ${row.map(cell).join(" | ")} |`);
}

function tableColumnName(col) {
  return typeof col === "string" ? col : (col && (col.name || col.column || col.columnName));
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function renderReturn(signature) {
  const ret = signature && signature.return;
  if (!ret || !ret.oracleType) return "- Return: None";
  return `- Return: Oracle ${ret.oracleType || ""} -> Java ${ret.javaType || ""}`;
}

function renderFsdMarkdown(facts) {
  const lines = [];
  const identity = facts.identity || {};
  const signature = facts.signature || {};
  const dependencies = facts.dependencies || {};
  const controlFlow = facts.controlFlow || {};
  const transactions = facts.transactions || {};
  const templateDepth = facts.templateDepth || {};

  lines.push(`# FSD - ${identity.id || ""}`);
  lines.push("");

  pushSection(lines, "概览");
  pushSubsection(lines, "存储过程功能");
  pushTable(lines, ["项目", "内容"], [
    ["子程序名", identity.subprogramName || ""],
    ["类型", identity.kind || ""],
    ["所属包", identity.packageName || ""],
    ["功能摘要", templateDepth.overview && templateDepth.overview.summary || "需人工复核：L3 根据事实归纳"],
    ["翻译策略", asArray(templateDepth.overview && templateDepth.overview.translationStrategy).join("；") || "标准 Service + MyBatis Mapper"],
  ]);
  pushSubsection(lines, "参数清单与 Java 类型映射");
  pushTable(lines, ["参数名", "方向", "Oracle 类型", "Java 类型", "说明"], asArray(signature.params).map((param) => [
    param.name || "",
    param.direction || "",
    param.oracleType || "",
    param.javaType || "UNKNOWN",
    "",
  ]));
  if (signature.return && signature.return.oracleType) {
    pushTable(lines, ["Oracle 返回类型", "Java 类型", "说明"], [[signature.return.oracleType, signature.return.javaType || "UNKNOWN", "Function 返回值映射"]]);
  } else {
    lines.push("返回值：无独立 RETURN，按 OUT 参数或无返回处理。");
  }
  pushSubsection(lines, "转换策略");
  pushTable(lines, ["项", "内容"], [
    ["服务映射", templateDepth.overview && templateDepth.overview.serviceMapping || ""],
    ["参数封装", templateDepth.overview && templateDepth.overview.parameterPackaging || ""],
    ["返回类型", templateDepth.overview && templateDepth.overview.returnMapping || ""],
    ["设计模式", templateDepth.overview && templateDepth.overview.designPattern || ""],
    ["异常处理", templateDepth.overview && templateDepth.overview.exceptionStrategy || ""],
  ]);
  pushSubsection(lines, "签名");
  lines.push("```sql");
  lines.push(signature.raw || "");
  lines.push("```");
  pushSubsection(lines, "输入类型定义");
  lines.push("无");
  lines.push("");

  pushSection(lines, "表结构映射");
  pushSubsection(lines, "涉及的表清单");
  const depthTables = asArray(templateDepth.tableMappings).length ? asArray(templateDepth.tableMappings) : asArray(facts.tableMappings);
  pushTable(lines, ["表名", "操作类型", "DO 类名", "说明"], depthTables.map((row) => [
    row.tableName || "",
    asArray(row.operations).join(", "),
    row.doClassName || "",
    row.description || "",
  ]));
  pushSubsection(lines, "列 → DO 字段映射");
  if (depthTables.length) {
    for (const row of depthTables) {
      lines.push(`#### ${row.tableName || ""} 表 → ${row.doClassName || ""}`);
      pushTable(lines, ["列名", "Oracle 类型", "Java 类型", "Java 字段名", "可空", "主键", "本 SP 使用"], asArray(row.columns).map((col) => {
        if (typeof col === "string") return [col, "UNKNOWN", "UNKNOWN", "", "UNKNOWN", "", "UNKNOWN"];
        return [
          col.name || col.column || col.columnName || "",
          col.oracleType || col.oracle_type || "",
          col.javaType || col.java_type || "UNKNOWN",
          col.javaFieldName || col.java_field_name || "",
          firstPresent(col.nullable, col.is_nullable, col.isNullable, "UNKNOWN"),
          firstPresent(col.primaryKey, col.primary_key, col.pk, col.is_primary_key, col.isPrimaryKey),
          firstPresent(col.usedByCurrentSp, col.used_by_current_sp, "UNKNOWN"),
        ];
      }));
    }
  } else {
    pushNone(lines);
  }
  pushSubsection(lines, "跨表关系");
  pushTable(lines, ["关系", "类型", "说明"], []);
  pushSubsection(lines, "特殊列处理");
  pushTable(lines, ["表.列", "特殊类型", "处理方式"], []);
  lines.push("");

  pushSection(lines, "依赖分析");
  pushSubsection(lines, "调用的其他子程序");
  pushTable(lines, ["Oracle 调用", "目标包", "目标子程序 (refName)", "功能"], asArray(dependencies.calls).map((row) => [
    row.target || "",
    row.targetPackage || String(row.target || "").split(".")[0],
    row.targetMember || String(row.target || "").split(".").slice(1).join("."),
    "",
  ]));
  pushSubsection(lines, "被其他子程序调用");
  pushTable(lines, ["调用方", "入口"], asArray(dependencies.calledBy).map((row) => [row.caller || "", identity.refName || identity.subprogramName || ""]));
  pushSubsection(lines, "跨包调用 → Service 注入");
  pushTable(lines, ["字段", "类型", "来源包", "用途"], asArray(templateDepth.dependencyInjection).map((row) => [
    row.fieldName || "",
    row.serviceType || "",
    row.sourcePackage || "",
    row.usage || "",
  ]));
  pushSubsection(lines, "序列依赖");
  pushTable(lines, ["序列名", "用途"], asArray(dependencies.sequences).map((row) => [row.name || "", ""]));
  pushSubsection(lines, "常量依赖");
  pushTable(lines, ["常量名", "所属包", "值", "用途"], asArray(dependencies.constants).map((row) => {
    const parts = String(row.target || "").split(".");
    return [parts.slice(1).join(".") || row.target || "", parts[0] || "", row.value ?? "UNKNOWN", ""];
  }));
  lines.push("");

  pushSection(lines, "业务规则");
  pushSubsection(lines, "校验规则");
  pushTable(lines, ["规则 ID", "类别", "描述", "Oracle 位置", "Java 实现"], asArray(templateDepth.businessRules && templateDepth.businessRules.validations).map((row) => [
    row.id || "",
    row.category || "",
    row.description || "",
    row.location || "",
    row.javaImplementation || "",
  ]));
  pushSubsection(lines, "计算逻辑");
  pushTable(lines, ["逻辑 ID", "描述", "Oracle 表达式", "Java 实现"], asArray(templateDepth.businessRules && templateDepth.businessRules.calculations).map((row) => [
    row.id || "",
    row.description || "",
    row.oracleExpression || "",
    row.javaImplementation || "",
  ]));
  pushSubsection(lines, "状态流转");
  pushTable(lines, ["转换", "条件", "操作"], asArray(templateDepth.businessRules && templateDepth.businessRules.stateTransitions).map((row) => [
    row.transition || "",
    row.condition || "",
    row.action || "",
  ]));
  pushSubsection(lines, "边界条件");
  pushTable(lines, ["条件", "处理方式", "Oracle 行为", "Java 映射"], asArray(templateDepth.businessRules && templateDepth.businessRules.boundaries).map((row) => [
    row.condition || "",
    row.handling || "",
    row.oracleBehavior || "",
    row.javaMapping || "",
  ]));
  lines.push("");

  pushSection(lines, "控制流与异常");
  pushSubsection(lines, "流程图");
  if (controlFlow.mermaidHint) {
    lines.push("```mermaid");
    lines.push(controlFlow.mermaidHint);
    lines.push("```");
  } else {
    lines.push("本子程序控制流由下方分支、循环和异常表描述。");
  }
  if (asArray(controlFlow.nodes).length) {
    pushTable(lines, ["节点 ID", "步骤"], asArray(controlFlow.nodes).map((row) => [
      row.id || "",
      row.label || "",
    ]));
  }
  pushSubsection(lines, "分支逻辑");
  pushTable(lines, ["分支 ID", "条件", "真分支", "假分支", "Oracle 行号"], asArray(controlFlow.branches).map((row) => [
    row.id || "",
    row.condition || "",
    row.trueBranch || "",
    row.falseBranch || "",
    row.line || "",
  ]));
  pushSubsection(lines, "循环结构");
  pushTable(lines, ["循环 ID", "类型", "Oracle 构造", "Java 映射", "退出条件"], asArray(controlFlow.loops).map((row) => [
    row.id || "",
    row.type || "",
    row.oracleConstruct || "",
    row.javaMapping || "",
    row.exitCondition || "",
  ]));
  pushSubsection(lines, "异常处理");
  pushTable(lines, ["异常", "Oracle 处理", "Java 映射", "处理方式"], asArray(facts.exceptions).map((row) => [
    row.name || "",
    row.action || "",
    "Java exception / rollback",
    row.action || "",
  ]));
  lines.push("");

  pushSection(lines, "特殊语法转化规约");
  pushSubsection(lines, "转化映射");
  pushTable(lines, ["Oracle 构造", "位置", "Java/MyBatis 等价", "风险"], asArray(facts.specialSyntax).map((row) => [
    row.type || "",
    row.line || "",
    row.mapping || "需人工复核",
    row.risk || "",
  ]));
  pushSubsection(lines, "事务边界");
  lines.push(`- 显式 COMMIT: ${Boolean(transactions.hasCommit) ? "是" : "否"}`);
  lines.push(`- 显式 ROLLBACK: ${Boolean(transactions.hasRollback) ? "是" : "否"}`);
  lines.push(`- SAVEPOINT: ${Boolean(transactions.hasSavepoint) ? "是" : "否"}`);
  lines.push(`- 自治事务: ${Boolean(transactions.autonomous) ? "是" : "否"}`);
  lines.push(`- Spring 等价: ${transactions.springEquivalent || "由调用方或 @Transactional 控制事务"}`);
  pushSubsection(lines, "需手动审查的构造");
  pushTable(lines, ["构造", "位置", "原因", "建议"], asArray(facts.manualReview).map((row) => {
    const syntax = asArray(facts.specialSyntax).find((syn) => syn.id === row.sourceId) || {};
    return [syntax.type || row.sourceId || "", syntax.line || "", row.reason || "", "迁移时人工确认等价语义"];
  }));
  lines.push("");

  return `${lines.join("\n").trim()}\n`;
}

module.exports = {
  FSD_MARKDOWN_SECTIONS,
  FSD_MARKDOWN_SUBSECTIONS,
  renderFsdMarkdown,
};
