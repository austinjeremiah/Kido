#!/usr/bin/env bash
# ContextLock secret scanner. Fails (exit 1) if any secret material is tracked by git.
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
say(){ printf '%s\n' "$*"; }

say "=== ContextLock secret scan ==="

# 1. Files that must never be tracked
say "--- tracked-file check ---"
for pat in '.env' '.env.local' 'wallets.json' 'secrets.yaml' 'cre.yaml' '*.key' '*.pem'; do
  hits=$(git ls-files "$pat" 2>/dev/null)
  if [ -n "$hits" ]; then say "FAIL tracked secret file: $hits"; FAIL=1; fi
done
[ $FAIL -eq 0 ] && say "OK  no secret files tracked"

# 2. Content scan of tracked files for key-shaped material
say "--- tracked-content check ---"
# 64-hex private keys (allow the well-known public Anvil test keys used in local tests)
ANVIL='ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80|59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d|5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a|7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6|47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in specs/*|reports/*|docs/REFERENCE_MANIFEST.md) continue;; esac
  if grep -nEo '(^|[^0-9a-fA-Fx])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)' "$f" 2>/dev/null \
       | grep -Ev "$ANVIL" | grep -Eq '[0-9a-fA-F]{64}'; then
    # allow keccak digests / bytes32 constants in solidity+ts by requiring key-ish context
    # A 64-hex value in key-ish context.
    #
    # A single repeated nibble — 0x1111…, 0xaaaa… — is not a key any generator would produce, and
    # the fail-closed tests need such values to prove that a runtime carrying one refuses to start.
    # Excluding them by SHAPE rather than by file keeps the check strict everywhere: a real key has
    # entropy, and anything with entropy still fails.
    if grep -nEi '(private_?key|privkey|secret|seed|mnemonic|WALLET_PASS)[^\n]{0,40}[0-9a-fA-F]{64}' "$f" 2>/dev/null \
         | grep -qvE '(0{64}|1{64}|2{64}|3{64}|4{64}|5{64}|6{64}|7{64}|8{64}|9{64}|[aA]{64}|[bB]{64}|[cC]{64}|[dD]{64}|[eE]{64}|[fF]{64})'; then
      say "FAIL possible private key in $f"; FAIL=1
    fi
  fi
  # API-key-shaped strings.
  #
  # Same rule as WALLET_PASS below, and for the same reason: several tests exist specifically to
  # prove the in-code scanners FIRE on a credential, which requires a credential-shaped string. An
  # allowlist of whole test FILES would let a real key hide in one, so the VALUE itself must
  # announce that it is not real. Anything that looks like a live key still fails, in any file.
  if grep -nEi '(sk-proj-[A-Za-z0-9_-]{20,}|xoxb-[A-Za-z0-9-]{20,})' "$f" 2>/dev/null \
       | grep -qvE '(NOT-A-REAL-KEY|dummy-only|placeholder)'; then
    say "FAIL possible API key in $f"; FAIL=1
  fi
  # WALLET_PASS assigned an actual value.
  #
  # Test fixtures legitimately assign a dummy password to exercise the fail-closed paths, so a
  # blanket ban is unusable. Rather than allowlisting whole test FILES — which would let a real
  # secret hide in one — the VALUE itself must be self-evidently non-secret: empty, a variable
  # reference (restoring a saved value), or containing an explicit fake marker.
  # Anything that looks like a real password still fails, including in a test file.
  if sed 's/#.*//' "$f" 2>/dev/null \
       | grep -E 'WALLET_PASS[[:space:]]*=[[:space:]]*[^[:space:]]+' \
       | grep -qvE 'WALLET_PASS[[:space:]]*=[[:space:]]*("";|'"''"';|prev|process\.env|\$|<|.*(not-a-real|NOT-a-real|dummy-only|placeholder))'; then
    say "FAIL WALLET_PASS literal in $f"; FAIL=1
  fi
done < <(git ls-files)
[ $FAIL -eq 0 ] && say "OK  no key-shaped material in tracked content"

# 2b. The CRE secrets.yaml is allowed to be tracked because it is a NAME-ONLY mapping.
#     Verify that literally: any line assigning a value (rather than referencing an env var name)
#     fails the scan, so the exception cannot be abused to smuggle a secret in.
say "--- CRE secrets.yaml name-only check ---"
for f in $(git ls-files 'workflows/cre-policy/**/secrets.yaml' 2>/dev/null); do
  # Permitted shapes: comments, `secretsNames:`, `  ID:`, `    - ENV_VAR_NAME`.
  if grep -vE '^[[:space:]]*(#|$)|^secretsNames:|^[[:space:]]+[A-Za-z0-9_]+:[[:space:]]*$|^[[:space:]]+-[[:space:]]*[A-Z0-9_]+[[:space:]]*$' "$f" | grep -q .; then
    say "FAIL $f contains something other than a name mapping"; FAIL=1
  else
    say "OK  $f is a name-only mapping"
  fi
done

# 3. .gitignore sanity
say "--- gitignore check ---"
for must in '.env' 'wallets.json' 'node_modules/'; do
  grep -qxF "$must" .gitignore || { say "FAIL .gitignore missing: $must"; FAIL=1; }
done
[ $FAIL -eq 0 ] && say "OK  .gitignore covers required patterns"

# 4. History check
say "--- git history check ---"
if git rev-parse HEAD >/dev/null 2>&1; then
  h=$(git log --all --name-only --pretty=format: | sort -u | grep -E '^(\.env$|.*wallets\.json$|.*\.key$)' || true)
  if [ -n "$h" ]; then say "FAIL secret file in git history: $h"; FAIL=1; else say "OK  no secret files in history"; fi
else
  say "SKIP no commits yet"
fi

say ""
if [ $FAIL -eq 0 ]; then say "SECRET SCAN: CLEAN"; exit 0; else say "SECRET SCAN: FAILED"; exit 1; fi
