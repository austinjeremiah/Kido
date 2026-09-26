# ContextLock Studio — pinned dependencies (P11.0)

Every version below was resolved from the live npm registry on **2026-09-08** and every
capability claim was verified by executing it, not by reading documentation. Where the V2 Bible's
assumption did not match what the package actually ships, a `FND-V2-*` finding is filed and linked.

## Core

| Package | Version | Reason | Official docs | Security implication | Upgrade risk |
|---|---|---|---|---|---|
| `@openai/agents` | **0.17.0** | Studio orchestration; `Agent`, `SandboxAgent`, `run`, usage accounting | https://openai.github.io/openai-agents-js/ | Runs untrusted model output; the sandbox boundary is the security control | **HIGH** — pre-1.0. Sandbox API surface may move; `DockerSandboxClient` is exported from a subpath (see FND-V2-001) |
| `openai` | 7.x (transitive) | HTTP client under the SDK | https://platform.openai.com/docs | API-key handling; never reaches the browser | Medium |
| `zod` | **4.1.12** | Blueprint schema, structured model output, API validation | https://zod.dev | The Blueprint validator is the deterministic security gate — schema correctness is load-bearing | Low; already used by broker/adapters. SDK peer is `^4.0.0` |
| `@xyflow/react` | **12.11.6** | Architecture view | https://reactflow.dev | Renders topology only; positions are computed deterministically, never by the model | Low |
| `react` / `react-dom` | **19.2.8** | Required by `@xyflow/react` | https://react.dev | None directly | Low |
| `vite` | **8.2.2** | Studio frontend build | https://vite.dev | Dev server binds localhost only | Low |
| `@vitejs/plugin-react` | **6.1.1** | React fast refresh / JSX transform | https://vite.dev | None | Low |
| `fastify` | **5.12.3** | Studio API — same version the broker already runs | https://fastify.dev | Body-schema validation; version already patched for the FND-015 advisory | Low |
| `better-sqlite3` | **12.4.1** | Studio persistence — same engine as the broker | https://github.com/WiseLibs/better-sqlite3 | Synchronous transactions give atomic quota reservation (STUDIO-016) | Low |

## Model

| | |
|---|---|
| Model | `gpt-5.6-luna` — **verified present** on `GET /v1/models` for this account |
| Set explicitly on | every Studio agent role; never inherited from an SDK default |
| Sibling models present but **not used** | `gpt-5.6-sol`, `gpt-5.6-terra` |
| Reasoning effort | per-role via `modelSettings.reasoning.effort`; SDK accepts `none \| minimal \| low \| medium \| high \| xhigh \| max` |
| Usage source | `result.state.usage` → `{requests, inputTokens, outputTokens, totalTokens, requestUsageEntries[]}` — **verified by a live run**, never estimated from text length |

Live verification (probe run, 2026-09-08):

```
OUTPUT: { "protocol": "Aave", "autoLimitUsd": null, "unknowns": ["autoLimitUsd"] }
USAGE:  { "requests": 1, "inputTokens": 108, "outputTokens": 178, "totalTokens": 286, "entries": 1 }
```

The probe also confirms the behaviour P11 depends on: asked for an Aave agent with no stated limit,
the model returned `null` and named the field as unknown rather than inventing a spending limit.
That behaviour is *relied upon but not trusted* — the deterministic validator enforces it.

## Sandbox

| | |
|---|---|
| Import path | `@openai/agents/sandbox/local` — **not** `@openai/agents/sandbox` (FND-V2-001) |
| Development client | `DockerSandboxClient` — **fully functional**, verified end to end |
| Base image | `node:22-bookworm-slim` (SDK default is `python:3.14-slim`, wrong toolchain for a TypeScript agent) |
| Network | `networkMode: 'none'` — **verified genuinely blocking**: DNS returns `NO_DNS`, HTTP fails `EAI_AGAIN` |
| `E2BSandboxClient` | **DOES NOT EXIST** in the SDK (FND-V2-002). Abstracted behind `StudioSandboxProvider`; no E2B implementation is shipped or claimed |
| Session creation | ~3.7s measured |

Live verification (probe run, 2026-09-08):

```
created session in 3718 ms
node version: "v22.23.2" exit 0
file roundtrip: "export const x = 1;" exit 0
dns probe: "NO_DNS"
net probe: "NET_BLOCKED:EAI_AGAIN"
listDir: [{"name":"a.ts","path":"proof/a.ts","type":"file"}]
```

## Docker host

| | |
|---|---|
| Docker | 28.1.1, server `linux/aarch64` |
| Daemon | must be running; the Studio fails closed with a named error if it is not |

## Deliberately NOT added

| | Why |
|---|---|
| LangGraph | The Bible forbids a second orchestration runtime. Application code owns the state machine. |
| Vercel AI SDK | Not needed — SSE is emitted directly from persisted Studio events. |
| E2B | No SDK client exists (FND-V2-002). The provider interface is there; an implementation is not invented. |
| Any new DB engine | The broker's `better-sqlite3` is reused, including its synchronous-transaction semantics. |
| Any rewrite of `apps/web` | The P9 operator console is untouched. Studio is a new app (see DECISIONS D11.2). |
