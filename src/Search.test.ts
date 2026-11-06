import { expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'
import * as Markdown from './Markdown.ts'
import * as PagePath from './PagePath.ts'
import * as Search from './Search.ts'
import * as SystemOne from './SystemOne.ts'

const path = PagePath.PagePath.make

test('groups items into windows that fit one request', () => {
  const items = Array.from({ length: 450 }, (_, i) => ({ id: `B${i}`, text: 'x' }))
  expect(Search.windows(items).map((window) => window.length)).toEqual([200, 200, 50])
  const big = Array.from({ length: 10 }, (_, i) => ({ id: `B${i}`, text: 'x'.repeat(10_000) }))
  expect(Search.windows(big).every((window) => window.length <= 6)).toBe(true)
})

test('merges matching blocks across short gaps into passages', () => {
  const content = [
    '# T',
    'match one',
    '***',
    'match two',
    'unrelated '.repeat(20),
    'match three',
  ].join('\n\n')
  const blocks = Markdown.blocks(content)
  const passages = Search.passagesOf(path('/p.md'), content, blocks, [0, 0.9, 0, 0.6, 0, 0.7], 0.5)
  expect(passages.map(({ text, relevance }) => [text, relevance])).toEqual([
    ['match one\n\n***\n\nmatch two', 0.9],
    ['match three', 0.7],
  ])
  expect(passages[0]!.headings).toEqual(['T'])
})

/**
 * Answers link questions by the score of the link's path, and other Nouls by the score of the first
 * keyword in the text they're about (their block or passage, or the whole state).
 */
const fakeSystemOne = (scores: {
  readonly links: Record<string, number>
  readonly text: Record<string, number>
}) => {
  const requests: Array<SystemOne.Request> = []
  const layer = Layer.succeed(SystemOne.SystemOne, {
    evaluate: (request) => {
      requests.push(request)
      const state = request.state as {
        readonly blocks?: Record<string, string>
        readonly passages?: Record<string, { readonly text: string }>
      }
      const answers: Record<string, SystemOne.Answer> = {}
      for (const [id, question] of Object.entries(request.questions)) {
        const link = / link to (\S+) /.exec(String(question.instructions))?.[1]
        const item =
          state.blocks?.[id] ?? state.passages?.[id]?.text ?? JSON.stringify(request.state)
        const score =
          link === undefined
            ? (Object.entries(scores.text).find(([word]) => item.includes(word))?.[1] ?? 0)
            : (scores.links[link] ?? 0)
        answers[id] = { type: 'noul', noul: score }
      }
      return Effect.succeed(
        new SystemOne.Response({
          model: 'jev-test',
          answers,
          usage: { input_tokens: 100, output_tokens: 0 },
        }),
      )
    },
  })
  return { requests, layer }
}

const pages: Record<string, string> = {
  '/llms.txt': '- [Guides](/guides/llms.txt): all guides\n- [Other](/other.md): unrelated',
  '/guides/llms.txt':
    '- [Retries](/guides/retries.md): retry policy\n- [Intro](/guides/intro.md): getting started',
  '/guides/retries.md':
    '# Retries\n\nRetries use exponential backoff.\n\nSee [this page](/guides/retries/) and [guides](/guides/llms.txt).',
}

const source: Search.Source = {
  origin: 'https://x.dev',
  index: path('/llms.txt'),
  page: (p) => Effect.succeed({ url: new URL(`https://x.dev${p}`), content: pages[p]! }),
}

const links = { '/guides/llms.txt': 0.6, '/guides/retries.md': 0.9 }

test('follows the most promising links until the passages found answer the query', async () => {
  const { requests, layer } = fakeSystemOne({ links, text: { backoff: 0.9 } })
  const result = await Search.search(source, 'how do retries work?').pipe(
    Effect.provide(layer),
    Effect.runPromise,
  )
  expect(result.stopped).toBe('answered')
  expect(result.answered).toBe(0.9)
  expect(result.pages.map((page): [string, number | undefined] => [page.path, page.round])).toEqual(
    [
      ['/llms.txt', 1],
      ['/guides/llms.txt', 2],
      ['/guides/retries.md', 3],
      // Links to pages already read (in any form, like `/guides/retries/`) aren't queued.
      ['/other.md', undefined],
      ['/guides/intro.md', undefined],
    ],
  )
  expect(result.rounds.map((round) => round.answered)).toEqual([0, 0, 0.9])
  expect(result.passages.map((passage) => passage.text)).toEqual([
    'Retries use exponential backoff.',
  ])
  // A request per page, and one judging the passages found.
  expect(requests).toHaveLength(4)
  // The query is in the state once, not in every question.
  expect(requests[0]!.state).toMatchObject({ query: 'how do retries work?' })
  expect(JSON.stringify(requests.map((request) => request.questions))).not.toContain('retries work')
  expect(result.usage).toMatchObject({ requests: 4, inputTokens: 400 })
  expect(result.usage.cost).toBeCloseTo(400 * 0.042e-6, 12)
  const text = Search.format(result)
  expect(text).toContain('Verdict: answered (0.90)')
  expect(text).toContain('--- /guides/retries.md › Retries (relevance 0.90)')
  expect(text).toContain('Pages read: /llms.txt, /guides/llms.txt, /guides/retries.md')
})

test('stops when no link is promising', async () => {
  const { requests, layer } = fakeSystemOne({ links: {}, text: {} })
  const result = await Search.search(source, 'kubernetes').pipe(
    Effect.provide(layer),
    Effect.runPromise,
  )
  expect(result.stopped).toBe('exhausted')
  expect(result.rounds).toHaveLength(1)
  expect(result.passages).toEqual([])
  expect(requests).toHaveLength(1)
  expect(Search.format(result)).toContain('Verdict: not found (0.00)')
})

test("doesn't read pages that would go over the budget", async () => {
  const { requests, layer } = fakeSystemOne({ links, text: {} })
  const result = await Search.search(source, 'retries', { budget: 1e-9 }).pipe(
    Effect.provide(layer),
    Effect.runPromise,
  )
  expect(result.stopped).toBe('budget')
  expect(result.pages[0]!.error).toStartWith('Skipped')
  expect(requests).toHaveLength(0)
})

test('identifies pages regardless of how they are linked', () => {
  expect(['/a/', '/a/index.md', '/a.md', '/a'].map(Search.pageKey)).toEqual([
    '/a',
    '/a',
    '/a',
    '/a',
  ])
  expect(['/', '/index.md', '/llms.txt'].map(Search.pageKey)).toEqual(['/', '/', '/llms.txt'])
})
