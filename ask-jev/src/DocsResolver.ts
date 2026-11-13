import { Context, Effect, Schema } from 'effect'

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

/** Supply your own resolver, or compose Documentation.layer with storage, transport and policy. */
export class DocsResolver extends Context.Service<
  DocsResolver,
  { fetch: (url: URL) => Effect.Effect<Page, DocsResolverError> }
>()('ask-jev/DocsResolver') {}
