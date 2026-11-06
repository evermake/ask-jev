import { Context, Effect, Layer, Schema } from 'effect'

export class DocsResolverError extends Schema.TaggedError<DocsResolverError>()(
  'DocsResolverError',
  {
    url: Schema.String,
    message: Schema.String,
    status: Schema.optional(Schema.Int),
  },
) {}

export interface Page {
  readonly url: URL
  readonly content: string
}

export class DocsResolver extends Context.Service<
  DocsResolver,
  {
    fetch: (url: URL) => Effect.Effect<Page, DocsResolverError>
  }
>()('ask-jev/DocsResolver') {}

const decodePage = Schema.decodeUnknownSync(
  Schema.Struct({ url: Schema.String, content: Schema.String }),
)

/** Only the Worker stores the HTTP cache; the browser never persists documentation. */
export const layerWith = (workerUrl: string) => {
  const pending = new Map<string, Promise<Page>>()
  return Layer.succeed(DocsResolver, {
    fetch: (url) =>
      Effect.tryPromise({
        try: async (signal) => {
          const existing = pending.get(url.href)
          if (existing) return existing
          const load = async () => {
            const endpoint = new URL('/docs', workerUrl)
            endpoint.searchParams.set('url', url.href)
            const response = await fetch(endpoint, {
              signal,
              credentials: 'omit',
              referrerPolicy: 'no-referrer',
            })
            if (!response.ok)
              throw new Error(
                `Documentation request returned HTTP ${response.status}. Check the Worker's DOCS_HOSTS setting.`,
              )
            const page = decodePage(await response.json())
            return { url: new URL(page.url), content: page.content }
          }
          const promise = load().finally(() => {
            pending.delete(url.href)
          })
          pending.set(url.href, promise)
          return promise
        },
        catch: (error) =>
          new DocsResolverError({
            url: url.href,
            message: error instanceof Error ? error.message : 'Failed to load documentation.',
          }),
      }),
  })
}
