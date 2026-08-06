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

export { ZodError, $ZodRealError, defaultError, finalizeIssue } from "../core/errors.js";
export type {
  $ZodError,
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
