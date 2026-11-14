# ask-jev

Effect-based documentation search with Jev / System One. The package has **no Cloudflare imports, browser endpoints, global API key, or bundled storage implementation**. Search uses injectable Effect services and returns passages as written rather than generated text.

## Services and extension points

| Service | Contract | How to provide it |
| --- | --- | --- |
| `DocsResolver.DocsResolver` | `fetch(URL): Effect<Page, DocsResolverError>` | Implement your own resolver, or use `Documentation.layer` below. |
| `SystemOne.SystemOne` | `evaluate(Request): Effect<Response, SystemOneError>` | Implement your own model/telemetry adapter, or use `SystemOne.makeWith` / `layerWith`. |
| `Documentation.CacheStorage` | `get`, `set`, `remove` cached HTTP entries | SQLite, memory, Redis, filesystem, etc. Adapter owns retention/eviction. |
| `Documentation.DocsTransport` | credential-free GET, without following redirects | Supply your transport, or `Documentation.layerFetch`. |
| `Documentation.DocsPolicy` | URL validation and max body bytes | Your host/SSRF policy; runs before cache use and every redirect/fallback. |

`Documentation.layer` provides `DocsResolver` and requires the last three services. `Docs.make(index)` captures `DocsResolver` and `SystemOne`, returning a facade with `contentOf`, `linksFrom`, `tocOf` and `search`. Alternatively, call `Search.search(source, query, options)` with your own page source and provide only `SystemOne`.

The default docs workflow handles HTTP freshness, conditional requests, safe stale-on-error and Markdown alternatives. HTTP cache calculations are also exported independently from `HttpCache`. The Jev adapter uses Effect's `HttpClient`; `makeWith` leaves that dependency injectable, whereas `layerWith` supplies `FetchHttpClient.layer`.

## Example: integrate with your adapters

```ts
import { Docs, Documentation, DocsResolver, HttpCache, Search, SystemOne } from 'ask-jev'
import { Effect, Layer, Redacted } from 'effect'

// Example only: process-local memory, no eviction. Real integrations should bound storage.
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
          url: url.href, message: 'Documentation URL is not permitted.', status: 400,
        })),
})
const documentation = Documentation.layer.pipe(
  Layer.provide(Layer.mergeAll(cache, policy, Documentation.layerFetch)),
)
const key = Effect.try({
  try: () => {
    if (!process.env.TYPESAFE_API_KEY) throw new Error('Missing key')
    return Redacted.make(process.env.TYPESAFE_API_KEY)
  },
  catch: () => new SystemOne.SystemOneError({ message: 'Set TYPESAFE_API_KEY.' }),
})
const model = SystemOne.layerWith(key) // TypeSafe endpoint; zero automatic retries.

const program = Effect.gen(function* () {
  const docs = yield* Docs.make(new URL('https://docs.typesafe.ai/llms.txt'))
  return yield* docs.search('How do retries work?', { budget: 0.02 })
})
const result = await Effect.runPromise(
  program.pipe(Effect.provide(Layer.merge(documentation, model))),
)
console.log(Search.format(result))
```

**This example makes paid API requests** if run with a real key. Budgeting estimates input tokens and is not a hard billing cap. `SystemOne.layerWith(key, endpoint?, { retries: 0 })` has no speculative hedging and defaults to no retries. Enabling retries may incur additional charges not reflected in successful logical-request usage.

## OpenRouter or TypeSafe

The default provider is TypeSafe (`SystemOne.TYPESAFE_ENDPOINT`). To use an OpenRouter key, supply an Effect that returns that key as `Redacted` (as above, reading `OPENROUTER_API_KEY` instead), then choose either form:

```ts
const model = SystemOne.layerOpenRouter(openRouterKey)
// Equivalent, retaining the positional endpoint API:
const explicit = SystemOne.layerWith(openRouterKey, SystemOne.OPENROUTER_ENDPOINT)
```

`SystemOne.OPENROUTER_ENDPOINT` is `https://openrouter.ai/api/v1/systemone`, not the chat-completions endpoint. `makeOpenRouter(key, options?)` is the injectable-`HttpClient` equivalent of `layerOpenRouter(key, options?)`; both accept the same retry options as `makeWith` / `layerWith`. Keys are evaluated before every request. Keep server keys on your server; these adapters do not provide a browser proxy or expose keys for you.

Both providers accept the same typed questions and responses. The default `jev-latest` and `jev-preview` aliases work on OpenRouter without a namespace; you can also pass a qualified ID such as `typesafe/jev-1.13-20260917` in `docs.search(query, { model })` or `SystemOne.Request.model`. The returned model ID is preserved, including its namespace.

OpenRouter responses include optional `usage.cost` in USD. Search adds each response's reported cost (including zero), falling back to `input_tokens * SystemOne.PRICE_PER_TOKEN` when absent. Results and round costs use that total. Before passage judging, search rechecks spending and the estimated judge cost; if it cannot fit, search returns the passages already found with `stopped: "budget"`. Future-request budgeting still estimates token costs and is not a hard billing cap or a provider-pricing guarantee. On OpenRouter BYOK configurations, reported cost may cover only OpenRouter's fee, not separate provider charges.

To add tracing, wrap `SystemOne.evaluate`, `DocsTransport.get` or `CacheStorage` in your own layer and/or supply an Effect tracer. The built-in client creates a `SystemOne.evaluate` span with a question count and disables outgoing trace headers. Never annotate/log keys or prompt bodies unless you explicitly intend to disclose them. Search's `usage.requests` counts successful logical evaluations; it is not a billing ledger.

Search results include `duration: { totalMs, jevMs, restMs }`. These are elapsed milliseconds measured with a monotonic clock during core search execution. Jev time counts the union of all active logical model evaluations, including judging, so concurrent calls count only once. Rest is total minus Jev. Total includes documentation loading and processing, but excludes application setup, response serialization and browser/network latency.

## Development / future npm release

From the workspace root:

```sh
pnpm --filter ask-jev build
pnpm --filter ask-jev test
pnpm --filter ask-jev pack
```

The package exports ESM JavaScript and declarations from `dist/`, including subpaths such as `ask-jev/Search`. This avoids relying on Node's TypeScript stripping inside `node_modules`. Tests run the `.ts` sources directly with Node 24's test runner.

It is intentionally **private for now**. Before publishing, remove `private`, choose the public name/version/license and release metadata, and review the API. `effect` is a peer dependency so integrations share a single Effect runtime; all Markdown dependencies are ordinary production dependencies. No workspace-only or Cloudflare dependencies are required by the published package.
