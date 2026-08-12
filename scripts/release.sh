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

# publish.yml pins the tag against all seven of these.
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
