/**
 * @since 4.0.0
 */
import * as Context from "../../Context.js";
import * as Effect from "../../Effect.js";
import { hasProperty } from "../../Predicate.js";
import { redact } from "../../Redactable.js";
import * as Schema from "../../Schema.js";
import * as UrlParams from "./UrlParams.js";
/**
 * @since 4.0.0
 * @category Type IDs
 */
export const TypeId = "~effect/http/HttpIncomingMessage";
/**
 * @since 4.0.0
 * @category Guards
 */
export const isHttpIncomingMessage = u => hasProperty(u, TypeId);
/**
 * @since 4.0.0
 * @category schema
 */
export const schemaBodyJson = (schema, options) => {
  const decode = Schema.decodeEffect(Schema.toCodecJson(schema).annotate({
    options
  }));
  return self => Effect.flatMap(self.json, decode);
};
/**
 * @since 4.0.0
 * @category schema
 */
export const schemaBodyUrlParams = (schema, options) => {
  const decode = UrlParams.schemaRecord.pipe(Schema.decodeTo(schema), Schema.annotate({
    options
  }), Schema.decodeEffect);
  return self => Effect.flatMap(self.urlParamsBody, decode);
};
/**
 * @since 4.0.0
 * @category schema
 */
export const schemaHeaders = (schema, options) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return self => decode(self.headers, options);
};
/**
 * @since 4.0.0
 * @category References
 */
export const MaxBodySize = /*#__PURE__*/Context.Reference("effect/http/HttpIncomingMessage/MaxBodySize", {
  defaultValue: () => undefined
});
/**
 * @since 4.0.0
 */
export const inspect = (self, that) => {
  const contentType = self.headers["content-type"] ?? "";
  let body;
  if (contentType.includes("application/json")) {
    try {
      body = Effect.runSync(self.json);
      // oxlint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_) {
      //
    }
  } else if (contentType.includes("text/") || contentType.includes("urlencoded")) {
    try {
      body = Effect.runSync(self.text);
      // oxlint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_) {
      //
    }
  }
  const obj = {
    ...that,
    headers: redact(self.headers),
    remoteAddress: self.remoteAddress
  };
  if (body !== undefined) {
    obj.body = body;
  }
  return obj;
};
//# sourceMappingURL=HttpIncomingMessage.js.map