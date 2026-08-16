import assert from "node:assert/strict";
import { test } from "node:test";

import { hostDescriptor, resolveWasmTierFiles } from "./verify-installed.mjs";

test("WASM tier files are host-independent", () => {
  assert.deepEqual(resolveWasmTierFiles(), {
    entry: "wasm/zodrs_node.wasi.cjs",
    files: [
      "wasm/zodrs_node.wasi.cjs",
      "wasm/zodrs_node.wasm32-wasi.wasm",
      "wasm/wasi-worker.mjs",
    ],
  });
});

test("host descriptor covers every shipped native package", () => {
  const hosts = [
    ["linux", "x64", "gnu", "linux-x64-gnu"],
    ["linux", "arm64", "gnu", "linux-arm64-gnu"],
    ["linux", "x64", "musl", "linux-x64-musl"],
    ["linux", "arm64", "musl", "linux-arm64-musl"],
    ["darwin", "x64", undefined, "darwin-x64"],
    ["darwin", "arm64", undefined, "darwin-arm64"],
    ["win32", "x64", undefined, "win32-x64-msvc"],
    ["win32", "arm64", undefined, "win32-arm64-msvc"],
  ];

  for (const [platform, arch, libc, expected] of hosts) {
    assert.equal(hostDescriptor(platform, arch, libc), expected);
  }
});

test("host descriptor rejects unshipped hosts", () => {
  assert.throws(
    () => hostDescriptor("aix", "ppc64"),
    /unsupported host: platform="aix" arch="ppc64"/,
  );
  assert.throws(
    () => hostDescriptor("linux", "x64", "other"),
    /unsupported host: platform="linux" arch="x64"/,
  );
});
