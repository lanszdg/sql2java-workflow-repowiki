"use strict";

const FSD_FACTS_SCHEMA_VERSION = 1;

const SECTION_IDS = [
  "overview",
  "tableMappings",
  "dependencies",
  "businessRules",
  "controlFlowAndExceptions",
  "specialSyntaxMappings",
];

const REQUIRED_FACT_FIELDS = [
  "schemaVersion",
  "identity",
  "signature",
  "tableMappings",
  "dependencies",
  "controlFlow",
  "exceptions",
  "transactions",
  "specialSyntax",
  "manualReview",
  "sourceTrace",
  "coverage",
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function addError(errors, code, path, message) {
  errors.push({ code, path, message });
}

function validateFsdFacts(fact) {
  const errors = [];
  if (!isObject(fact)) {
    addError(errors, "INVALID_CONTRACT", "", "fsd-facts must be an object");
    return { ok: false, errors };
  }

  for (const field of REQUIRED_FACT_FIELDS) {
    if (!(field in fact)) {
      addError(errors, "REQUIRED_FIELD_MISSING", field, `${field} is required`);
    }
  }

  if (fact.schemaVersion !== FSD_FACTS_SCHEMA_VERSION) {
    addError(errors, "SCHEMA_VERSION_INVALID", "schemaVersion", `schemaVersion must be ${FSD_FACTS_SCHEMA_VERSION}`);
  }

  if (!isObject(fact.identity)) {
    addError(errors, "REQUIRED_FIELD_MISSING", "identity", "identity is required");
  } else {
    if (!fact.identity.id) addError(errors, "REQUIRED_FIELD_MISSING", "identity.id", "identity.id is required");
    if (!fact.identity.outputPath) addError(errors, "REQUIRED_FIELD_MISSING", "identity.outputPath", "identity.outputPath is required");
    if (fact.identity.outputPath && !/^fsd\/.+\.md$/.test(String(fact.identity.outputPath))) {
      addError(errors, "OUTPUT_PATH_INVALID", "identity.outputPath", "outputPath must be an fsd/*.md path");
    }
  }

  if (!hasItems(fact.sourceTrace)) {
    addError(errors, "SOURCE_TRACE_REQUIRED", "sourceTrace", "sourceTrace must contain at least one trace item");
  }

  const reviewSourceIds = new Set((Array.isArray(fact.manualReview) ? fact.manualReview : [])
    .map((row) => row && row.sourceId)
    .filter(Boolean));
  for (const item of Array.isArray(fact.specialSyntax) ? fact.specialSyntax : []) {
    const risk = String(item && item.risk || "").toLowerCase();
    if ((risk === "high" || risk === "medium") && !reviewSourceIds.has(item.id)) {
      addError(errors, "MANUAL_REVIEW_REQUIRED", "manualReview", `specialSyntax ${item.id || "<missing id>"} requires manualReview`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateFsdFactsBatch(facts) {
  const errors = [];
  if (!Array.isArray(facts)) {
    return {
      ok: false,
      errors: [{ code: "INVALID_BATCH", path: "", message: "facts must be an array" }],
    };
  }

  const ids = new Map();
  const outputPaths = new Map();
  facts.forEach((fact, index) => {
    const result = validateFsdFacts(fact);
    for (const err of result.errors) {
      errors.push({ ...err, path: `[${index}].${err.path}` });
    }
    const id = fact && fact.identity && fact.identity.id;
    const outputPath = fact && fact.identity && fact.identity.outputPath;
    if (id) {
      if (ids.has(id)) addError(errors, "IDENTITY_DUPLICATE", "identity.id", `duplicate identity ${id}`);
      ids.set(id, index);
    }
    if (outputPath) {
      if (outputPaths.has(outputPath)) addError(errors, "OUTPUT_PATH_COLLISION", "identity.outputPath", `duplicate outputPath ${outputPath}`);
      outputPaths.set(outputPath, index);
    }
  });

  return { ok: errors.length === 0, errors };
}

module.exports = {
  FSD_FACTS_SCHEMA_VERSION,
  SECTION_IDS,
  REQUIRED_FACT_FIELDS,
  validateFsdFacts,
  validateFsdFactsBatch,
};

