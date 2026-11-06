import { expect, test } from 'bun:test'
import * as Markdown from './Markdown.ts'

test('finds inline links, reference definitions and autolinks in order', () => {
  const md = [
    '# Title',
    '- [Intro](https://x.dev/intro.md): about',
    '- [With title](/a.md "A") and <https://x.dev/auto>',
    '- [Nested [label]](b.md) and [parens](https://x.dev/p_(1).md)',
    '[ref]: <https://x.dev/ref.md>',
  ].join('\n')
  expect(Markdown.linkDestinations(md)).toEqual([
    'https://x.dev/intro.md',
    '/a.md',
    'https://x.dev/auto',
    'b.md',
    'https://x.dev/p_(1).md',
    'https://x.dev/ref.md',
  ])
})

test('skips images and code', () => {
  const md = [
    '![img](/img.png) [![badge](/badge.svg)](/target.md)',
    'Use `[not](/inline.md)` here.',
    '```md',
    '[not](/fenced.md)',
    '```',
    '~~~~',
    '```',
    '[not](/tilde.md)',
    '~~~~',
    '[yes](/after.md)',
  ].join('\n')
  expect(Markdown.linkDestinations(md)).toEqual(['/target.md', '/after.md'])
})

test('finds bare URLs and ignores escaped or indented-code links', () => {
  const md = [
    'See https://x.dev/bare.md for details.',
    '\\[not](/escaped.md) and [ref link][r]',
    '',
    '    [not](/indented-code.md)',
    '',
    '[r]: /r.md',
  ].join('\n')
  expect(Markdown.linkDestinations(md)).toEqual(['https://x.dev/bare.md', '/r.md'])
})

/** ToC titles as nested objects, for compact assertions. */
const titles = (entries: ReadonlyArray<Markdown.TocEntry>): unknown =>
  entries.map((e) => (e.children.length === 0 ? e.title : { [e.title]: titles(e.children) }))

test('builds a nested table of contents with offsets', () => {
  const md = [
    '# Title',
    'Intro',
    '## Install `pkg`',
    '### With *bun*',
    '#### Deep',
    '## Usage',
    '```',
    '# not a heading',
    '```',
    'Setext',
    '------',
    '# Second',
    '### Skipped level',
  ].join('\n')
  const toc = Markdown.toc(md)
  expect(titles(toc)).toEqual([
    { Title: [{ 'Install pkg': [{ 'With bun': ['Deep'] }] }, 'Usage', 'Setext'] },
    { Second: ['Skipped level'] },
  ])
  const usage = toc[0]!.children[1]!
  expect(usage.depth).toBe(2)
  expect(md.slice(usage.offset).startsWith('## Usage')).toBe(true)
})

test('shortens link destinations on the same origin', () => {
  const md = [
    '- [Intro](https://x.dev/intro.md): about https://x.dev/bare.md',
    '- [https://x.dev/label](https://x.dev/target.md "https://x.dev/title")',
    '- [Root](https://x.dev) and [query](https://x.dev?q=1) ![img](https://x.dev/i.png)',
    '- [Other](https://other.dev/a.md) [Lookalike](https://x.dev.evil.com/a) <https://x.dev/auto>',
    '- `[code](https://x.dev/code.md)`',
    '',
    '[ref]: https://x.dev/ref.md',
  ].join('\n')
  expect(Markdown.relativizeLinks(md, 'https://x.dev')).toBe(
    [
      '- [Intro](/intro.md): about https://x.dev/bare.md',
      '- [https://x.dev/label](/target.md "https://x.dev/title")',
      '- [Root](/) and [query](/?q=1) ![img](/i.png)',
      '- [Other](https://other.dev/a.md) [Lookalike](https://x.dev.evil.com/a) <https://x.dev/auto>',
      '- `[code](https://x.dev/code.md)`',
      '',
      '[ref]: /ref.md',
    ].join('\n'),
  )
})

test('splits a document into blocks under their headings', () => {
  const md = ['# A', 'intro', '## B', '- one', '- two', '# C', '```ts', 'code', '```'].join('\n')
  expect(Markdown.blocks(md).map(({ text, headings }) => [text, headings])).toEqual([
    ['# A', []],
    ['intro', ['A']],
    ['## B', ['A']],
    ['- one', ['A', 'B']],
    ['- two', ['A', 'B']],
    ['# C', []],
    ['```ts\ncode\n```', ['C']],
  ])
  const [, intro] = Markdown.blocks(md)
  expect(md.slice(intro!.start, intro!.end)).toBe('intro')
})

test('describes each link by the paragraph it is in', () => {
  const md = [
    '# Docs',
    '## Guides',
    '- [Intro](/intro.md): getting started',
    '  - [Nested](/nested.md): deeper',
    '',
    `A long paragraph ${'x '.repeat(300)} with [a link](/long.md).`,
  ].join('\n')
  const entries = Markdown.linkEntries(md)
  expect(entries.map(({ start: _start, ...entry }) => entry)).toEqual([
    { url: '/intro.md', text: '[Intro](/intro.md): getting started', headings: ['Docs', 'Guides'] },
    { url: '/nested.md', text: '[Nested](/nested.md): deeper', headings: ['Docs', 'Guides'] },
    { url: '/long.md', text: '[a link](/long.md)', headings: ['Docs', 'Guides'] },
  ])
  expect(entries.map((entry) => md.slice(entry.start, entry.start + 7))).toEqual([
    '[Intro]',
    '[Nested',
    '[a link',
  ])
})
