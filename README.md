# Frontend

The web client: a landing page and the workbench behind it.

## Running it

```bash
npm install
cp .env.example .env.local   # fill in the WalletConnect project id
npm run dev                  # http://localhost:3000
```

The API server has to be running separately on `127.0.0.1:4310`. The Next
server rewrites `/api/*` to it, so the browser only ever talks to its own
origin — there are no CORS headers anywhere in the stack, and setting a public
API URL in the environment would break that by sending the browser
cross-origin instead.

```bash
npm run build        # production build
npm run typecheck    # tsc --noEmit
```

## Layout

| Path | What lives there |
| --- | --- |
| `app/` | Routes. `page.tsx` is the landing, `projects/[projectId]/*` is the workbench. |
| `components/landing/` | The wallet handoff from the landing into the product. |
| `components/studio/` | The workbench: shell, panels, wallet and signing surfaces. |
| `lib/studio/` | API client, event stream, workbench state, the context agent. |
| `public/styles/` | Stylesheets in load order; `landing.css` is last and carries every change to the base sheets. |
| `public/assets`, `public/models` | The landing's scene engine and its models. |

## Two things worth knowing before editing

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
