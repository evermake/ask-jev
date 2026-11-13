import { Schema } from 'effect'
import type { Markdown, Search } from 'ask-jev'

/** ?docs=<id> selects a registered index; search cannot override it. Questions and keys stay out of navigation URLs. */
export const SearchInput = Schema.Struct({
  query: Schema.String,
  budget: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.Literals(['jev-latest', 'jev-preview'])),
})
export type SearchInput = typeof SearchInput.Type

export interface PageResult {
  readonly url: string
  readonly content: string
  readonly links: ReadonlyArray<{ readonly url: string; readonly text: string }>
  readonly toc: ReadonlyArray<Markdown.TocEntry>
}
export type SearchResult = Search.Result
export interface ApiError { readonly error: string }
