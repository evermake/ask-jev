import { Effect } from 'effect'
import * as PagePath from './PagePath.ts'
import * as DocsResolver from './DocsResolver.ts'
import * as Markdown from './Markdown.ts'
import * as Search from './Search.ts'
import * as SystemOne from './SystemOne.ts'

/** Documentation of some service. */
export interface Docs {
  /** Origin all pages live under, e.g. `https://docs.example.com`. */
  readonly origin: string
  /** Path of the index page the docs were made from, e.g. `/llms.txt`. */
  readonly index: PagePath.PagePath
  /** Text of the page. Links to this origin are shortened to paths, e.g. `/guide.md`. */
  contentOf(path: PagePath.PagePath): Effect.Effect<string, DocsResolver.DocsResolverError>
  /** Pages of these docs (same origin) that the page links to, in order, without duplicates. */
  linksFrom(
    path: PagePath.PagePath,
  ): Effect.Effect<ReadonlyArray<PagePath.PagePath>, DocsResolver.DocsResolverError>
  /** Table of contents of the page: its headings, nested by level. */
  tocOf(
    path: PagePath.PagePath,
  ): Effect.Effect<ReadonlyArray<Markdown.TocEntry>, DocsResolver.DocsResolverError>
  /**
   * Finds the passages of the docs that answer a question or match a description, using a fast
   * System One model to read pages starting from the index and follow the most promising links
   * until the answer is found, nothing promising is left, or the budget is spent. Passages are
   * returned as written; see {@link Search.format} for a version to hand to an agent.
   */
  search(
    query: string,
    options?: Search.Options,
  ): Effect.Effect<Search.Result, DocsResolver.DocsResolverError | SystemOne.SystemOneError>
}

export const make = Effect.fnUntraced(function* (
  index: URL,
): Effect.fn.Return<Docs, never, DocsResolver.DocsResolver | SystemOne.SystemOne> {
  const origin = index.origin
  const rootPath = PagePath.PagePath.make(index.pathname)
  if (index.href !== `${origin}${rootPath}`) {
    throw new Error(`Expected index URL to contain only origin and path: ${index.href}`)
  }
  const resolver = yield* DocsResolver.DocsResolver
  const systemOne = yield* SystemOne.SystemOne

  // Concatenate instead of `new URL(path, origin)`, so a path like
  // `//other.host/x` can't point outside the origin.
  const urlOf = (path: PagePath.PagePath) => new URL(`${origin}${path}`)

  /**
   * The page with links to this origin shortened to paths, plus the URL it was actually found at
   * (it may differ after redirects or Markdown fallbacks, which matters for relative links).
   */
  const load = (path: PagePath.PagePath) =>
    resolver.fetch(urlOf(path)).pipe(
      Effect.map((page) => ({
        url: page.url,
        content: Markdown.relativizeLinks(page.content, origin),
      })),
    )

  const contentOf = (path: PagePath.PagePath) =>
    load(path).pipe(Effect.map(({ content }) => content))

  const linksFrom = (path: PagePath.PagePath) =>
    load(path).pipe(
      Effect.map((page) => {
        const self = new Set([path, `${page.url.pathname}${page.url.search}`])
        const links = new Set<PagePath.PagePath>()
        for (const href of Markdown.linkDestinations(page.content)) {
          const url = URL.parse(href, page.url.href)
          if (url === null || url.origin !== origin) continue
          const linked = PagePath.PagePath.make(`${url.pathname}${url.search}`)
          if (!self.has(linked)) links.add(linked)
        }
        return [...links]
      }),
    )

  const tocOf = (path: PagePath.PagePath) => contentOf(path).pipe(Effect.map(Markdown.toc))

  const search = (query: string, options?: Search.Options) =>
    Search.search({ origin, index: rootPath, page: load }, query, options).pipe(
      Effect.provideService(SystemOne.SystemOne, systemOne),
    )

  return { origin, index: rootPath, contentOf, linksFrom, tocOf, search }
})
