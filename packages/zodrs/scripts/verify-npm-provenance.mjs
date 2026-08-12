import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

const REPOSITORY = "https://github.com/metaphorics/zodrs";
const WORKFLOW = ".github/workflows/publish.yml";
const BUILDER = "https://github.com/actions/runner/github-hosted";
const PROVENANCE_TYPE = "https://slsa.dev/provenance/v1";

export class ProvenanceMismatch extends Error {}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new ProvenanceMismatch(`${label} is missing`);
  return value;
}

export function expectedAttestationUrl(packageName, version) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(packageName) || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new ProvenanceMismatch("package name or version is invalid");
  }
  return `https://registry.npmjs.org/-/npm/v1/attestations/${packageName}@${version}`;
}

// Matches the decoded in-toto SLSA provenance *statement* against the expected
// release identity. This does NOT verify the DSSE envelope signature, the Fulcio
// certificate, or the Rekor log entry — those are authenticated separately by
// `npm audit signatures` in the verify-public job. The statement itself is
// falsifiable (npm generates it from build env vars), so callers must rely on
// the signature audit, not this function, for cryptographic authenticity.
export function matchProvenanceStatement(document, expected) {
  const attestations = document?.attestations;
  if (!Array.isArray(attestations)) throw new ProvenanceMismatch("attestations is missing");
  const attestation = attestations.find((candidate) => candidate?.predicateType === PROVENANCE_TYPE);
  const payload = requireString(attestation?.bundle?.dsseEnvelope?.payload, "SLSA payload");

  let statement;
  try {
    statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch (error) {
    throw new ProvenanceMismatch(`SLSA payload is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow;
  const dependencies = statement?.predicate?.buildDefinition?.resolvedDependencies;
  const subject = statement?.subject?.[0];
  const builder = statement?.predicate?.runDetails?.builder?.id;
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(expected.integrity)) {
    throw new ProvenanceMismatch("package integrity is invalid");
  }
  const expectedDigest = Buffer.from(expected.integrity.slice("sha512-".length), "base64").toString("hex");
  const dependency = Array.isArray(dependencies)
    ? dependencies.find((candidate) => candidate?.digest?.gitCommit === expected.gitSha)
    : undefined;

  if (statement?.predicateType !== PROVENANCE_TYPE) throw new ProvenanceMismatch("predicate type does not match");
  if (workflow?.repository !== REPOSITORY || workflow?.path !== WORKFLOW || workflow?.ref !== expected.gitRef) {
    throw new ProvenanceMismatch("workflow identity does not match");
  }
  if (builder !== BUILDER) throw new ProvenanceMismatch("builder is not GitHub-hosted");
  if (dependency?.uri !== `git+${REPOSITORY}@${expected.gitRef}`) {
    throw new ProvenanceMismatch("source dependency does not match the release ref");
  }
  if (subject?.name !== `pkg:npm/${expected.packageName}@${expected.version}` || subject?.digest?.sha512 !== expectedDigest) {
    throw new ProvenanceMismatch("package subject or digest does not match");
  }
}

async function main() {
  const [url, packageName, version, gitSha, gitRef, integrity] = process.argv.slice(2);
  if ([url, packageName, version, gitSha, gitRef, integrity].some((value) => value === undefined)) {
    process.stderr.write(
      "usage: verify-npm-provenance <url> <package> <version> <git-sha> <git-ref> <sha512-integrity>\n",
    );
    process.exitCode = 2;
    return;
  }
  if (url !== expectedAttestationUrl(packageName, version)) throw new ProvenanceMismatch("attestation URL is not allowed");
  if (!/^[0-9a-f]{40}$/.test(gitSha) || gitRef !== `refs/tags/v${version}` || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new ProvenanceMismatch("release identity is invalid");
  }

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    process.stderr.write(`npm attestation lookup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 70;
    return;
  }
  if (response.status === 404) {
    process.exitCode = 4;
    return;
  }
  if (!response.ok || response.url !== url) {
    process.stderr.write(`npm attestation lookup returned HTTP ${response.status}\n`);
    process.exitCode = 70;
    return;
  }

  const text = await response.text();
  if (text.length > 5_000_000) throw new ProvenanceMismatch("attestation response is too large");
  matchProvenanceStatement(JSON.parse(text), { packageName, version, gitSha, gitRef, integrity });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof ProvenanceMismatch ? 65 : 70;
  });
}
