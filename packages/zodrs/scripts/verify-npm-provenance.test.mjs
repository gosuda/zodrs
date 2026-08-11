import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import {
  ProvenanceMismatch,
  expectedAttestationUrl,
  verifyProvenance,
} from "./verify-npm-provenance.mjs";

const expected = {
  packageName: "zod-rs",
  version: "0.1.2",
  gitSha: "a".repeat(40),
  gitRef: "refs/tags/v0.1.2",
  integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
};

function attestation(mutate = () => {}) {
  const statement = {
    subject: [
      {
        name: "pkg:npm/zod-rs@0.1.2",
        digest: { sha512: Buffer.alloc(64, 7).toString("hex") },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/metaphorics/zodrs",
            path: "/.github/workflows/publish.yml",
            ref: "refs/tags/v0.1.2",
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/metaphorics/zodrs@refs/tags/v0.1.2",
            digest: { gitCommit: "a".repeat(40) },
          },
        ],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  mutate(statement);
  return {
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } },
      },
    ],
  };
}

test("expectedAttestationUrl permits only an exact unscoped package and stable version", () => {
  assert.equal(
    expectedAttestationUrl("zod-rs", "0.1.2"),
    "https://registry.npmjs.org/-/npm/v1/attestations/zod-rs@0.1.2",
  );
  assert.throws(() => expectedAttestationUrl("../zod-rs", "0.1.2"), ProvenanceMismatch);
  assert.throws(() => expectedAttestationUrl("zod-rs", "next"), ProvenanceMismatch);
});

test("verifyProvenance accepts the tagged GitHub workflow and package digest", () => {
  assert.doesNotThrow(() => verifyProvenance(attestation(), expected));
});

test("verifyProvenance rejects a different source commit", () => {
  const document = attestation((statement) => {
    statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40);
  });
  assert.throws(() => verifyProvenance(document, expected), ProvenanceMismatch);
});

test("verifyProvenance rejects a different workflow or ref", () => {
  const document = attestation((statement) => {
    statement.predicate.buildDefinition.externalParameters.workflow.path = "/.github/workflows/other.yml";
  });
  assert.throws(() => verifyProvenance(document, expected), ProvenanceMismatch);
});

test("verifyProvenance rejects a different package digest", () => {
  const document = attestation((statement) => {
    statement.subject[0].digest.sha512 = Buffer.alloc(64, 8).toString("hex");
  });
  assert.throws(() => verifyProvenance(document, expected), ProvenanceMismatch);
});
