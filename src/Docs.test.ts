import { expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'
import * as Docs from './Docs.ts'
import * as DocsResolver from './DocsResolver.ts'
import * as PagePath from './PagePath.ts'
import * as SystemOne from './SystemOne.ts'

/** Docs backed by fixed pages; `found` maps a requested URL to where its content lives. */
const run = <A>(
  pages: Record<string, string>,
  found: Record<string, string>,
  body: (docs: Docs.Docs) => Effect.Effect<A, DocsResolver.DocsResolverError>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* Docs.make(new URL('https://x.dev/llms.txt')))
  }).pipe(
    Effect.provide(SystemOneUnused),
    Effect.provide(
      Layer.succeed(DocsResolver.DocsResolver, {
        fetch: (url) => {
          const actual = found[url.href] ?? url.href
          const content = pages[actual]
          return content === undefined
            ? Effect.fail(new DocsResolverError({ url: url.href, message: 'not found' }))
            : Effect.succeed({ url: new URL(actual), content })
        },
      }),
    ),
    Effect.runPromise,
  )

const { DocsResolverError } = DocsResolver

const SystemOneUnused = Layer.succeed(SystemOne.SystemOne, {
  evaluate: () => Effect.die('System One is not used in these tests'),
})
const path = PagePath.PagePath.make

test('shortens same-origin links in content', async () => {
  await run(
    { 'https://x.dev/llms.txt': '[A](https://x.dev/a.md) [B](https://other.dev/b.md)' },
    {},
    (docs) =>
      Effect.gen(function* () {
        expect(yield* docs.contentOf(docs.index)).toBe('[A](/a.md) [B](https://other.dev/b.md)')
        expect(yield* docs.linksFrom(docs.index)).toEqual([path('/a.md')])
      }),
  )
})

test('resolves relative links against where the page was found', async () => {
  await run(
    { 'https://x.dev/guide/index.md': '[Self](index.md) [Next](next.md) [Up](../up.md)' },
    { 'https://x.dev/guide': 'https://x.dev/guide/index.md' },
    (docs) =>
      Effect.gen(function* () {
        expect(yield* docs.linksFrom(path('/guide'))).toEqual([
          path('/guide/next.md'),
          path('/up.md'),
        ])
      }),
  )
})
