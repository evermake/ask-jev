# Ask Jev: repository architecture and integration guide

This document explains the repository as it exists today and how to use its core library independently once it is published to npm.

**The central boundary:** `ask-jev` owns reusable search and documentation logic; `shared` owns the deployed application's dependency-free documentation catalog; `api` supplies Cloudflare adapters and an HTTP interface; `playground` is an HTTP client and user interface. The core library does not require the catalog or either application.

> Publication status: `ask-jev/package.json` currently has `private: true`. The installation examples below assume a future npm release named `ask-jev`, with the current API and Effect peer dependency.

## 1. Repository structure

```text
.
├── shared/                      # Private @ask-jev/shared workspace package
│   ├── src/index.ts             # Readonly DOCS catalog and DocsEntry/DocsId types
│   └── test/index.test.ts       # Expected entries, uniqueness and clean HTTPS indexes
├── ask-jev/                     # Reusable ESM library; future npm package
│   ├── src/
│   │   ├── index.ts             # Public namespace exports
│   │   ├── Docs.ts              # High-level documentation facade
│   │   ├── DocsResolver.ts      # Injectable page-resolution contract and error
│   │   ├── Documentation.ts     # HTTP documentation/cache workflow and services
│   │   ├── HttpCache.ts         # Pure cache metadata/freshness/revalidation logic
│   │   ├── Search.ts            # Best-first search, scoring, results and formatting
│   │   ├── SystemOne.ts         # Jev service, protocol types and default HTTP client
│   │   ├── Markdown.ts          # Parsing, blocks, links and table of contents
│   │   └── PagePath.ts          # Branded root-relative path schema
│   ├── test/                   # Core unit and adapter tests
│   └── README.md               # Focused library integration guide
├── api/                        # Private @ask-jev/api workspace package
│   ├── src/
│   │   ├── index.ts            # Worker admission, CORS, rate limiting, DO routing
│   │   ├── object.ts           # HttpCacheObject: executes browsing and search
│   │   ├── cache.ts            # SQLite CacheStorage adapter and cleanup alarms
│   │   ├── contracts.ts        # HTTP input schema and response types
│   │   └── security.ts         # URL policy, input/body limits and public errors
│   ├── test/                  # Security and real workerd/SQLite integration tests
│   └── wrangler.jsonc         # Worker, static assets, bindings and DO migration
├── playground/                # Private React + Vite workspace package
│   ├── src/main.tsx           # UI state, high-level HTTP calls and result display
│   ├── src/style.css
│   ├── public/_headers        # Production static-asset security headers
│   └── vite.config.ts         # React build and local /api proxy
├── .github/workflows/
│   ├── ci.yml                 # Typechecks, tests and builds
│   └── deploy.yml             # Manual Cloudflare deployment
├── package.json               # Workspace orchestration and Node requirement
├── pnpm-workspace.yaml        # The four workspace packages
├── pnpm-lock.yaml
├── tsconfig.json              # Shared strict TypeScript settings
└── README.md                  # Getting started, operation and deployment
```

Generated `shared/dist/` and `ask-jev/dist/` contain their packages' JavaScript, declarations and source maps. `playground/dist/` contains static assets; `api/dist/` is Wrangler's deployment dry-run output. None is source-controlled.

Development uses **Node.js 24+ and pnpm**. Tests execute TypeScript directly with Node's test runner. Production API code runs in Cloudflare's **workerd**, while the playground runs in the browser. GitHub Actions selects Node 24 directly; no `.node-version` file is required.

## 2. Dependencies between packages

### Workspace dependencies

Arrows mean “depends on”:

```text
api ── runtime ──────────────────────────> ask-jev
api ── runtime ──────────────────────────> @ask-jev/shared
playground ── runtime ───────────────────> @ask-jev/shared
playground ── development / types only ──> api/contracts
                                                │
                                                └── types ──> ask-jev

ask-jev ──X──> shared, api or playground
shared ──X──> framework, Effect or application dependencies
```

- **`api` → `ask-jev`:** the Durable Object imports and runs the core modules.
- **`api` and `playground` → `@ask-jev/shared`:** both import the same runtime `DOCS` catalog; `DocsEntry` and `DocsId` are derived types. The UI dropdown and server URL policy cannot drift into separate source lists.
- **`playground` → `@ask-jev/api/contracts`:** a workspace development dependency used through `import type`. The shared contract refers to core result types, but those imports are erased from browser JavaScript.
- **`playground` → API at runtime:** ordinary same-origin HTTP requests, not an imported server implementation.
- **`ask-jev`:** has no dependency on Cloudflare, React, the playground, or this deployment's HTTP endpoints.

### Important external dependencies

| Package | Runtime dependencies | Main development/build tools |
| --- | --- | --- |
| `shared` | None | TypeScript; Node test runner |
| `ask-jev` | Effect **peer dependency** `^4.1.4`; mdast/micromark/unist Markdown libraries | TypeScript; Node test runner |
| `api` | `@ask-jev/shared`; `ask-jev`; Effect | Wrangler; Cloudflare types; Miniflare/workerd and esbuild for integration tests |
| `playground` | `@ask-jev/shared`; React; React DOM | Vite; React plugin; shared API contract types |

The workspace currently develops against Effect **4.1.4**. Effect is a peer dependency of the library so an integrating application supplies a compatible version rather than receiving an independent bundled runtime. HTTP client support is imported from `effect/http`.

### Build and deployment relationship

The root build runs in this order:

1. Build `@ask-jev/shared` JavaScript and declarations.
2. Build `ask-jev` JavaScript and declarations.
3. Build the React SPA.
4. Run Wrangler's deployment dry run with the catalog, core and SPA available.

Root `dev`, `typecheck` and `test` also build shared before the core; development watches both alongside the applications. The shared package exposes `build`, `typecheck` and `test` scripts for recursive workspace runs.

### Shared documentation catalog

`shared/src/index.ts` is the single application source of truth:

| ID | Label | Index URL |
| --- | --- | --- |
| `typesafe` | TypeSafe | `https://docs.typesafe.ai/llms.txt` |
| `telegram` | Telegram | `https://core.telegram.org/llms.txt` |
| `cloudflare` | Cloudflare | `https://developers.cloudflare.com/llms.txt` |

The package root exports readonly `DOCS`, `type DocsEntry = (typeof DOCS)[number]` and `type DocsId = DocsEntry['id']`. It has no frontend, framework or Effect dependency. To add a source, add one `{ id, label, indexUrl }` entry here, update the expected-entry test and rebuild/deploy. The UI derives its dropdown from this list; the server derives its allowed source and origin from the same entry. `DOCS_HOSTS` has been removed; environment configuration does not add arbitrary hosts.

The API deployment includes the playground's static assets. This is **one Cloudflare Worker deployment with a Durable Object and static assets**, not a separate Pages deployment. `/api/*` reaches Worker code first; other routes serve static assets with SPA fallback.

## 3. Runtime request flow

```text
Browser: playground
    │ Dropdown selects a shared catalog ID
    │ GET /api/page?docs=typesafe[&url=...]
    │ POST /api/search?docs=typesafe + Bearer key + JSON body
    ▼
Worker: api/src/index.ts
    │ Origin/CORS checks, rate limit, catalog and initial URL validation
    │ Select DO with idFromName(new URL(source.indexUrl).hostname)
    ▼
Durable Object: api/src/object.ts
    ├── Independently validates catalog selection and selected-origin URL policy
    ├── Documentation resolver ──> public documentation host
    │           └───────────────> SQLite HTTP cache
    └── Search ──> request-scoped SystemOne client ──> TypeSafe Jev API
```

### Browse request

1. The Worker validates `docs` against the catalog and the optional page `url` against that source's exact origin, then forwards to the per-host DO. Omitting `url` selects the registered index.
2. The DO independently validates the source/page selection and calls `DocsResolver.fetch`, using the composed `Documentation.layer`.
3. The resolver validates the target and every redirect/Markdown fallback against the selected origin, checks SQLite, and downloads/revalidates as needed.
4. The DO extracts approved same-origin links and a table of contents.
5. The browser receives `{ url, content, links, toc }` and renders escaped text.

Browsing needs no Jev key and makes no model calls.

### Search request

1. The Worker validates `docs` against the catalog and forwards the request to the same per-host DO. Search starts at the registered `indexUrl`; `url` must be absent or exactly equal to that index, never an arbitrary starting page.
2. The DO independently validates that catalog/index selection, plus the Bearer key, JSON content type, question, model and estimated budget.
3. It constructs a **request-scoped** `SystemOne` layer using that visitor's key.
4. It combines that model layer with the documentation layer, creates `Docs`, and calls `docs.search`.
5. The complete traversal, page fetching, cache access, scoring and answer judging execute inside the DO.
6. The final `Search.Result` returns through the Worker to the browser.

The DO retains its public-document cache adapter and documentation layer, **not a visitor's model client or key**. Searches are synchronous HTTP requests, not durable jobs. Browser disconnection must not be treated as a guarantee of server-side cancellation or avoided charges.

Documentation IDs are selection keys only. Durable Object identities remain `idFromName(new URL(source.indexUrl).hostname)`, preserving existing per-host SQLite caches rather than creating new caches keyed by `typesafe`, `telegram` or `cloudflare`.

### API contracts versus core API

`api/src/contracts.ts` defines `SearchInput`, `PageResult`, `SearchResult` and `ApiError`. `SearchResult` aliases the core's `Search.Result`.

The deployed API requires a catalog `docs` selector (`typesafe`, `telegram` or `cloudflare`). Browse URLs default to the selected index and must use its exact HTTPS origin with no credentials/query/fragment; redirects and Markdown alternatives must stay on that same selected origin, even if another origin also appears in the catalog. Search has a fixed registered starting index. Worker and DO enforce these constraints independently. The API also allows two model names, a 4,000-character question limit and an estimated budget greater than $0 and at most $1. These are **deployment restrictions**, not the complete capabilities or validation contract of the reusable library. An integrator must define its own admission and spending policy.

## 4. Core modules and interfaces

### Effect vocabulary

In the signatures below, `Effect.Effect<A, E, R>` describes a computation that succeeds with `A`, fails with a typed error `E`, and requires services `R`.

- A **service** is an injectable capability, such as page fetching or Jev evaluation.
- A **layer** supplies an implementation of one or more services.
- `Layer.provide` wires a layer's prerequisites; `Effect.provide` supplies services to a program.
- `Effect.runPromise` executes a fully provided program at an application boundary.

Importing modules or constructing a search effect does not itself make model requests.

### `Docs.ts`: the high-level facade

`Docs.make(index: URL)` requires both `DocsResolver.DocsResolver` and `SystemOne.SystemOne`. It captures them and returns a `Docs` object with no remaining service requirements on its methods:

| Member | Purpose |
| --- | --- |
| `origin`, `index` | Documentation origin and root-relative index path |
| `contentOf(path)` | Load content and shorten same-origin link destinations |
| `linksFrom(path)` | Return unique same-origin linked page paths |
| `tocOf(path)` | Return nested headings |
| `search(query, options?)` | Traverse documentation and return ranked passages |

`Docs.make` expects the index URL to contain only an origin and path. It does not fetch the index eagerly. Even browsing-only use of this facade currently requires a model service to construct it; use `DocsResolver` directly when you only need page fetching.

### `DocsResolver.ts`: replaceable page resolution

The service contract is:

```ts
fetch(url: URL): Effect.Effect<DocsResolver.Page, DocsResolver.DocsResolverError>

// DocsResolver.Page:
{ readonly url: URL; readonly content: string }
```

The returned `url` is the page's **actual resolved URL**, including redirects or Markdown alternatives. Relative links resolve against that URL, not necessarily the requested one.

You can supply this service directly for filesystem documents, a database, a remote service or test fixtures. Doing so bypasses the stock HTTP caching workflow; the custom resolver owns access control, fetching and caching.

### `Documentation.ts`: the stock HTTP workflow

`Documentation.layer` provides `DocsResolver` and requires three services:

| Service | Interface | Adapter responsibility |
| --- | --- | --- |
| `CacheStorage` | `get(url)`, `set(entry)`, `remove(url)` | Persistence, serialization, retention and eviction |
| `DocsTransport` | `get(url, headers)` returning a native `Response` | Credential-free GET; return redirects without following them |
| `DocsPolicy` | `validate(url)` and `maxBytes` | Allowed targets/SSRF policy and streamed body-size limit |

Each method returns an Effect; adapter failures use `DocsResolverError`. `CacheStorage.get` returns `CachedResponse | undefined`.

```text
CacheStorage ───┐
DocsTransport ──┼──> Documentation.layer ──> DocsResolver
DocsPolicy ─────┘
```

`Documentation.layerFetch` is the default transport: native fetch, manual redirects, omitted credentials, no referrer and a ten-second fetch timeout.

The workflow implements freshness checks, ETag/Last-Modified conditional requests, 304 metadata updates, permitted stale-on-transport/5xx-error fallback, redirect validation, streamed size limits and common `.md` alternatives when a response is HTML. Policy failures are not converted into stale-cache successes.

This is a **public-document cache**, not a general authenticated/variant HTTP cache. It excludes private, `no-store`, cookie-setting and credential-varying responses. The stock cache key is the requested URL. If a custom transport varies representations by user or other request headers, revisit the keying strategy or replace the resolver rather than sharing those responses accidentally.

### `HttpCache.ts`: pure HTTP cache calculations

`CachedResponse` contains the requested and resolved URLs, body, relevant response headers, and request/response timestamps. The main helpers are:

- `fromResponse`, `isStorable`: create metadata and check basic storage eligibility.
- `isFresh`, `freshnessLifetime`, `currentAge`: calculate reuse without a request.
- `conditionalHeaders`, `freshen`: perform validator-based revalidation.
- `canServeStale`: check whether directives permit stale fallback.

These helpers do no I/O. Shared/public-cache exclusions are applied by `Documentation`, while the storage adapter owns physical retention. HTTP freshness and storage retention are distinct policies.

### `SystemOne.ts`: Jev protocol and injectable model service

```ts
evaluate(request: SystemOne.Request):
  Effect.Effect<SystemOne.Response, SystemOne.SystemOneError>
```

A request contains `state`, named `questions` and an optional `model`. Question types are `noul` (yes/no probability), `choice` and `score`. The decoded response includes answers, a versioned model ID and token usage; helper methods include `response.noul(id)` and `response.probabilities(id)`.

- `makeWith(apiKeyEffect, endpoint?, options?)` builds an implementation using an injected Effect `HttpClient`.
- `layerWith(...)` supplies that service with the default fetch-based HTTP client.
- The key effect is evaluated before each evaluation, allowing dynamic credentials.
- Defaults: `jev-latest`, the fixed TypeSafe System One endpoint, a 30-second response timeout and **zero automatic retries**. There is no speculative hedging.

A custom `SystemOne` service can add instrumentation, use a controlled proxy or return deterministic test responses. It must preserve the protocol semantics and usage accounting expected by search; it is not an arbitrary text-generation interface.

### `Search.ts`: traversal and result model

`Search.search(source, query, options?)` requires `SystemOne`. Its `Source` interface is independent of the HTTP resolver:

```ts
interface Source {
  readonly origin: string
  readonly index: PagePath.PagePath
  readonly page: (path: PagePath.PagePath) => Effect.Effect<
    { readonly url: URL; readonly content: string },
    DocsResolver.DocsResolverError
  >
}
```

Search starts at the index, parses Markdown blocks and links, asks Jev to rate their relevance, follows the most promising links, merges useful blocks into passages, and judges whether those passages collectively answer the query. Document load failures are recorded on pages so traversal can continue; model evaluation failures fail the search.

Public options are currently `budget` (default **$0.02**) and `model`. Page/concurrency limits and score thresholds are implementation constants, not public options.

`Search.Result` contains:

| Field | Meaning |
| --- | --- |
| `passages` | Ranked source text, paths, heading context, relevance and content offsets |
| `answered` | Model-estimated probability that the found passages answer the question |
| `stopped` | `answered`, `exhausted`, `budget` or `max-pages` |
| `pages`, `rounds` | Traversal history, remaining links and progress by round |
| `usage` | Successful logical evaluation count, input tokens and calculated cost |
| `duration` | Core search elapsed milliseconds: `totalMs`, `jevMs` and `restMs` |
| `model` | Last reported model ID; may be empty if no evaluation ran and no model was supplied |

Duration uses a monotonic clock per search. `jevMs` is the union of model-evaluation intervals across all concurrent pages and windows, including answer judging; overlaps count once and gaps do not count. `restMs = totalMs - jevMs`, including documentation work and processing when no evaluation is active. Total excludes Worker/layer setup, response serialization and browser/network latency. Model timing surrounds the logical `SystemOne.evaluate` operation, not provider-only inference.

These are runtime-observed durations: Cloudflare Workers advance their clock after I/O, so CPU-only processing may register as zero. Zero values are valid; this metric is not a CPU profiler.

`Search.format(result)` produces compact Markdown for an agent or CLI. It **does not generate an answer**. Passage offsets refer to the content supplied to search, which the `Docs` facade may normalize; do not apply them blindly to raw downloaded bytes.

Budgeting uses token estimates and a configured per-token price, not a billing cap. Charges from retries, unsuccessful/aborted requests or provider pricing changes may not be represented by successful-result usage.

### `Markdown.ts` and `PagePath.ts`

`Markdown` supplies GitHub Flavored Markdown parsing, block splitting, link destinations/context, same-origin link shortening and nested tables of contents. It does not render trusted HTML.

`PagePath.PagePath` brands strings starting with `/`. This is a path type, **not a complete security validator**. URL access policy belongs in the resolver/application. The facade concatenates the origin and path rather than resolving a path like `//other.host/x` as another host.

## 5. How the core pieces fit together

```text
CacheStorage + DocsTransport + DocsPolicy
                    │
                    ▼
          Documentation.layer
                    │ provides
                    ▼
               DocsResolver ─────┐
                                 ├──> Docs.make(index) ──> docs.search(...)
            SystemOne ───────────┘                            │
                 ▲                                           ▼
                 │                              Search + Markdown processing
        SystemOne.layerWith(key)                    │                 │
                                                   ▼                 ▼
                                            resolve pages      evaluate questions
```

There are three integration levels:

1. **Use `Docs` + `Documentation`:** keep the default HTTP workflow and supply storage and policy. Usually the best starting point.
2. **Use `Docs` + your `DocsResolver`:** replace all page resolution/caching while retaining the facade and search.
3. **Use `Search.search` + your `Source`:** integrate an existing document store without adopting the HTTP workflow or facade.

## 6. Using the future npm package

### Install and imports

Assuming the published name and peer range remain unchanged:

```sh
pnpm add ask-jev 'effect@^4.1.4'
```

The package is ESM with TypeScript declarations. Configure a Node application as an ES module (`"type": "module"` in its `package.json`) and use Node 24+.

```ts
// Namespace-style public exports:
import { Docs, Documentation, DocsResolver, HttpCache, Search, SystemOne } from 'ask-jev'

// Alternatively, individual modules:
import * as SearchModule from 'ask-jev/Search'
```

You do **not** need the `api` or `playground` workspace packages, Wrangler, React, or a Cloudflare account. The default adapters contact the documentation host and TypeSafe directly.

### Complete example: HTTP documentation with an in-memory cache

Save this as `search.ts` in your application. The document cache is shared across calls, while each call receives its own key and model layer.

```ts
import {
  Docs, Documentation, DocsResolver, HttpCache, Search, SystemOne,
} from 'ask-jev'
import { Effect, Layer, Redacted } from 'effect'

// Demonstration cache only: add byte/entry bounds and eviction for production.
const entries = new Map<string, HttpCache.CachedResponse>()
const cache = Layer.succeed(Documentation.CacheStorage, {
  get: (url) => Effect.sync(() => entries.get(url)),
  set: (entry) => Effect.sync(() => { entries.set(entry.url, entry) }),
  remove: (url) => Effect.sync(() => { entries.delete(url) }),
})

const policy = Layer.succeed(Documentation.DocsPolicy, {
  maxBytes: 1_000_000,
  validate: (url) =>
    url.protocol === 'https:' && url.hostname === 'docs.typesafe.ai' &&
    !url.port && !url.username && !url.password && !url.search && !url.hash
      ? Effect.void
      : Effect.fail(new DocsResolver.DocsResolverError({
          url: url.href,
          message: 'Documentation URL is not permitted.',
          status: 400,
        })),
})

const documentation = Documentation.layer.pipe(
  Layer.provide(Layer.mergeAll(cache, policy, Documentation.layerFetch)),
)

export async function searchDocs(query: string, apiKey: string) {
  const model = SystemOne.layerWith(Effect.succeed(Redacted.make(apiKey)))
  const program = Effect.gen(function* () {
    const docs = yield* Docs.make(new URL('https://docs.typesafe.ai/llms.txt'))
    return yield* docs.search(query, { budget: 0.02, model: 'jev-latest' })
  })
  return Effect.runPromise(
    program.pipe(Effect.provide(Layer.merge(documentation, model))),
  )
}

const key = process.env.TYPESAFE_API_KEY
if (!key) throw new Error('Set TYPESAFE_API_KEY before running this example.')
const result = await searchDocs('How do retries and timeouts work?', key)
console.log(Search.format(result))
console.log(result.usage)
```

Run it with Node 24 after setting `TYPESAFE_API_KEY` securely in your environment:

```sh
node search.ts
```

**This makes paid Jev calls.** Do not put real credentials in source control or logs. In a server application, keep `searchDocs` in a module without the example's top-level invocation, validate caller input, and pass the authenticated/request-specific key explicitly. If your application already uses Effect, expose the program as an Effect and compose it instead of calling `runPromise` inside every helper.

The example allowlist is intentional. Do not turn a user-provided URL into unrestricted server-side fetching. Approve only trusted public documentation hosts and account for DNS/network restrictions appropriate to your deployment.

### Bring an existing document source

If documentation already lives in a filesystem, database or application-managed cache, bypass `Documentation` entirely:

```ts
import { DocsResolver, PagePath, Search, SystemOne } from 'ask-jev'
import { Effect, Redacted } from 'effect'

const origin = 'https://docs.example.com'
const documents = new Map([
  ['/llms.txt', '# Documentation\n\n[Retries](/retries.md)'],
  ['/retries.md', '# Retries\n\nRetry failed operations with bounded backoff.'],
])

const source: Search.Source = {
  origin,
  index: PagePath.PagePath.make('/llms.txt'),
  page: (path) => Effect.gen(function* () {
    const content = documents.get(path)
    if (content === undefined) {
      return yield* Effect.fail(new DocsResolver.DocsResolverError({
        url: `${origin}${path}`, message: 'Document not found.', status: 404,
      }))
    }
    return { url: new URL(`${origin}${path}`), content }
  }),
}

// apiKey is supplied by your application; this still makes paid model calls.
export const searchStoredDocs = (query: string, apiKey: string) =>
  Search.search(source, query, { budget: 0.02 }).pipe(
    Effect.provide(SystemOne.layerWith(Effect.succeed(Redacted.make(apiKey)))),
  )
```

The returned value remains an Effect; run it at your application boundary. There is no HTTP documentation transport, HTTP cache or `DocsResolver` service requirement here—only the model service is provided. `DocsResolverError` is reused as the page-loading error type.

## 7. Adapter ownership, security and observability

| Concern | Reusable library | This repository's Cloudflare application |
| --- | --- | --- |
| Search strategy and result shape | `Search`, `Docs`, `Markdown` | Calls the library |
| HTTP cache decisions | `Documentation`, `HttpCache` | Supplies persistence |
| Cache lifetime/capacity | Storage adapter's responsibility | Seven-day retention, 128 entries and 8,000,000 bytes per host; alarms/access cleanup |
| Allowed documentation targets | Injected policy | Shared catalog; Worker and DO independently validate selection/page origin; redirects/fallbacks stay on the selected origin |
| Jev credentials | Supplied key effect; redacted wrapper | Request-scoped visitor key; fixed endpoint and redirect rejection |
| HTTP admission, CORS, rate limiting | Not provided | Worker and DO request validation |
| UI and HTTP contract | Not required | Playground and `api/contracts` |

Only public documentation is persisted by the API. Questions, visitor keys, Jev responses and search jobs are not stored in SQLite. The browser holds the key in tab memory, not local/session storage. Provider infrastructure may have its own operational logging/retention policies.

For tracing, wrap `SystemOne.evaluate`, `DocsTransport.get` or storage methods, or supply an Effect tracer. Named spans exist for documentation fetch/load/download and System One evaluation. Search also emits debug events with request counts, token counts and round progress. Avoid logging keys, document bodies or prompts. A custom adapter's errors must not embed credential-bearing requests or unredacted secrets.

Tests can replace these same services with deterministic layers. Shared tests cover expected catalog entries, unique IDs/index URLs and clean HTTPS indexes. Core tests cover parsing, cache semantics and search; API integration tests exercise actual workerd and SQLite with mocked upstream responses, so they do not require keys or spend credits.

## 8. Publication boundary

The future npm artifact exports JavaScript/declarations from `dist/`, with source files included for source maps. It has no workspace-only runtime dependency. Shipping compiled JavaScript avoids relying on Node to strip TypeScript from installed `node_modules` packages.

Before publishing, remove `private`, settle the public name/version/license and release metadata, and review the exported API and Effect peer range. `shared`, `api` and `playground` remain private application packages; consumers should not depend on their catalog or contracts to use the library.

For local commands and Cloudflare deployment, see [README.md](README.md). For the shorter library-specific guide, see [ask-jev/README.md](ask-jev/README.md).
