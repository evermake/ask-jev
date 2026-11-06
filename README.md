# Ask Jev

Browse public documentation and find passages with TypeSafe's Jev / System One model. The frontend is a static GitHub Pages site; a separate Cloudflare Worker handles upstream requests, with a SQLite-backed Durable Object caching documentation.

## Use

Open <https://evermake.github.io/ask-jev/>, enter a public docs index such as `https://docs.typesafe.ai/llms.txt`, and browse its links. To search, enter **your own TypeSafe API key**, a question, a budget, and a model.

Search returns relevant passages, not generated answers. It shows relevance scores, pages followed, token usage, and the requests sent to Jev. Searches cost money on **your** TypeSafe account. The budget is an estimate, not a billing cap; upstream retries and slow-request duplicates can incur additional charges.

The Worker only fetches hosts listed in `DOCS_HOSTS`. Initially that is `docs.typesafe.ai`. Add other **public documentation** hosts explicitly before using them; redirects must also stay within this list. URLs must use HTTPS and cannot contain credentials, query strings, or fragments. This restriction intentionally avoids creating a general-purpose public proxy.

## Privacy and security

- The site has no shared API key. Visitors authorize Jev requests with their own key.
- Keys stay in tab memory until forgotten, navigation away, or reload. They are never put in URLs, local/session storage, cookies, build artifacts, or the SQLite cache. The password field necessarily holds the key while in use.
- The key is sent over HTTPS to the configured Worker, and from there **only** to `https://api.typesafe.ai/v1/systemone`. The Worker operator is therefore part of your trust boundary. Use a dedicated, limited-spend key.
- Search questions and selected documentation are sent to the Worker and TypeSafe. Questions are omitted from navigation URLs. Neither prompts nor Jev responses are persisted by application code; TypeSafe's own data policies still apply.
- SQLite stores **public documentation only**, with HTTP freshness, ETag / Last-Modified revalidation, safe stale-on-error fallback, Markdown alternatives, eviction, and retention cleanup. Private, `no-store`, cookie-setting, or credential-varying responses are not persisted. Do not use confidential documentation.
- Cache storage is bounded to 128 entries / 8 MB per approved host and entries older than seven days are removed on access or periodic cleanup.
- Worker observability is disabled, and application code does not log request bodies, keys, or prompts. Hosting providers may still retain operational metadata according to their policies.
- Exact-origin CORS, per-IP rate limits, an operator-managed host allowlist, validation of every redirect, and streaming size limits reduce abuse. **CORS is not authentication**: non-browser clients can spoof Origin. Rate limits are approximate and per Cloudflare location; they are not an account-wide cost cap. No operator-funded TypeSafe key is available to abuse.
- The frontend bundles its dependencies locally and loads no analytics, external scripts, or remote fonts. Its CSP blocks form submissions and script injection. Request bodies and documentation are rendered as escaped text, not trusted HTML.

## Local development

Requires Bun 1.4.4 or newer.

```sh
bun install --frozen-lockfile
bun run check
bun run worker:dev
```

In another terminal:

```sh
bun run build
bun run dev
```

Open `http://localhost:3000`. Wrangler runs the Worker at `http://localhost:8787` and stores development SQLite data under the ignored `.wrangler/` directory. Enter your key in the browser; no `.env` file is needed.

## Deploy

### 1. Cloudflare Worker and SQLite Durable Object

```sh
bunx wrangler login
bun run worker:deploy
```

The `v1` migration provisions `HttpCacheObject` with SQLite storage. `ALLOWED_ORIGINS` and `DOCS_HOSTS` in `wrangler.jsonc` are public configuration, not credentials. Set exact approved origins and documentation hosts before deployment. No TypeSafe secret is configured in Cloudflare or GitHub. Check Cloudflare's current plan limits and billing settings before exposing the Worker.

Worker deployments are manual. Cloudflare credentials remain on the deploying machine; do not commit them or upload them as Pages artifacts.

### 2. GitHub Pages

1. Set the repository **Actions variable** `PUBLIC_WORKER_URL` to the deployed Worker origin, e.g. `https://ask-jev-api.<your-subdomain>.workers.dev`. This URL is public.
2. Set **Settings → Pages → Source** to **GitHub Actions**.
3. Push to `main` or run **Deploy Pages** in Actions.

The workflow installs from the lockfile, checks types, runs tests, builds only the frontend into `site/`, and uploads **only `site/`**. It never uploads the source tree, local SQLite files, Wrangler state, or environment files. Deployment fails if a production Worker URL has not been configured.

## Layout

- `src/`: browser UI, Markdown processing, best-first documentation search, and HTTP caching helpers.
- `worker/index.ts`: constrained Jev gateway and SQLite-backed Durable Object.
- `worker/security.ts`: target validation, shared-cache restrictions, and body limits.
- `scripts/`: frontend build and local static server.
- `.github/workflows/pages.yml`: frontend checks and Pages deployment.

All tests use synthetic data and mock Jev responses; running them does not use an API key or spend TypeSafe credits.
