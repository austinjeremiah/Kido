#!/usr/bin/env bash
# P8.15 — privilege boundary audit.
# Proves the untrusted agent cannot reach any privileged credential, by inspecting the source
# tree, the dependency graph and the runtime surfaces rather than by assertion.
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
say(){ printf '%s\n' "$*"; }

PRIVILEGED='DEPLOYER_PRIVATE_KEY|CAPABILITY_ISSUER_PRIVATE_KEY|RELAYER_PRIVATE_KEY|CRE_ETH_PRIVATE_KEY|FUNDER_PRIVATE_KEY|APPROVER_STANDIN_PRIVATE_KEY|WALLET_PASS'
AGENT_SRC='apps/demo-agent/src'

say "=== P8.15 privilege boundary audit ==="

say "--- [1] agent source references no privileged credential ---"
if grep -rlE "$PRIVILEGED" "$AGENT_SRC" 2>/dev/null | grep -q .; then
  say "FAIL agent source references a privileged credential"; FAIL=1
else say "OK  no privileged credential name in $AGENT_SRC"; fi

say "--- [2] agent cannot sign ---"
if grep -rlE "privateKeyToAccount|mnemonicToAccount|signTypedData|signMessage|Wallet\(" "$AGENT_SRC" 2>/dev/null | grep -q .; then
  say "FAIL agent source can construct a signer"; FAIL=1
else say "OK  agent has no signing capability"; fi

say "--- [3] agent reads no environment secret ---"
if grep -rnE "process\.env" "$AGENT_SRC" 2>/dev/null | grep -qvE "process\.env\.(NODE_ENV|OPENAI_MODEL)"; then
  say "FAIL agent reads process.env beyond benign config"; FAIL=1
else say "OK  agent reads no secret from the environment"; fi

say "--- [4] agent dependency graph cannot reach signing, db or ledger ---"
DEPS=$(node -e "const p=require('./apps/demo-agent/package.json');console.log(Object.keys(p.dependencies||{}).join(' '))" 2>/dev/null)
say "    declared deps: ${DEPS:-<none>}"
for forbidden in "@contextlock/protocol" "@contextlock/ledger" "better-sqlite3" "@ledgerhq"; do
  case " $DEPS " in *"$forbidden"*) say "FAIL agent depends on $forbidden"; FAIL=1;; esac
done
[ $FAIL -eq 0 ] && say "OK  agent depends on nothing privileged"

say "--- [5] agent has no import path into broker internals ---"
if grep -rnE "from ['\"].*(broker/src|providers/|key-ring|secret-provider)" "$AGENT_SRC" 2>/dev/null | grep -q .; then
  say "FAIL agent imports broker internals"; FAIL=1
else say "OK  agent imports no broker internal module"; fi

say "--- [6] privileged env vars are referenced ONLY by operator-run code ---"
# Deploy scripts and the broker legitimately READ these from the environment — that is their job.
# The invariant is not "the name never appears", it is "the name never appears anywhere the
# untrusted agent can reach". Naming them in an ops script is correct; naming them in the agent is
# a breach, and check [1] covers that. Here we verify the reference set is exactly the expected
# operator surface, so a new unexpected consumer is caught.
# Tests are an expected consumer: several of them exist specifically to assert these names are
# absent from agent-reachable surfaces, which requires naming them.
# apps/web is the operator console. It NAMES these variables in the "what the agent cannot reach"
# panel — it is a documentation surface, not a consumer. Because it is browser-served code, that
# concession is paid for immediately below by a STRICTER check: apps/web may not read any
# environment variable at all. (FND-017)
# Phase 11 additions, all of the same kind as apps/web: they NAME these variables without
# consuming them. apps/studio/src/export.ts names them in a scanner that blocks them from an
# export; packages/studio-templates names WALLET_PASS in a generated instruction telling the
# user to keep it in their own shell. Both are the opposite of a leak.
#
# Widening an allowlist is how a tripwire quietly dies, so check [6b] below now closes the
# residual risk recorded in FND-017: naming is allowed anywhere, READING is allowed nowhere
# except a small operator-run set. That is strictly stronger than what this check enforced
# before Phase 11.
# Group E additions, all of the same kind as apps/web and export.ts: files that name these
# variables in order to FORBID them. `apps/agent-runtime/src/config.ts` refuses to start when one is
# present; `studio-runtime/src/hardening.ts` refuses to launch a container carrying one;
# `studio-deploy/src/{cre,secrets}.ts` refuse to persist one. A deny-list has to name what it
# denies, and a check that punished it would push the names into a pattern nobody can audit.
#
# Paid for by [6c] below, which verifies that in exactly these files every mention IS a denial.
DENY_LIST_FILES='^(apps/agent-runtime/src/config\.ts|packages/studio-runtime/src/hardening\.ts|packages/studio-deploy/src/cre\.ts|packages/studio-deploy/src/secrets\.ts)$'
ALLOWED_CONSUMERS='^(\.gitignore|README\.md|AGENT_GAUNTLET\.md|CONTEXTLOCK_BUILD_BIBLE\.md|CONTEXTLOCK_STUDIO_V2_BUILD_BIBLE\.md|CONTEXTLOCK_DEPLOYMENT_TO_GA_BUILD_ADDENDUM\.md|README_V2\.md|ENV_REQUIRED\.md|FEEDBACK_LEDGER\.md|.*\.env\.example|specs/|docs/|reports/|scripts/|contracts/script/|apps/broker/src/|apps/web/|apps/studio/src/|packages/ledger/src/|packages/studio-templates/src/|.*/test/|.*\.test\.ts)'
UNEXPECTED=$(git grep -lE "$PRIVILEGED" -- . 2>/dev/null | grep -vE "$ALLOWED_CONSUMERS" | grep -vE "$DENY_LIST_FILES" || true)
if [ -n "$UNEXPECTED" ]; then
  say "FAIL unexpected consumer of a privileged env var:"; echo "$UNEXPECTED"; FAIL=1
else
  say "OK  every consumer is an ops script, the broker, documentation, or a deny-list"
fi

say "--- [6c] the deny-list files only ever DENY ---"
# The concession above is paid for here. In each of those four files, every line mentioning a
# privileged variable must be a bare string-literal list entry or a comment — never an expression
# that could read, assign or forward the value. One line of `process.env.OPENAI_API_KEY` in a file
# whose job is to forbid it would be the exact inversion this whole audit exists to catch.
DENY_OK=1
for f in $(git ls-files | grep -E "$DENY_LIST_FILES"); do
  # Lines that mention a privileged name and are NOT a plain quoted list entry or a comment.
  # The line must be, in its entirety, either a comment or a list of quoted names. Anything else —
  # an assignment, a `process.env` read, a template string, a function call — fails. Matching the
  # WHOLE line matters: a `grep -v` on a fragment would let `const k = process.env.X; // "Y", "Z"`
  # through on the strength of its comment.
  BAD=$(grep -nE "$PRIVILEGED" "$f" \
        | grep -vE ':[[:space:]]*(//|\*|/\*)' \
        | grep -vE ':[[:space:]]*("[A-Za-z_][A-Za-z0-9_]*",?[[:space:]]*)+$' \
        || true)
  if [ -n "$BAD" ]; then
    say "FAIL $f mentions a privileged variable outside a denial:"; echo "$BAD"; DENY_OK=0; FAIL=1
  fi
done
[ $DENY_OK -eq 1 ] && say "OK  every mention in a deny-list file is a denial, not a use"

say "--- [6b] privileged env vars are READ only by operator-run code ---"
# The stronger form of [6]: an occurrence is fine, a read is not. Matches the actual read shapes —
# process.env.X, process.env["X"], vm.envString("X"), $X / ${X} in a shell script — rather than the
# variable name in prose. Comments are stripped first so a doc comment naming a variable is not a
# read (this scanner class has produced a false positive six times in this project).
READERS_ALLOWED='^(scripts/|contracts/script/|apps/broker/src/|packages/ledger/src/|.*/test/|.*\.test\.ts)'
READ_VIOLATION=0
# Only executable file types can read anything. A markdown file quoting `process.env.X` is
# documentation -- FND-017's own report quotes the planted negative control and would otherwise
# be flagged by the check it documents.
for f in $(git grep -lE "$PRIVILEGED" -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.sh' '*.sol' '*.yaml' '*.yml' 2>/dev/null | grep -vE "$READERS_ALLOWED"); do
  # strip /* */ and // comments and markdown quote/bullet lines before looking for a read
  body=$(sed -e 's|/\*.*\*/||g' -e 's|//.*$||' -e 's|^[[:space:]]*[*#>].*$||' "$f" 2>/dev/null || true)
  if printf '%s' "$body" | grep -qE "(process\.env\.($PRIVILEGED)|process\.env\[[\"']($PRIVILEGED)[\"']\]|envString\([\"']($PRIVILEGED)[\"']\)|\\\$\{?($PRIVILEGED)\}?)"; then
    say "FAIL $f READS a privileged env var"; READ_VIOLATION=1; FAIL=1
  fi
done
[ $READ_VIOLATION -eq 0 ] && say "OK  no unexpected code reads a privileged env var"

# apps/web is browser-served: it must never READ an environment variable, only name one in prose.
if git grep -lE 'process\.env|import\.meta\.env' -- apps/web 2>/dev/null | grep -q .; then
  say "FAIL the operator console reads an environment variable"; FAIL=1
else say "OK  the operator console reads no environment variable at all"; fi

# And specifically: none of them is anything the agent imports.
if git grep -lE "$PRIVILEGED" -- apps/demo-agent 2>/dev/null | grep -q .; then
  say "FAIL the agent package references a privileged env var"; FAIL=1
else say "OK  the agent package references none of them"; fi

say "--- [7] the SecretProvider surface exposes no getter ---"
# Strip block AND line comments first: key-ring.ts documents "There is no getSecret()" in prose,
# and a naive scan matches its own explanation. The check must test code.
GETTERS=$(for f in $(git ls-files 'packages/ledger/src/*.ts' 'apps/broker/src/**/*.ts' 2>/dev/null); do
  perl -0pe 's{/\*.*?\*/}{}gs; s{//.*$}{}gm' "$f" 2>/dev/null \
    | grep -nE "(getSecret|readSecret|revealSecret|exportSecret)\s*\(" \
    | grep -v "runtime\.getSecret" | sed "s|^|$f:|"
done)
if [ -n "$GETTERS" ]; then
  say "FAIL a secret getter exists on a reachable surface:"; echo "$GETTERS"; FAIL=1
else say "OK  no secret getter on any reachable surface"; fi

# Prove the comment-stripper works, so this cannot pass vacuously.
if printf '/* getSecret() */\nconst x=1;\n' | perl -0pe 's{/\*.*?\*/}{}gs' | grep -q "getSecret"; then
  say "FAIL comment stripper is not working - check [7] would pass vacuously"; FAIL=1
else say "OK  comment stripper verified"; fi

say ""
if [ $FAIL -eq 0 ]; then say "PRIVILEGE AUDIT: CLEAN"; exit 0; else say "PRIVILEGE AUDIT: FAILED"; exit 1; fi
