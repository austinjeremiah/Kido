# ContextLock Studio — build progress

Frontend implementation of `contextlock-frontend.md`, built inside the existing
`frontend/` Next.js app and skinned entirely with that site's own design system.

**Ground rule:** structure, pages, buttons and behaviour come from the spec.
Look and feel comes from the landing site — cream `--soft` ground, blue `--color`
ink, `NM_Regular` / `NM_Medium` / `Editorial` type. The spec's own dark-IDE theme
(§8.3) is deliberately **not** followed.

Phases follow the spec's own build sequence (§52).

---

## ✅ Phase FE-1 — Workbench shell

Commit `3e4b1bd`.

The persistent three-column IDE frame every page renders inside.

| Piece | Spec | Notes |
|---|---|---|
| TitleBar | §4 | project + agent switchers, revision chip & drawer, always-on `TESTNET LAB` badge, command field, build status, blockers, notifications, user menu |
| Activity Rail + Explorer | §5 | 9 rail views swapping explorer groups; nav badges always carry text, never colour alone |
| Editor tabs | §3.3 | preview/pin, dirty dot, stale warning, live dot; restore after refresh |
| Bottom panel | §3.4 | Problems · Output · Tests · Events · Terminal (dev-mode only, never a host shell) |
| Context Agent sidebar | §6 | page- and selection-aware, structured response cards, authority tiers enforced |
| Status bar | §7 | every item a defined click target; policy shows *observed* state + freshness |
| Command palette | §4.5 | ⌘K; policy/emergency entries only **open** confirmations |
| Resizers | §3.2 | pointer + keyboard operable, sizes persisted, double-click resets |
| Shortcuts | §44 | ⌘K ⌘B ⌘J ⌘⇧A ⌘⇧S ⌘⇧T ⌘⇧D — no single keystroke reaches a security control |

Also landed: typed domain model (`lib/studio/types.ts`), mock data layer,
RainbowKit/wagmi **testnet-only** wallet config, route tree for all 21 pages.

## ✅ Phase FE-2 — Shared domain primitives

Commit `3e4b1bd`.

`StatusBadge` · `VerdictBadge` · `FreshnessBadge` (§33) · `ReasonCode` with a
deterministic code catalog (§35) · `BlockchainRef` that **never** emits a public
explorer link for local-fork objects (§34) · `TrustClassBadge` ·
`NetworkRoleBadge` · `CreModeBadge` (a simulator can never render a DON badge) ·
`SecurityPath` · `StaleBanner` · `DraftAheadBanner` (§36) · `EmptyState` (§47).

Dialogs (§31): standard · security (current → requested → network → resource →
consequence) · emergency (ordered steps + typed confirmation) · destructive
(type the resource name).

## ✅ Phase FE-3 — Build & Design

Commits `0f2f8dc` (Composer, Organization) and `2de608f` (Blueprint,
Architecture, Permissions).

| Page | Spec | What landed |
|---|---|---|
| Composer / Build | §10 | Prompt editor with autosave and `/limits` `/protocol` `/data` `/forbid` helpers; parser output held at **DRAFT** until a deterministic artifact exists and a missing ceiling held at **REQUIRED** rather than invented; live build timeline whose stages open the matching bottom panel; Examples / Import Requirements / Cancel Build / Resume Build |
| Organization / Agents | §11 | Principal tree + agent detail; `EXECUTION: NONE` for reporting-only agents; blocking **CRITICAL — shared policy principal** check; Add / Duplicate as New Agent / Open Blueprint / Architecture / Policy / Revoke (security confirmation stating sibling + capability impact) / Remove Draft |
| Blueprint | §12 | All 19 canonical sections; editing opens a **draft revision** and never mutates the live one; left-edge change markers; **AUTHORITY EXPANSION** call-outs with the concrete consequence; grouped validation panel with click-to-focus-field; revision comparison listing expansions first plus what goes stale; Raw JSON / Copy / Export; publish action is **Create Revision**, not Save |
| Architecture | §13 | React Flow canvas, 14 node categories, labelled edges (READ / CONTEXT / TRIGGER / POLICY / AUTHORIZATION / EXECUTE / ESCALATE); **live overlay reuses the same graph**; 7 layer toggles; node inspector opens **inside the center pane** with navigation only — no destructive controls; accessible alternate node list; Fit / Zoom / Lock / Layers / Live Overlay / Export SVG |
| Permissions & Security | §14 | Posture summary; three-column **ALLOW / ESCALATE / DENY** matrix with per-rule policy refs and proof links; 7 constraint panels (capability bindings, recipients, expiry/nonce, data trust, confidentiality, identity, org aggregate); authority-increase review; Open Policy / Compare / Run boundary simulations / Export / Create policy revision. Deliberately offers **no** enable/disable control |

## ✅ UI hardening round (after FE-3 review)

Commits `16dbf7d`, `f6828d9`, `77a1ecf`. Driven by review of the running app —
the findings are generalised into **House rules** below so they are not
rediscovered later.

- Contrast: element resets were outranking component classes, so every button
  inherited its parent's ink (blue icons on the blue rail, cream menus on cream).
- Chrome bars: colour is inherited, not forced with `*`; badges and status dots
  get light-end hues on navy.
- Panels: explorer, agent sidebar and bottom panel now fill their sized wrapper.
- Full-width buttons wrap instead of forcing their container off-screen.
- Tab ✕ navigates to a neighbour instead of stranding the page.
- Explorer header shows the project, not a repeat of the group label.
- Revision indicator rebuilt as labelled segments, amber when trailing.
- Output log reads as a log: timestamp / scope / message, tinted by level.
- Architecture is per-agent; a reporting-only agent has no execution path drawn.
- Code runs the dark editor theme across the whole shell.
- Dev compile time: wallet stack moved behind a dynamic import, Turbopack on.

## ✅ Phase FE-4 — Test surfaces

| Page | Spec | What landed |
|---|---|---|
| Simulation Center | §15 | 24 scenarios across all 11 groups; grouped list with per-scenario checkboxes; detail shows deterministic inputs, mutation, expected vs actual, reason code, changed fields, layers evaluated, timing and run log; **a run built against an older Blueprint is shown STALE** rather than as a current pass; security path per run; Run All / Run Selected / Stop Run / Create Scenario / Duplicate / Reset to Template / Compare Runs / Open failed assertion / Run CRE Simulation. The expected result is fixed when a scenario is written and is never editable to turn a failure green |
| Reality Lab | §16 | **Market source and execution target are two separate fields**, never merged; four modes each reporting AVAILABLE / LIMITED / BLOCKED with the exact blocker (Historical Replay is LIMITED for want of an archive RPC; The Graph is UNAVAILABLE for want of a credential, with no substitution); snapshot header with anchor block, coherence and hash; source table with trust class and freshness; provenance drawer; local fork panel with Create / Reset / Snapshot / Restore / Destroy / Run Agent on Fork, endpoint shown only in developer mode; **fork transactions are labelled LOCAL FORK TRANSACTION and never receive a public explorer link**; six synthetic overlays applied over an immutable base snapshot, with Apply / Clear / Compare with Base |
| Attack Lab | §17 | 16 attacks across all 10 categories; cards carry applicability, severity, last result and stopping layer; detail shows original vs injected values, the stopping layer, reason code, and `NOT ISSUED` / `NOT SUBMITTED`; **defences exercised lists only the layers a run actually reached** — a layer never reached is not claimed as a defence; mainnet write attempt always offered for a write-capable agent; attacks that cannot apply to a reporting-only principal are marked not applicable and report no result; Run Attack / Run All Applicable / View Security Path / Compare with Baseline / Open Policy Rule / Open Simulation / Export Result |

Attack applicability is derived from the agent's execution class, so a
reporting-only principal is not shown green results for attacks that could never
have run against it.

## ✅ Phase FE-5 — Engineering surfaces

| Page | Spec | What landed |
|---|---|---|
| Code | §18 | Monaco editor, dynamically imported so it stays out of every other route's graph, themed from the workbench's own dark tokens; file tree across all seven groups with `GENERATED` / `TEMPLATE` / `MODIFIED` / `STALE` / `LOCKED` marks; **generated code is read-only after a successful build** so the artifact still corresponds to its Blueprint; developer mode may open a draft, which marks the file MODIFIED, raises a banner and states that revalidation and a rebuild are required — a hand edit is never invisible to Blueprint validation; Monaco Diff for revision compare; per-file provenance linking to the Blueprint section that generated it and the test that covers it; Rebuild from Blueprint / Run tests / Open Problems / Compare revision / Download project / Copy / Copy path / Download |
| Integrations & Data Sources | §19 | Four tabs (Adapters, Data Sources, Credentials, Custom/OpenAPI); adapter table with id, version, type, network role, capabilities, trust class, status, lifecycle and used-by, opening an inspector with full provenance; **credential values are never displayed** — only name, scope, storage boundary, status, last verified and what uses them, with the existing value replaceable but never readable; an unavailable source names exactly what is missing and states that nothing of lower trust is substituted; OpenAPI import pinned to a single allowed host, generating an adapter at trust class UNVERIFIED; Add Integration / Import OpenAPI / Configure credential / Rotate / Test connection / View provenance / Run conformance tests / Disable adapter |

Trust class is treated as a property of the source throughout: a Blueprint that
requires a verified oracle will not accept an indexed source in its place, and
no control on this page can raise a source's trust class.

## ✅ Phase FE-6 — Deployment

| Page | Spec | What landed |
|---|---|---|
| Deploy / Preflight | §20 | Nine-step preflight whose **wallet step reflects the live connection**, not a stored value; deployment summary with both revisions, contract reuse/deploy counts, image digest, CRE mode and workflow hash; **cost kept in five separate sections** — deployment gas, per-action execution, model usage, runtime hosting and CRE — with an explicit note that they are not added together because they are paid in different currencies at different times; deployment plan showing which contracts are deployed and which reused; artifact hashes; confirmation stating network, transaction count, balance requirement, revisions, `Policy: DISABLED`, CRE mode, image digest and `Production-chain execution: DISABLED`, with a button that names itself rather than a bare Confirm; progress that **persists across a reload** and ends at READY TO ACTIVATE; Run Preflight / Refresh Estimate / Connect Testnet Wallet / Fund Testnet Wallet / Run CRE Simulation / View artifact hashes / Review Deployment Plan / Deploy / Cancel |
| Deployments | §20 | History with per-deployment status, revisions, network, CRE mode and security status; receipt showing contracts, addresses, verification and recorded progress; states that the active deployment stays on its revision regardless of how far the Blueprint has moved |

**Deployment is currently BLOCKED, on purpose.** One mandatory security scenario
fails (`sim_graph_unavailable`), and the gate requires a clean regression, so
Deploy is disabled and names exactly why rather than offering a green path. This
is the product behaving correctly, not an unfinished screen.

**The wallet lands here**, mounted by `deploy/layout.tsx` rather than the
workbench layout. The build confirms the scoping: `/deploy` is 350 kB first-load
while every other route stays around 135 kB. Connecting on a production chain is
reported as a wrong network rather than silently accepted, and faucet links are
labelled as third-party with no promise that funds will arrive.

## ✅ Phase FE-7 — Live operations

| Page | Spec | What landed |
|---|---|---|
| Overview | §21 | Header states execution network, read-only market source, CRE mode and `Production-chain execution: DISABLED` — **never "LIVE" unqualified**; seven status tiles each carrying their own last-verified time; authority usage with limit, window consumption, escalation band and hard ceiling; compact live architecture strip on observed state; recent decisions with verdicts and reason codes; Open Activity / Run Simulation / Attack Test / Pause Runtime / Disable Policy / Emergency Lock |
| Activity | §22 | Filter bar over source, verdict and free text; timeline table; event drawer with RuntimeEvent schema, reason code, capability, CRE execution, revisions and source freshness; **confidential payloads are not rendered**, only public metadata; correlation trace of the whole run back to its trigger; `Open transaction` appears only for a real testnet transaction — a local-fork transaction never gets a public explorer link |
| Policies | §23 | Observed chain state with freshness, authority matrix, on-chain state, drift; **a submission is never treated as proof** — after disable the state reads DISABLING until a fresh chain read confirms it; Enable is gated on seven preconditions and is unavailable while any fails; Refresh Chain State / Create Policy Revision / Compare Policy / Run Policy Simulations / Disable / Enable |
| Runtime | §24 | Status, resource metrics, health dependencies where **a running process with a broken dependency is DEGRADED, never HEALTHY**; runtime revisions with rollback gated on compatibility; credential fencing shown as a verified result rather than assumed; every stop-type control states that it does **not** disable on-chain financial authority |
| Control Plane | §25 | Ten-component topology with current, expected, drift, freshness and last failure; reconciliation where observed is treated as the truth; alerts that can only be resolved after acknowledgement and evidence; four control groups; **Emergency Lock attempts the financial policy first and reports each step separately**, so a partial result reads `EMERGENCY_LOCK_PARTIAL` rather than being rounded up to success |
| Chainlink CRE | §26 | **Four truth labels stated separately** — official simulation YES, real DON NO, DON consensus NO, hardware TEE NO — each set only by evidence; a simulator never renders a DON badge and a fixture simulation id is labelled as not a workflow id; three mode cards with exact blockers; connect flow that **never asks for a password or OTP**, authenticating through the official CRE login with only a sanitized status returned; promotion that moves the exact approved artifact and never silently rebuilds |
| Identity / ENS | §27 | Identity card, organization namespace, records and lifecycle; states plainly that **ENS identifies and revokes agents while ContextLock policy defines their financial permissions**, and no spending limit is stored as a name record; revoke confirmation spelling out sibling impact, capability impact, that the policy state is unaffected, and that a fresh ENS read must confirm it |

## ✅ Phase FE-8 — Context Agent integration

The sidebar already explained, navigated and proposed. FE-8 made it *bound* —
the parts of §6 and §30 that constrain what it may do, and the parts that make
its answers traceable.

| Piece | Spec | What landed |
|---|---|---|
| Prohibited shortcuts | §30 | `lib/studio/agent-refusals.ts` — all **19** page-specific prohibitions, each detected and answered with a visible refusal card stating what was asked, why it is not the agent's to do, and the legitimate route. Checked *before* any other routing, so no keyword or page default can accidentally satisfy a request that must be refused |
| Mention resolution | §6.2 | `lib/studio/mentions.ts` — the frontend resolves `@token` to a real entity id before the turn is sent, never leaving it for the model to guess. Ranked typeahead over agents, adapters, scenarios, attacks, deployments, events, transactions, alerts, files and problems; arrow keys / Enter / Escape; an unknown mention is reported unresolved rather than answered around. **Credentials are deliberately absent from the index** — an adapter is mentionable, its API key is not |
| Citations | §6.7 | Answers cite the artifacts they drew on as clickable chips carrying the human label; the opaque id is a tooltip, never the text |
| Authority tiers | §6.4 | Tier is rendered on the card — `Needs explicit Apply`, `Typed control only`, `Critical modal only` — so the gate is legible rather than implied |
| Patch delivery | §6.4 | "Apply to draft" no longer just toasts. The proposal is delivered to the page that owns the artifact (`AgentPatchInbox` on Blueprint and Composer) where a person merges or discards it. The agent still never writes: applying moves a proposal, it does not mutate |
| Selection awareness | §6.6 | Extended to the last operate pages — policy matrix rows, runtime dependencies, CRE runs, ENS records. 18 of 22 pages now feed the selection chip; the remaining four are launchpads whose clicks navigate away |
| Error attachment | §6.2 | Attaches the highest-severity real problem instead of a hardcoded placeholder id, and is disabled when nothing is wrong |

**Verified, not assumed:** a 45-case check confirms each detector fires on its
prohibited ask and stays silent on the adjacent legitimate question ("disable
the policy" refuses; "what does disabling the policy do?" answers). It caught
two real bugs — `\bpolic\b` can never match "policy" because the boundary falls
inside the word, and the fixed pattern then swallowed the page's own quick
prompt "Why is Enable Policy disabled?", which is a question about a greyed-out
button, not a request to change state.

## ✅ Phase FE-9 — Reports, Settings and polish

| Piece | Spec | What landed |
|---|---|---|
| Safety Reports | §28 | Seven report types with revision, generated time, hash, current/stale and privacy classification; full Agent Safety Report preview across all 14 required sections; Generate / Regenerate / Preview / Verify Hash / Download PDF / Download JSON / Copy Share Link. **Secret scanning gates distribution** — every download and share control is unavailable until a scan passes, and an ungenerated report is UNSCANNED rather than an empty pass. A report built against r7 while the Blueprint is r8 is marked STALE and says what that does and does not mean |
| Evidence | §28 | Evidence bundle with what each artifact *proves*, stated plainly; simulated runs carry a SIMULATED RUN badge wherever they appear, so CRE evidence reads as simulator output and never as DON execution |
| Settings | §29 | Six tabs — Project, Appearance, Simulation limits, Runtime, Notifications, Developer mode. **Simulation limits are read-only** because they are server policy; a control that appeared to raise them would be a lie. **Developer mode reveals, never disables** — stated on the tab and true in the code |
| Appearance wired for real | §29 | Theme (auto / light / dark), density and editor font size are live preferences, persisted, driving the shell and Monaco — not decorative controls. `auto` keeps the dark ground for the Code editor only |
| Monitoring mode | §46 | Below 900px the workbench changes job rather than shrinking: rail and explorer give way to a compact nav over Overview, Activity, Alerts and Reports plus a plain policy/runtime status. An authoring page reached at that width **explains why it is unavailable** and offers somewhere useful — it is never silently redirected or hidden |
| Accessibility | §45 | Mention picker given full combobox semantics (`aria-expanded`, `aria-controls`, `aria-activedescendant`, `role=option`). The rest of §45 was already satisfied: keyboard-operable resizers, accessible architecture node list, focus-trapped modals, text labels on every badge, reduced-motion handling, AA contrast |

**All 24 pages are now built.** No `PendingSurface` stub remains in the app.

## ✅ Clarifying interview in the Composer

The parser reported what a description *said* and then stopped, leaving the
gaps as red rows for the user to go and fix. It flagged holes without ever
asking about them, which is why the Composer felt like a form.

| Piece | Spec | What landed |
|---|---|---|
| Interview queue | §10 | One question at a time, REQUIRED gaps before WARN, rather than a wall of empty fields. Answer / Skip; skipped questions stay open in the requirements table and a REQUIRED gap still blocks the build |
| The refusal | §30 | For a financial boundary the agent asks and then **refuses to answer**. No figure, no "typical" value, no inference from the other limits — and it says so on the question, so the absence of a suggestion reads as a position rather than an oversight. Everywhere else it proposes candidates freely |
| Answers close gaps | §10 | An answer sets the requirement to PASS exactly as a stated description would, so a requirement satisfied by conversation is indistinguishable from one written up front |
| Modal → Composer | §9.1 | The description typed in the New Project modal now carries through as `?seed=`. It was previously discarded, which made the field appear to do nothing |

**Deliberately NOT changed:** the New Project modal stays a plain form. It
captures three deterministic facts — name, single/multi, template — and turning
"what do you want to call it?" into a chat turn is worse UX, not better. The
conversation belongs one screen later, where the answers are open-ended and
carry consequences.

## ⬜ Remaining — landing polish only

| Phase | Scope | Notes |
|---|---|---|
| **Landing** ← next | Polish pass | Deferred by explicit decision until the workbench was done. Includes wiring "Get Started" → wallet connect; the session layer already supports it |

---

## House rules

Learned the hard way. Check these *before* writing a page, not after.

### The landing page's CSS is global and it leaks

`inline.css` and `webflow.css` style bare elements for the marketing site and
apply to everything, including the workbench.

- `section { padding: 30rem 0; width: 100vw }` → phantom gaps and right-side
  overflow inside any centred column.
- `* { font-weight: 100; line-height: 100%; color: var(--color) }`.
- `h1`–`h6` at 38px/bold with top margins, `label` bold+block, `ul/ol` padded
  40px, `dd` indented 40px.
- `html { font-size: calc(100vw / 1920 * 10) }` → 1rem ≈ 7.5px at 1440px wide.

All are neutralised inside `.cl-studio`. **Never use `rem` in workbench CSS** —
the root size is not what you think. Workbench pages pin `html` to 16px via
`html:has(.cl-studio)` so third-party rem-based CSS (RainbowKit) renders sanely.

### Specificity: element resets must use `:where()`

`.cl-studio button { color: inherit }` is **(0,1,1)** and silently outranks every
component class at **(0,1,0)** — `.cl-btn-primary`, `.cl-rail-btn`,
`.cl-palette-item`. The symptom is components ignoring their own colour and
inheriting their parent's. Always write `.cl-studio :where(button) { … }`.

For the same reason, never colour a region with `.region * { color: … }`: it
captures popovers and dialogs rendered inside that region. Set colour on the
region and let it inherit, then re-assert it on any surface with its own ground.

### A grid container needs its columns declared

`.cl-shell` set `grid-template-rows` but no `grid-template-columns`. The implicit
column is `auto`, which sizes to the widest row's **max-content** — so the title
bar, whose every child is `white-space: nowrap` and non-shrinking, widened the
entire shell past the viewport and pushed the agent sidebar off screen. It only
looked fine at 90% browser zoom, where the extra CSS pixels hid it.

Declare `grid-template-columns: minmax(0, 1fr)` on any fixed-size grid, and give
dense bars `min-width: 0; overflow: hidden` so they clip themselves rather than
resizing their container.

### A flex child must be told to fill its wrapper

The shell sizes panels on a wrapper div. A panel that is only
`display: flex; flex-direction: column` sizes to its **content**, leaving dead
space or clipping. Every panel needs `flex: 1 1 auto; width: 100%`. This bit the
explorer, the agent sidebar and the bottom panel separately.

### `white-space: nowrap` belongs on toolbar buttons only

`.cl-btn` is nowrap so toolbars do not ragged-wrap. A full-width button holding a
sentence must override it, or it forces its container wider than the viewport.
Use `.cl-btn-block`, which wraps and left-aligns.

### The verdict palette is tuned for the cream ground

`--cl-pass` / `--cl-warn` and friends are dark inks. On the navy chrome bars they
are nearly unreadable, so badges there switch to outline form with light-end
hues. If a new surface has a dark ground, it needs the same treatment.

### Per-agent data is not optional

Agents are distinct principals. Anything rendered per-agent — architecture,
blueprint, permissions, budgets — must be derived from the selected agent. A
shared graph made Reporter appear to have an execution path, contradicting
Organization and Permissions. **Blueprint and Permissions still render
Guardian's data for every agent** and should be made per-agent as those phases
are revisited.

When data varies by agent, the memo that builds it must depend on the agent, and
any selection keyed to the old data must reset.

### Keep the wallet lazy

**A `dynamic()` import only helps if nothing on the path imports the module
statically.** Wrapping the runtime in `dynamic()` while a panel three levels down
did `import { ConnectTestnetWallet }` put the whole stack straight back into that
route's bundle — /deploy measured 353 kB against 143 kB everywhere else. Check
the route's First Load JS after any change here; if one route is heavier than its
neighbours, something on it imports the runtime eagerly.

**Turbopack's `resolveAlias` matches exact specifiers — there is no prefix
matching.** Aliasing `@x402/core` does nothing for `@x402/core/client`. All 21
subpaths reached through `@coinbase/cdp-sdk` have to be listed individually;
webpack's `IgnorePlugin` takes a regex and does not.

wagmi + RainbowKit + viem + WalletConnect is ~7,000 modules. Mounted in the
layout it made every route compile all of it (~20s per page in dev, which does
not tree-shake). It lives in `components/studio/wallet/` behind `dynamic()`.

Providers do belong in a layout — just never the **root** one, since a layout's
module graph compiles for every route beneath it. The correct home is a nested
layout scoped to the routes that need it (`deploy/layout.tsx`,
`policies/layout.tsx`), which keeps React context working normally while only
those routes pay the cost.

### A trailing `\b` after a truncated stem never matches

`\bpolic\b` cannot match "policy" — the boundary falls inside the word. Write
`\bpolic\w*\b`. This shipped silently in a refusal detector and only surfaced
because the behaviour was tested with a case list rather than eyeballed.

### Test a refusal in both directions

Any pattern that refuses a request needs the negative case as well as the
positive one. "Disable the policy" must refuse; "Why is Enable Policy disabled?"
must answer. The second is a question about a greyed-out button, and refusing it
reads as the product being broken. Every detector added to
`agent-refusals.ts` gets both cases.

### Product copy, not build notes

No phase numbers, no "in progress", no framework names in anything a user reads.
An unbuilt page says what it is for and that it is not available — nothing else.
Never show a healthy or green state for something that does not exist yet.

### Repo

- Commit messages carry **no Claude attribution trailers**.
- `.gitignore` patterns for build output must be **anchored** (`/build/`, not
  `build/`) — an unanchored pattern matched the `app/.../build/` route segment
  and silently dropped a real page from a commit.
- `npm run dev` uses Turbopack; `npm run dev:webpack` is the fallback. After
  switching between them, `rm -rf .next` or the production build fails with
  `Cannot find module for page: /`.
- **Never `rm -rf .next` — or run `npm run build` — while a dev server is
  running.** Both write that directory. It deletes the running
  server's Turbopack runtime out from under it; the dev server then throws
  `Cannot find module '../chunks/ssr/[turbopack]_runtime.js'` and has to be
  restarted. Run `tsc --noEmit` to check work instead, or ask before clearing.

### Working agreement

Build one phase, stop, and let the UI be reviewed before starting the next.

---

## Decisions on record

1. **Design system over spec theme.** Spec §8.3 asks for a dark IDE. We use the
   landing site's cream/blue palette and fonts across every page instead.
2. **No Tailwind, no shadcn.** Components are hand-rolled against the site's
   tokens in `public/styles/studio.css`, scoped under `.cl-studio`, so the
   landing page is untouched.
3. **Libraries added only where the spec names them:** `@xyflow/react`
   (Architecture), `@monaco-editor/react` (Code), `@tanstack/react-query`
   (server state), `lucide-react` (icons), `wagmi` + `viem` +
   `@rainbow-me/rainbowkit` (wallet).
4. **Mock data layer mirrors the real artifact shapes** (`lib/studio/mock/*`),
   so backend wiring is a data-source swap, not a rewrite.
5. **Chrome slightly taller than spec dimensions** — title bar 44px (spec 40),
   status bar 26px (spec 24) — for legibility at the chosen type scale.

## 2026-09-13 — The Graph enabled; Ledger over USB

- **The Graph**: `THEGRAPH_API_KEY` (Studio backend env) now drives a real gateway transport
  (`packages/studio-adapters/src/adapters/thegraph/gateway.ts`) behind the subgraph adapter. Fork
  deployments read the Uniswap v3 USDC/WETH 0.05% pool *at the fork block* into the sealed market
  snapshot as a `THE_GRAPH` / `INDEXED_CHAIN_DATA` source with the indexer's lag recorded.
  `/api/lab/reality/modes` reports the source HEALTHY and lists `configuredSecretNames`; the
  Integrations, Reality and Overview screens follow. Token API and Substreams stay modelled (they
  take a Graph Market JWT, not a gateway key).
- **Ledger**: upstream commit `0fbb884` (WebHID sheet + hook) pulled in under
  `components/studio/ledger/`, extended with EIP-712 typed-data signing
  (`signEIP712Message`, hashed fallback for Nano S). Overview → "Waiting for a human" offers
  *Browser wallet* or *Ledger over USB*; Deploy can pick a Ledger's address as the approver.
  `/ledger-demo` is the upstream harness (Sepolia transfer, signed not broadcast).

## 2026-09-13 — Studio credentials under the Ledger Key Ring

- `apps/studio/src/secrets.ts`: protected secrets with two sources — `ledger-key-ring` (a
  `wallet-cli ring encrypt` ciphertext in `secrets/<name>.ring`, decrypted through
  `packages/ledger`'s `LedgerKeyRing` when used; `WALLET_PASS` from the operator's environment;
  fail-closed, no plaintext fallback) and `env`. Never `getSecret()`: only `withValue(cb)`.
- The Graph gateway transport takes a key *resolver*; `THEGRAPH_API_KEY` is resolved per request
  through the protected source. Verified end to end with a stand-in CLI: env var unset, ciphertext
  on disk → ring decrypt → gateway → block-pinned observation in the sealed fork snapshot.
- `/api/lab/reality/modes` reports `protectedSources` (name, source, ring status — never a value);
  a ring credential counts as available only while the ring on the Studio machine answers.
  Integrations → Credentials shows the boundary (`LEDGER KEY RING` vs `STUDIO SERVER ENVIRONMENT`)
  and a banner with the ring's status.
- Operator flow (one device tap): `wallet-cli ring init --name contextlock-studio`, then
  `scripts/studio/ring-secret.sh THEGRAPH_API_KEY`, remove the plaintext line from `.env`, restart
  with `WALLET_PASS` exported. `@ledgerhq/wallet-cli` 2.1.0 is a root devDependency.
- Tests: `apps/studio/test/secrets.test.ts` (SEC-001…007) against a stand-in wallet-cli.
