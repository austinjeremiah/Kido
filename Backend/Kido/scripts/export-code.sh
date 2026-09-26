#!/usr/bin/env bash
# Export the CODE of this repository — no phase documents, bibles, reports, blockers, findings,
# evidence, or legacy UIs — into a clean directory that can be copied into another repository.
#
#   scripts/export-code.sh [target-dir]        default: ../ContextLock-code
#
# What goes:   everything git tracks or would track (so node_modules, .env, secrets/, studio.db,
#              .next and .scratch are out by construction), minus the exclusions below.
# What stays:  reports/, docs/, specs/, the *_BIBLE / ADDENDUM / GAUNTLET / FEEDBACK / SOURCES
#              documents and their PDF/DOCX copies, templates for blockers/findings, and the two
#              retired test UIs (apps/studio-web, apps/web).
# Afterwards:  the export is scanned for secret material (see below) and a short
#              README-HANDOFF.md is written at its root. The export is not a git repository.
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-../ContextLock-code}"
if [ -e "$target" ]; then
  echo "refusing to overwrite $target — remove it first or pass another directory" >&2
  exit 2
fi
mkdir -p "$target"
target="$(cd "$target" && pwd)"

# Tracked + untracked-but-not-ignored files, then the exclusions. `-z` keeps odd filenames intact.
git ls-files -z --cached --others --exclude-standard \
  | tr '\0' '\n' \
  | grep -vE '^(reports|docs|specs|templates|\.scratch)/' \
  | grep -vE '^apps/(studio-web|web)/' \
  | grep -vE '^(AGENT_GAUNTLET|AI_USAGE|CONTEXTLOCK_BUILD_BIBLE|CONTEXTLOCK_DEPLOYMENT_TO_GA_BUILD_ADDENDUM|CONTEXTLOCK_STUDIO_V2_BUILD_BIBLE|FEEDBACK_LEDGER|README_V2|SOURCES_AND_DOCS)\.md$' \
  | grep -vE '\.(pdf|docx)$' \
  | grep -vE '(^|/)\.DS_Store$' \
  | grep -vE '^apps/studio-web/|/LEGACY\.md$' \
  > "$target/.export-manifest"

count=$(wc -l < "$target/.export-manifest" | tr -d ' ')
echo "copying $count files → $target"
rsync -a --files-from="$target/.export-manifest" ./ "$target/"
rm "$target/.export-manifest"

# The Studio reads two evidence files for its built-in demo project from reports/; without them that
# one project is simply absent (readJson returns null). Every project you build yourself is in the DB.

# The root package.json names the two retired UIs as workspaces and scripts; the export has neither.
node - "$target/package.json" <<'JS'
const fs = require("node:fs"); const p = process.argv[2]; const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.workspaces = (j.workspaces ?? []).filter((w) => !/^apps\/(studio-web|web)$/.test(w));
for (const k of ["ui:legacy", "studio:web:legacy"]) delete j.scripts?.[k];
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
JS

cat > "$target/README-HANDOFF.md" <<'EOF'
# ContextLock — code handoff

This is the code only: the Studio API, the workbench frontend, the packages, contracts and CRE
workflows. Phase reports, build bibles and evidence were left out on purpose.

## Layout
- `apps/frontend`   the workbench (Next.js 15) — `npm run frontend` → http://localhost:3000
- `apps/studio`     the Studio API (Fastify) — port 4310
- `packages/*`      blueprint, policy, adapters, reality (fork lab), control plane, ledger (Key Ring)
- `contracts`       the ContextLock core (Foundry)
- `workflows`       the Chainlink CRE policy workflow
- `scripts`         operator scripts (`studio/ring-secret.sh`, `test-all.sh`, …)

## Run
```bash
npm install
npm run build                   # builds the workspace packages (their dist/ is what apps/studio imports) and the frontend
cp .env.example .env            # fill in OPENAI_API_KEY, MAINNET_RPC_URL (optional), THEGRAPH_API_KEY (or use the Key Ring)
cp apps/frontend/.env.example apps/frontend/.env.local   # NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

# terminal 1 — API (needs Docker for sandbox builds, `anvil` on PATH for the fork lab)
set -a; source .env; set +a
export WALLET_PASS="$(security find-generic-password -a default -s ledger-wallet-cli -w)"   # only if a secret is under the Ledger Key Ring
STUDIO_CRE_SEPOLIA_RPC=https://1rpc.io/sepolia STUDIO_MAX_FORKS=6 npx tsx apps/studio/src/server.ts

# terminal 2 — frontend
npm run frontend
```
`ENV_REQUIRED.md` lists every variable. `scripts/test-all.sh` runs the whole suite.

## Secrets
Nothing in this export holds a secret: `.env`, `secrets/`, `studio.db` and `apps/frontend/.env.local`
were never copied, and the export was scanned for key-shaped values and for the exact values of
this machine's secrets before handoff.
EOF

# The repo's scanner keys on `git ls-files`; the export is not a repository, so scan its files
# directly: private keys (Anvil's public test keys allowed), provider keys, and the exact values
# this machine holds in .env, which must not appear anywhere in the copy.
echo "scanning the export for secrets…"
ANVIL='ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80|59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d|5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a|7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6|47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'
fail=0
# A 64-hex value is a key only when the line says so; tx hashes and digests are public and common.
hits=$(grep -rIEn --exclude-dir=node_modules --exclude='*.lock' --exclude='package-lock.json' '(0x)?[0-9a-fA-F]{64}' "$target" | grep -viE "$ANVIL" | grep -E '(PRIVATE_KEY|privateKey|PRIVKEY|MNEMONIC|SECRET_KEY)\s*[:=]' | grep -v '/test/' | grep -vE '(11){32}|(22){32}|(aa){32}|(00){32}' | head -5 || true)
[ -n "$hits" ] && { echo "FAIL private-key-shaped value on a key line:"; echo "$hits"; fail=1; }
# Provider-key shapes, ignoring the scanners' own test fixtures (EXAMPLE / sk-abcdef…).
hits=$(grep -rIEn --exclude-dir=node_modules '(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})' "$target" | grep -vE 'EXAMPLE|sk-abcdef|/test/' | head -3 || true)
[ -n "$hits" ] && { echo "FAIL provider key:"; echo "$hits"; fail=1; }
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    v="${v%\"}"; v="${v#\"}"
    [ -z "$k" ] && continue; case "$k" in \#*) continue;; esac
    # Only secret-shaped names; public values (RPC URLs, addresses) legitimately appear in code.
    case "$k" in *KEY*|*SECRET*|*PASS*|*TOKEN*|*PRIVATE*|*MNEMONIC*|*PROJECT_ID*) ;; *) continue;; esac
    [ ${#v} -lt 16 ] && continue
    case "$v" in http*|0x????????????????????????????????????????) continue;; esac
    if grep -rIqF --exclude-dir=node_modules -- "$v" "$target"; then echo "FAIL the value of $k from .env appears in the export"; fail=1; fi
  done < <(grep -E '^[A-Z0-9_]+=' .env)
fi
if [ -f apps/frontend/.env.local ]; then
  while IFS='=' read -r k v; do
    [ ${#v} -ge 16 ] || continue
    if grep -rIqF --exclude-dir=node_modules -- "$v" "$target"; then echo "FAIL the value of $k from apps/frontend/.env.local appears in the export"; fail=1; fi
  done < <(grep -E '^[A-Z0-9_]+=' apps/frontend/.env.local)
fi
for f in .env secrets studio.db apps/frontend/.env.local; do [ -e "$target/$f" ] && { echo "FAIL $f was copied"; fail=1; }; done
[ $fail -ne 0 ] && { echo "SECRET SCAN FAILED — do not hand this over" >&2; exit 1; }
echo "OK  no secret material in the export"

echo
echo "✓ exported to $target ($count files)"
echo "  size: $(du -sh "$target" | cut -f1)"
echo "  next: copy its contents into your friend's repository, then \`npm install\` there."
