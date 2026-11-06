/** Markdown helpers built on mdast (the syntax tree used by remark). */
import type { ListItem, Node, Root, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { toString } from 'mdast-util-to-string'
import { gfm } from 'micromark-extension-gfm'
import { visit } from 'unist-util-visit'

/** Parses GitHub Flavored Markdown into an mdast tree. */
export const parse = (markdown: string): Root =>
  fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })

/**
 * Link destinations found in the document, in order of appearance: inline links, autolinks
 * (including bare URLs) and reference definitions. Images and code are ignored.
 */
export const linkDestinations = (markdown: string): Array<string> => {
  const urls: Array<string> = []
  visit(parse(markdown), ['link', 'definition'], (node) => {
    if (node.type === 'link' || node.type === 'definition') urls.push(node.url)
  })
  return urls
}

/**
 * Shortens link destinations that point at `origin` to root-relative paths, e.g.
 * `[a](https://x.dev/a.md)` → `[a](/a.md)`, to save tokens. Covers inline links, images and
 * reference definitions; autolinks, bare URLs and code are left as they are.
 */
export const relativizeLinks = (markdown: string, origin: string): string => {
  const starts: Array<number> = []
  visit(parse(markdown), ['link', 'image', 'definition'], (node) => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return
    if (URL.parse(node.url)?.origin !== origin) return
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    // Autolinks (`<https://…>`) and bare URLs don't start with a bracket.
    if (start === undefined || end === undefined) return
    if (!markdown.startsWith('[', start) && !markdown.startsWith('![', start)) return
    // The destination comes after the link text, which may itself contain the URL.
    const textEnd =
      node.type === 'link'
        ? (node.children.at(-1)?.position?.end.offset ?? start)
        : markdown.indexOf(']', start)
    const at = markdown.indexOf(origin, textEnd)
    // Only a whole origin counts, not `https://x.dev.evil.com`.
    if (at !== -1 && at < end && !/[\w.:-]/.test(markdown[at + origin.length] ?? ''))
      starts.push(at)
  })
  let result = markdown
  for (const at of starts.toSorted((x, y) => y - x)) {
    const rest = result.slice(at + origin.length)
    result = result.slice(0, at) + (rest.startsWith('/') ? '' : '/') + rest
  }
  return result
}

/** A top-level piece of a document: a heading, paragraph, code block, list item, table, etc. */
export interface Block {
  /** Source text of the block. */
  readonly text: string
  /** Where the block starts and ends in the document, as string indices. */
  readonly start: number
  readonly end: number
  /** Titles of the headings the block is under, outermost first (not including itself). */
  readonly headings: ReadonlyArray<string>
}

/** Calls `f` for each top-level node (list items count as top-level) with the headings above it. */
const walkBlocks = (
  markdown: string,
  f: (node: RootContent | ListItem, headings: ReadonlyArray<string>) => void,
) => {
  const stack: Array<{ readonly depth: number; readonly title: string }> = []
  for (const node of parse(markdown).children) {
    if (node.type === 'heading') {
      while (stack.length > 0 && stack.at(-1)!.depth >= node.depth) stack.pop()
    }
    const headings = stack.map((heading) => heading.title)
    if (node.type === 'list') for (const item of node.children) f(item, headings)
    else f(node, headings)
    if (node.type === 'heading') stack.push({ depth: node.depth, title: toString(node).trim() })
  }
}

/**
 * Splits a document into top-level blocks, in order. Lists are split into their items, so a long
 * list of links becomes one block per link.
 */
export const blocks = (markdown: string): Array<Block> => {
  const result: Array<Block> = []
  walkBlocks(markdown, (node, headings) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start !== undefined && end !== undefined)
      result.push({ text: markdown.slice(start, end), start, end, headings })
  })
  return result
}

/** A link with the text around it, e.g. an entry of an `llms.txt` index. */
export interface LinkEntry {
  /** Link destination as written. */
  readonly url: string
  /**
   * Source text describing the link: the paragraph it's in (such as `[Title](/a.md): what it is` in
   * a list item), or just the link when the paragraph is long.
   */
  readonly text: string
  /** Titles of the headings the link is under, outermost first. */
  readonly headings: ReadonlyArray<string>
  /** Where the link starts in the document, as a string index. */
  readonly start: number
}

const MAX_LINK_CONTEXT = 400

/** Links in the document, each with the text that describes it, in order of appearance. */
export const linkEntries = (markdown: string): Array<LinkEntry> => {
  const entries: Array<LinkEntry> = []
  const slice = (node: Node) =>
    markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0)
  walkBlocks(markdown, (block, headings) => {
    visit(block, ['paragraph', 'heading', 'tableCell'], (container) => {
      const context = slice(container).replace(/\s+/g, ' ').trim()
      visit(container, 'link', (link) => {
        const text = context.length <= MAX_LINK_CONTEXT ? context : slice(link)
        entries.push({ url: link.url, text, headings, start: link.position?.start.offset ?? 0 })
      })
      return 'skip'
    })
  })
  return entries
}

/** A heading in a table of contents, with the headings nested under it. */
export interface TocEntry {
  /** Heading level, 1 for `#` to 6 for `######`. */
  readonly depth: number
  /** Heading text without Markdown syntax. */
  readonly title: string
  /** Where the heading starts in the document, as a string index. */
  readonly offset: number
  readonly children: ReadonlyArray<TocEntry>
}

/**
 * Table of contents: headings nested under the closest preceding heading of a higher level.
 * Headings that skip levels (`#` then `###`) still nest.
 */
export const toc = (markdown: string): Array<TocEntry> => {
  const roots: Array<TocEntry> = []
  const stack: Array<TocEntry & { readonly children: Array<TocEntry> }> = []
  visit(parse(markdown), 'heading', (node) => {
    const entry = {
      depth: node.depth,
      title: toString(node).trim(),
      offset: node.position?.start.offset ?? 0,
      children: [],
    }
    while (stack.length > 0 && stack.at(-1)!.depth >= entry.depth) stack.pop()
    ;(stack.at(-1)?.children ?? roots).push(entry)
    stack.push(entry)
  })
  return roots
}
