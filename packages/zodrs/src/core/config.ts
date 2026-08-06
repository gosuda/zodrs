import type { $ZodErrorMap } from "./errors.js";

export interface $ZodConfig {
  /** Custom error map. Overrides `config().localeError`. */
  customError?: $ZodErrorMap | undefined;
  /** Localized error map. Lowest priority. */
  localeError?: $ZodErrorMap | undefined;
  /** Disable JIT (`new Function`) compilation. */
  jitless?: boolean | undefined;
}

declare global {
  // eslint-disable-next-line vars-on-top, no-var
  var __zodrs_globalConfig: $ZodConfig | undefined;
}

export const globalConfig: $ZodConfig = (globalThis.__zodrs_globalConfig ??= {});

export function config(newConfig?: Partial<$ZodConfig>): $ZodConfig {
  if (newConfig) Object.assign(globalConfig, newConfig);
  return globalConfig;
}
