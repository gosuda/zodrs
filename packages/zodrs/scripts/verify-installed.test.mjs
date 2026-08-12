import assert from "node:assert/strict";
import { test } from "node:test";

// Regression contract for PR #17: the native triple must be resolved only
// after tier selection and only for the native tier. The WASM file set is
// static and host-independent, so `verify-installed <dir> wasm` must work on
// hosts that ship no native artifact. Spoofing process.platform/arch BEFORE
// the dynamic import proves the module performs no eager host probing.

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");

function spoofHost(platform, arch) {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  Object.defineProperty(process, "arch", { ...archDescriptor, value: arch });
}

function restoreHost() {
  Object.defineProperty(process, "platform", platformDescriptor);
  Object.defineProperty(process, "arch", archDescriptor);
}

const modulePromise = (async () => {
  spoofHost("darwin", "arm64");
  try {
    return await import("./verify-installed.mjs");
  } finally {
    restoreHost();
  }
})();

test("importing the verifier never probes the native triple", async () => {
  const { resolveTierFiles } = await modulePromise;
  assert.equal(typeof resolveTierFiles, "function");
});

test("WASM tier files are static and host-independent", async () => {
  const { resolveTierFiles } = await modulePromise;
  spoofHost("darwin", "arm64");
  try {
    assert.deepEqual(resolveTierFiles("wasm"), {
      entry: "wasm/zodrs_node.wasi.cjs",
      files: ["wasm/zodrs_node.wasi.cjs", "wasm/zodrs_node.wasm32-wasi.wasm"],
    });
  } finally {
    restoreHost();
  }
});

test("native tier selects the same entry on a supported host", async () => {
  const { resolveTierFiles } = await modulePromise;
  spoofHost("linux", "x64");
  try {
    assert.deepEqual(resolveTierFiles("native"), {
      entry: "native/zodrs_node.linux-x64-gnu.node",
      files: ["native/zodrs_node.linux-x64-gnu.node"],
    });
  } finally {
    restoreHost();
  }
});

test("native tier fails closed on an unsupported host", async () => {
  const { resolveTierFiles } = await modulePromise;
  spoofHost("win32", "arm64");
  try {
    assert.throws(
      () => resolveTierFiles("native"),
      /unsupported host: platform="win32" arch="arm64"; no native artifact is shipped for this pair/,
    );
  } finally {
    restoreHost();
  }
});
