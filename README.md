# Kido

## Layout

| Path | What lives there |
| --- | --- |
| `frontend/` | The web client: the landing page and the workbench behind it. |
| `Backend/Kido/` | The Kido backend: design interview, blueprint, security review, simulation, build, wallet-driven deployment, runtime (HTTP API on port 4310). |
| `Backend/Aname/` | Amane, the on-chain authority layer (Solidity + Move + TypeScript SDK) Kido deploys agents onto. |

## Running everything

```bash
# 1. Amane SDK (Kido imports it from ../Aname)
cd Backend/Aname && npm ci && npm run build

# 2. Kido API on 127.0.0.1:4310
cd ../Kido && npm ci && npm run build && npm run kido:api

# 3. Web app on http://localhost:3000 (proxies /api/* to the Kido API)
cd ../../frontend && npm ci && npm run dev
```

The create flow (`/new`) and the workbench run against the API with no keys at all. Deployment
needs three more backend variables (see `Backend/Kido/.env.example`): `KIDO_ISSUER_KEY` (Kido's
lease issuer), `KIDO_AGENT_ADDRESS`, and `KIDO_SUI_RELAYER_KEY` for Sui agents. The owner's key is
never given to the backend: the connected wallet signs the owner policy and, on Ethereum, sends and
pays for the account transactions.

## Running the frontend

```bash
cd frontend
npm install
cp .env.example .env.local   # fill in the WalletConnect project id
npm run dev                  # http://localhost:3000
```

The Kido API (`Backend/Kido`, `npm run kido:api`) has to be running separately on `127.0.0.1:4310`. The Next
server rewrites `/api/*` to it, so the browser only ever talks to its own
origin — there are no CORS headers anywhere in the stack, and setting a public
API URL in the environment would break that by sending the browser
cross-origin instead.

```bash
npm run build        # production build
npm run typecheck    # tsc --noEmit
```

### Inside `frontend/`

| Path | What lives there |
| --- | --- |
| `app/` | Routes. `page.tsx` is the landing, `projects/[projectId]/*` is the workbench. |
| `components/landing/` | The wallet handoff from the landing into the product. |
| `components/studio/` | The workbench: shell, panels, wallet and signing surfaces. |
| `lib/kido/` | Kido API client, types, React Query hooks, formatting and typed-data helpers. |
| `lib/studio/` | Workbench state, navigation, the project context the shell reads. |
| `public/styles/` | Stylesheets in load order; `landing.css` is last and carries every change to the base sheets. |
| `public/assets`, `public/models` | The landing's scene engine and its models. |

## Two things worth knowing before editing the frontend

**The scene engine holds direct DOM references.** It resolves its nodes by
selector when it constructs and keeps them, so destroying or remounting those
nodes breaks it rather than re-initialising it. Sections that are not part of
the story are hidden, not deleted; the wallet runtime is mounted as a sibling
rather than a wrapper, because it changes element type when it activates and
as an ancestor that would remount the hero canvas; and moving between the
landing and the workbench is a document navigation, not a client transition.

**The build event stream is persisted before it is broadcast.** A client that
subscribes late replays the same sequence a client present from the start saw,
so both end up in identical states. Nothing in the workbench needs to be open
when a build starts.
