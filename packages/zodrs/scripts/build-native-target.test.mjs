import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./build-native-target.mjs", import.meta.url));

function run(args, envOverrides = {}) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env,
    encoding: "utf8",
    timeout: 5_000,
  });
}

test("--cross-compile alone reaches the missing-target diagnostic (exit 1)", () => {
  const r = run(["--cross-compile"], { NAPI_TARGET: undefined, NAPI_CROSS_COMPILE: undefined });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /set NAPI_TARGET=<rust-triple> or pass one as an argument/);
});

test("unknown flag is rejected with exit 2 before spawn", () => {
  const r = run(["--bogus"], { NAPI_TARGET: undefined, NAPI_CROSS_COMPILE: undefined });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag: --bogus/);
});

test("extra positional target is rejected with exit 2 before spawn", () => {
  const r = run(["aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"], {
    NAPI_TARGET: undefined,
    NAPI_CROSS_COMPILE: undefined,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unexpected extra argument: x86_64-unknown-linux-gnu/);
});

test("NAPI_TARGET conflicting with positional target is rejected with exit 2", () => {
  const r = run(["x86_64-unknown-linux-gnu"], {
    NAPI_TARGET: "aarch64-unknown-linux-gnu",
    NAPI_CROSS_COMPILE: undefined,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /conflicts with positional/);
});

test("no arguments and no NAPI_TARGET reaches the missing-target diagnostic (exit 1)", () => {
  const r = run([], { NAPI_TARGET: undefined, NAPI_CROSS_COMPILE: undefined });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /set NAPI_TARGET=<rust-triple> or pass one as an argument/);
});

test("invalid NAPI_CROSS_COMPILE value is still rejected with exit 2", () => {
  const r = run(["x86_64-unknown-linux-gnu"], {
    NAPI_TARGET: undefined,
    NAPI_CROSS_COMPILE: "yes",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /NAPI_CROSS_COMPILE must be one of/);
});
