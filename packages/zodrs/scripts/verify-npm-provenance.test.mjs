import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import {
  ProvenanceMismatch,
  expectedAttestationUrl,
  matchProvenanceStatement,
} from "./verify-npm-provenance.mjs";

// ---------------------------------------------------------------------------
// Fixture source note
//
// The attestation envelope below is shaped from a real npm provenance payload
// captured for `zod-rs@0.1.2` via the npm attestations endpoint
// (https://registry.npmjs.org/-/npm/v1/attestations/zod-rs@0.1.2).
//
// The in-toto SLSA v1 statement fields — workflow.path, workflow.repository,
// workflow.ref, builder.id, resolvedDependencies, subject — mirror the exact
// shape npm emits on a tagged GitHub Actions publication. In particular
// workflow.path is slashless (`.github/workflows/publish.yml`) because npm's
// libnpmpublish strips `${GITHUB_REPOSITORY}/` from GITHUB_WORKFLOW_REF before
// recording it.
//
// The digest / SHA / integrity values are deterministic placeholders (not the
// real published bytes) so the suite stays hermetic, but the *structure* is
// faithful: if the verifier's WORKFLOW constant regains a leading slash, or
// any other constant drifts from npm's emitted shape, the happy-path test
// fails because the fixture no longer matches.
// ---------------------------------------------------------------------------

const FIXTURE_PACKAGE = "zod-rs";
const FIXTURE_VERSION = "0.1.2";
const FIXTURE_GIT_SHA = "a".repeat(40);
const FIXTURE_GIT_REF = "refs/tags/v0.1.2";
const FIXTURE_DIGEST_BYTES = Buffer.alloc(64, 7);
const FIXTURE_INTEGRITY = `sha512-${FIXTURE_DIGEST_BYTES.toString("base64")}`;
const FIXTURE_DIGEST_HEX = FIXTURE_DIGEST_BYTES.toString("hex");

// The captured statement shape — every literal here is independently sourced
// from the npm attestation envelope, NOT copied from the verifier's constants.
const CAPTURED_STATEMENT = {
  _type: "https://in-toto.io/Statement/v1",
  subject: [
    {
      name: `pkg:npm/${FIXTURE_PACKAGE}@${FIXTURE_VERSION}`,
      digest: { sha512: FIXTURE_DIGEST_HEX },
    },
  ],
  predicateType: "https://slsa.dev/provenance/v1",
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: {
          repository: "https://github.com/metaphorics/zodrs",
          path: ".github/workflows/publish.yml",
          ref: FIXTURE_GIT_REF,
        },
      },
      resolvedDependencies: [
        {
          uri: `git+https://github.com/metaphorics/zodrs@${FIXTURE_GIT_REF}`,
          digest: { gitCommit: FIXTURE_GIT_SHA },
        },
      ],
    },
    runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
  },
};

function attestation(mutate = () => {}) {
  const statement = structuredClone(CAPTURED_STATEMENT);
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

const expected = {
  packageName: FIXTURE_PACKAGE,
  version: FIXTURE_VERSION,
  gitSha: FIXTURE_GIT_SHA,
  gitRef: FIXTURE_GIT_REF,
  integrity: FIXTURE_INTEGRITY,
};

test("expectedAttestationUrl permits only an exact unscoped package and stable version", () => {
  assert.equal(
    expectedAttestationUrl("zod-rs", "0.1.2"),
    "https://registry.npmjs.org/-/npm/v1/attestations/zod-rs@0.1.2",
  );
  assert.throws(() => expectedAttestationUrl("../zod-rs", "0.1.2"), ProvenanceMismatch);
  assert.throws(() => expectedAttestationUrl("zod-rs", "next"), ProvenanceMismatch);
});

test("matchProvenanceStatement accepts a statement matching the captured npm envelope shape", () => {
  assert.doesNotThrow(() => matchProvenanceStatement(attestation(), expected));
});

test("matchProvenanceStatement rejects a workflow path with a leading slash", () => {
  const document = attestation((statement) => {
    statement.predicate.buildDefinition.externalParameters.workflow.path = "/.github/workflows/publish.yml";
  });
  assert.throws(() => matchProvenanceStatement(document, expected), ProvenanceMismatch);
});

test("matchProvenanceStatement rejects a different source commit", () => {
  const document = attestation((statement) => {
    statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40);
  });
  assert.throws(() => matchProvenanceStatement(document, expected), ProvenanceMismatch);
});

test("matchProvenanceStatement rejects a different workflow path or ref", () => {
  const document = attestation((statement) => {
    statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml";
  });
  assert.throws(() => matchProvenanceStatement(document, expected), ProvenanceMismatch);
});

test("matchProvenanceStatement rejects a different workflow ref", () => {
  const document = attestation((statement) => {
    statement.predicate.buildDefinition.externalParameters.workflow.ref = "refs/tags/v9.9.9";
  });
  assert.throws(() => matchProvenanceStatement(document, expected), ProvenanceMismatch);
});

test("matchProvenanceStatement rejects a different package digest", () => {
  const document = attestation((statement) => {
    statement.subject[0].digest.sha512 = Buffer.alloc(64, 8).toString("hex");
  });
  assert.throws(() => matchProvenanceStatement(document, expected), ProvenanceMismatch);
});
