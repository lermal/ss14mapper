#!/usr/bin/env bash
# Builds the asset pack of one SS14 fork: sparse checkout of what build-pack reads, then build-pack, then a tarball.
#
#   tools/ci/build-fork.sh <repo url> <branch> <commit sha> <fork id> <work dir>
#
# Layout of <work dir>: checkout/ (the fork), pack/ (build-pack output), pack.tar.gz (files at the archive root),
# failure.txt (the reason, only when the build failed), build-pack.log.
# On failure prints one line `FAILED: <reason>` to stderr and exits non-zero.
#
# Nothing from the fork is executed: no hooks, no LFS smudge, no symlinks (they are written as plain files),
# only the RobustToolbox submodule is fetched. Limits (env): MAX_CHECKOUT_MB (2048), MAX_PACK_MB (200).
# Other env: ALLOW_ANY_REMOTE=1 allows repository URLs other than https://github.com/owner/name (local tests).
set -euo pipefail

MAX_CHECKOUT_MB="${MAX_CHECKOUT_MB:-2048}"
MAX_PACK_MB="${MAX_PACK_MB:-200}"

if [ "$#" -ne 5 ]; then
    echo "FAILED: usage: build-fork.sh <repo url> <branch> <commit sha> <fork id> <work dir>" >&2
    exit 2
fi
REPO="$1" BRANCH="$2" COMMIT="$3" FORK_ID="$4" WORK="$5"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
CHECKOUT="$WORK/checkout" PACK="$WORK/pack" TARBALL="$WORK/pack.tar.gz"
rm -rf "$CHECKOUT" "$PACK" "$TARBALL" "$WORK/failure.txt" "$WORK/build-pack.log"

fail() {
    echo "FAILED: $*" >&2
    printf '%s\n' "$*" > "$WORK/failure.txt"
    exit 1
}
trap 'LAST_LINE=$LINENO' ERR
trap 'rc=$?; if [ "$rc" -ne 0 ] && [ ! -e "$WORK/failure.txt" ]; then echo "FAILED: unexpected error (script line ${LAST_LINE:-?})" >&2; echo "unexpected error" > "$WORK/failure.txt"; fi; exit "$rc"' EXIT

# ---- inputs
if [ "${ALLOW_ANY_REMOTE:-}" != 1 ]; then
    [[ "$REPO" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "invalid repository URL"
fi
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ && "$BRANCH" != -* && "$BRANCH" != *..* ]] || fail "invalid branch name"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "invalid commit sha"
[[ "$FORK_ID" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || fail "invalid fork id"

# Nothing of the fork runs: hooks off, symlinks written as plain files, no prompts, no LFS.
export GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1 GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_COUNT=3
export GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null
export GIT_CONFIG_KEY_1=core.symlinks GIT_CONFIG_VALUE_1=false
export GIT_CONFIG_KEY_2=submodule.recurse GIT_CONFIG_VALUE_2=false

size_mb() { du -sm --exclude=.git "$1" | cut -f1; }

# ---- the fork: tree only, then the files build-pack reads
git clone -q --depth 1 --filter=blob:none --no-checkout --branch "$BRANCH" -- "$REPO" "$CHECKOUT" 2> "$WORK/git.log" \
    || fail "cannot clone $REPO at branch $BRANCH: $(tail -n 1 "$WORK/git.log")"
g() { git -C "$CHECKOUT" "$@"; }

if [ "$(g rev-parse HEAD)" != "$COMMIT" ]; then
    g fetch -q --depth 1 origin "$COMMIT" 2> "$WORK/git.log" \
        || fail "branch $BRANCH is no longer at $COMMIT and the commit cannot be fetched"
    [ "$(g rev-parse FETCH_HEAD)" = "$COMMIT" ] || fail "fetched commit differs from $COMMIT"
    g update-ref --no-deref HEAD "$COMMIT"
fi

g ls-tree -d --name-only HEAD Resources/Prototypes | grep -qx 'Resources/Prototypes' \
    || fail "not an SS14 checkout: no Resources/Prototypes"
SUB="$(g ls-tree HEAD RobustToolbox | awk '$1 == "160000" && $2 == "commit" { print $3 }')"
[[ "$SUB" =~ ^[0-9a-f]{40}$ ]] || fail "no RobustToolbox submodule"
MODULES="$(g cat-file blob HEAD:.gitmodules 2>/dev/null || true)"
SUB_KEY="$(printf '%s\n' "$MODULES" | git config --file /dev/stdin --get-regexp '^submodule\..*\.path$' | awk '$2 == "RobustToolbox" { print $1; exit }' || true)"
SUB_URL=""
[ -n "$SUB_KEY" ] && SUB_URL="$(printf '%s\n' "$MODULES" | git config --file /dev/stdin --get "${SUB_KEY%.path}.url" || true)"
[ -n "$SUB_URL" ] || fail "no URL of the RobustToolbox submodule in .gitmodules"
if [ "${ALLOW_ANY_REMOTE:-}" != 1 ]; then
    [[ "$SUB_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "the RobustToolbox submodule is not on github.com"
fi

# non-cone patterns: Resources/{Prototypes,Textures,Locale/en-US}, root Resources/*migration*.yml, Content.* C# sources
g sparse-checkout init --no-cone
g sparse-checkout set --no-cone --stdin <<'PATTERNS'
/Resources/Prototypes/
/Resources/Textures/
/Resources/Locale/en-US/
/Resources/*migration*.yml
/Content.*/**/*.cs
PATTERNS
g checkout -q --detach "$COMMIT" 2> "$WORK/git.log" || fail "cannot check out the fork: $(tail -n 1 "$WORK/git.log")"
rm -rf "$CHECKOUT/.git/hooks"
[ -d "$CHECKOUT/Resources/Prototypes" ] || fail "not an SS14 checkout: no Resources/Prototypes"

# ---- RobustToolbox at the pinned commit
ENGINE="$CHECKOUT/RobustToolbox"
rm -rf "$ENGINE"
mkdir -p "$ENGINE"
e() { git -C "$ENGINE" "$@"; }
e init -q
e remote add origin "$SUB_URL"
e fetch -q --depth 1 --filter=blob:none origin "$SUB" 2> "$WORK/git.log" \
    || fail "cannot fetch RobustToolbox $SUB from $SUB_URL: $(tail -n 1 "$WORK/git.log")"
e sparse-checkout init --no-cone
e sparse-checkout set --no-cone --stdin <<'PATTERNS'
/Resources/EnginePrototypes/
/Robust.Shared.Maths/Color.cs
/Robust.*/**/*.cs
PATTERNS
e checkout -q --detach FETCH_HEAD 2> "$WORK/git.log" || fail "cannot check out RobustToolbox: $(tail -n 1 "$WORK/git.log")"
rm -rf "$ENGINE/.git"
[ -d "$ENGINE/Resources/EnginePrototypes" ] || fail "RobustToolbox has no Resources/EnginePrototypes"

CHECKOUT_MB="$(size_mb "$CHECKOUT")"
[ "$CHECKOUT_MB" -le "$MAX_CHECKOUT_MB" ] || fail "checkout is ${CHECKOUT_MB} MB, over the limit of ${MAX_CHECKOUT_MB} MB"
echo "checkout: ${CHECKOUT_MB} MB, engine $SUB" >&2

# ---- the pack
(cd "$ROOT" && npm run build-pack -- --checkout "$CHECKOUT" --out "$PACK" --id "$FORK_ID" --repo "$REPO" --branch "$BRANCH" --commit "$COMMIT") \
    > "$WORK/build-pack.log" 2>&1 \
    || { tail -n 20 "$WORK/build-pack.log" >&2; fail "build-pack failed: $(grep -v '^\s*$' "$WORK/build-pack.log" | tail -n 1 | cut -c1-300)"; }
tail -n 5 "$WORK/build-pack.log" >&2
[ -f "$PACK/manifest.json" ] || fail "build-pack wrote no manifest.json"

PACK_MB="$(du -sm "$PACK" | cut -f1)"
[ "$PACK_MB" -le "$MAX_PACK_MB" ] || fail "pack is ${PACK_MB} MB, over the limit of ${MAX_PACK_MB} MB"
[ -z "$(find "$PACK" -mindepth 1 \( -type l -o -type d \) -print -quit)" ] || fail "pack has links or directories"

(cd "$PACK" && find . -mindepth 1 -maxdepth 1 -type f -printf '%P\0' | LC_ALL=C sort -z | tar --null --owner=0 --group=0 --numeric-owner -czf "$TARBALL" -T -)
echo "pack: ${PACK_MB} MB, tarball $(du -m "$TARBALL" | cut -f1) MB" >&2
