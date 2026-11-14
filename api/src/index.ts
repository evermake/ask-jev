import { Duration } from 'effect'
import { docsSource, docsTarget, PublicError } from './security.ts'
import type { HttpCacheObject } from './object.ts'
export { HttpCacheObject } from './object.ts'

const CORS_MAX_AGE = Duration.minutes(10)

export interface Env {
  HTTP_CACHE: DurableObjectNamespace<HttpCacheObject>
  REQUEST_LIMITER: RateLimit
  SEARCH_LIMITER: RateLimit
  DEMO_LIMITER: RateLimit
  ALLOWED_ORIGINS: string
  OPENROUTER_API_KEY?: string
}

/** Admission/routing only. Documentation, SQLite, Markdown processing and Jev run in the DO. */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('origin')
    const allowed = [url.origin, ...env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean)]
    if (origin && !allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 })
    const headers: Record<string, string> = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      vary: 'Origin',
      ...(origin ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type',
        'access-control-max-age': String(Duration.toSeconds(CORS_MAX_AGE)),
      } : {}),
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    let response: Response
    try {
      const { success } = await env.REQUEST_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') ?? 'local' })
      if (!success) throw new PublicError('Too many requests. Try again in a minute.', 429)
      if (!((url.pathname === '/api/page' && request.method === 'GET') ||
          (url.pathname === '/api/search' && request.method === 'POST'))) throw new PublicError('Not found.', 404)
      const source = docsSource(url.searchParams)
      docsTarget(url.searchParams, source, url.pathname === '/api/search')
      if (url.pathname === '/api/search') {
        const { success: visitorAllowed } = await env.SEARCH_LIMITER.limit({
          key: request.headers.get('cf-connecting-ip') ?? 'local',
        })
        if (!visitorAllowed) throw new PublicError('Search limit reached. Try again in a minute.', 429)
        const { success: demoAllowed } = await env.DEMO_LIMITER.limit({ key: 'public-demo' })
        if (!demoAllowed) throw new PublicError('The demo is busy. Try again in a minute.', 429)
      }
      const stub = env.HTTP_CACHE.get(env.HTTP_CACHE.idFromName(new URL(source.indexUrl).hostname))
      response = await stub.fetch(request, { signal: request.signal })
    } catch (error) {
      response = Response.json({ error: error instanceof PublicError ? error.message : 'API unavailable. Please try again.' }, {
        status: error instanceof PublicError ? error.status : 502,
      })
    }
    const result = new Response(response.body, response)
    for (const [name, value] of Object.entries(headers)) result.headers.set(name, value)
    return result
  },
} satisfies ExportedHandler<Env>
