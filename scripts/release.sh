#!/usr/bin/env bash
# Tag the current commit and push the tag. Pushing a `v*` tag is the only
# supported upload path: `.github/workflows/publish.yml` re-verifies the tag
# SHA, packs, installs and checks both release artifacts, then publishes to
# crates.io over OIDC and to npm with provenance.
#
# Every check here mirrors one the workflow makes after the tag exists. A tag
# is effectively single-use for a release, so failing locally is free and
# failing in CI is not.
set -euo pipefail

die() {
	printf 'release: %s\n' "$1" >&2
	exit 1
}

branch=$(git branch --show-current)
[ "$branch" = "main" ] || die "releases run from main, not '$branch'"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean"

git fetch --quiet origin main
head=$(git rev-parse HEAD)
remote=$(git rev-parse origin/main)
[ "$head" = "$remote" ] ||
	die "HEAD ($head) and origin/main ($remote) differ; push or pull first"

# publish.yml pins the tag against all of these.
version=$(node -p "require('./packages/zodrs/package.json').version")
for pair in \
	"packages/zodrs/native/package.json:native addon" \
	"packages/zodrs/wasm/package.json:wasm addon" \
	"crates/zodrs-node/package.json:node binding" \
	"crates/zodrs-node/smoke/package.json:node smoke"; do
	manifest=${pair%%:*}
	found=$(node -p "require('./$manifest').version")
	[ "$found" = "$version" ] || die "${pair#*:} is $found, expected $version"
done
workspace=$(python3 -c 'import tomllib; print(tomllib.load(open("Cargo.toml","rb"))["workspace"]["package"]["version"])')
[ "$workspace" = "$version" ] || die "Cargo workspace is $workspace, expected $version"
crate=$(cargo metadata --format-version 1 --no-deps |
	jq -r '.packages[] | select(.name == "zodrs") | .version')
[ "$crate" = "$version" ] || die "zodrs crate is $crate, expected $version"
# Fixed list — kept independent of publish.yml matrices so a narrowed
# producer build cannot silently narrow the release contract.
platform_dirs="
	linux-x64-gnu
	linux-arm64-gnu
	linux-x64-musl
	linux-arm64-musl
	darwin-x64
	darwin-arm64
	win32-x64-msvc
	win32-arm64-msvc
"
for dir in $platform_dirs; do
	manifest="packages/zodrs/npm/$dir/package.json"
	[ -f "$manifest" ] || die "platform manifest $manifest is missing"
	expected_name="zod-rs-node-$dir"
	name=$(node -p "require('./$manifest').name")
	[ "$name" = "$expected_name" ] ||
		die "platform package $dir is named '$name', expected '$expected_name'"
	found=$(node -p "require('./$manifest').version")
	[ "$found" = "$version" ] ||
		die "platform package $dir is $found, expected $version"
	npm view "$expected_name" name --json --registry=https://registry.npmjs.org/ >/dev/null 2>&1 ||
		die "$expected_name is not bootstrapped on npm; publish an initial version and configure trusted publishing before tagging"
done

VERSION="$version" node -e '
  const fs = require("fs");
  const main = JSON.parse(fs.readFileSync("packages/zodrs/package.json", "utf8"));
  const version = process.env.VERSION;
  const expected = [
    "zod-rs-node-linux-x64-gnu",
    "zod-rs-node-linux-arm64-gnu",
    "zod-rs-node-linux-x64-musl",
    "zod-rs-node-linux-arm64-musl",
    "zod-rs-node-darwin-x64",
    "zod-rs-node-darwin-arm64",
    "zod-rs-node-win32-x64-msvc",
    "zod-rs-node-win32-arm64-msvc",
  ];
  const opt = main.optionalDependencies || {};
  const expectedSet = new Set(expected);
  const actual = Object.keys(opt);
  const missing = expected.filter(k => !(k in opt));
  const extra = actual.filter(k => !expectedSet.has(k));
  const mismatched = expected.filter(k => k in opt && opt[k] !== version);
  const problems = [];
  if (missing.length) problems.push("missing: " + missing.join(", "));
  if (extra.length) problems.push("extra: " + extra.join(", "));
  if (mismatched.length) problems.push("wrong pin: " + mismatched.map(k => k + "=" + opt[k]).join(", "));
  if (problems.length) {
    console.error("release: optionalDependencies " + problems.join("; "));
    process.exit(1);
  }
'

tag="v$version"
if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
	die "$tag already exists locally"
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
	die "$tag already exists on origin"
fi

git tag -a "$tag" -m "$tag"
git push origin "$tag"
printf 'release: pushed %s at %s; publish.yml now verifies and uploads\n' "$tag" "$head"
