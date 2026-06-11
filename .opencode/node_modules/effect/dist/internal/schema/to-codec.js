import { memoize } from "../../Function.js";
import * as Predicate from "../../Predicate.js";
import * as AST from "../../SchemaAST.js";
import * as InternalSchema from "./schema.js";
/** @internal */
export const toCodecJson = /*#__PURE__*/AST.toCodec(ast => {
  const out = toCodecJsonBase(ast);
  if (out !== ast && AST.isOptional(ast)) {
    return AST.optionalKeyLastLink(out);
  }
  return out;
});
function toCodecJsonBase(ast) {
  switch (ast._tag) {
    case "Declaration":
      {
        const getLink = ast.annotations?.toCodecJson ?? ast.annotations?.toCodec;
        if (Predicate.isFunction(getLink)) {
          const tps = AST.isDeclaration(ast) ? ast.typeParameters.map(tp => InternalSchema.make(AST.toEncoded(tp))) : [];
          const link = getLink(tps);
          const to = toCodecJson(link.to);
          return AST.replaceEncoding(ast, to === link.to ? [link] : [new AST.Link(to, link.transformation)]);
        }
        return AST.replaceEncoding(ast, [AST.unknownToNull]);
      }
    case "Unknown":
    case "ObjectKeyword":
      return AST.replaceEncoding(ast, [AST.unknownToJson]);
    case "Undefined":
    case "Void":
    case "Literal":
    case "Number":
      return ast.toCodecJson();
    case "UniqueSymbol":
    case "Symbol":
    case "BigInt":
      return ast.toCodecStringTree();
    case "Objects":
      {
        if (ast.propertySignatures.some(ps => typeof ps.name !== "string")) {
          throw new globalThis.Error("Objects property names must be strings", {
            cause: ast
          });
        }
        return ast.recur(toCodecJson);
      }
    case "Union":
      {
        const sortedTypes = jsonReorder(ast.types);
        if (sortedTypes !== ast.types) {
          return new AST.Union(sortedTypes, ast.mode, ast.annotations, ast.checks, ast.encoding, ast.context).recur(toCodecJson);
        }
        return ast.recur(toCodecJson);
      }
    case "Arrays":
    case "Suspend":
      return ast.recur(toCodecJson);
  }
  // `Schema.Any` is used as an escape hatch
  return ast;
}
/** @internal */
export const jsonReorder = /*#__PURE__*/makeReorder(getJsonPriority);
function getJsonPriority(ast) {
  switch (ast._tag) {
    case "BigInt":
    case "Symbol":
    case "UniqueSymbol":
      return 0;
    default:
      return 1;
  }
}
/** @internal */
export function makeReorder(getPriority) {
  return types => {
    // Create a map of original indices for O(1) lookup
    const indexMap = new Map();
    for (let i = 0; i < types.length; i++) {
      indexMap.set(AST.toEncoded(types[i]), i);
    }
    // Create a sorted copy of the types array
    const sortedTypes = [...types].sort((a, b) => {
      a = AST.toEncoded(a);
      b = AST.toEncoded(b);
      const pa = getPriority(a);
      const pb = getPriority(b);
      if (pa !== pb) return pa - pb;
      // If priorities are equal, maintain original order (stable sort)
      return indexMap.get(a) - indexMap.get(b);
    });
    // Check if order changed by comparing arrays
    const orderChanged = sortedTypes.some((ast, index) => ast !== types[index]);
    if (!orderChanged) return types;
    return sortedTypes;
  };
}
/** @internal */
export const toCodecIso = /*#__PURE__*/memoize(ast => {
  const out = toCodecIsoBase(ast);
  if (out !== ast && AST.isOptional(ast)) {
    return AST.optionalKeyLastLink(out);
  }
  return out;
});
function toCodecIsoBase(ast) {
  switch (ast._tag) {
    case "Declaration":
      {
        const getLink = ast.annotations?.toCodecIso ?? ast.annotations?.toCodec;
        if (Predicate.isFunction(getLink)) {
          const link = getLink(ast.typeParameters.map(tp => InternalSchema.make(tp)));
          const to = toCodecIso(link.to);
          return AST.replaceEncoding(ast, to === link.to ? [link] : [new AST.Link(to, link.transformation)]);
        }
        return ast;
      }
    case "Arrays":
    case "Objects":
    case "Union":
    case "Suspend":
      return ast.recur(toCodecIso);
  }
  return ast;
}
//# sourceMappingURL=to-codec.js.map