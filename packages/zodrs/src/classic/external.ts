/** zodrs classic surface: the drop-in `z` API. */
export * from "./schemas.js";
export {
  null_ as null,
  undefined_ as undefined,
  void_ as void,
  enum_ as enum,
  function_ as function,
  instanceOf as instanceof,
} from "./schemas.js";

export { ZodError, $ZodError, $ZodRealError, ZodRealError, defaultError, finalizeIssue } from "../core/errors.js";
export type {
  $ZodErrorMap,
  $ZodIssue,
  $ZodIssueBase,
  $ZodIssueCode,
  $ZodRawIssue,
  $ZodStringFormatIssues,
  $ZodStringFormats,
  ParseContext,
} from "../core/errors.js";

export { config, globalConfig } from "../core/config.js";
export type { $ZodConfig } from "../core/config.js";

export { flattenError, formatError, treeifyError, prettifyError, toDotPath } from "../core/error-utils.js";
export type { $ZodFlattenedError, $ZodFormattedError, $ZodErrorTree } from "../core/error-utils.js";

export { $output, $input, registry, globalRegistry, $ZodRegistry } from "../core/registries.js";
export type { $replace, GlobalMeta, JSONSchemaMeta } from "../core/registries.js";

export { createStandardProps } from "../core/standard-schema.js";
export type {
  StandardSchemaV1,
  StandardTypedV1,
  StandardJSONSchemaV1,
  StandardSchemaWithJSON,
  StandardSchemaWithJSONProps,
} from "../core/standard-schema.js";

export type { output as TypeOf, output as Infer } from "./schemas.js";
export * as core from "../core/index.js";
export * as util from "../core/util.js";
export * as locales from "../locales/index.js";

export { toJSONSchema } from "../core/json-schema.js";
export type {
  ToJSONSchemaParams,
  RegistryToJSONSchemaParams,
  ToJSONSchemaSource,
  ToJSONSchemaOverrideContext,
} from "../core/json-schema.js";
export { fromJSONSchema } from "./from-json-schema.js";
export type { FromJSONSchemaParams } from "./from-json-schema.js";

// The classic surface registers English as the default locale, matching Zod v4's
// `classic/external.ts`. The core chain has no built-in locale; this is what makes
// unconfigured classic parses produce verbose English messages.
import { config } from "../core/config.js";
import en from "../locales/en.js";
config(en());
