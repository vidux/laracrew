#!/usr/bin/env bash
# Packs laracrew, installs the tarball into an empty directory, and exercises the installed
# binary — the release check `npm test` cannot perform. Run from the repo root.
#
#   bash .claude/skills/prepare-for-publish/smoke-test.sh
#
# Exits non-zero on the first failure and prints what it was checking.
set -u

REPO="$(pwd)"
FAILURES=0

# Git Bash hands node a POSIX path it resolves against C:\ — cygpath -m gives D:/... instead.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

step() { printf '\n\033[36m== %s\033[0m\n' "$1"; }
pass() { printf '   \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '   \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

VERSION="$(node -p "require('$(native "$REPO")/package.json').version")"
step "laracrew $VERSION"

step "gate: npm run prepublishOnly"
if npm run prepublishOnly >/dev/null 2>&1; then pass "typecheck, tests and build"; else
  fail "prepublishOnly — rerun it directly to see why"
  exit 1
fi

step "pack"
TARBALL="$REPO/laracrew-$VERSION.tgz"
rm -f "$REPO"/laracrew-*.tgz
npm pack >/dev/null 2>&1
[ -f "$TARBALL" ] && pass "$(basename "$TARBALL")" || { fail "no tarball at $TARBALL"; exit 1; }

# src/ and test/ must never reach the tarball; the four docs and dist/ must.
CONTENTS="$(tar -tzf "$TARBALL")"
for want in package/dist/index.js package/README.md package/CHANGELOG.md package/LICENSE; do
  printf '%s\n' "$CONTENTS" | grep -q "^$want$" && pass "ships $want" || fail "missing $want"
done
for unwanted in "package/src/" "package/test/" "package/.claude/"; do
  printf '%s\n' "$CONTENTS" | grep -q "^$unwanted" && fail "leaks $unwanted" || pass "excludes $unwanted"
done

step "install into an empty directory"
CONSUMER="$(mktemp -d)"
trap 'rm -rf "$CONSUMER"' EXIT
( cd "$CONSUMER" && npm init -y >/dev/null 2>&1 && npm install "$(native "$TARBALL")" >/dev/null 2>&1 ) \
  && pass "installed" || { fail "npm install of the tarball"; exit 1; }

BIN="$CONSUMER/node_modules/.bin/laracrew"
[ -x "$BIN" ] || [ -f "$BIN" ] || { fail "no bin shim at node_modules/.bin/laracrew"; exit 1; }

export LARACREW_HOME="$(native "$CONSUMER/home")"

step "the installed binary"
REPORTED="$("$BIN" --version 2>&1 | tr -d '\r')"
[ "$REPORTED" = "$VERSION" ] \
  && pass "--version reports $REPORTED" \
  || fail "--version reports '$REPORTED', package.json says '$VERSION'"

"$BIN" init --examples >/dev/null 2>&1 && pass "init --examples" || fail "init --examples"
"$BIN" ls >/dev/null 2>&1 && pass "ls" || fail "ls"

if "$BIN" doctor example >/dev/null 2>&1; then pass "doctor example exits 0"; else
  fail "doctor example exited $? — run it directly to see the findings"
fi

# A pipe that closes is how you bound a supervisor on Windows; -s INT does not reach it.
# 14 lines: the demo's slow-starter gate opens at ~1.2s and "ready in" lands on line 8.
BOOT="$("$BIN" up example --plain 2>&1 | head -14)"
printf '%s' "$BOOT" | grep -q "ready in" && pass "up example boots" || fail "up example never reported ready"

"$BIN" logs --list --stack example 2>&1 | grep -q "demo" \
  && pass "logs --list reads the run back" \
  || fail "logs --list found nothing from the boot"

step "no survivors"
if command -v powershell >/dev/null 2>&1; then
  sleep 1
  LEFT="$(powershell -NoProfile -Command \
    "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*heartbeat*' }).Count" 2>/dev/null | tr -d '\r ')"
  [ "${LEFT:-0}" = "0" ] && pass "no orphaned demo processes" || fail "$LEFT demo process(es) survived the stop"
else
  pgrep -f "heartbeat" >/dev/null 2>&1 && fail "demo processes survived the stop" || pass "no orphaned demo processes"
fi

step "cleanup"
rm -f "$REPO"/laracrew-*.tgz && pass "removed the tarball"
git -C "$REPO" status --short 2>/dev/null | grep -q "laracrew-.*\.tgz" \
  && fail "a tarball is still staged — git rm --cached it" \
  || pass "nothing stray in git status"

if [ "$FAILURES" -eq 0 ]; then
  printf '\n\033[32mready to publish %s\033[0m — commit, tag v%s, then npm publish\n' "$VERSION" "$VERSION"
else
  printf '\n\033[31m%s check(s) failed\033[0m — do not publish\n' "$FAILURES"
fi
exit "$FAILURES"
