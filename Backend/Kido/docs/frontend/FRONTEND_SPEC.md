# **ContextLock Studio Frontend Product & UX Build Specification** 

### **Agentic IDE for Secure Financial Agents** 

## Table of Contents 

## **ContextLock Studio Frontend Product & UX Build Specification** 

##### **Version:** 1.0 

**Product mode:** ContextLock Testnet Lab 

**Audience:** Frontend engineers, product designers, full-stack engineers, QA engineers **Primary UX:** Agentic IDE for designing, proving, deploying and operating financial agents **Status:** Frontend implementation specification for the P0-P28 product surface 

#### **1. Product vision** 

ContextLock Studio should feel like an IDE where the thing being authored is not source code but a **financial agent and its authority model** . 

The user’s mental model should be: 

I describe an agent, inspect how it is built, inspect what it can and cannot do, simulate it, expose it to real market conditions, deploy it to a testnet lab, and operate it from one workspace. 

The frontend must make three ideas visible at all times: 

1. **What am I editing?** - Blueprint, architecture, strategy, code, policy, runtime revision, etc. 

2. **What is real right now?** - Testnet deployment state, runtime health, CRE mode, observed chain state, data freshness. 

3. **What authority exists?** - ALLOW / ESCALATE / DENY boundaries, execution network, current policy state, identity state, emergency controls. 

The UI must never collapse these into a generic dashboard that only says things such as Connected, Healthy, Private, or Live without explaining the exact meaning. 

#### **2. Core UX principles** 

##### **2.1 Agentic IDE, not SaaS dashboard** 

The center of the product is a persistent workspace. Pages open like IDE editors. Users move between Blueprint, Architecture, Simulation, Code, Deploy and Control Plane without losing build/runtime context. 

##### **2.2 One canonical project, many projections** 

Blueprint, architecture, simulation, code, deployment and live state are not independent frontend documents. They are projections of versioned backend artifacts. 

The UI must always show the current revision and stale state. If Blueprint revision 8 invalidates simulations from revision 7, the Simulation page must visibly say STALE rather than continuing to show revision 7 as current. 

##### **2.3 Truth before polish** 

A blocked integration is shown as BLOCKED, an unavailable source as UNAVAILABLE, stale telemetry as STALE, and simulated CRE as SIMULATED. 

Never use a green success state because a component succeeded once in the past. 

##### **2.4 Agent proposes; deterministic systems decide** 

The right-hand assistant can explain, draft, compare and propose changes. It must not become an alternative control plane. 

For security-sensitive actions, the assistant may prepare the operation, but the user completes it through the product’s typed confirmation UI. 

##### **2.5 Testnet boundary is visually obvious** 

Every write-capable surface must make the execution environment explicit. Mainnet may appear as a read-only data source or local fork source, but never as an execution target. 

##### **2.6 Progressive disclosure** 

The default experience should be understandable to a DeFi user who is not a smart-contract engineer. Deep hashes, calldata, provenance and transaction traces are available through inspectors, expandable sections and developer mode. 

#### **3. Global workbench layout** 

ContextLock uses a persistent three-column workbench with a top title bar and bottom status bar. 

┌───────────────────────────────────────────────────────────────────── ────────────────────────────────┐ │ TITLE BAR: Project · Agent · Revision · TESTNET LAB · Command Palette · Global status · User      │ 

├───────────────┬───────────────────────────────────────────────────── ──────────┬─────────────────────┤ │ LEFT           CENTER WORKSPACE                                               RIGHT AGENT         │ │ │ │ NAVIGATION                                                                                        │ │ │ │                Editor tabs                                                    Context Agent       │ │ │ │ Activity rail  │ ───────────────────────────────────────────────────────────│ │ │ + explorer                                                                    Page-aware chat     │ │ │ │                Current page / canvas / editor / dashboard                     Selection-aware     │ │ │ │                                                                               Proposed changes    │ │ │ │                                                                               Explain / ask       │ │ │ │ │ │ │ │ │───────────────────────────────────────────────────────────│ │ │                Optional bottom panel: Problems · Output · Tests · Events                          │ │ │ ├───────────────┴───────────────────────────────────────────────────── ──────────┴─────────────────────┤ 

│ STATUS BAR: execution network · reality source · CRE mode · policy · runtime · sync · blockers     │ 

└───────────────────────────────────────────────────────────────────── ────────────────────────────────┘ 

##### **3.1 Recommended dimensions** 

|Surface|Default|Minimum|Maximum /<br>behavior|
|---|---|---|---|
|Title bar|40 px|40 px|fixed|
|Activity rail|48 px|48 px|fixed|
|Left explorer|224 px|180 px|340 px, resizable|
|Center workspace|flexible|640 px|consumes<br>remaining width|
|Right agent|380 px|300 px|520 px,<br>resizable/collapsi<br>ble|
|Bottom panel|220 px|120 px|55% of center<br>height|
|Status bar|24 px|24 px|fixed|



At widths below ~1180 px, collapse the right Agent Sidebar into a drawer. At widths below ~900 px, the product should become a simplified read-only/monitoring experience rather than trying to reproduce the full authoring IDE. 

##### **3.2 Resizing** 

All three major horizontal regions should use accessible resizable handles. Persist sizes per user/workspace. 

Double-click a resize handle to restore defaults. 

##### **3.3 Center editor tabs** 

The center workspace supports tabs such as: 

Blueprint × | Architecture × | Simulation: PROMPT_INJECTION × | policy.sol × | Deployment #12 × 

##### Rules: 

- Navigation opens or focuses a tab. 

- Single-click navigation may reuse the current preview tab. 

- Double-click/pin keeps a tab open. 

- A dot indicates unsaved client-side edits. 

- A warning icon indicates stale artifact/revision. 

- A live dot means the tab is showing observed runtime state. 

- Tabs restore after refresh. 

##### **3.4 Bottom panel** 

The bottom panel belongs to the center workspace, so the overall product remains a threesegment IDE. 

##### Tabs: 

- **Problems** - validation failures, blockers, stale artifacts. 

- **Output** - build/deploy command output, sanitized. 

- **Tests** - suites, failures, mutations, simulation results. 

- **Events** - live RuntimeEvent stream. 

- **Terminal** - developer-only constrained terminal. Never expose privileged host shell by default. 

##### Buttons: 

- Toggle Panel 

- Maximize Panel 

- Clear (where safe) 

- Follow Output 

- Copy Selected 

- Download Sanitized Log 

#### **4. Global title bar** 

Left to right: 

1. ContextLock mark. 

2. Workspace/project switcher. 

3. Current agent switcher for multi-agent organizations. 

4. Current revision chip. 

5. TESTNET LAB environment badge. 

6. Command/search field. 

7. Global build/deployment status. 

8. Blockers/alerts button. 

9. Notifications. 

10. User/avatar menu. 

##### **4.1 Project switcher** 

Click opens searchable list: 

- Recent projects. 

- Organizations. 

- New Agent Project. 

- Import Project. 

- Open Shared Project where supported. 

##### **4.2 Agent switcher** 

For single-agent projects this simply shows the agent name. 

For organization projects: 

Treasury Department Guardian Rebalancer Reporter 

Selecting an agent updates page context and right-agent context but does not navigate away. 

##### **4.3 Revision chip** 

Example: 

Blueprint r8 · Deploy r3 · Runtime r3 

Click opens the revision drawer with: 

- current Blueprint revision; 

- Strategy revision; 

- Build revision; 

- Deployment revision; 

- Runtime revision; 

- CRE artifact hash; 

- stale dependency warnings; 

- Compare revisions button. 

##### **4.4 Global environment badge** 

##### Always visible: 

###### TESTNET LAB 

Tooltip: 

Production-chain execution is disabled. Mainnet may only be used as a read-only data source or isolated local fork. 

##### **4.5 Command palette** 

##### Shortcut: Cmd/Ctrl + K or Cmd/Ctrl + P. 

Searchable commands include: 

- Go to Blueprint. 

- Go to Simulation. 

- Run all simulations. 

- Open Attack Lab. 

- Open latest deployment. 

- Focus Agent Sidebar. 

- Toggle Agent Sidebar. 

- Toggle bottom panel. 

- Compare revisions. 

- Open Problems. 

- Copy project ID. 

- Open current transaction. 

- Disable policy - opens confirmation; never executes directly from palette. 

- Emergency Lock - opens critical confirmation; never executes directly from palette. 

#### **5. Left navigation: Activity Rail + Project Explorer** 

The left segment combines a narrow Activity Rail and contextual Explorer. 

##### **5.1 Activity Rail icons** 

Recommended icons/order: 

1. **Project / Build** 

2. **Design** 

3. **Test** 

4. **Code** 

5. **Deploy** 

6. **Operate** 

7. **Integrations** 

8. **Reports** 9. **Settings** 

Bottom-fixed: 

- Help/docs. 

- Account/settings. 

Clicking an Activity Rail icon changes the Explorer content, similar to an IDE view container. 

##### **5.2 Explorer groups** 

##### _PROJECT_ 

- Composer 

- Organization / Agents 

##### _DESIGN_ 

- Blueprint 

- Architecture 

- Permissions & Security 

##### _TEST_ 

- Simulation 

- Reality Lab 

- Attack Lab 

##### _IMPLEMENT_ 

- Code 

- Integrations & Data Sources 

##### _DEPLOY_ 

- Preflight 

- Deployments 

##### _OPERATE_ 

- Overview 

- Activity 

- Policies 

- Runtime 

- Control Plane 

- Chainlink CRE 

- Identity / ENS 

##### _OUTPUT_ 

- Safety Reports 

- • Evidence 

##### **5.3 Navigation badges** 

Items may show compact badges: 

- 3 validation problems. 

- STALE. 

- BLOCKED. 

- LIVE. 

- SIM. 

- 2 alerts. 

Do not use badge color alone; include icon/text/tooltip. 

#### **6. Right Agent Sidebar - Context Agent** 

The right panel is a permanent product primitive, not a generic chatbot bolted onto the UI. 

##### **6.1 Header** 

Context Agent                           [new thread] [•••] [collapse] Architecture · Guardian Selected: ContextLock Policy node 

Header contains: 

- Page-context chip. 

- Current agent chip. 

- Selected-object chip. 

- Conversation history selector. 

- Clear/new conversation action. 

- Collapse. 

##### **6.2 Input composer** 

Capabilities: 

- multiline prompt; 

- @ mentions for project entities; 

- attach current selection; 

- attach current error/event; 

- voice optional later; 

- submit/stop generation. 

Supported mentions: 

@blueprint @architecture @policy @simulation:PROMPT_INJECTION @deployment:12 @runtime @event:<id> @tx:<hash> @adapter:chainlink-data-feeds @agent:guardian 

The frontend resolves mentions to IDs. Never inject private secrets into model context. 

##### **6.3 Agent response types** 

The panel renders structured response cards, not only markdown text. 

**Explanation** - normal text. 

**Reference** - clickable links to nodes, files, events, policies. 

**Proposed Patch** - typed change with before/after diff. 

Buttons: 

- Review change 

- Apply to draft 

- Reject 

**Suggested Simulation** - scenario proposal. 

Buttons: 

- Open scenario 

- Run 

**Navigation** - Open Architecture, Show transaction, etc. 

**Control suggestion** - never directly executes a privileged control. Example: 

##### Policy state drift is critical. I recommend Emergency Lock. 

Button: 

###### Open Emergency Lock 

This opens the native deterministic control dialog. 

##### **6.4 Agent authority tiers** 

|Tier|Example|Agent maydo immediately?|
|---|---|---|
|Read|Explain this node|Yes|
|Navigate|Open failed simulation|Yes|
|Draft|Propose Blueprint change|Yes, as proposal|
|Safe computation|Create comparison /<br>simulation proposal|Yes|
|Project mutation|Apply Blueprint patch|Requires explicitApply|
|Deployment mutation|Redeploy revision|Native confirmation|
|Financial authority|Enable/disable policy|Native typed control only|
|Emergency|Emergency Lock|Native critical modal only|



Free-text chat is never itself evidence of control authorization. 

##### **6.5 Page-specific quick prompts** 

The first empty-state suggestions change by page. Examples are specified under each page below. 

##### **6.6 Selection awareness** 

Selecting an Architecture node, code range, simulation row, alert, transaction or policy automatically changes the Context Agent’s selection chip. 

The chat does not silently send the entire project on every turn. Send only the page context, explicit selections, relevant artifacts and safe summaries. 

##### **6.7 Agent answer citations inside product** 

Answers should cite internal artifacts using clickable chips: 

Blueprint r8 · Policy CL-17 · Simulation 31 · Event evt_... 

Do not display opaque IDs when a human label exists. 

#### **7. Global status bar** 

Always visible at the bottom. 

Recommended items: 

TESTNET | Exec: Sepolia | Reality: Mainnet READ ONLY | CRE: Simulator | Policy: Disabled | Runtime: Stopped | Sync: 3s | Problems: 2 

Click behavior: 

- TESTNET -> explains network boundary. 

- execution network -> opens Deploy/Environment inspector. 

- Reality -> opens Reality Lab. 

- CRE -> opens CRE page. 

- Policy -> opens Policies page. 

- Runtime -> opens Runtime page. 

- Sync -> opens Control Plane freshness details. 

- Problems -> opens bottom Problems panel. 

Never display Policy: Enabled from frontend optimistic state; it must represent fresh observed backend/chain state. 

#### **8. Common visual language** 

##### **8.1 Status vocabulary** 

Use the same status vocabulary across all pages: 

- READY 

- RUNNING 

- PASS 

- WARN 

- ESCALATE 

- DENY 

- FAIL 

- BLOCKED 

- UNAVAILABLE 

- DEGRADED 

- STALE 

- PAUSED 

- STOPPED 

- UNKNOWN 

Avoid synonyms such as Okay, Fine, Good, Working for machine states. 

##### **8.2 Verdict colors** 

Recommended semantic palette: 

- ALLOW / PASS: green. 

- ESCALATE / WARN: amber. 

- DENY / ERROR / destructive: red. 

- SIMULATED / informational: violet. 

- MAINNET READ ONLY / data: cyan. 

- BLOCKED / unavailable: gray with warning icon. 

Every color-coded state also includes text/icon. 

##### **8.3 Base visual style** 

Dark IDE-first theme: 

- near-black canvas; 

- slightly lighter panels; 

- subtle 1px borders; 

- minimal shadows; 

- compact 12-14px UI typography; 

- monospace for hashes, addresses, code and reason codes; 

- 16-20px content text for major empty states; 

- generous canvas space, dense inspectors. 

Use rounded corners sparingly. The product should feel like a professional development environment, not a card-heavy consumer dashboard. 

##### **8.4 Light theme** 

Support light theme, but dark should be the default design target. 

## **9. Entry surfaces outside the IDE** 

#### **9.1 Projects / Home** 

##### **Purpose** 

Give the user one place to create/open projects before entering the IDE workbench. 

##### **Layout** 

Top area: 

- ContextLock Studio. 

- Search projects. 

- New Agent primary button. 

- User menu. 

##### Center: 

- Recent projects table/cards. 

- Organization projects. 

- Templates. 

Project row fields: 

- Name. 

- Agent count. 

- State. 

- Last revision. 

- Execution network. 

- CRE mode. 

- Last updated. 

- Alerts. 

##### **Buttons** 

- **New Agent** -> new-project modal. 

- **Open** -> enter IDE at last active page. 

- **Duplicate** -> copy as new draft, never copy active authority. 

- **Archive** -> confirmation. 

- **Import** -> import validated ContextLock project bundle. 

##### **New-project modal** 

Fields: 

- Project name. 

- Single agent / multi-agent organization. 

- Template optional. 

- Start from description. 

Primary button: Create Project. 

## **10. Page specification: Composer / Build** 

#### **Purpose** 

The starting surface for natural-language agent creation and major agent revisions. 

#### **Center layout** 

##### Header: 

Build Agent                                  Draft · Blueprint not generated Describe what this agent should do and the boundaries it must obey. 

##### Main composition: 

┌────────────────────────────────────────────────────┐ │ Large agent description editor                     │ │ │ │ "Build an Aave guardian..."                       │ └────────────────────────────────────────────────────┘ 

[Examples] [Import requirements]                     [Generate Blueprint] 

Detected Requirements 

┌──────────────────────┬─────────────────────────────┐ │ Objective             Prevent liquidation         │ │ │ Protocol              Aave                        │ │ │ Missing hard cap      REQUIRED                    │ │ └──────────────────────┴─────────────────────────────┘ 

#### **Sections** 

##### **Prompt editor** 

##### Features: 

- autosave draft; 

- optional structured prompt snippets; 

- command /limits, /protocol, /data, /forbid helpers; 

- no secret input. 

##### **Detected requirements** 

Live parser may show candidate requirements, but must clearly label them DRAFT until deterministic Requirements output exists. 

##### **Build timeline** 

After generation starts: 

Requirements        PASS Blueprint           RUNNING Security Review     PENDING User Review         PENDING 

Build               PENDING Tests               PENDING 

Clicking a stage opens detail in bottom Output/Tests panel. 

#### **Buttons** 

**Generate Requirements / Generate Blueprint** - starts backend build pipeline; - disabled while required project setup is invalid; - shows usage/quota warning if near limit. 

**Examples** - opens examples palette. 

**Import Requirements** - accepts validated JSON/file. 

**Cancel Build** - available during model/build stages; - sends explicit stop request; - does not destroy already persisted artifacts. 

**Resume Build** - appears after paused/upstream-limit state. 

#### **Right Agent suggestions** 

- Help me turn this goal into explicit limits. 

- What important financial boundary is missing? 

- Explain why the build is blocked. 

- Rewrite this goal without changing its authority. 

Agent may propose text changes but does not fabricate missing ceilings. 

#### **States** 

- Empty. 

- Draft. 

- Generating. 

- Requirements incomplete. 

- Awaiting user review. 

- Build paused by quota. 

- Failed. 

- Complete. 

## **11. Page specification: Organization / Agents** 

#### **Purpose** 

Manage multi-agent organizations as distinct principals rather than one super-agent. 

#### **Center layout** 

Organization tree on left side of center content; selected agent details on right. 

###### Treasury Department 

- ├─ Guardian       HEALTHY 

- ├─ Rebalancer     PAUSED 

- └─ Reporter       READ ONLY 

Selected agent pane: 

- ENS identity. 

- Role/objective. 

- Execution class. 

- Allowed adapters. 

- Individual budget. 

- Organization aggregate budget impact. 

- Policy hash. 

- Runtime revision. 

- Current status. 

#### **Buttons** 

- Add Agent - creates draft principal. 

- Duplicate as New Agent - duplicates configuration but forces new identity/domain/policy. 

- Open Blueprint. 

- Open Architecture. 

- Open Policy. 

- Revoke Agent - native security confirmation. 

- Remove Draft Agent - only if not deployed. 

#### **Critical UI rules** 

If two agents share a forbidden security primitive, show a blocking issue such as: 

CRITICAL - shared policy principal 

Reporting-only agents must visibly show: 

EXECUTION: NONE 

#### **Right Agent suggestions** 

- Compare Guardian and Rebalancer authority. 

- Why can't Reporter execute? 

- Show aggregate budget risk. 

## **12. Page specification: Blueprint** 

#### **Purpose** 

Human-readable and machine-precise representation of the canonical ContextLock Agent Blueprint. 

#### **Center layout** 

Toolbar: 

Blueprint r8 · VALID · Edit draft · Compare · Raw JSON 

Content uses sectioned structured forms: 

1. Identity. 

2. Objective. 

3. Protocols. 

4. Assets. 

5. Triggers. 

6. Actions. 

7. Permissions. 

8. Autonomous policy. 

9. Escalation policy. 

10. Confidential policy. 

11. Data requirements. 

12. Capability policy. 

13. ENS. 

14. CRE. 

15. Ledger/elevation. 

16. Execution networks. 

17. Simulation requirements. 

18. Generated modules/adapters. 

19. Security assertions. 

#### **Editing mode** 

Do not immediately mutate current live Blueprint. 

Edit Blueprint creates a draft revision. 

Fields changed from current revision get a left-side change marker. 

Authority-increasing changes are visually highlighted. 

##### Example: 

Autonomous amount $500 → $1,000 

###### AUTHORITY EXPANSION 

Agent may autonomously move an additional $500 per action. 

#### **Buttons** 

- **Edit Blueprint** -> create draft revision. 

- **Save Draft** . 

- **Validate** -> deterministic validator. 

- **Discard Draft** . 

- **Compare Revision** . 

- **Generate Architecture** / focus architecture after valid save. 

- **Raw JSON** toggle. 

- **Copy JSON** . 

- **Export Blueprint** . 

Primary publish action: 

Create Revision rather than Save when editing an already built/deployed agent. 

#### **Validation panel** 

Errors grouped: 

- schema; 

- security invariant; 

- missing required information; 

- trust/freshness; 

- adapter compatibility; 

- execution network. 

Click error -> scroll/focus field. 

#### **Right Agent suggestions** 

- Explain this field. 

- Is this authority broader than revision 7? 

- Propose a safer autonomous limit. 

- Why is BP-xxx failing? 

- Show which pages become stale if I apply this change. 

Agent proposals render as Blueprint patch cards with Apply/Reject. 

## **13. Page specification: Architecture** 

#### **Purpose** 

Visualize how the agent obtains identity, context, policy decisions and execution authority. 

#### **Technology** 

Use React Flow for canvas, nodes, edges, minimap and zoom/fit/lock controls. 

#### **Center layout** 

Full-canvas graph with small toolbar: 

[Fit] [Zoom -] [Zoom +] [Lock] [Layers] [Live Overlay] [Export SVG] 

##### **Node categories** 

- User / operator. 

- Agent runtime. 

- ENS identity. 

- ContextLock policy/broker. 

- CRE simulator / CRE DON. 

- Chainlink feed/stream. 

- The Graph. 

- Aave. 

- Uniswap. 

- Adapter Broker. 

- Reality Engine. 

- Local Fork. 

- Capability. 

- Executor. 

- Treasury. 

- Ledger / approval. 

##### **Edge categories** 

Use labeled edges: 

- READ. 

- CONTEXT. 

- TRIGGER. 

- POLICY. 

- AUTHORIZATION. 

- EXECUTE. 

- ESCALATE. 

##### **Live overlay** 

When deployed, same graph overlays states: 

- HEALTHY. 

- DEGRADED. 

- SIMULATED. 

- DISABLED. 

- BLOCKED. 

- STALE. 

Do not regenerate a separate live graph. 

#### **Node selection inspector** 

Click a node -> open an inspector drawer **inside the center workspace** , not over the right Agent Sidebar. 

Inspector fields: 

- configured purpose; 

- adapter/provider; 

- version; 

- trust class; 

- network role; 

- status; 

- last verified; 

- relevant hash/address; 

- capabilities; 

- generated module; 

- recent related events. 

Buttons depend on node: 

- Open Blueprint section. 

- Open Code. 

- Open Activity. 

- Run related simulation. 

- View provenance. 

No destructive controls inside node inspector. 

#### **Layer menu** 

Toggle: 

- Identity. 

- Data. 

- Policy. 

- Execution. 

- Runtime. 

- Live health. 

- Security boundaries. 

#### **Right Agent suggestions** 

- Explain this architecture. 

- Trace how money can move. 

- What happens if this node is compromised? 

- Why does this edge require CRE? 

- Trace authority from user to executor. 

- selected node: Explain this node. 

## **14. Page specification: Permissions & Security** 

#### **Purpose** 

Give the clearest possible answer to: **What can this agent do, and what can it never do?** 

#### **Center layout** 

Top security summary: 

Security posture: PASS Execution: Sepolia only Mainnet writes: PROHIBITED Policy: revision 8 

Three primary columns: 

##### **ALLOW** 

Examples: 

- Read Aave position. 

- Read verified price. 

- Repay <= $1,000. 

##### **ESCALATE** 

- Repay $1,000-$5,000. 

##### **DENY** 

- Above $5,000. 

- Borrow. 

- Withdraw collateral. 

- External recipient. 

- Mainnet writes. 

Additional panels: 

- Capability bindings. 

- Recipient/target restrictions. 

- Expiry/nonce rules. 

- Data trust requirements. 

- Confidentiality evidence. 

- Identity/revocation. 

- Organization aggregate rules. 

#### **Buttons** 

- Open Policy. 

- Compare revisions. 

- Run boundary simulations. 

- Export permission summary. 

- Create policy revision. 

Never expose Enable policy here as a casual button. Security state changes belong to Policies/Control Plane with confirmation. 

#### **Right Agent suggestions** 

- Summarize the blast radius if the agent is compromised. 

- Explain ALLOW vs ESCALATE. 

- Find authority increases since last revision. 

- Which attack simulations prove this deny rule? 

## **15. Page specification: Simulation Center** 

#### **Purpose** 

Run deterministic ContextLock simulations and official CRE workflow simulations, with exact reason codes. 

#### **Center layout** 

Sub-layout: 

┌──────────────────┬────────────────────────────────────────────┐ │ Scenario list     Scenario detail / execution path           │ │ │ │ │ │ Baseline          Selected scenario                           │ │ │ Security          Input                                       │ │ │ Protocol          Mutation                                    │ │ │ CRE               Expected vs actual                          │ │ │ Organization      Security path                               │ │ └──────────────────┴────────────────────────────────────────────┘ 

##### **Scenario list** 

##### Group by: 

- Baseline. 

- Policy boundaries. 

- Prompt injection. 

- Mutation/replay. 

- ENS/policy lifecycle. 

- Data/freshness. 

- Adapter failures. 

- Protocol-specific. 

- Cross-chain. 

- Organization. 

- CRE. 

##### Rows show: 

###### PASS/FAIL · scenario name · last run · revision. 

##### **Scenario detail** 

##### Fields: 

- scenario ID; 

- revision; 

- deterministic inputs; 

- expected result; 

- actual result; 

- reason code; 

- changed fields; 

- layers evaluated; 

- timing; 

- relevant logs. 

#### **Buttons** 

- Run All. 

- Run Selected. 

- Stop Run. 

- Create Scenario. 

- Duplicate. 

- Reset to Template. 

- Compare Runs. 

- Open failed assertion. 

- Run CRE Simulation when applicable. 

Run All displays estimated count and does not consume the user-requested simulation allowance for mandatory security regression if backend distinguishes those quotas. 

#### **Result visualization** 

Security path example: 

Input                 PASS Blueprint             PASS Strategy              PASS CRE Simulator         PASS ContextLock Policy    DENY: RECIPIENT_NOT_ALLOWED Capability            NOT ISSUED Transaction           NOT SUBMITTED 

#### **Stale state** 

If Blueprint changed: 

SIMULATION STALE Built against Blueprint r7. Current Blueprint is r8. [Re-run] 

Do not show old green checks as current. 

#### **Right Agent suggestions** 

- Explain why this scenario denied. 

- Why did expected and actual differ? 

- Create an edge case around this threshold. 

- Show the exact security field that changed. 

## **16. Page specification: Reality Lab** 

#### **Purpose** 

Expose real mainnet read-only context, local forks, snapshots and synthetic overlays without blurring execution authority. 

#### **Center header** 

Two very prominent fields: 

MARKET SOURCE Ethereum Mainnet · READ ONLY 

EXECUTION TARGET 

Ethereum Sepolia · TESTNET 

Never merge them. 

#### **Reality mode selector** 

- **Live Mainnet Mirror** . 

- **Historical Replay** . 

- **Local Mainnet Fork** . 

- **Synthetic** . 

Each option shows Available / Blocked / Limited. 

Current blocked examples should be represented honestly: 

- The Graph auth missing -> UNAVAILABLE. 

- archive RPC missing -> Historical Replay LIMITED/BLOCKED. 

#### **Live Mirror panels** 

##### **Snapshot header** 

- Snapshot ID. 

- Mainnet anchor block/hash. 

- Created at. 

- Age. 

- Coherence. 

- Hash. 

##### **Sources** 

Rows: 

- provider; 

- value/data type; 

- trust class; 

- source block/time; 

- freshness; 

- lifecycle/deprecation; 

- status. 

##### **Provenance drawer** 

Click source -> full provenance. 

#### **Local Fork panel** 

##### Fields: 

- fork ID; 

- source chain; 

- block number/hash; 

- Anvil version; 

- state; 

- local endpoint hidden from ordinary user unless developer mode; 

- resource lifetime. 

##### Buttons: 

- Create Fork. 

- Reset Fork. 

- Snapshot Fork. 

- Restore. 

- Destroy Fork. 

- Run Agent on Fork. 

##### **Fork transaction presentation** 

Must say: 

###### LOCAL FORK TRANSACTION 

Never show public explorer link. 

#### **Synthetic overlay** 

Presets: 

- ETH -10%. 

- ETH -30%. 

- Flash crash. 

- Oracle stale. 

- Liquidity -50%. 

- Graph lag. 

Buttons: 

- Apply Overlay. 

- Clear Overlay. 

- Compare with Base. 

Base snapshot is immutable. 

#### **Right Agent suggestions** 

- Explain why this source is VERIFIED_ORACLE. 

- Is this snapshot coherent enough for the strategy? 

- What happens under a 30% ETH drop? 

- Why is Historical Replay blocked? 

- Compare fork execution with testnet execution. 

## **17. Page specification: Attack Lab** 

#### **Purpose** 

Turn ContextLock’s security model into an interactive, understandable product feature. 

#### **Center layout** 

Left within center: attack catalog. 

Right: attack configuration + result. 

##### **Categories** 

- Prompt / agent compromise. 

- Transaction mutation. 

- Replay / expiry. 

- Identity / ENS. 

- Data / oracle. 

- Policy. 

- CRE/runtime. 

- Cross-agent. 

- Cross-chain. 

- Network boundary. 

##### **Attack cards** 

Each card shows: 

- attack name; 

- applicable/not applicable; 

- severity; 

- last result; 

- stopping layer. 

##### Examples: 

- Prompt Injection. 

- Amount Mutation. 

- Recipient Mutation. 

- Target Mutation. 

- Replay. 

- Expired Capability. 

- ENS Revocation. 

- Policy Change. 

- Stale Oracle. 

- Oracle Disagreement. 

- CRE Simulator Crash. 

- Runtime Compromise. 

- Wrong Chain. 

- Mainnet Write Attempt. 

- Cross-Agent Fake Approval. 

- CCIP Wrong Destination. 

#### **Attack detail** 

Display original vs mutated values. 

Example: 

Recipient Mutation 

Original 0xTreasury... 

Injected 0xAttacker... 

RESULT DENIED 

Stopped by ContextLock Policy 

Reason RECIPIENT_NOT_ALLOWED 

Capability NOT ISSUED 

#### **Buttons** 

- Run Attack. 

- Run All Applicable. 

- View Security Path. 

- Compare with Baseline. 

- Open Policy Rule. 

- Open Simulation. 

- Export Result. 

#### **Mainnet write attack** 

Always available for write-capable agents. 

Result should list only defenses actually exercised. 

#### **Right Agent suggestions** 

- Explain why this attack failed. 

- What would happen if this policy check were removed? 

- Which layer first stopped this attack? 

- Create a stronger variant of this attack. 

Agent may suggest attack cases but cannot modify production controls silently. 

## **18. Page specification: Code** 

#### **Purpose** 

Expose actual generated sandbox files for engineers without making code the primary product abstraction. 

#### **Technology** 

Use Monaco Editor. 

#### **Center layout** 

Three sub-regions inside center: 

File tree | Monaco editor | optional diff/preview 

File tree groups: 

- Generated agent. 

- ContextLock modules. 

- Adapter modules. 

- Tests. 

- CRE workflow. 

- Deployment. 

- Config. 

##### Mark files: 

- generated; 

- template-owned; 

- modified; 

- stale; 

- locked/generated from Blueprint. 

#### **Toolbar** 

- language/file breadcrumb; 

- revision; 

- read-only/edit status; 

- Diff; 

- Open in split; 

- Copy; 

- Download. 

#### **Editing rules** 

Default generated code is read-only after a successful build. 

Developer mode may allow edits in an explicit draft workspace, but edited generated code must invalidate artifact correspondence and require revalidation/rebuild before deployment. 

Never let a manual code edit remain invisible to Blueprint/artifact validation. 

#### **Diff editor** 

Use Monaco Diff Editor for: 

- revision compare; 

- generated change review; 

- Agent Sidebar proposed patch; 

- template upgrade. 

#### **Buttons** 

- Rebuild from Blueprint. 

- Run tests. 

- Open Problems. 

- Compare revision. 

- Download project. 

- . 

- Copy file path 

Optional developer-only: 

- Open constrained terminal. 

#### **Right Agent suggestions** 

- Explain this file. 

- Explain selected code. 

- Which Blueprint field generated this? 

- Find the test that covers this policy. 

- Propose a patch. 

Patch must render as diff and require Apply. 

## **19. Page specification: Integrations & Data Sources** 

#### **Purpose** 

Manage registered adapters, data trust, credentials and source health. 

#### **Center layout** 

Tabs: 

- **Adapters** . 

- **Data Sources** . 

- **Credentials** . 

- **Custom/OpenAPI** . 

##### **Adapter table** 

Columns: 

- name; 

- adapter ID/version; 

- type; 

- network; 

- capabilities; 

- trust class; 

- status; 

- source lifecycle; 

- used by agents. 

Row click opens inspector. 

##### **Data Sources** 

##### Example rows: 

Chainlink ETH/USD  VERIFIED_ORACLE  HEALTHY The Graph          INDEXED          UNAVAILABLE · API key required Mainnet RPC        READ ONLY        HEALTHY 

##### **Credentials** 

##### Never show values. 

##### Rows: 

- logical credential name; 

- scope; 

- storage boundary; 

- status; 

- last verified; 

- used by; 

- rotate/reconnect controls. 

##### Possible boundaries: 

- Local Bridge. 

- CRE local session. 

- secret manager. 

- none/public. 

##### **Custom/OpenAPI** 

- import spec; 

- validation results; 

- allowed host; 

- auth type; 

- generated adapter; 

- conformance status. 

#### **Buttons** 

- Add Integration. 

- Import OpenAPI. 

- . 

- Configure credential 

- Test connection. 

- View provenance. 

- Run conformance tests. 

- Disable adapter where allowed. 

#### **Right Agent suggestions** 

- Which source satisfies my verified-price requirement? 

- Why can't The Graph replace Chainlink here? 

- Explain this adapter's trust class. 

- What breaks if I disable this source? 

## **20. Page specification: Deploy / Preflight** 

#### **Purpose** 

Convert a verified build into a safe Testnet Lab deployment while making costs, artifacts, networks and blockers explicit. 

#### **Center layout** 

Step-based deployment workbench. 

|1 Build               PASS|
|---|
|2 Security            PASS|
|3 CRE Simulation      PASS|
|4 Reality             PASS|
|5 Network             Sepolia|
|6 Wallet              PASS|
|7 Cost                READY|
|8 Runtime image       READY|
|9 Approval            REQUIRED|



##### **Deployment summary** 

##### Show: 

- execution testnet; 

- mainnet-read status; 

- exact Blueprint/build revision; 

- contract reuse/deploy plan; 

- runtime image digest; 

- CRE mode; 

- CRE WASM hash; 

- security score/status; 

- blockers. 

##### **Cost estimate** 

Separate sections: 

**One-time deployment gas** - candidate transaction; - estimated gas; - current fee assumption; - estimated native token; - safety buffer; - recommended wallet balance; - actual balance. 

**Expected execution costs** - informational per-action estimate. 

**Model usage** - expected usage/cost estimate. 

**Runtime hosting** - runtime estimate if available. 

**CRE** - simulator / private-registry / runtime usage classification. 

Do not merge into one misleading total. 

#### **Buttons** 

- . 

- Run Preflight 

- Refresh Estimate. 

- Connect Testnet Wallet. 

- Fund Testnet Wallet - informational/faucet links only if approved, never claim value. 

- Run CRE Simulation. 

- View artifact hashes. 

- Review Deployment Plan. 

- Deploy to Testnet Lab - primary. 

- Cancel Deployment where state permits. 

- Resume Deployment. 

##### **Deployment confirmation modal** 

Must contain: 

- network; 

- transactions count; 

- estimated balance requirement; 

- Blueprint/build revision; 

- policy begins disabled; 

- CRE mode; 

- runtime image digest; 

- explicit Production-chain execution: DISABLED. 

Primary: Deploy Testnet Agent. 

No ambiguous Confirm alone. 

##### **Deployment progress** 

Preparing release Deploying contracts Configuring policy DISABLED Verifying contracts Building/verifying runtime Starting CRE simulator Starting runtime Running health checks READY TO ACTIVATE 

#### **Right Agent suggestions** 

- Explain this gas estimate. 

- Why is deployment blocked? 

- Which contracts will be reused? 

- What exactly will happen when I deploy? 

Agent cannot deploy directly from chat. 

## **21. Page specification: Overview** 

#### **Purpose** 

Primary post-deployment status page for ordinary users. 

#### **Header** 

Example: 

AAVE GUARDIAN                      ● TESTNET LAB ACTIVE Execution: Sepolia Reality: Ethereum Mainnet · READ ONLY CRE: Official CLI Simulator Production-chain execution: DISABLED 

Never display LIVE without qualification. 

#### **Top status strip** 

Cards/compact tiles: 

- Policy. 

- Runtime. 

- CRE. 

- ENS identity. 

- Required adapters. 

- Current revision. 

- Alerts. 

Each tile includes last verified time. 

#### **Main content** 

##### **Agent objective** 

One-sentence purpose. 

##### **Authority usage** 

- autonomous limit; 

- used in window; 

- escalation band; 

- hard deny ceiling. 

##### **Live architecture** 

Compact version of Architecture graph with observed overlay. 

##### **Recent decisions** 

Rows: 

- time; 

- verdict; 

- action; 

- amount; 

- reason; 

- execution result. 

##### **Market context** 

- snapshot age; 

- verified price; 

- source/trust; 

- mainnet read-only badge. 

##### **Alerts** 

Only open important alerts. 

#### **Buttons** 

- Open Activity. 

- Run Simulation. 

- Attack Test. 

- Pause Runtime. 

- Disable Policy. 

- Emergency Lock. 

Disable Policy and Emergency Lock use security dialogs. 

#### **Right Agent suggestions** 

- Summarize what this agent has done today. 

- Why did the last decision escalate? 

- Are any data sources stale? 

- Explain current authority usage. 

## **22. Page specification: Activity** 

#### **Purpose** 

Queryable audit timeline across agent, CRE, policy, chain, adapters and runtime. 

#### **Center layout** 

Top filter bar: 

- time range; 

- agent; 

- source; 

- verdict; 

- severity; 

- adapter; 

- chain; 

- transaction; 

- correlation ID. 

Timeline/table supports virtualization. 

##### Columns: 

- timestamp; 

- source; 

- event; 

- verdict/status; 

- summary; 

- correlation; 

- tx/reference. 

Click a row opens detail drawer. 

#### **Event detail drawer** 

- event ID; 

- RuntimeEvent schema; 

- agent/project/deployment; 

- source; 

- type; 

- time; 

- reason code; 

- public metadata; 

- related events; 

- capability/authorization; 

- transaction; 

- CRE execution; 

- revision; 

- source freshness. 

##### Buttons: 

- Trace full run. 

- Open transaction for real testnet transactions only. 

- Open decision. 

- Open simulation. 

- Copy correlation ID. 

- Export sanitized trace. 

##### **Correlation view** 

Visual vertical sequence: 

Trigger Data reads Strategy CRE ContextLock Capability Transaction Receipt Finalized 

#### **Right Agent suggestions** 

- Summarize this run. 

- Why did this event happen? 

- Trace this transaction back to the trigger. 

- Compare this run with the previous one. 

## **23. Page specification: Policies** 

#### **Purpose** 

View and safely revise the current ContextLock financial authority state. 

#### **Center layout** 

##### Header: 

ContextLock Policy Observed: DISABLED Verified 4s ago · Sepolia Policy version: 8 

##### **Current authority matrix** 

- actions; 

- limits; 

- recipients; 

- targets; 

- trust/freshness; 

- expiry/nonce; 

- escalation requirements. 

##### **On-chain state** 

- enabled/disabled; 

- policy hash; 

- admin; 

- relevant addresses; 

- last verified block. 

##### **Drift** 

Expected vs observed. 

#### **Buttons** 

- Refresh Chain State. 

- Create Policy Revision. 

- Compare Policy. 

- Run Policy Simulations. 

- Disable Policy. 

- Enable Policy only when all backend preconditions pass. 

##### **Disable Policy modal** 

Show: 

- chain; 

- contract; 

- current state; 

- intended state; 

- signer; 

- estimated testnet gas; 

- consequence. 

##### Button: Disable Financial Authority. 

After submission, UI remains DISABLING until fresh chain read proves disabled. 

##### **Enable Policy modal** 

More restrictive than disable. 

Show preconditions: 

- deployment verified; 

- runtime revision healthy; 

- required CRE mode healthy; 

- identity active; 

- adapters healthy; 

- no critical drift; 

- testnet network guard. 

Button: Enable Testnet Financial Authority. 

#### **Right Agent suggestions** 

- Explain this policy. 

- What changes if I increase this limit? 

- Which simulations prove this rule? 

- Why is Enable Policy disabled? 

Agent cannot directly issue enable/disable command. 

## **24. Page specification: Runtime** 

#### **Purpose** 

Operate the containerized agent process and inspect runtime health without confusing process state with financial authority. 

#### **Center layout** 

##### **Runtime status** 

- state; 

- revision; 

- image digest; 

- started at; 

- heartbeat; 

- broker connectivity; 

- model gateway; 

- event cursor; 

- credential validity; 

- restart count. 

##### **Resource metrics** 

- CPU; 

- memory; 

- uptime; 

- requests; 

- errors; 

- optional network/broker traffic. 

##### **Health dependencies** 

Process              HEALTHY Model Gateway        HEALTHY Adapter Broker       HEALTHY ContextLock Broker   HEALTHY 

Event Cursor         HEALTHY Overall              HEALTHY 

A running process with broken broker = DEGRADED. 

##### **Runtime revisions** 

List recent revisions with: 

- image digest; 

- Blueprint/build revision; 

- created; 

- status; 

- previous/current. 

#### **Buttons** 

- Start Runtime. 

- Pause Runtime. 

- Resume Runtime. 

- Restart Runtime. 

- Stop Runtime. 

- Rollback Runtime. 

- Open Logs. 

- Compare Image Revision. 

Important warning beside pause/stop: 

Runtime controls stop agent processing. They do not by themselves disable on-chain financial authority. 

#### **Rollback modal** 

Show current vs target digest and compatibility checks. 

Button: Roll Back Runtime. 

After revision switch, old runtime credential must be fenced; frontend shows fence verification. 

#### **Right Agent suggestions** 

- Why is runtime degraded? 

- Explain this restart loop. 

- Compare runtime revisions. 

- Will stopping runtime disable the policy? 

## **25. Page specification: Control Plane** 

#### **Purpose** 

Operator-grade view of all live components, reconciliation, alerts and emergency controls. 

#### **Center header** 

Control Plane Last full reconciliation: 5s ago 

#### **System topology** 

Grid or compact topology: 

- Chain observer. 

- Policy state. 

- ENS. 

- Agent runtime. 

- CRE mode/runtime. 

- Adapter health. 

- Model gateway. 

- ContextLock broker. 

- Event pipeline. 

- • Telemetry. 

Each has: 

- current state; 

- freshness; 

- expected state; 

- drift; 

- last failure. 

#### **Reconciliation panel** 

Expected vs observed: 

Policy enabled       expected false | observed false Consumer code hash   expected ...   | observed ... Admin                expected ...   | observed ... Runtime digest       expected ...   | observed ... 

Differences open alert/details. 

#### **Alerts table** 

Columns: 

- severity; 

- alert type; 

- resource; 

- first seen; 

- last seen; 

- occurrences; 

- state. 

Buttons: 

- Acknowledge. 

- Resolve only after evidence/reconciliation. 

- Open evidence. 

- Run reconciliation. 

#### **Control groups** 

**Operational** - Pause/Resume Runtime. 

**CRE** - Start/Stop/Restart Simulator; or Pause/Activate real workflow. 

**Financial Security** - Disable Policy. 

**Identity** - Revoke Agent. 

**Emergency** - Emergency Lock. 

#### **Emergency Lock button** 

Large, visually distinct, not constantly flashing. 

Click opens critical modal: 

Emergency Lock 

This will attempt, in order: 

1. Disable ContextLock policy 

2. Block new capabilities 

3. Pause/stop CRE path 

4. Stop agent runtime 

5. Optionally revoke agent identity 

The financial policy is attempted first. 

Checkbox optional: 

Also revoke ENS identity 

Button requires deliberate confirmation: 

###### EMERGENCY LOCK TESTNET AGENT 

Never run Luna before issuing deterministic emergency command. 

#### **Emergency progress** 

Persist per-step: 

Disable policy          PASS Block capability issue  PASS Pause CRE               FAIL Stop runtime            PASS Revoke ENS              NOT REQUESTED 

Result EMERGENCY_LOCK_PARTIAL Financial policy: DISABLED 

Do not hide partial success/failure. 

#### **Right Agent suggestions** 

- Explain the current system health. 

- What does this drift mean? 

- Summarize critical alerts. 

- Why is Emergency Lock partial? 

If agent recommends Emergency Lock, button only opens native modal. 

## **26. Page specification: Chainlink CRE** 

#### **Purpose** 

Make simulator vs user-simulated vs real-DON state completely explicit. 

#### **Center header** 

Example: 

Chainlink CRE Mode: OFFICIAL CLI SIMULATION 

#### **Status card** 

Fields: 

- mode; 

- CRE CLI version; 

- account mode; 

- organization if user connected; 

- Deploy Access; 

- registry; 

- simulation ID or workflow ID; 

- workflow WASM hash; 

- config hash; 

- production limits; 

- last run; 

- status; 

- DON deployment; 

- hardware TEE evidence. 

##### **Truth labels** 

For simulator: 

Official CRE simulation     YES Real DON                     NO Real DON consensus           NO Hardware TEE                 NO 

For actual deployment, update only evidence-supported fields. 

#### **CRE mode selector** 

Show modes as cards, not a simple unlabeled dropdown: 

##### **ContextLock Simulator** 

- Official CLI simulator. 

- Internal-only if platform multi-tenant approval remains unresolved. 

- No DON. 

##### **My CRE Simulator** 

- User Local Bridge + CRE login. 

- No DON. 

##### **My CRE Deployment** 

- Requires Deploy Access. 

- Private registry for current Testnet Lab architecture. 

Unavailable modes show exact blocker. 

#### **Buttons** 

- Start Simulator. 

- Stop Simulator. 

- Restart Simulator. 

- Run Once. 

- Connect My CRE. 

- Reconnect Local Bridge. 

- Run Parity Suite. 

- Promote to CRE only with actual Deploy Access. 

- Pause Workflow / Activate Workflow only for deployed CRE. 

##### **Connect CRE flow** 

Never ask for password/OTP. 

##### Modal: 

###### Connect Chainlink CRE 

1. Launch ContextLock Bridge 

2. ContextLock Bridge runs official CRE login locally if needed 

3. Chainlink browser authentication opens 

4. ContextLock receives only sanitized connection status 

Buttons: 

- Launch / Connect Bridge. 

- Check CRE Status. 

- Cancel. 

##### **Promotion flow** 

Show exact: 

- approved WASM hash; 

- current WASM hash; 

- config hash; 

- Deploy Access; 

- registry; 

- parity suite status; 

- execution remains testnet-only. 

Button: . Promote Exact Workflow Artifact 

Never silently rebuild. 

#### **Simulation history** 

Rows: 

- time; 

- trigger; 

- result; 

- reason; 

- config hash; 

- binary hash; 

- production-limit mode; 

- testnet broadcast/dry run. 

#### **Right Agent suggestions** 

- Explain simulator vs DON. 

- Why can't I promote this workflow? 

- Explain this CRE result. 

- What evidence would prove TEE execution? 

## **27. Page specification: Identity / ENS** 

#### **Purpose** 

Show agent identity, namespace, lifecycle and revocation separately from financial permissions. 

#### **Center layout** 

##### **Identity card** 

- ENS name. 

- node/hash. 

- owner/manager where safe. 

- agent address. 

- identity hash. 

- expiry. 

- state. 

- last verified. 

##### **Organization hierarchy** 

Tree visualization for multi-agent namespace. 

##### **Records** 

Show relevant agent-context / endpoint records and resolver metadata. 

##### **Security explanation** 

Visible text: 

ENS identifies and revokes agents. ContextLock policy defines their financial permissions. 

Do not show financial limits as ENS roles. 

#### **Buttons** 

- Refresh ENS State. 

- View Records. 

- Open Architecture. 

- Revoke Agent Identity. 

- Renew / manage only if backend supports and testnet-only lifecycle is appropriate. 

##### **Revoke modal** 

##### Show: 

- identity; 

- affected agent; 

- sibling impact; 

- expected capability impact; 

- transaction network; 

- post-write verification. 

Button: Revoke Agent Identity. 

#### **Right Agent suggestions** 

- Explain what ENS does here. 

- Will revoking this agent affect its siblings? 

- How does identity revocation stop old capabilities? 

## **28. Page specification: Safety Reports & Evidence** 

#### **Purpose** 

Produce shareable, secret-free evidence of what the agent was built to do and what was actually tested. 

#### **Center layout** 

Report list: 

- Agent Safety Report. 

- Deployment Receipt. 

- Simulation Report. 

- Attack Lab Report. 

- Reality/Fork Report. 

- CRE Simulation Evidence. 

- Test Results. 

##### Each row: 

- report type; 

- revision; 

- generated; 

- hash; 

- current/stale; 

- privacy classification. 

#### **Safety Report preview** 

##### Sections: 

- agent goal; 

- Blueprint/Strategy hashes; 

- ENS identity; 

- permissions; 

- execution testnets; 

- production write boundary; 

- adapters/versions; 

- Reality data sources; 

- CRE mode; 

- CRE binary hash; 

- DON/TEE evidence classification; 

- runtime image digest; 

- simulations; 

- attacks; 

- deployment receipts; 

- blockers/findings. 

#### **Buttons** 

- Generate Report. 

- Regenerate Current Revision. 

- Preview. 

- Download PDF. 

- Download JSON. 

- Copy Share Link only if public sharing is implemented safely. 

- Verify Hash. 

Reports must pass secret scanning before download/share. 

#### **Right Agent suggestions** 

- Summarize this report for a judge. 

- Explain the strongest security evidence. 

- Which claims are still simulated? 

- What blockers remain? 

## **29. Page specification: Settings** 

#### **Purpose** 

Configure non-secret project/workspace behavior and inspect safe integration settings. 

Tabs: 

- Project. 

- Appearance. 

- Simulation limits. 

- Runtime preferences. 

- Notifications. 

- Developer mode. 

##### **Project** 

- Name. 

- Description. 

- Organization. 

- default agent. 

- archive project. 

##### **Appearance** 

- theme; 

- density; 

- editor font size; 

- restore layout defaults. 

##### **Simulation limits** 

Read backend-enforced quotas. 

Do not let frontend settings exceed server policy. 

##### **Developer mode** 

Controls: 

- show raw IDs/hashes; 

- show raw JSON; 

- enable constrained Terminal tab; 

- verbose events. 

Never make developer mode disable security checks. 

#### **Buttons** 

- Save Settings. 

- Reset Layout. 

- Export Project. 

- Archive Project. 

## **30. Context Agent behavior by page** 

|Page|Agent knows by<br>default|Bestquick actions|Prohibited shortcut|
|---|---|---|---|
|Composer|draft prompt,<br>requirements status|clarify limits, rewrite<br>intent, explain<br>blocker|invent hard financial<br>caps|
|Organization|selected agents,<br>budgets, identity<br>separation|compare authority,<br>blast radius|merge principals<br>silently|
|Blueprint|current/draft<br>revision, validation|explain field, propose<br>patch, security diff|auto-publish revision|
|Architecture|graph + selected<br>node|explain path, trace<br>authority|alter graph<br>independently of<br>Blueprint|
|Permissions|deterministic<br>permission matrix|summarize<br>can/cannot, find<br>expansion|declare permission<br>from model opinion|
|Simulation|selected<br>scenario/run|explain reason,<br>propose edge case|rewrite expected<br>result to make test<br>green|
|Reality|snapshot/<br>provenance/fork<br>state|explain<br>trust/freshness,<br>compare|switch to lower-trust<br>source silently|



|Page|Agent knows by<br>default|Bestquick actions|Prohibited shortcut|
|---|---|---|---|
|Attack Lab|attack<br>mutation/security<br>path|explain stop layer,<br>propose variant|disable controls to<br>make attack pass|
|Code|file/selection/build<br>revision|explain, propose diff,<br>locate tests|write directly<br>without review when<br>deployed|
|Integrations|adapter<br>manifest/trust/statu<br>s|recommend<br>compatible source|promote trust class<br>by prose|
|Deploy|plan, estimates,<br>blockers|explain cost and<br>steps|click<br>Deploy/Approve for<br>user|
|Overview|live state, recent<br>decisions|summarize status|infer policy from<br>cached UI state|
|Activity|selected<br>RuntimeEvent/correl<br>ation|summarize/trace|expose confidential<br>event payload|
|Policies|current chain<br>state/policy|explain and draft<br>revision|enable/disable via<br>free-text chat|
|Runtime|health/revision|explain degradation|claim stop = financial<br>disable|
|Control Plane|alerts/reconciliation|explain drift,<br>recommend action|run Emergency Lock<br>directly|
|CRE|mode/account/<br>status|explain<br>simulator/DON|claim simulator is<br>TEE/DON|
|ENS|identity state|explain revoke<br>impact|treat ENS as financial<br>policy|
|Reports|selected report|summarize evidence|embellish<br>unsupported claims|



## **31. Modals and confirmations** 

Critical actions must use consistent modal patterns. 

#### **31.1 Standard confirmation** 

For non-financial project mutations. 

Structure: 

- title; 

- consequence; 

- affected revision/resource; 

- cancel; 

- action-specific button. 

#### **31.2 Security confirmation** 

Used for: 

- Enable Policy. 

- Disable Policy. 

- Revoke ENS identity. 

- Promote CRE artifact. 

Structure: 

ACTION 

Current state 

... 

Requested state ... 

Network Sepolia 

Resource 

... 

Expected consequence ... 

###### [Cancel] [Action-specific explicit label] 

No generic OK. 

#### **31.3 Emergency confirmation** 

Used only for Emergency Lock. 

- strongest control first; 

- per-step expected behavior; 

- optional ENS revoke; 

- typed or deliberate high-friction confirmation if appropriate; 

- no countdown that delays execution. 

#### **31.4 Destructive deletion** 

For deleting project/draft/workflow where allowed. 

Require resource name confirmation for irreversible actions. 

## **32. Loading, stale, degraded and error UX** 

Every backend-backed page needs separate states for: 

##### **First load** 

Skeleton matching final layout. 

##### **Background refresh** 

Keep current data but show subtle refresh indicator. 

##### **Stale** 

Display last verified timestamp and STALE status. Never turn stale into healthy. 

##### **Degraded** 

Part of the system works; explain which dependency is failing and what behavior is affected. 

##### **Blocked** 

Action cannot proceed because a prerequisite is missing. Show blocker ID and next action when user-actionable. 

##### **Failed** 

Operation failed. Preserve already successful previous steps. 

##### **Partial** 

For deployment/emergency/multi-step operations, show each completed/failed step. 

## **33. Data freshness component** 

Create one shared component: 

<FreshnessBadge /> 

##### Inputs: 

- source; 

- observedAt; 

- ttl; 

- state; 

- lastSuccessfulAt; 

- staleReason. 

##### Examples: 

Fresh · verified 4s ago 

STALE · last confirmed 2m ago 

UNKNOWN · never synchronized 

Use it across: 

- chain state; 

- CRE; 

- adapters; 

- Reality snapshots; 

- runtime; 

- ENS. 

## **34. Address, hash and identity component** 

Create shared <BlockchainRef />. 

##### Behavior: 

- human label first where known; 

- shortened monospace value; 

- copy button; 

- full value tooltip; 

- network badge; 

- explorer link only for actual supported public-chain objects; 

- **never** generate public explorer link for LOCAL_FORK transactions. 

##### Examples: 

Policy Registry · 0xCBd9…7F24 · Sepolia 

## **35. Reason-code component** 

Create <ReasonCode />. 

Example: 

###### DENY · RECIPIENT_NOT_ALLOWED 

Click opens: 

- human explanation; 

- deterministic source; 

- policy/validator link; 

- related simulation tests; 

- relevant field/value. 

Do not allow model-generated prose to replace the actual code. 

## **36. Revision and staleness system** 

Frontend must understand revision dependencies. 

Conceptual chain: 

Requirements ↓ Blueprint ↓ Strategy ↓ Build 

↓ Simulation ↓ Deployment ↓ Runtime 

If Blueprint changes: 

- architecture updates from new draft/current revision; 

- old Strategy may become stale; 

- old simulations stale; 

- code/build stale; 

- deployment remains the currently deployed old revision until explicit deployment; 

- live Overview must continue showing deployed revision, not draft. 

Display a persistent banner when editing a newer draft than the live deployment: 

You are editing Blueprint r9. 

The active Testnet Lab deployment is still r8. [Compare] [Deploy r9 when ready] 

## **37. Live event transport** 

Recommended frontend model: 

- REST/query endpoints for snapshots/current state. 

- SSE for build events, RuntimeEvents, deployment progress and agent-chat streaming when one-way streaming is enough. 

- WebSocket only for truly bidirectional live surfaces such as a developer terminal. 

Never make the browser event stream authoritative. On reconnect, fetch the persisted snapshot/events and resume from cursor. 

Frontend must tolerate: 

- duplicate events; 

- reconnect; 

- out-of-order network delivery; 

- stale cached page; 

- event stream interruption. 

## **38. Frontend state management** 

Separate server state from UI state. 

##### **Server state** 

Use TanStack Query or the existing equivalent for: 

- project; 

- Blueprint; 

- build; 

- simulations; 

- deployment; 

- runtime; 

- policy/chain observation; 

- CRE; 

- adapters; 

- alerts; 

- reports. 

Query keys must include relevant project/agent/revision identifiers. 

##### **Local UI state** 

Keep only UI concerns locally: 

- panel widths; 

- open tabs; 

- selected node/file/event; 

- collapsed groups; 

- theme; 

- bottom-panel state; 

- draft input before server persistence. 

Do not put authoritative policy/deployment/runtime state into a client store and treat it as truth. 

## **39. Agent Sidebar data contract** 

The frontend should send a typed context envelope, not handcrafted giant prompts. 

Conceptual: 

**interface** AgentPageContext { projectId: string; agentId?: string; route: string; pageKind: PageKind; 

blueprintRevision?: number; strategyRevision?: number; buildRevision?: number; deploymentRevision?: number; runtimeRevision?: number; 

selectedEntity?: { kind: string; id: string; }; 

###### safeContextRefs: string[]; } 

The backend resolves refs to safe, authorized context. 

Never trust browser-supplied full policy/secret context just because the agent sidebar sent it. 

## **40. Suggested frontend component architecture** 

App 

└─ ProjectWorkbench ├─ TitleBar │├─ ProjectSwitcher │├─ AgentSwitcher │├─ RevisionIndicator │├─ EnvironmentBadge │├─ CommandPaletteTrigger │└─ GlobalAlerts │ ├─ WorkbenchBody │├─ LeftWorkbench ││├─ ActivityRail ││└─ ProjectExplorer ││ │├─ CenterWorkspace ││├─ EditorTabBar ││├─ PageOutlet ││└─ BottomPanel ││ │└─ ContextAgentSidebar │ ├─ AgentContextHeader │ ├─ Conversation │ ├─ StructuredResponseRenderer │ └─ AgentComposer │ └─ StatusBar 

Shared domain components: 

StatusBadge FreshnessBadge VerdictBadge 

ReasonCode BlockchainRef RevisionBadge TrustClassBadge NetworkRoleBadge CreModeBadge HealthIndicator AuthorityMatrix SecurityPath RuntimeEventRow CorrelationTrace ArtifactHash DiffSummary ControlCommandDialog DeploymentStep BlockerBanner FindingCard 

## **41. Recommended frontend technology** 

Use the existing project stack where possible. If not already fixed, this is the recommended direction: 

##### **Core** 

- React + TypeScript. 

- Vite if already used by Studio. 

- Tailwind CSS. 

- shadcn/ui primitives. 

##### **Three-pane shell** 

Use shadcn Resizable / react-resizable-panels for left-center-right sizing. 

##### **Sidebar** 

Use shadcn Sidebar primitives or equivalent composition, with a collapsible activity/navigation model. 

##### **Architecture** 

@xyflow/react / React Flow. 

Required primitives: 

- ReactFlow. 

- Controls. 

- MiniMap where useful. 

- custom nodes/edges. 

- fitView. 

- viewport locking. 

##### **Code** 

Monaco Editor. 

Use the Diff Editor for revision and agent-proposed patch review. 

##### **Terminal** 

xterm.js only for explicit developer-mode constrained terminals. 

Do not attach xterm.js directly to a privileged host shell. 

##### **Server state** 

TanStack Query v5 or existing project equivalent. 

##### **Icons** 

Lucide React for consistent compact IDE iconography. 

##### **Streaming** 

SSE for most build/runtime/chat streams. WebSocket only where bidirectional terminal behavior requires it. 

## **42. Routing map** 

Suggested routes; adapt to existing router/backend contracts. 

/projects /projects/new 

/projects/:projectId/build /projects/:projectId/organization /projects/:projectId/blueprint /projects/:projectId/architecture /projects/:projectId/security /projects/:projectId/simulation /projects/:projectId/reality 

/projects/:projectId/attacks /projects/:projectId/code/* /projects/:projectId/integrations /projects/:projectId/deploy /projects/:projectId/deployments/:deploymentId /projects/:projectId/overview /projects/:projectId/activity /projects/:projectId/policies /projects/:projectId/runtime /projects/:projectId/control-plane /projects/:projectId/cre /projects/:projectId/identity /projects/:projectId/reports /projects/:projectId/settings 

Agent-level optional query/path: 

?agent=guardian 

The app should preserve selected agent when moving between relevant pages. 

## **43. Suggested API/query contracts for frontend** 

Exact endpoint names can follow the existing backend. The UI needs equivalent contracts. 

##### **Project shell** 

Returns: 

- project identity; 

- selected/default agent; 

- lifecycle state; 

- revisions; 

- blockers; 

- environment; 

- global status summary. 

##### **Blueprint** 

- current revision; 

- draft revision; 

- validation findings; 

- artifact/stale dependencies. 

##### **Live state snapshot** 

Returns independently observed: 

- policy state/freshness; 

- ENS state/freshness; 

- runtime state/freshness; 

- CRE state/freshness; 

- adapter health; 

- alerts; 

- deployment revision. 

##### **Commands** 

All mutations use typed commands rather than generic arbitrary RPC from frontend. 

Examples: 

RUN_SIMULATION DEPLOY_TESTNET ACTIVATE_TESTNET_POLICY DISABLE_POLICY PAUSE_RUNTIME RESUME_RUNTIME ROLLBACK_RUNTIME START_CRE_SIMULATOR STOP_CRE_SIMULATOR REVOKE_AGENT EMERGENCY_LOCK 

Backend determines authorization and preconditions. 

## **44. Keyboard shortcuts** 

Recommended: 

|Shortcut|Action|
|---|---|
|Cmd/Ctrl + K|Command palette|
|Cmd/Ctrl + B|Toggle left explorer|
|Cmd/Ctrl + Shift + A|Toggle Agent Sidebar|
|Cmd/Ctrl + J|Toggle bottom panel|
|Cmd/Ctrl + P|Quick open page/file|
|Cmd/Ctrl + Enter|Submit Agent Sidebar prompt when|



|Shortcut|Action|
|---|---|
||focused|
|Cmd/Ctrl + Shift + S|Run selected simulation|
|Cmd/Ctrl + Shift + T|Open Tests panel|
|Cmd/Ctrl + Shift + D|Open Deploy|
|Esc|close transient inspector/dialog when<br>safe|



Do not assign a one-keystroke shortcut to Emergency Lock or policy enable/disable. 

## **45. Accessibility requirements** 

- All panes keyboard reachable. 

- Resize handles keyboard operable. 

- Architecture node selection accessible through an alternate node list/tree. 

- Verdict/status never conveyed only by color. 

- Critical modals correctly trap focus. 

- Buttons have action-specific accessible names. 

- Tooltips are supplementary; required meaning must be visible elsewhere. 

- Monaco accessibility mode supported. 

- Reduced-motion mode disables decorative graph/status animations. 

- Minimum text contrast meets WCAG AA. 

## **46. Responsive strategy** 

This is a desktop-first authoring product. 

##### **>= 1440 px** 

Full three-pane IDE. 

##### **1180-1439 px** 

Three panes supported, Agent Sidebar narrower/collapsible. 

##### **900-1179 px** 

Left navigation collapses to icons; Agent Sidebar becomes overlay drawer; center remains functional. 

##### **< 900 px** 

Prefer monitoring/review mode: 

- Overview. 

- Activity. 

- Alerts. 

- Reports. 

- simple policy/runtime status. 

Hide or discourage: 

- full Blueprint editing; 

- Architecture authoring; 

- Monaco code editing; 

- complex deployment operations. 

Never squeeze three 300px panes into mobile width. 

## **47. Empty states** 

Empty states should always answer: 

1. What is this page? 

2. Why is it empty? 

3. What can I do next? 

Examples: 

##### **No Blueprint** 

Describe your agent first. ContextLock will generate a typed Blueprint that defines identity, data sources, actions and authority boundaries. 

Button: Build Agent. 

##### **No deployment** 

This agent has not been deployed to the Testnet Lab. 

Button: . Run Deployment Preflight 

##### **No CRE workflow** 

The agent is using the official CRE simulator. A real DON workflow is optional and requires CRE Deploy Access. 

Button: Connect My CRE. 

##### **The Graph unavailable** 

The Graph adapter is configured but cannot authenticate. No indexed Graph data is being substituted with another source. 

Button: . Configure Credential 

## **48. Toasts and notifications** 

Use toasts for lightweight feedback only: 

- copied address; 

- draft saved; 

- simulation started; 

- report generated. 

Do not use disappearing toast as the only representation of: 

- deployment failure; 

- critical alert; 

- policy state change; 

- emergency-lock result; 

- CRE promotion result. 

Those require persistent page state/event records. 

## **49. Security-specific frontend requirements** 

1. Never derive permission from disabled/enabled appearance in client state. 

2. Never treat a successful POST as proof of on-chain state; wait for observed reconciliation. 

3. Never store privileged credentials in browser localStorage/sessionStorage. 

4. Never render raw secret values from backend even in developer mode. 

5. Sanitize logs and agent context. 

6. Never let a fixture CRE simulation ID display as a real workflow ID. 

7. Never show TEE/DON claims without evidence flags. 

8. Never expose mainnet write UI. 

9. Never generate public explorer links for local-fork transactions. 

10. Never let an agent-chat message bypass typed control confirmation. 

11. Never make a stale green badge remain green without freshness indication. 

12. Never let draft revisions replace the observed live revision in Overview. 

## **50. Product analytics events** 

Track UX analytics, not sensitive financial details. 

Useful events: 

- project_created; 

- blueprint_generated; 

- architecture_opened; 

- simulation_run; 

- attack_run; 

- reality_mode_selected; 

- preflight_started; 

- deployment_started/completed/failed; 

- runtime_started/paused; 

- cre_connect_started/completed; 

- report_generated; 

- agent_sidebar_used; 

- page_opened. 

Do not put: 

- private policy values; 

- wallet secrets; 

- raw prompts if privacy policy disallows; 

- transaction calldata; 

- private API responses 

into analytics by default. 

## **51. Frontend test plan** 

#### **Shell** 

- pane resizing persists; 

- collapse/restore works; 

- selected project/agent persists; 

- tabs restore; 

- keyboard shortcuts work; 

- agent context updates with page. 

#### **State truth** 

- stale source does not show healthy; 

- blocked source does not show green; 

- database policy state cannot override fresh observed chain state; 

- draft revision cannot appear as active deployment; 

- CRE simulator cannot render DON badge; 

- local-fork tx cannot get public explorer URL. 

#### **Controls** 

- Agent Sidebar cannot directly invoke security controls; 

- policy enable/disable requires native dialog; 

- Emergency Lock works even if agent panel/model disconnected; 

- runtime stop warning clearly says authority may remain; 

- stale control command/revision errors render clearly. 

#### **Page integration** 

- selecting Architecture node updates right-agent context; 

- selecting Simulation result updates agent context; 

- clicking reason code links to policy/test; 

- clicking RuntimeEvent traces correlation; 

- Deployment progress survives reload; 

- reconnect reconstructs from server state rather than local memory. 

#### **Accessibility** 

- keyboard navigation; 

- screen-reader labels; 

- focus restoration; 

- graph alternate tree; 

- status text plus color; 

- high contrast. 

## **52. Suggested frontend build sequence** 

Build in this order so the shell and state model stabilize before the many pages. 

##### **FE-1 - Workbench Shell** 

- TitleBar. 

- ActivityRail. 

- ProjectExplorer. 

- CenterWorkspace. 

- EditorTabBar. 

- ContextAgentSidebar shell. 

- StatusBar. 

   - Resizable panels. 

   - responsive behavior. 

- **FE-2 - Shared domain primitives** 

   - statuses; 

   - freshness; 

   - verdict; 

   - reason code; 

   - blockchain refs; 

   - revision/stale banner; 

   - trust class; 

   - network role; 

   - CRE mode; 

   - control dialogs. 

- **FE-3 - Build & Design** 

   - Composer. 

   - Organization. 

   - Blueprint. 

   - Architecture. 

   - Permissions. 

##### **FE-4 - Test surfaces** 

- Simulation. 

- Reality Lab. 

- Attack Lab. 

##### **FE-5 - Engineering surfaces** 

- Code. 

- Integrations. 

- bottom Tests/Problems/Output. 

**FE-6 - Deployment** 

- Preflight. 

- cost estimate. 

- deployment progress. 

- ready-to-activate. 

**FE-7 - Live operations** 

- Overview. 

- Activity. 

- Policies. 

- Runtime. 

- Control Plane. 

- CRE. 

- ENS. 

##### **FE-8 - Context Agent integration** 

Implement page-aware context envelopes, selections, structured responses and proposed patches across all pages. 

##### **FE-9 - Reports, settings and polish** 

- Safety Reports. 

- Evidence. 

- Settings. 

- command palette. 

- shortcuts. 

- accessibility. 

- responsive monitoring view. 

## **53. Definition of frontend complete** 

The frontend is product-complete when a user can perform this journey without leaving the ContextLock workbench: 

1. Create a project. 

2. Describe an agent. 

3. Generate requirements/Blueprint. 

4. Inspect its authority. 

5. Inspect architecture. 

6. Ask page-aware questions in the right Agent Sidebar. 

7. Run deterministic simulations. 

8. Run official CRE simulation. 

9. Select live mainnet read-only Reality data. 

10. Inspect provenance/freshness. 

11. Run Attack Lab scenarios. 

12. Inspect generated code. 

13. Run deployment preflight. 

14. Understand required testnet gas/balance. 

15. Deploy to Testnet Lab. 

16. Verify policy starts disabled. 

17. Start runtime/CRE simulation. 

18. Activate policy only through explicit user control. 

19. Watch agent Activity and live Architecture. 

20. Trace a decision end to end. 

21. Pause runtime and understand it is not the financial kill switch. 

22. Disable policy and see fresh chain verification. 

23. Run Emergency Lock through deterministic native controls. 

24. Connect a CRE account without giving ContextLock the user’s password/OTP. 

25. See real CRE promotion availability honestly. 

26. Run mainnet Shadow/Fork testing with zero public-mainnet execution path. 

27. Export a secret-free Agent Safety Report. 

The visual experience should leave the user with one clear impression: 

##### **ContextLock is an IDE for designing and operating financial agents with visible, testable authority boundaries.** 

## **54. Reference implementation notes** 

The UI architecture intentionally borrows from the IDE workbench model rather than ordinary dashboard navigation. VS Code documents its workbench as a combination of title bar, activity bar, side bar, editor groups, panel and status bar. React Flow is suitable for the Architecture canvas and provides zoom/fit/viewport controls. Monaco is the browser editor that powers VS Code and includes a Diff Editor. shadcn/ui currently provides composable Sidebar and Resizable primitives built for collapsible and accessible panel layouts. TanStack Query is a good fit for asynchronous server-state fetching/caching while keeping local panel/tab selection separate. xterm.js should be reserved for a constrained developer terminal, not treated as a security boundary. 

##### **External references** 

- Visual Studio Code - Extending the Workbench: https://code.visualstudio.com/api/extension-capabilities/extending-workbench 

- React Flow Controls: https://reactflow.dev/api-reference/components/controls 

- Monaco Editor: https://microsoft.github.io/monaco-editor/ 

- shadcn/ui Sidebar: https://ui.shadcn.com/docs/components/base/sidebar 

- shadcn/ui Resizable: https://ui.shadcn.com/docs/components/base/resizable 

- shadcn/ui Command: https://ui.shadcn.com/docs/components/base/command 

- TanStack Query React: https://tanstack.com/query/latest/docs/framework/react 

- xterm.js: https://xtermjs.org/ 

- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-js/guides/tracing/ 

## **55. One-screen visual target** 

The default desktop screen should approximately read like this: 

─ ─ ─ ─ ┌ ContextLock  Treasury Guardian  Blueprint r8  TESTNET LAB  Search / Command ─ Alerts(1) ┐ 

|├──<br>───<br> <br>││<br>|┬──────────────────────┬───────────────────────────────────────────<br>─────┬─────────────────────┤<br>PROJECT               Architecture                                       Context Agent<br>│<br>│<br>│<br><br><br><br>|
|---|---|
|<br>│◆<br>|Composer                                                                 Architecture<br>│<br>│<br>│<br>│<br><br><br><br>|
|<br>│◇|Blueprint                 MAINNET DATA                                   Selected: Policy<br>│<br>│<br>│<br>│|
|<br>│◇|Architecture<br>Chainlink<br>│<br>●<br>│<br>│<br>│|
|<br>│◇|Permissions                                                             "How is this agent<br>│<br>│<br>│<br>│<br>│|
|<br>││<br>|prevented from<br>│<br>▼<br>│<br>│<br><br><br><br>|
|<br>│▷|TEST                        Reality Engine                                sending funds to<br>│<br>│<br>│<br>│|
|<br>││|Simulation                                                               another wallet?"<br>│<br>│<br>│<br>│|
|<br>││|Reality Lab<br>│<br>▼<br>│<br>│|
|<br>││<br>││<br><br>|Attack Lab                  Agent Runtime                                The recipient is...<br>│<br>│<br>│<br>│<br>│<br>│<br>│<br><br><br><br>|
|<><br>│<br>|IMPLEMENT                                                               [Open policy rule]<br>│<br>│<br>▼<br>│<br>│|
|<br>││|Code                       CRE Simulator                                 [Run attack]<br>│<br>│<br>│|
|<br>││|Integrations<br>│<br>│<br>│<br>│|
|││|│<br>▼<br>│<br>│|
|<br>│⇧|DEPLOY                    ContextLock Policy<br>│<br>│<br>│<br>│|
|<br><br> <br>││|<br><br><br><br><br>Prefight<br>│<br>│<br>│<br>│|
|<br>││|Deployments<br>│<br>▼<br>│<br>│|
|<br>││|Executor<br>│<br>│<br>│|
|<br>│●|OPERATE<br>│<br>│<br>│<br>│<br>│|
|<br>││|Overview<br>│<br>▼<br>│<br>│|
|<br>││|Activity                 Ethereum Sepolia<br>│<br>│<br>│|
|<br>││|Policies                    TESTNET<br>│<br>│<br>│|
|<br>││|Runtime<br>│<br>│<br>│|
|<br>││|Control Plane<br>│<br>│<br>│|
|<br>││<br> <br>││<br>├──|CRE<br>│<br>│<br>│<br>Identity<br>│<br>│<br>│<br>┴──────────────────────┴───────────────────────────────────────────|
|───|─────┴─────────────────────┤|



│ TESTNET | Exec Sepolia | Reality Mainnet READ ONLY | CRE SIM | Policy DISABLED | Runtime STOPPED │ 

└───────────────────────────────────────────────────────────────────── 

────────────────────────────┘ 

That is the target experience to keep in mind throughout implementation. 

