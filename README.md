# Ask Jev

Find relevant passages in public documentation using TypeSafe's Jev / System One model through TypeSafe or OpenRouter. This is a **pnpm workspace running on Node.js 24+**, with an integratable Effect library, a Cloudflare Worker + SQLite Durable Object API, and a React + Vite playground.

Search returns documentation as written, **not generated answers**. The API's per-search budget defaults to and cannot exceed **$0.02**, but is an estimate, not a billing cap. The reusable library defaults to TypeSafe and also supports OpenRouter.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the repository structure, package dependency graph, service interfaces, request flows and standalone npm integration examples.

```text
React playground (Cloudflare static assets)
  │ same-origin /api/page and /api/search
  ▼
Worker (origin checks, rate limiting, per-host DO routing)
  ▼
Durable Object (one per approved documentation hostname)
  ├── ask-jev: Markdown, HTTP cache workflow, best-first search, Jev client
  ├── public documentation ←→ SQLite HTTP cache
  └── request-scoped Jev client → https://openrouter.ai/api/v1/systemone
```

**All documentation fetching, cache reads/writes, Markdown processing, search orchestration, and Jev calls run in the Durable Object.** The Worker is an admission/routing layer. The browser communicates with the application's HTTP API rather than running the search algorithm itself.

| Package | Responsibility |
| --- | --- |
| `shared/` | Dependency-free `@ask-jev/shared` documentation catalog, shared by the API and playground. |
| [`ask-jev/`](ask-jev/README.md) | Platform-independent Effect services, Markdown parsing, HTTP caching, Jev requests and search. No Cloudflare or browser dependencies. |
| `api/` | Worker proxy, Durable Object, SQLite cache adapter, catalog-based URL policy, typed API contract, Cloudflare deployment. |
| `playground/` | React + Vite SPA. Documentation dropdown, browsing, search, results, passages, usage and pages explored. |

### Documentation catalog

The playground dropdown and server policy use `DOCS` from `@ask-jev/shared`:

| ID | Label | Fixed search index |
| --- | --- | --- |
| `typesafe` | TypeSafe | `https://docs.typesafe.ai/llms.txt` |
| `telegram` | Telegram | `https://core.telegram.org/llms.txt` |
| `cloudflare` | Cloudflare | `https://developers.cloudflare.com/llms.txt` |

To add documentation, add one `{ id, label, indexUrl }` entry in **`shared/src/index.ts`**, update the expected-entry test, and rebuild/deploy. The package exports the readonly `DOCS` catalog and derived `DocsEntry`/`DocsId` types, with no framework or Effect dependencies. There is no `DOCS_HOSTS` setting or arbitrary-host input.

### Where the implementation lives

- `ask-jev/src/Search.ts`: best-first traversal, page/window concurrency, passage scoring, answer judging and estimated budget accounting.
- `ask-jev/src/SystemOne.ts`: typed Jev requests/responses and Effect HTTP client for TypeSafe and OpenRouter. `TYPESAFE_ENDPOINT`, `OPENROUTER_ENDPOINT`, `makeOpenRouter` and `layerOpenRouter` are exported through `SystemOne`; `makeWith`/`layerWith` keep their positional endpoint argument and TypeSafe default. No speculative duplicates; paid retries are opt-in.
- `ask-jev/src/Documentation.ts`: injectable storage, transport and policy services; conditional requests, freshness, stale-on-error and Markdown alternatives.
- `ask-jev/src/HttpCache.ts`: pure RFC 9111 caching semantics.
- `ask-jev/src/Docs.ts`, `Markdown.ts`: documentation facade, links, headings and blocks.
- `api/src/object.ts`: composes these services **per request** in the DO.
- `api/src/cache.ts`: Cloudflare SQLite storage adapter, retention, eviction and alarms.
- `api/src/index.ts`: thin Worker entrypoint.

Previously, search and the Jev client lived in the browser's `src/` directory, while the Worker proxied low-level model requests. That low-level `/systemone` endpoint is removed. The simpler playground intentionally does not expose raw Jev request bodies or a live per-request trace. Search results still include logical request count, token usage, duration, rounds and pages explored; integrators can instrument the Effect service boundaries/spans.

## Local development

Install **Node.js 24+** and **pnpm 10.34.9** (pinned in `packageManager`). If using Corepack, run `corepack enable` first.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

Open **http://localhost:5173**. Vite proxies `/api` to Wrangler on port 8787. The dev command builds the shared catalog, core library and initial static assets, then watches both packages, the Worker and React app in parallel. You can also open port 8787 for the last built SPA (without Vite HMR).

For local search, set `OPENROUTER_API_KEY` in **`api/.dev.vars`**, which is ignored by git. Keep secrets out of source control and frontend-prefixed environment variables.

Both `localhost:5173` and `127.0.0.1:5173` are allowed local frontend origins. The frontend alone is not enough for browsing or searching: the API must also be running on port 8787. If you already started `pnpm --filter playground dev`, start the backend separately with `pnpm --filter @ask-jev/api dev`. An empty or non-JSON `/api` response usually means the backend is unavailable; do not retry paid searches automatically.

- `pnpm typecheck`: builds shared/core declarations and checks all packages.
- `pnpm test`: Node's native test runner executes TypeScript directly, including real workerd/SQLite integration tests via Miniflare. Synthetic Jev responses only; tests do not contact model providers.
- `pnpm build`: builds shared JS/declarations first, then the core, Vite assets, and a Wrangler deployment dry run.
- `pnpm check`: all of the above.

Cancellation coverage injects an abort inside workerd to test Worker → Durable Object → Effect propagation and prevent subsequent model calls. Real browser/socket disconnect propagation could not be verified in the local Miniflare runtime.

Node executes `.ts` test files without Bun, ts-node or tsx. The library also builds distributable JavaScript because Node does not strip TypeScript inside published `node_modules` packages. Cloudflare code runs in **workerd**, not Node.

## HTTP API

Both endpoints require `?docs=typesafe|telegram|cloudflare` to select a registered documentation source. Questions are only sent in POST bodies. Responses use `Cache-Control: no-store`.

### Browse

```http
GET /api/page?docs=typesafe
```

An optional `url` selects a page on the selected source's exact origin; omitting it browses that source's registered index. For example, `GET /api/page?docs=typesafe&url=https%3A%2F%2Fdocs.typesafe.ai%2Fllms.txt`.

Returns `{ url, content, links: [{ url, text }], toc }`. The returned URL reflects redirects/Markdown alternatives; links resolve against that URL. Only approved links on the selected documentation origin are listed.

### Search

```http
POST /api/search?docs=typesafe
Content-Type: application/json

{"query":"How do retries work?","budget":0.02,"model":"jev-latest"}
```

Search always starts at the selected source's registered index, not the currently browsed page. Omit `url`; if provided, it must exactly equal that registered index URL. A different page URL is rejected even on the same origin.

Returns `Search.Result`: passages, pages, rounds, answer confidence, stop reason, model and usage. The API allows `jev-latest`/`jev-preview`, queries up to 4,000 characters and estimated budgets above $0 and at most **$0.02**; an omitted budget defaults to $0.02 and larger values are rejected. OpenRouter's `/api/v1/systemone` endpoint uses the same Jev schema and bare model aliases. Reported `usage.cost` is honored, including zero; otherwise cost falls back to a token-based estimate. Errors are `{ error: string }` with an appropriate HTTP status. Contracts live in `api/src/contracts.ts`; the playground imports those contracts **as types only**, and imports the shared catalog at runtime.

Search admission is limited to **5 requests/minute per IP** and **20 requests/minute across the deployment**, in addition to the general API limit of **120 requests/minute per IP**. All limits are approximate and **per Cloudflare location**, not global quotas or hard spending caps.

Results also include `duration: { totalMs, jevMs, restMs }`, in milliseconds. Total measures core search execution, including documentation loading and processing, but excludes Worker setup, response serialization and browser/network latency. Jev measures time with at least one model evaluation active: two overlapping one-second calls count as one second, not two. Rest is total minus Jev; these values measure elapsed time, not CPU time or provider-only inference time.

Timing precision depends on the runtime. Cloudflare Workers advance their clock after I/O, so CPU-only work may register as zero milliseconds.

A search is one synchronous HTTP request, not a persisted job. The `enable_request_signal` compatibility flag allows observed client disconnects to interrupt the request-scoped search; the Worker explicitly forwards cancellation to the Durable Object. **Disconnecting cannot undo already-started provider work or guarantee avoided charges.** There is no resumable search/job storage.

## Deploy to Cloudflare

The React SPA and API deploy together as **one Cloudflare Worker with static assets**, on the same origin. GitHub Pages and `PUBLIC_WORKER_URL` are no longer used.

1. Review `api/wrangler.jsonc`:
   - Documentation sources come from `shared/src/index.ts`, not environment host configuration.
   - `ALLOWED_ORIGINS`: optional additional exact origins; the deployment's own origin is always accepted. The initial extra origin is the Vite development server.
   - Worker `name`, custom domains/routes and rate limits as needed.
2. Authenticate, configure the deployment secret, and deploy:

   ```sh
   pnpm --filter @ask-jev/api exec wrangler login
   pnpm --filter @ask-jev/api exec wrangler secret put OPENROUTER_API_KEY
   pnpm run deploy
   ```

   Enter the value at Wrangler's secret prompt, never as a command argument. `api/wrangler.jsonc` declares the required secret and validates deployment configuration.

3. Open the deployed Worker URL.

`pnpm run deploy` runs checks/builds and deploys the SPA, API and Durable Object together. `assets.run_worker_first` reserves `/api/*` for the Worker; other routes serve the SPA with client-side routing fallback. Production security headers live in `playground/public/_headers`.

The Worker name, `HTTP_CACHE` binding, `HttpCacheObject` class, `v1` SQLite migration and per-host object names are preserved. Routing still uses `idFromName(new URL(source.indexUrl).hostname)`; documentation IDs select catalog entries, never cache identities. **Deploying to the same Cloudflare account and Worker retains existing public-document caches; do not delete or reset the migration.** Local Wrangler state now lives under `api/.wrangler/`; old root `.wrangler/` data is not automatically moved. The old GitHub Pages frontend will no longer be compatible with this API; disable Pages in repository settings after deploying.

### GitHub Actions

- **Check** runs frozen-lockfile installation, typechecks, Node tests and builds on pushes/PRs.
- **Deploy Cloudflare** is manual (`workflow_dispatch`). Configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the GitHub **production** environment, with permissions to deploy Workers, static assets and Durable Objects. Use environment protection rules if desired. Provision `OPENROUTER_API_KEY` directly with Wrangler's secret prompt; no model-provider key belongs in CI or the repository.

Alternatively, use Cloudflare's Git integration with the repository root as the build root, `pnpm build` as the build command and `pnpm --filter api run deploy` as the deploy command.

## Operational logs

Server failures are logged with `console.error(Error, stack)`; source maps are uploaded for Cloudflare's source-level diagnostics. Look in **Workers & Pages → ask-jev-api → Observability → Logs / Issues**, or stream logs:

```sh
pnpm --filter @ask-jev/api exec wrangler tail --format json
```

Only sanitized error messages and stack frames are logged, not questions, credentials, response bodies or raw causes. Explicit stack text contains runtime/bundle locations; Cloudflare's captured exception diagnostics use the uploaded source maps. Model HTTP errors retain the upstream status in their message. Successful requests, expected validation failures and cancellation are not logged by application code; automatic invocation logs and library console output are disabled. An application-returned 502 may still count as a handled invocation, so filter by log severity rather than invocation outcome. Logs are not retroactive; Cloudflare controls retention, platform metadata and logging limits.

## Privacy and security

- Questions and Jev responses are transient. **Only public documentation is persisted as application data in SQLite.** Application error logs contain sanitized messages and stack frames, not keys, questions or model responses. Hosting providers, OpenRouter and TypeSafe may retain operational/request data according to their policies.
- The HTTP cache respects freshness, ETag/Last-Modified, revalidation and safe stale-on-error. Private, `no-store`, cookie-setting and credential-varying responses are not stored. Cache entries are bounded to **128 entries / 8 MB per host**, with seven-day retention and alarm/access cleanup.
- The Worker and Durable Object independently validate the catalog selection and page URL. Documentation URLs require HTTPS, no credentials, query or fragment, and the selected source's exact origin. Every redirect/Markdown fallback must stay on that selected origin; another catalog entry's origin is not interchangeable. Caller cookies/headers are never forwarded to docs. Jev credentials go only to the fixed endpoint, with redirects rejected and upstream error bodies suppressed.
- Origin checks, per-IP and deployment-wide rate limits, and streamed body limits reduce abuse. **CORS is not authentication**: non-browser clients can omit/spoof Origin. Limits are approximate/per Cloudflare location, not an account-wide spending or resource cap; estimated search budgets are not hard billing limits either.
- Documentation and passages render as React-escaped text, never trusted HTML. No analytics, external scripts, fonts or CDNs. Do not use confidential documentation.
