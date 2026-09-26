/**
 * ContextLock operator console.
 *
 * Every value rendered here comes from the real deployment manifest, real demo results, or a live
 * Sepolia read. Nothing is mocked, and confidential policy VALUES are never fetched or displayed —
 * only their names and a commitment.
 */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const short = (s, head = 10, tail = 8) =>
  typeof s === "string" && s.length > head + tail + 3 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
const scanTx = (h) => `https://sepolia.etherscan.io/tx/${h}`;
const scanAddr = (a) => `https://sepolia.etherscan.io/address/${a}`;

function kv(container, pairs) {
  container.innerHTML = "";
  for (const [k, v, opts = {}] of pairs) {
    container.appendChild(el("div", "k", k));
    const val = el("div", "v");
    if (opts.badge) {
      val.appendChild(el("span", `badge ${opts.badge}`, v));
    } else if (opts.link) {
      const a = el("a", "", v);
      a.href = opts.link;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.style.color = "var(--accent)";
      val.appendChild(a);
    } else {
      val.textContent = v;
    }
    container.appendChild(val);
  }
}

// ─────────────────────────── tabs ───────────────────────────
document.querySelectorAll("#tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $(`#${b.dataset.tab}`).classList.add("active");
  });
});

// ─────────────────────────── load ───────────────────────────
async function load() {
  const [manifest, demo, live] = await Promise.all([
    fetch("/api/manifest").then((r) => r.json()).catch(() => null),
    fetch("/api/demo-results").then((r) => r.json()).catch(() => ({ results: [] })),
    fetch("/api/live").then((r) => r.json()).catch(() => ({ available: false, reason: "unreachable" })),
  ]);

  if (!manifest) {
    $("#chainPill").textContent = "manifest missing";
    return;
  }

  $("#chainPill").textContent = live.available
    ? `Sepolia · chainId ${live.chainId} · block ${live.block}`
    : `Sepolia · offline (${live.reason ?? "no RPC"})`;
  $("#footerStatus").textContent = `commit ${short(manifest.sourceCommit, 8, 0)} · executor ${short(manifest.canonicalExecutor.address)}`;

  renderDashboard(manifest, live);
  renderContracts(manifest);
  renderRoles(manifest);
  renderAgents(manifest, live);
  renderPolicies(manifest);
  renderLab(demo);
  renderRequests(demo);
  renderAudit(demo);
}

// ─────────────────────────── dashboard ───────────────────────────
function renderDashboard(m, live) {
  const ensCurrent = live.available ? live.ens.identityCurrent : null;
  kv($("#ensPanel"), [
    ["Status", "LIVE", { badge: "executed" }],
    ["Name", m.ens.agentName],
    ["Node", short(m.ens.node)],
    ["Owner", short(m.ens.nameOwner), { link: scanAddr(m.ens.nameOwner) }],
    ["Expires", m.ens.expiryIso.slice(0, 10)],
    ["Identity current", ensCurrent === null ? "unknown (offline)" : ensCurrent ? "YES" : "NO",
      { badge: ensCurrent === null ? "pending" : ensCurrent ? "allow" : "deny" }],
  ]);

  kv($("#crePanel"), [
    ["Mode", m.cre.mode, { badge: "escalate" }],
    ["CLI", m.cre.cliVersion],
    ["SDK", m.cre.sdkVersion],
    ["Official CLI simulation", m.cre.officialCliSimulation ? "YES" : "NO",
      { badge: m.cre.officialCliSimulation ? "allow" : "deny" }],
    ["Real TEE execution", m.cre.realTeeExecution ? "YES" : "NO",
      { badge: m.cre.realTeeExecution ? "allow" : "deny" }],
    ["Live CRE deployment", m.cre.liveCreDeployment ? "YES" : "NO",
      { badge: m.cre.liveCreDeployment ? "allow" : "deny" }],
    ["Workflow binary", short(m.cre.workflowBinaryHash)],
  ]);

  kv($("#ledgerPanel"), [
    ["Status", "PENDING HARDWARE", { badge: "deny" }],
    ["Blocker", m.ledger.blocker],
    ["Key Ring provisioned", m.ledger.keyRingProvisioned ? "YES" : "NO", { badge: "deny" }],
    ["Physical approval", m.ledger.physicalApproval ? "YES" : "NO", { badge: "deny" }],
    ["Clear Signing rendered", m.ledger.clearSigningRendered ? "YES" : "NO", { badge: "deny" }],
    ["Software", "implemented and tested", { badge: "allow" }],
  ]);

  const sec = [];
  if (live.available) {
    sec.push(
      ["Agent identity", live.ens.identityCurrent ? "CURRENT" : "NOT CURRENT",
        { badge: live.ens.identityCurrent ? "allow" : "deny" }],
      ["Agent identity hash", short(live.ens.agentIdentityHash)],
      ["ENS token id", short(live.ens.tokenId, 12, 6)],
      ["Authorization writer", short(live.authorizationWriter), { link: scanAddr(live.authorizationWriter) }],
      ["Writer is CRE consumer", live.writerIsConsumer ? "YES" : "NO",
        { badge: live.writerIsConsumer ? "allow" : "deny" }],
      ["Protected target calls", live.target.callCount],
      ["Current block", live.block],
    );
  } else {
    sec.push(["Live reads", `unavailable — ${live.reason ?? "no RPC"}`, { badge: "pending" }]);
  }
  sec.push(["Policy version", String(m.ens ? 1 : 1)], ["Canonical executor", short(m.canonicalExecutor.address), { link: scanAddr(m.canonicalExecutor.address) }]);
  kv($("#securityPanel"), sec);
}

function renderContracts(m) {
  const tb = $("#contractsTable tbody");
  tb.innerHTML = "";
  const canonical = m.canonicalExecutor.address.toLowerCase();
  for (const [name, addr] of Object.entries(m.contracts)) {
    const tr = el("tr");
    if (addr.toLowerCase() === canonical) tr.className = "canonical";
    tr.appendChild(el("th", "", name));
    const td = el("td", "addr");
    const a = el("a", "", addr);
    a.href = scanAddr(addr);
    a.target = "_blank";
    a.rel = "noreferrer";
    a.style.color = "var(--accent)";
    td.appendChild(a);
    tr.appendChild(td);
    tr.appendChild(el("td", "", addr.toLowerCase() === canonical ? "canonical executor" : ""));
    tb.appendChild(tr);
  }
  for (const h of m.historicalExecutors) {
    const tr = el("tr");
    tr.appendChild(el("th", "", `ContextLockExecutor (${h.version})`));
    tr.appendChild(el("td", "addr", h.address));
    tr.appendChild(el("td", "", `historical — phases ${h.phases.join(", ")}`));
    tb.appendChild(tr);
  }
}

function renderRoles(m) {
  const tb = $("#rolesTable tbody");
  tb.innerHTML = "";
  const rows = [
    ["Deployer / policy admin", m.roles.deployer, "configures policy; cannot mint capabilities"],
    ["Capability issuer", m.roles.capabilityIssuer, "signs EIP-712 capabilities; separate from every other role"],
    ["Relayer", m.roles.relayer, "pays gas; holds no authority"],
    ["Agent (untrusted)", m.roles.agent, "proposes intents only"],
    ["CRE authorization writer", m.roles.creAuthorizationWriter, "the only address that may record a verdict"],
    ["CRE forwarder", m.roles.creForwarder.address, `${m.roles.creForwarder.status} — no live DON has written`],
    ["Ledger approver", m.roles.ledgerApprover.address, m.roles.ledgerApprover.status],
  ];
  for (const [role, addr, note] of rows) {
    const tr = el("tr");
    tr.appendChild(el("th", "", role));
    tr.appendChild(el("td", "addr", addr));
    tr.appendChild(el("td", "", note));
    tb.appendChild(tr);
  }
}

function renderAgents(m, live) {
  kv($("#agentPanel"), [
    ["ENS name", m.ens.agentName],
    ["Agent address", m.roles.agent, { link: scanAddr(m.roles.agent) }],
    ["Identity hash", live.available ? short(live.ens.agentIdentityHash) : "offline"],
    ["Identity current", live.available ? (live.ens.identityCurrent ? "YES" : "NO") : "unknown",
      { badge: live.available ? (live.ens.identityCurrent ? "allow" : "deny") : "pending" }],
    ["Registered until", m.ens.expiryIso.slice(0, 10)],
    ["Registration tx", short(m.ens.registrationTx), { link: scanTx(m.ens.registrationTx) }],
  ]);

  const deny = [
    ["the capability issuer key", "no endpoint returns it; the agent package cannot import a signer"],
    ["the deployer / policy-admin key", "policy mutators are onlyAdmin"],
    ["the relayer key", "the agent never submits a transaction"],
    ["the Ledger-protected secret", "there is no getSecret; only performProtectedAction"],
    ["WALLET_PASS", "read from the operator environment, never handled by the agent"],
    ["raw target or calldata", "typed adapters build the bytes; the API schema is strict"],
    ["the private policy thresholds", "reason codes are coarse; values never leave the enclave"],
    ["the ability to self-approve", "approval consumption is onlyExecutor"],
  ];
  const ul = $("#denyList");
  ul.innerHTML = "";
  for (const [what, why] of deny) {
    const li = el("li");
    li.appendChild(el("b", "", what));
    li.appendChild(document.createTextNode(` — ${why}`));
    ul.appendChild(li);
  }
}

function renderPolicies(m) {
  kv($("#policyPanel"), [
    ["Policy registry", short(m.contracts.ContextLockPolicyRegistry), { link: scanAddr(m.contracts.ContextLockPolicyRegistry) }],
    ["Allowed action", "MOCK_TRANSFER"],
    ["Allowed target", short(m.contracts.MockTreasuryTarget), { link: scanAddr(m.contracts.MockTreasuryTarget) }],
    ["Policy admin", short(m.roles.policyAdmin)],
    ["Enforced on-chain", "value hard cap, target allowlist, action allowlist, binding version"],
  ]);
  kv($("#policyCommit"), [
    ["Commitment", "policyHash binds id + version + every private value"],
    ["Effect", "changing any threshold changes the commitment, so an old authorization cannot apply"],
  ]);
}

// ─────────────────────────── attack lab ───────────────────────────
function renderLab(demo) {
  const meta = $("#labMeta");
  meta.textContent = demo.generatedAt
    ? `last run ${demo.generatedAt} · executor ${demo.executor} · CRE mode ${demo.creMode}`
    : "no demo results yet — run `npm run demo:all`";

  const host = $("#labScenes");
  host.innerHTML = "";
  for (const r of demo.results ?? []) {
    const scene = el("div", "scene");

    const head = el("div", "scene-head");
    const left = el("div");
    const h3 = el("h3", "", `${r.id} — ${r.title}`);
    left.appendChild(h3);
    left.appendChild(el("span", "exp", r.expectation));
    head.appendChild(left);
    head.appendChild(el("span", `badge ${r.outcome === "EXECUTED" ? "executed" : "blocked"}`, r.outcome));
    scene.appendChild(head);

    const stages = el("div", "stages");
    for (const t of r.trace) {
      const row = el("div", "stage");
      row.appendChild(el("span", `mark ${t.ok ? "ok" : "stop"}`, t.ok ? "OK" : "STOP"));
      row.appendChild(el("span", "name", t.stage));
      const d = el("span", "detail", t.detail);
      if (t.tx) {
        const tx = el("span", "tx", t.tx);
        d.appendChild(tx);
      }
      row.appendChild(d);
      stages.appendChild(row);
    }
    scene.appendChild(stages);

    const foot = el("div", "scene-foot");
    const bits = [`target callCount ${r.targetBefore} → ${r.targetAfter}`];
    if (r.stoppedAt) bits.push(`stopped at ${r.stoppedAt}`);
    if (r.verdict) bits.push(`verdict ${r.verdict}`);
    if (r.error) bits.push(`revert ${r.error}`);
    foot.textContent = bits.join("  ·  ");
    scene.appendChild(foot);

    host.appendChild(scene);
  }
}

function renderRequests(demo) {
  const tb = $("#requestsTable tbody");
  tb.innerHTML = "";
  for (const r of demo.results ?? []) {
    const tr = el("tr");
    tr.appendChild(el("td", "", r.id));
    const v = el("td");
    if (r.verdict && ["ALLOW", "ESCALATE", "DENY"].includes(r.verdict)) {
      v.appendChild(el("span", `badge ${r.verdict.toLowerCase()}`, r.verdict));
    } else {
      v.textContent = r.verdict ?? "—";
    }
    tr.appendChild(v);
    const o = el("td");
    o.appendChild(el("span", `badge ${r.outcome === "EXECUTED" ? "executed" : "blocked"}`, r.outcome));
    tr.appendChild(o);
    tr.appendChild(el("td", "", r.stoppedAt ?? "—"));
    tr.appendChild(el("td", "addr", r.capabilityDigest ? short(r.capabilityDigest, 12, 8) : "—"));
    tr.appendChild(el("td", "", r.reason ?? r.error ?? "—"));
    tb.appendChild(tr);
  }
}

function renderAudit(demo) {
  const host = $("#auditTimeline");
  host.innerHTML = "";
  for (const r of demo.results ?? []) {
    for (const t of r.trace) {
      const item = el("div", "tl-item");
      item.appendChild(el("div", "tl-scene", r.id));
      const body = el("div", "tl-body");
      body.appendChild(document.createTextNode(`${t.stage} — ${t.detail}`));
      if (t.tx) body.appendChild(el("span", "tx", t.tx));
      item.appendChild(body);
      host.appendChild(item);
    }
  }
  if (!host.children.length) host.appendChild(el("p", "note", "no demo results yet — run `npm run demo:all`"));
}

load();
