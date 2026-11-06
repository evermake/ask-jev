/**
 * Search over docs with a System One model, which can't write text but quickly and cheaply rates
 * how well each option fits. Results are passages of the docs as written, so an agent can read them
 * as is.
 *
 * Search reads pages like a person browsing, best first:
 *
 * 1. Read the index. Rate each block (paragraph, code block, list item, …) for whether it helps answer
 *    the query, and each link for whether following it leads to the answer.
 * 2. Read the most promising pages linked so far (a few at a time), rating their blocks and links the
 *    same way. Matching blocks become passages; links join the queue.
 * 3. After each round that finds passages, judge everything found so far: does it answer the query,
 *    and which passages contribute? Stop when it does, when no promising link is left, or before
 *    going over the budget.
 *
 * Each block and link is rated by its own yes/no question, so ratings are comparable across pages.
 */
import { Duration, Effect, Result as R } from 'effect'
import type * as DocsResolver from './DocsResolver.ts'
import * as Markdown from './Markdown.ts'
import * as PagePath from './PagePath.ts'
import * as SystemOne from './SystemOne.ts'

export interface Options {
  /** Most to spend on System One, in USD. Search stops before going over it. Default $0.02. */
  readonly budget?: number
  /** System One model, e.g. `jev-latest` (the default) or `jev-preview`. */
  readonly model?: string
}

export const defaults = { budget: 0.02 } satisfies Options

/** A page search found a link to, read or not. */
export interface Page {
  readonly path: PagePath.PagePath
  /** How the page linking to it describes it; empty for the index. */
  readonly description: string
  /** 0–1, how likely following the link leads to the answer; 1 for the index. */
  readonly relevance: number
  /** Page the link was found on; none for the index. */
  readonly from?: PagePath.PagePath
  /** Round the page was read in, from 1; none if it wasn't read. */
  readonly round?: number
  /** Probability that the page by itself answers the query, once read. */
  readonly answers?: number
  /** Why the page wasn't read: it failed to load or was too big for the budget left. */
  readonly error?: string
}

/** Consecutive blocks of a page that match the query. */
export interface Passage {
  readonly path: PagePath.PagePath
  /** Titles of the headings the passage is under, outermost first. */
  readonly headings: ReadonlyArray<string>
  readonly text: string
  /**
   * 0–1, how much the passage contributes to the answer, judged together with the other passages
   * found (or, when it wasn't judged, the highest relevance of its blocks).
   */
  readonly relevance: number
  /** Where the passage starts and ends in the page content (see `Docs.contentOf`). */
  readonly start: number
  readonly end: number
}

/** Pages read together, and what was known after them. */
export interface Round {
  readonly pages: ReadonlyArray<PagePath.PagePath>
  /** Probability that the passages found so far answer the query. */
  readonly answered: number
  /** Spent so far, in USD. */
  readonly cost: number
}

/**
 * Why search stopped: the passages found answer the query, no link is promising enough to follow,
 * the next pages would go over the budget, or it read the most pages it reads.
 */
export type Stop = 'answered' | 'exhausted' | 'budget' | 'max-pages'

export interface Usage {
  readonly requests: number
  readonly inputTokens: number
  /** In USD. */
  readonly cost: number
}

export interface Result {
  readonly query: string
  /** Probability that the passages found answer the query. */
  readonly answered: number
  readonly stopped: Stop
  /** Pages read (or tried), in order, then the links not followed, most promising first. */
  readonly pages: ReadonlyArray<Page>
  /** Best first. */
  readonly passages: ReadonlyArray<Passage>
  readonly rounds: ReadonlyArray<Round>
  readonly usage: Usage
  /** Versioned ID of the model that answered. */
  readonly model: string
}

/** What search needs from the docs. */
export interface Source {
  readonly origin: string
  readonly index: PagePath.PagePath
  /** Page content and the URL it was found at (relative links resolve against it). */
  readonly page: (
    path: PagePath.PagePath,
  ) => Effect.Effect<
    { readonly url: URL; readonly content: string },
    DocsResolver.DocsResolverError
  >
}

/** Keeps each request well below the model's 64k-token context, where it's more accurate. */
const MAX_WINDOW_CHARS = 24_000
const MAX_WINDOW_ITEMS = 200
/** Long blocks (big code samples) are cut in the state; the passage keeps the full text. */
const MAX_ITEM_CHARS = 4_000

/** Least relevance for a block to be part of a passage, or a passage to be returned. */
const RELEVANT = 0.5
/** Stop once the passages found answer the query with this probability. */
const ANSWERED = 0.8
/** From this probability on, the query is partially answered. */
const PARTIALLY_ANSWERED = 0.35
/** Links less promising than this aren't followed… */
const MIN_LINK_RELEVANCE = 0.1
/** …or than this, once the query is partially answered. */
const MIN_LINK_RELEVANCE_PARTIAL = 0.3
/** Pages read per round, when they're about as promising as the best one. */
const PAGES_PER_ROUND = 3
const ROUND_RELEVANCE_RATIO = 0.3
const MAX_PAGES = 30
/** Passages judged per round, and returned, at most. */
const MAX_JUDGED_CHARS = 16_000
const MAX_RESULT_CHARS = 8_000
/** Passages returned, by block relevance, when none is judged to contribute. */
const FALLBACK_PASSAGES = 3
/** Request size in tokens per character of JSON, until measured. */
const TOKENS_PER_CHAR = 0.3
const PAGE_CONCURRENCY = 3
const WINDOW_CONCURRENCY = 3

interface Item {
  readonly id: string
  readonly text: string
}

/** Splits items into consecutive groups that each fit in one request. */
export const windows = <A extends Item>(items: ReadonlyArray<A>): Array<Array<A>> => {
  const result: Array<Array<A>> = []
  let current: Array<A> = []
  let chars = 0
  for (const item of items) {
    const size = Math.min(item.text.length, MAX_ITEM_CHARS) + item.id.length + 8
    if (
      current.length > 0 &&
      (chars + size > MAX_WINDOW_CHARS || current.length >= MAX_WINDOW_ITEMS)
    ) {
      result.push(current)
      current = []
      chars = 0
    }
    current.push(item)
    chars += size
  }
  if (current.length > 0) result.push(current)
  return result
}

const truncate = (text: string) =>
  text.length <= MAX_ITEM_CHARS ? text : `${text.slice(0, MAX_ITEM_CHARS)} […]`

/**
 * The state of a request: the query, and the items keyed by ID so questions can point at them.
 * Questions refer to "the query" instead of repeating it, which saves its tokens on every
 * question.
 */
const stateOf = <I extends Item, A>(
  query: string,
  field: string,
  items: ReadonlyArray<I>,
  value: (item: I) => A,
) => ({
  query,
  [field]: Object.fromEntries(items.map((item) => [item.id, value(item)])),
})

interface Link {
  readonly path: PagePath.PagePath
  readonly description: string
  /** Index of the block the link is in. */
  readonly block: number
}

/**
 * Identifies a page regardless of how it's linked: `/a/`, `/a/index.md`, `/a.md` and `/a` are the
 * same page (sites link to the HTML version, indexes to the Markdown one).
 */
export const pageKey = (path: string) =>
  path.replace(/(\/index)?\.md(?=$|\?)/, '').replace(/\/(?=$|\?)/, '') || '/'

/** Links of a page to other pages of the same docs, each with its block, without duplicates. */
export const linksOf = (
  origin: string,
  page: { readonly url: URL; readonly content: string },
  blocks: ReadonlyArray<Markdown.Block>,
): Array<Link> => {
  const seen = new Set([pageKey(`${page.url.pathname}${page.url.search}`)])
  const links: Array<Link> = []
  for (const entry of Markdown.linkEntries(page.content)) {
    const url = URL.parse(entry.url, page.url.href)
    if (url === null || url.origin !== origin) continue
    const path = `${url.pathname}${url.search}`
    if (seen.has(pageKey(path))) continue
    seen.add(pageKey(path))
    const block = blocks.findIndex((b) => b.start <= entry.start && entry.start < b.end)
    if (block === -1) continue
    const section = entry.headings.length > 0 ? `${entry.headings.join(' › ')}: ` : ''
    links.push({
      path: PagePath.PagePath.make(path),
      description: `${section}${entry.text}`,
      block,
    })
  }
  return links
}

/** Blocks this short (separators, anchors, headings) don't split a passage. */
const MAX_GAP_CHARS = 120
const MAX_GAP_BLOCKS = 2

/**
 * Merges matching blocks of a page into passages: consecutive ones, and ones separated only by a
 * couple of short blocks such as `***` or a heading.
 */
export const passagesOf = (
  path: PagePath.PagePath,
  content: string,
  blocks: ReadonlyArray<Markdown.Block>,
  relevance: ReadonlyArray<number>,
  threshold: number,
): Array<Passage> => {
  const matches = relevance.flatMap((score, i) => (score >= threshold ? [i] : []))
  const groups: Array<[first: number, last: number]> = []
  for (const i of matches) {
    const group = groups.at(-1)
    const gap = group === undefined ? [] : blocks.slice(group[1] + 1, i)
    if (
      group !== undefined &&
      gap.length <= MAX_GAP_BLOCKS &&
      gap.every((block) => block.text.length <= MAX_GAP_CHARS)
    ) {
      group[1] = i
    } else {
      groups.push([i, i])
    }
  }
  return groups.map(([first, last]) => ({
    path,
    headings: blocks[first]!.headings,
    text: content.slice(blocks[first]!.start, blocks[last]!.end),
    relevance: Math.max(...relevance.slice(first, last + 1)),
    start: blocks[first]!.start,
    end: blocks[last]!.end,
  }))
}

/** A page ready to rate: its blocks, its links not seen before, and the requests to send. */
interface Plan {
  readonly page: Page
  readonly content: string
  readonly blocks: ReadonlyArray<Markdown.Block>
  readonly links: ReadonlyArray<Link & { readonly id: string }>
  readonly requests: ReadonlyArray<SystemOne.Request>
  /** Size of the requests as JSON, to estimate their cost. */
  readonly chars: number
}

const planPage = (
  page: Page,
  loaded: { readonly url: URL; readonly content: string },
  origin: string,
  known: ReadonlySet<string>,
  query: string,
): Plan => {
  const blocks = Markdown.blocks(loaded.content)
  const links = linksOf(origin, loaded, blocks)
    .filter((link) => !known.has(pageKey(link.path)))
    .map((link, i) => ({ ...link, id: `L${i}` }))
  const linksByBlock = Map.groupBy(links, (link) => link.block)
  const items = blocks.map((block, i) => ({ id: `B${i}`, text: block.text, block: i }))
  const requests = windows(items).map((window): SystemOne.Request => {
    const questions: Record<string, SystemOne.Question> = {
      answers: {
        type: 'noul',
        instructions: 'Do the blocks answer the query?',
        criteria: {
          true: 'The blocks state or directly imply the answer',
          false: 'The blocks do not address this',
        },
      },
    }
    for (const item of window) {
      questions[item.id] = {
        type: 'noul',
        instructions: `Does block ${item.id} help answer the query?`,
      }
      for (const link of linksByBlock.get(item.block) ?? []) {
        questions[link.id] = {
          type: 'noul',
          instructions: `Would following the link to ${link.path} in block ${item.id} lead to the answer to the query?`,
        }
      }
    }
    return { state: stateOf(query, 'blocks', window, (item) => truncate(item.text)), questions }
  })
  const chars = requests.reduce((sum, request) => sum + JSON.stringify(request).length, 0)
  return { page, content: loaded.content, blocks, links, requests, chars }
}

export const search = Effect.fnUntraced(function* (
  source: Source,
  query: string,
  options: Options = {},
): Effect.fn.Return<
  Result,
  DocsResolver.DocsResolverError | SystemOne.SystemOneError,
  SystemOne.SystemOne
> {
  const systemOne = yield* SystemOne.SystemOne
  const budget = options.budget ?? defaults.budget

  let requests = 0
  let inputTokens = 0
  let charsSent = 0
  let model = options.model ?? ''
  const cost = () => inputTokens * SystemOne.PRICE_PER_TOKEN
  /** Estimated cost of requests this big, from the requests sent so far. */
  const estimate = (chars: number) =>
    chars * (charsSent > 0 ? inputTokens / charsSent : TOKENS_PER_CHAR) * SystemOne.PRICE_PER_TOKEN
  const evaluate = (request: SystemOne.Request) =>
    systemOne.evaluate({ ...request, ...(options.model ? { model: options.model } : {}) }).pipe(
      Effect.timed,
      Effect.flatMap(([duration, response]) => {
        requests += 1
        inputTokens += response.usage.input_tokens
        charsSent += JSON.stringify(request).length
        model = response.model
        return Effect.logDebug(
          'System One request',
          `${Object.keys(request.questions).length} questions`,
          `${response.usage.input_tokens} tokens`,
          Duration.format(duration),
        ).pipe(Effect.as(response))
      }),
    )

  /** Rates the blocks and links of a page. */
  const rate = Effect.fnUntraced(function* (plan: Plan) {
    const responses = yield* Effect.forEach(plan.requests, evaluate, {
      concurrency: WINDOW_CONCURRENCY,
    })
    const noul = (id: string) => Math.max(0, ...responses.map((response) => response.noul(id)))
    return {
      answers: noul('answers'),
      passages: passagesOf(
        plan.page.path,
        plan.content,
        plan.blocks,
        plan.blocks.map((_, i) => noul(`B${i}`)),
        RELEVANT,
      ),
      links: plan.links.map((link): Page => ({
        path: link.path,
        description: link.description,
        relevance: noul(link.id),
        from: plan.page.path,
      })),
    }
  })

  /** Whether the passages found answer the query, and how much each contributes. */
  const judge = Effect.fnUntraced(function* (passages: ReadonlyArray<Passage>) {
    const judged: Array<Passage> = []
    let chars = 0
    for (const passage of passages.toSorted((a, b) => b.relevance - a.relevance)) {
      const size = Math.min(passage.text.length, MAX_ITEM_CHARS)
      if (judged.length > 0 && chars + size > MAX_JUDGED_CHARS) break
      judged.push(passage)
      chars += size
    }
    const items = judged.map((passage, i) => ({ id: `R${i}`, text: passage.text, passage }))
    const questions: Record<string, SystemOne.Question> = {
      answered: {
        type: 'noul',
        instructions: 'Do the passages together answer the query?',
        criteria: {
          true: 'The passages state the complete answer',
          false: 'Some or all of the answer is missing',
        },
      },
    }
    for (const item of items) {
      questions[item.id] = {
        type: 'noul',
        instructions: `Does passage ${item.id} contain part of the answer to the query?`,
      }
    }
    const state = stateOf(query, 'passages', items, (item) => ({
      source: [item.passage.path, ...item.passage.headings].join(' › '),
      text: truncate(item.passage.text),
    }))
    const response = yield* evaluate({ state, questions })
    return {
      answered: response.noul('answered'),
      scores: new Map(judged.map((passage, i) => [passage, response.noul(`R${i}`)])),
    }
  })
  /** Leaves room for the judge after a round. */
  const judgeReserve = () => estimate(MAX_JUDGED_CHARS + 4_000)

  const visited = new Map<string, Page>()
  // Keyed by `pageKey`.
  const queue = new Map<string, Page>([
    [pageKey(source.index), { path: source.index, description: '', relevance: 1 }],
  ])
  const found: Array<Passage> = []
  let scores = new Map<Passage, number>()
  let answered = 0
  const rounds: Array<Round> = []
  let stopped: Stop

  while (true) {
    if (visited.size >= MAX_PAGES) {
      stopped = 'max-pages'
      break
    }
    if (cost() >= budget) {
      stopped = 'budget'
      break
    }
    const floor = answered >= PARTIALLY_ANSWERED ? MIN_LINK_RELEVANCE_PARTIAL : MIN_LINK_RELEVANCE
    const candidates = [...queue.values()].toSorted((a, b) => b.relevance - a.relevance)
    const best = candidates[0]
    if (best === undefined || best.relevance < floor) {
      stopped = 'exhausted'
      break
    }
    const picked = candidates
      .filter((page) => page.relevance >= Math.max(floor, best.relevance * ROUND_RELEVANCE_RATIO))
      .slice(0, Math.min(PAGES_PER_ROUND, MAX_PAGES - visited.size))

    // Load the pages (free), then rate those that fit in the budget, most promising first.
    const loaded = yield* Effect.forEach(picked, (page) => Effect.result(source.page(page.path)), {
      concurrency: PAGE_CONCURRENCY,
    })
    const known = new Set([...visited.keys(), ...queue.keys()])
    const plans: Array<Plan> = []
    let planned = cost() + judgeReserve()
    let overBudget = false
    for (const [i, page] of picked.entries()) {
      queue.delete(pageKey(page.path))
      const result = loaded[i]!
      if (R.isFailure(result)) {
        yield* Effect.logWarning('Search failed to load page', page.path, result.failure)
        visited.set(pageKey(page.path), { ...page, error: result.failure.message })
        continue
      }
      const plan = planPage(page, result.success, source.origin, known, query)
      const pageCost = estimate(plan.chars)
      if (planned + pageCost > budget) {
        overBudget = true
        visited.set(pageKey(page.path), {
          ...page,
          error: `Skipped: reading it (~$${pageCost.toFixed(4)}) would go over the budget`,
        })
        continue
      }
      planned += pageCost
      plans.push(plan)
    }
    if (plans.length === 0) {
      if (overBudget) {
        stopped = 'budget'
        break
      }
      continue
    }

    const round = rounds.length + 1
    const rated = yield* Effect.forEach(plans, rate, { concurrency: PAGE_CONCURRENCY })
    let newPassages = 0
    for (const [i, { page }] of plans.entries()) {
      const { answers, passages, links } = rated[i]!
      visited.set(pageKey(page.path), { ...page, round, answers })
      found.push(...passages)
      newPassages += passages.length
      for (const link of links) {
        const key = pageKey(link.path)
        if (visited.has(key)) continue
        const queued = queue.get(key)
        if (queued === undefined || queued.relevance < link.relevance) queue.set(key, link)
      }
    }
    if (newPassages > 0) {
      const judgement = yield* judge(found)
      answered = judgement.answered
      scores = judgement.scores
    }
    rounds.push({ pages: plans.map((plan) => plan.page.path), answered, cost: cost() })
    yield* Effect.logDebug(
      `Search round ${round}`,
      plans.map((plan) => plan.page.path).join(', '),
      `answered ${answered.toFixed(2)}`,
      `$${cost().toFixed(4)}`,
    )
    if (answered >= ANSWERED) {
      stopped = 'answered'
      break
    }
  }

  return {
    query,
    answered,
    stopped,
    pages: [
      ...visited.values(),
      ...[...queue.values()].toSorted((a, b) => b.relevance - a.relevance),
    ],
    passages: select(found, scores),
    rounds,
    usage: { requests, inputTokens, cost: cost() },
    model,
  }
})

/**
 * Passages judged to contribute to the answer, best first, or the most relevant ones when none
 * does, up to a size an agent can read at once.
 */
const select = (found: ReadonlyArray<Passage>, scores: ReadonlyMap<Passage, number>) => {
  const contributing = [...scores]
    .filter(([, score]) => score >= RELEVANT)
    .toSorted(([, a], [, b]) => b - a)
    .map(([passage, relevance]) => ({ ...passage, relevance }))
  const ranked =
    contributing.length > 0
      ? contributing
      : found.toSorted((a, b) => b.relevance - a.relevance).slice(0, FALLBACK_PASSAGES)
  const selected: Array<Passage> = []
  let chars = 0
  for (const passage of ranked) {
    if (selected.length > 0 && chars + passage.text.length > MAX_RESULT_CHARS) break
    selected.push(passage)
    chars += passage.text.length
  }
  return selected
}

/** How likely the answer is in the docs, in words. */
export const verdict = (answered: number) =>
  answered >= 0.7 ? 'answered' : answered >= PARTIALLY_ANSWERED ? 'partially answered' : 'not found'

/**
 * The result as compact Markdown for an agent: the passages with where they're from, the pages
 * read, and links not followed that may still help.
 */
export const format = (result: Result): string => {
  const read = result.pages.filter((page) => page.round !== undefined)
  const lines = [
    `Search: ${result.query}`,
    `Verdict: ${verdict(result.answered)} (${result.answered.toFixed(2)})`,
  ]
  for (const passage of result.passages) {
    const where = [passage.path, ...passage.headings].join(' › ')
    lines.push('', `--- ${where} (relevance ${passage.relevance.toFixed(2)})`, passage.text)
  }
  if (result.passages.length === 0) lines.push('', 'No matching passages.')
  lines.push('', `Pages read: ${read.map((page) => page.path).join(', ') || 'none'}`)
  const unread = result.pages
    .filter((page) => page.round === undefined && page.relevance >= 0.2)
    .slice(0, 5)
  if (unread.length > 0) {
    lines.push(`Not read, may help: ${unread.map((page) => page.path).join(', ')}`)
  }
  return lines.join('\n')
}
