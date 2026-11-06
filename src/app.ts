/** Browser-only docs playground. Credentials never enter URLs, storage, or rendered markup. */
import { Cause, Effect, Exit, Layer, ManagedRuntime, Predicate, Redacted, Schema } from 'effect'
import * as Docs from './Docs.ts'
import * as DocsResolver from './DocsResolver.ts'
import type * as Markdown from './Markdown.ts'
import * as PagePath from './PagePath.ts'
import * as Search from './Search.ts'
import * as SystemOne from './SystemOne.ts'

const DEFAULT_INDEX = 'https://docs.typesafe.ai/llms.txt'
let apiKey: Redacted.Redacted | undefined
const config = Schema.decodeUnknownSync(Schema.Struct({ workerUrl: Schema.String }))(
  await (await fetch('./config.json', { cache: 'no-store' })).json(),
)
const worker = new URL(config.workerUrl)
if (
  worker.protocol !== 'https:' &&
  !(worker.protocol === 'http:' && worker.hostname === 'localhost')
) {
  throw new Error('Invalid Worker URL')
}
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    DocsResolver.layerWith(worker.origin),
    SystemOne.layerWith(
      Effect.suspend(() =>
        apiKey === undefined
          ? Effect.fail(
              new SystemOne.SystemOneError({
                message: 'Enter your own TypeSafe API key above to search.',
              }),
            )
          : Effect.succeed(apiKey),
      ),
      new URL('/systemone', worker).href,
    ),
  ),
)
const app = document.querySelector<HTMLDivElement>('#app')!

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )

const viewHref = (index: string, path: string, highlight?: { start: number; end: number }) =>
  `?${new URLSearchParams({
    route: 'view',
    index,
    path,
    ...(highlight ? { hl: `${highlight.start}-${highlight.end}` } : {}),
  }).toString()}${highlight ? '#hit' : ''}`

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --line: #e3e2de;
    --panel: #ffffff; --accent: #2457c5; --hover: #eef2fb; --error: #b42318;
    --mark: #fff1b8; --good: #1a7f37; --warn: #9a6700;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161615; --fg: #e8e7e3; --muted: #9a9993; --line: #2c2c2a;
      --panel: #1d1d1c; --accent: #8ab0ff; --hover: #23293a; --error: #ff8a80;
      --mark: #4a3f12; --good: #6fdd8b; --warn: #e3b341;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  #app { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  #settings {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
    font-size: 12px; color: var(--muted);
  }
  #settings label { display: flex; align-items: center; gap: 8px; }
  #settings input { padding: 6px; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
  #settings small { flex-basis: 100%; }
  .loading { padding: 24px; color: var(--muted); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px;
    padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
  }
  header .title { font-weight: 600; color: var(--fg); }
  form { display: flex; gap: 8px; flex: 1; min-width: 280px; }
  input[type=url], input[type=search], input[type=number], select {
    flex: 1; min-width: 0; padding: 6px 10px; font: inherit; color: inherit;
    background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  }
  button:disabled { opacity: .6; cursor: progress; }
  button {
    padding: 6px 14px; font: inherit; color: #fff; background: var(--accent);
    border: 0; border-radius: 6px; cursor: pointer;
  }
  .crumbs { display: flex; gap: 12px; align-items: baseline; color: var(--muted); font-size: 13px; }
  .crumbs code { color: var(--fg); }
  main { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; }
  nav, article { min-height: 0; overflow: auto; }
  nav { border-right: 1px solid var(--line); padding: 12px 8px; }
  nav h2 {
    margin: 0 8px 8px; font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
  }
  nav ul { list-style: none; margin: 0; padding: 0; }
  nav li a {
    display: block; padding: 3px 8px; border-radius: 4px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow-wrap: anywhere;
  }
  nav li a:hover { background: var(--hover); text-decoration: none; }
  nav .empty { margin: 0 8px; color: var(--muted); }
  pre {
    margin: 0; padding: 16px 20px; white-space: pre-wrap; overflow-wrap: anywhere;
    font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  article { position: relative; display: flex; flex-direction: column; overflow: hidden; }
  pre .heading { scroll-margin-top: 12px; border-radius: 3px; }
  pre .heading:target { background: var(--hover); box-shadow: 0 0 0 3px var(--hover); }
  .toc {
    position: absolute; top: 10px; right: 22px; z-index: 1; max-width: min(380px, 80%);
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    box-shadow: 0 4px 16px rgb(0 0 0 / .08); font-size: 12px; outline: none;
  }
  .toc-label { padding: 4px 10px; color: var(--muted); cursor: default; user-select: none; }
  .toc-body {
    display: none; max-height: 60vh; overflow: auto;
    padding: 6px; border-top: 1px solid var(--line);
  }
  .toc:hover .toc-body, .toc:focus-visible .toc-body, .toc:has(:focus-visible) .toc-body { display: block; }
  .toc ul { list-style: none; margin: 0; padding: 0 0 0 12px; }
  .toc-body > ul { padding: 0; }
  .toc a {
    display: block; padding: 2px 6px; border-radius: 4px; color: var(--fg);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .toc a:hover { background: var(--hover); text-decoration: none; }
  article pre { flex: 1; min-height: 0; overflow: auto; }
  article footer {
    display: flex; gap: 16px; padding: 6px 20px; font-size: 12px; color: var(--muted);
    border-top: 1px solid var(--line); background: var(--panel);
    font-variant-numeric: tabular-nums;
  }
  .error { padding: 24px; }
  .error h1 { margin: 0 0 12px; font-size: 18px; color: var(--error); }
  .error pre { padding: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
  pre mark { background: var(--mark); color: inherit; scroll-margin-top: 40px; border-radius: 2px; }
  .search-form { flex-basis: 100%; flex-wrap: wrap; }
  .search-form input[type=search] { flex: 3 1 280px; }
  .search-form label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
  .search-form label input, .search-form label select { flex: none; width: 76px; padding: 4px 6px; }
  .search-form label select { width: auto; }
  .results { overflow: auto; padding: 16px 20px 32px; display: flex; flex-direction: column; gap: 16px; }
  .summary { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; color: var(--muted); font-size: 13px; }
  .verdict { font-weight: 600; font-size: 15px; }
  .verdict.answered { color: var(--good); }
  .verdict.partially { color: var(--warn); }
  .verdict.not { color: var(--error); }
  .passage { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); overflow: hidden; }
  .passage-head {
    display: flex; gap: 12px; align-items: baseline; justify-content: space-between;
    padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13px;
  }
  .passage-head .where { overflow-wrap: anywhere; }
  .passage-head .where span { color: var(--muted); }
  .passage pre { padding: 10px 12px; max-height: 420px; overflow: auto; }
  .score { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); white-space: nowrap; }
  .bar {
    display: inline-block; width: 48px; height: 6px; margin-right: 6px; vertical-align: middle;
    border-radius: 3px; background: linear-gradient(to right, var(--accent) var(--p), var(--line) var(--p));
  }
  nav li.ranked a { display: flex; gap: 8px; align-items: center; }
  nav li.ranked .path { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  nav li.ranked.read .path { font-weight: 600; }
  nav li.ranked .badge { font-size: 11px; color: var(--muted); white-space: nowrap; }
  nav li.ranked.error .badge { color: var(--error); }
  .trail { margin: 0; padding: 0 0 0 18px; color: var(--muted); font-size: 13px; }
  .trail li { margin: 2px 0; }
  .trail code { color: var(--fg); }
  nav h2 + ul + h2 { margin-top: 16px; }
  details.agent { border: 1px dashed var(--line); border-radius: 8px; }
  details.agent summary { padding: 8px 12px; cursor: pointer; color: var(--muted); font-size: 13px; }
  details.agent pre { border-top: 1px dashed var(--line); }
  details.calls > summary { padding: 8px 0; cursor: pointer; color: var(--muted); font-size: 13px; }
  details.call { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); margin: 6px 0; }
  details.call > summary {
    padding: 6px 12px; cursor: pointer; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  details.call > summary .hint { color: var(--muted); }
  details.call.failed > summary { color: var(--error); }
  .call-body { border-top: 1px solid var(--line); padding: 8px 12px 12px; }
  .call-body h3 { margin: 10px 0 4px; font-size: 12px; color: var(--muted); font-weight: 600; }
  .call-body pre { max-height: 360px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
  table.questions { border-collapse: collapse; width: 100%; font-size: 12px; }
  table.questions td { border-top: 1px solid var(--line); padding: 3px 6px; vertical-align: top; }
  table.questions td:first-child, table.questions td:last-child { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
  table.questions td:last-child { text-align: right; }
  .empty-results { color: var(--muted); }
  .home { margin: auto; width: min(640px, 100% - 32px); padding: 48px 0; }
  .home h1 { font-size: 22px; margin: 0 0 6px; }
  .home p { color: var(--muted); margin: 0 0 18px; }
  @media (max-width: 720px) {
    main { grid-template-columns: 1fr; grid-template-rows: 35% 1fr; }
    nav { border-right: 0; border-bottom: 1px solid var(--line); }
  }
`

const page = (title: string, body: string) => {
  document.title = `${title} · Ask Jev`
  return body
}

const indexForm = (index: string) => `
  <form data-route="view">
    <input aria-label="Documentation index URL" type="url" name="index" value="${escape(index)}" placeholder="https://example.com/llms.txt" required>
    <button type="submit">Open</button>
  </form>`

interface SearchParams {
  readonly query: string
  readonly options: Required<Omit<Search.Options, 'model'>> & { readonly model: string }
}

const MODELS = ['jev-latest', 'jev-preview']

const defaultSearch: SearchParams = {
  query: '',
  options: { ...Search.defaults, model: MODELS[0]! },
}

const searchForm = (index: string, params: SearchParams) => {
  const number = (name: string, label: string, value: number, attrs: string) =>
    `<label title="${escape(label)}">${escape(name)} <input type="number" name="${name}" value="${value}" ${attrs}></label>`
  return `
  <form class="search-form" data-route="search">
    <input type="hidden" name="index" value="${escape(index)}">
    <input aria-label="Search query" type="search" name="q" value="${escape(params.query)}" placeholder="Ask or describe what to find…" required>
    ${number('budget', 'Most to spend on System One, in USD', params.options.budget, 'min="0.001" max="0.5" step="0.001"')}
    <label>model <select name="model">${MODELS.map(
      (model) =>
        `<option${model === params.options.model ? ' selected' : ''}>${escape(model)}</option>`,
    ).join('')}</select></label>
    <button type="submit">Search</button>
  </form>`
}

const header = (index: string, crumbs = '', search: SearchParams | undefined = defaultSearch) => `
  <header>
    <a class="title" href="./">Ask Jev</a>
    ${indexForm(index)}
    ${crumbs}
    ${search === undefined || index === '' ? '' : searchForm(index, search)}
  </header>`

const homePage = () =>
  page(
    'Ask Jev',
    `<div class="home">
      <h1>Ask Jev</h1>
      <p>Enter the URL of a docs index (such as an <code>llms.txt</code>) to browse its pages.</p>
      <p>Browse public docs and find relevant passages with Jev. The Worker only fetches documentation hosts approved by its operator; the default is <code>docs.typesafe.ai</code>. Search requires your own TypeSafe key and may incur charges, including retries and duplicate requests.</p>
      ${indexForm(DEFAULT_INDEX)}
    </div>`,
  )

const format = (n: number) => n.toLocaleString('en-US')

/** Character count and a rough token estimate (~4 characters per token). */
const contentStats = (content: string) => {
  const chars = [...content].length
  return `<span>${format(chars)} chars</span><span title="Estimated as chars / 4">≈ ${format(Math.ceil(chars / 4))} tokens</span>`
}

/** ToC entries in document order, each with the element id of its heading. */
const flattenToc = (toc: ReadonlyArray<Markdown.TocEntry>) => {
  const ids = new Map<Markdown.TocEntry, string>()
  const visit = (entries: ReadonlyArray<Markdown.TocEntry>) => {
    for (const entry of entries) {
      ids.set(entry, `toc-${ids.size}`)
      visit(entry.children)
    }
  }
  visit(toc)
  return ids
}

/**
 * The page text, with each heading line wrapped in an element that ToC links point to, and the
 * highlighted range (a search hit) in a `<mark id="hit">`.
 */
const previewHtml = (
  content: string,
  ids: ReadonlyMap<Markdown.TocEntry, string>,
  highlight: { readonly start: number; readonly end: number } | undefined,
) => {
  if (
    highlight &&
    (!Number.isSafeInteger(highlight.start) ||
      !Number.isSafeInteger(highlight.end) ||
      highlight.start < 0 ||
      highlight.end > content.length ||
      highlight.start >= highlight.end)
  )
    highlight = undefined
  // Tags to insert at offsets. At the same offset, closing tags go first and the mark wraps
  // headings (search hits start and end on block boundaries, so they don't cut through one).
  const tags: Array<{ readonly at: number; readonly order: number; readonly html: string }> = []
  for (const [entry, id] of ids) {
    const lineEnd = content.indexOf('\n', entry.offset)
    const end = lineEnd === -1 ? content.length : lineEnd
    tags.push({ at: entry.offset, order: 3, html: `<span class="heading" id="${id}">` })
    tags.push({ at: end, order: 0, html: '</span>' })
  }
  if (highlight !== undefined) {
    tags.push({ at: highlight.start, order: 2, html: '<mark id="hit">' })
    tags.push({ at: highlight.end, order: 1, html: '</mark>' })
  }
  let html = ''
  let cursor = 0
  for (const tag of tags.toSorted((a, b) => a.at - b.at || a.order - b.order)) {
    html += escape(content.slice(cursor, tag.at)) + tag.html
    cursor = tag.at
  }
  return html + escape(content.slice(cursor))
}

/** Box in the corner of the preview that expands on hover into the ToC. */
const tocBox = (
  toc: ReadonlyArray<Markdown.TocEntry>,
  ids: ReadonlyMap<Markdown.TocEntry, string>,
) => {
  if (toc.length === 0) return ''
  const list = (entries: ReadonlyArray<Markdown.TocEntry>): string =>
    `<ul>${entries
      .map(
        (entry) =>
          `<li><a href="#${ids.get(entry)}" title="${escape(entry.title)}">${escape(entry.title)}</a>${
            entry.children.length > 0 ? list(entry.children) : ''
          }</li>`,
      )
      .join('')}</ul>`
  return `<div class="toc" tabindex="0">
    <div class="toc-label">Contents (${ids.size})</div>
    <div class="toc-body">${list(toc)}</div>
  </div>`
}

const viewerPage = (options: {
  readonly docs: Docs.Docs
  readonly path: PagePath.PagePath
  readonly content: string
  readonly links: ReadonlyArray<PagePath.PagePath>
  readonly toc: ReadonlyArray<Markdown.TocEntry>
  readonly highlight: { readonly start: number; readonly end: number } | undefined
}) => {
  const { docs, path, content, links, toc, highlight } = options
  const ids = flattenToc(toc)
  const index = `${docs.origin}${docs.index}`
  const crumbs = `
    <div class="crumbs">
      ${path === docs.index ? '<span>index</span>' : `<a href="${escape(viewHref(index, docs.index))}">index</a>`}
      <code>${escape(path)}</code>
      <a href="${escape(`${docs.origin}${path}`)}" target="_blank" rel="noreferrer">raw ↗</a>
    </div>`
  const list =
    links.length === 0
      ? '<p class="empty">No links to other pages.</p>'
      : `<ul>${links
          .map((link) => `<li><a href="${escape(viewHref(index, link))}">${escape(link)}</a></li>`)
          .join('')}</ul>`
  return page(
    `${path} · ${docs.origin}`,
    `${header(index, crumbs)}
    <main>
      <nav><h2>Links (${links.length})</h2>${list}</nav>
      <article>
        ${tocBox(toc, ids)}
        <pre>${previewHtml(content, ids, highlight)}</pre>
        <footer>${contentStats(content)}</footer>
      </article>
    </main>`,
  )
}

const percent = (p: number) => `${Math.round(p * 100)}%`

const bar = (p: number) => `<span class="bar" style="--p: ${percent(p)}"></span>`

const MAX_UNREAD_SHOWN = 50

const STOPS: Record<Search.Stop, string> = {
  answered: 'stopped: answer found',
  exhausted: 'stopped: no promising links left',
  budget: 'stopped: budget reached',
  'max-pages': 'stopped: page limit reached',
}

/** A System One request made during a search, and what came of it. */
interface Call {
  readonly request: SystemOne.Request
  /** Milliseconds from the start of the search. */
  readonly startedAt: number
  millis?: number
  response?: SystemOne.Response
  error?: string
}

/** Wraps System One to record every request (once, however often it's retried or hedged). */
const recording =
  (calls: Array<Call>, started: number) =>
  (systemOne: SystemOne.SystemOne['Service']): SystemOne.SystemOne['Service'] => ({
    evaluate: (request) => {
      const call: Call = { request, startedAt: performance.now() - started }
      calls.push(call)
      return systemOne.evaluate(request).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            call.millis = performance.now() - started - call.startedAt
            if (Exit.isSuccess(exit)) call.response = exit.value
            else call.error = safeFailure(exit.cause)
          }),
        ),
      )
    },
  })

const seconds = (millis: number) => `${(millis / 1000).toFixed(1)}s`

const answerText = (answer: SystemOne.Answer | undefined) => {
  if (answer === undefined) return '—'
  if (answer.type === 'noul') return `${bar(answer.noul)}${answer.noul.toFixed(2)}`
  const label = answer.type === 'choice' ? answer.choice : String(answer.score)
  return `${escape(label)} (${answer.confidence.toFixed(2)})`
}

/**
 * State as readable text: each string field under a `── path ──` line, so the text of blocks shows
 * as written instead of as escaped JSON.
 */
const stateText = (value: unknown, path = ''): string => {
  if (Predicate.isObject(value) && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([key, field]) => stateText(field, path === '' ? key : `${path}.${key}`))
      .join('\n')
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return path === '' ? text : `── ${path} ──\n${text}`
}

const callItem = (call: Call, i: number) => {
  const { request, response } = call
  const questions = Object.entries(request.questions)
  const state = stateText(request.state)
  // What the request is about: the start of its first item, skipping the query.
  const items = Predicate.isObject(request.state)
    ? Object.entries(request.state).filter(([key]) => key !== 'query')
    : []
  const hint = (items.length > 0 ? stateText(Object.fromEntries(items)) : state)
    .replace(/── [\w.]+ ──/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  const summary = [
    `#${i + 1}`,
    `+${seconds(call.startedAt)}`,
    call.millis === undefined ? 'unfinished' : `took ${seconds(call.millis)}`,
    `${questions.length} questions`,
    response === undefined
      ? call.error === undefined
        ? ''
        : 'failed'
      : `${format(response.usage.input_tokens)} tokens`,
  ]
    .filter(Boolean)
    .join(' · ')
  const rows = questions
    .map(
      ([id, question]) =>
        `<tr><td>${escape(id)}</td><td>${escape(typeof question.instructions === 'string' ? question.instructions : JSON.stringify(question.instructions))}</td><td>${answerText(response?.answers[id])}</td></tr>`,
    )
    .join('')
  return `<details class="call${call.error === undefined ? '' : ' failed'}">
    <summary>${escape(summary)} <span class="hint">${escape(hint)}</span></summary>
    <div class="call-body">
      ${call.error === undefined ? '' : `<h3>Error</h3><pre>${escape(call.error)}</pre>`}
      <h3>Questions and answers${response === undefined ? '' : ` · ${escape(response.model)}`}</h3>
      <table class="questions">${rows}</table>
      <h3>State · ${format(state.length)} chars</h3>
      <pre>${escape(state)}</pre>
      <details><summary>Request body (JSON; the model defaults to jev-latest when missing)</summary>
        <pre>${escape(JSON.stringify(request, null, 2))}</pre>
      </details>
      ${response === undefined ? '' : `<details><summary>Response body (JSON)</summary><pre>${escape(JSON.stringify(response, null, 2))}</pre></details>`}
    </div>
  </details>`
}

const searchPage = (options: {
  readonly docs: Docs.Docs
  readonly params: SearchParams
  readonly result: Search.Result
  readonly millis: number
  readonly calls: ReadonlyArray<Call>
}) => {
  const { docs, params, result, millis, calls } = options
  const index = `${docs.origin}${docs.index}`
  const verdict = Search.verdict(result.answered)
  const agentText = Search.format(result)

  const pageItem = (rank: Search.Page) => {
    const state = rank.error !== undefined ? ' read error' : rank.round === undefined ? '' : ' read'
    const badge =
      rank.error !== undefined
        ? rank.error.startsWith('Skipped')
          ? 'skipped'
          : 'failed'
        : rank.round === undefined
          ? ''
          : `#${rank.round} · answers ${percent(rank.answers ?? 0)}`
    const title = [
      rank.error,
      rank.description,
      rank.from === undefined ? undefined : `Linked from ${rank.from}`,
      `Link relevance ${rank.relevance.toFixed(2)}`,
    ]
      .filter(Boolean)
      .join('\n')
    return `<li class="ranked${state}" title="${escape(title)}">
        <a href="${escape(viewHref(index, rank.path))}">${bar(rank.relevance)}<span class="path">${escape(rank.path)}</span><span class="badge">${badge}</span></a>
      </li>`
  }
  const tried = result.pages.filter((rank) => rank.round !== undefined || rank.error !== undefined)
  const unread = result.pages.filter((rank) => rank.round === undefined && rank.error === undefined)
  const shownUnread = unread.slice(0, MAX_UNREAD_SHOWN)

  const trail = result.rounds
    .map(
      (round, i) =>
        `<li>${round.pages.map((path) => `<code>${escape(path)}</code>`).join(', ')} → answered ${percent(round.answered)}, $${round.cost.toFixed(4)} spent${i === result.rounds.length - 1 ? ` · ${escape(STOPS[result.stopped])}` : ''}</li>`,
    )
    .join('')

  const passages = result.passages
    .map((passage) => {
      const where = passage.headings.map((heading) => ` › ${escape(heading)}`).join('')
      return `<section class="passage">
        <div class="passage-head">
          <a class="where" href="${escape(viewHref(index, passage.path, passage))}">${escape(passage.path)}<span>${where}</span></a>
          <span class="score">${bar(passage.relevance)}${passage.relevance.toFixed(2)}</span>
        </div>
        <pre>${escape(passage.text)}</pre>
      </section>`
    })
    .join('')

  const stats = [
    STOPS[result.stopped],
    `${tried.filter((rank) => rank.round !== undefined).length} pages read in ${result.rounds.length} rounds`,
    `${result.usage.requests} requests`,
    `${format(result.usage.inputTokens)} input tokens`,
    `$${result.usage.cost.toFixed(4)} of $${params.options.budget}`,
    `${(millis / 1000).toFixed(1)}s`,
    result.model,
  ]

  return page(
    `${params.query} · search · ${docs.origin}`,
    `${header(index, '', params)}
    <main>
      <nav>
        <h2>Pages read, in order (${tried.length})</h2>
        <ul>${tried.map(pageItem).join('')}</ul>
        <h2>Links not followed (${shownUnread.length < unread.length ? `top ${shownUnread.length} of ` : ''}${unread.length})</h2>
        <ul>${shownUnread.map(pageItem).join('')}</ul>
      </nav>
      <article>
        <div class="results">
          <div class="summary">
            <span class="verdict ${verdict.split(' ')[0]}">${escape(verdict)} (${percent(result.answered)})</span>
            ${stats.map((stat) => `<span>${escape(stat)}</span>`).join('')}
          </div>
          <ol class="trail">${trail}</ol>
          ${passages || '<p class="empty-results">No matching passages. Try rephrasing, or a bigger budget.</p>'}
          <details class="agent">
            <summary>Text for an agent · ${contentStats(agentText).replace(/<\/?span[^>]*>/g, ' ')}</summary>
            <pre>${escape(agentText)}</pre>
          </details>
          <details class="calls">
            <summary>System One requests (${calls.length}), in the order they were sent</summary>
            ${calls.map(callItem).join('')}
          </details>
        </div>
      </article>
    </main>`,
  )
}

const errorPage = (index: string, title: string, details: string) =>
  page(
    title,
    `${header(index)}<div class="error"><h1>${escape(title)}</h1><pre>${escape(details)}</pre></div>`,
  )

// ---------------------------------------------------------------------------
// Navigation (query-based routes work under the GitHub Pages repository subpath).
// ---------------------------------------------------------------------------

const safeFailure = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause)
  if (
    error._tag === 'Some' &&
    (error.value instanceof DocsResolver.DocsResolverError ||
      error.value instanceof SystemOne.SystemOneError)
  ) {
    return error.value.message
  }
  return 'The request failed. Check the index URL, your key, and the Worker connection.'
}

const indexOf = (url: URL): { index: string; indexUrl: URL } => {
  const index = url.searchParams.get('index')?.trim() ?? ''
  const indexUrl = URL.parse(index)
  if (
    !indexUrl ||
    indexUrl.protocol !== 'https:' ||
    indexUrl.username ||
    indexUrl.password ||
    indexUrl.search ||
    indexUrl.hash
  ) {
    throw new Error('Expected an HTTPS index URL without credentials, query, or fragment.')
  }
  return { index, indexUrl }
}

/** `start-end` offsets of a range to highlight. */
const parseHighlight = (value: string | null) => {
  const match = /^(\d+)-(\d+)$/.exec(value ?? '')
  return match === null ? undefined : { start: Number(match[1]), end: Number(match[2]) }
}

const view = async (url: URL, signal: AbortSignal): Promise<string> => {
  const parsed = indexOf(url)
  const { index, indexUrl } = parsed
  const requestedPath = url.searchParams.get('path')
  if (requestedPath !== null && !requestedPath.startsWith('/')) {
    return errorPage(index, 'Invalid page path', 'Paths must start with "/".')
  }

  const exit = await runtime.runPromiseExit(
    Effect.gen(function* () {
      const docs = yield* Docs.make(indexUrl)
      const path = requestedPath === null ? docs.index : PagePath.PagePath.make(requestedPath)
      const [content, links, toc] = yield* Effect.all(
        [docs.contentOf(path), docs.linksFrom(path), docs.tocOf(path)],
        { concurrency: 'unbounded' },
      )
      const highlight = parseHighlight(url.searchParams.get('hl'))
      return viewerPage({ docs, path, content, links, toc, highlight })
    }),
    { signal },
  )
  return Exit.isSuccess(exit)
    ? exit.value
    : errorPage(index, 'Failed to load page', safeFailure(exit.cause))
}

const numberParam = (url: URL, name: string, fallback: number, min: number, max: number) => {
  const value = Number(url.searchParams.get(name) ?? Number.NaN)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

const search = async (url: URL, signal: AbortSignal): Promise<string> => {
  const parsed = indexOf(url)
  const { index, indexUrl } = parsed
  const model = url.searchParams.get('model') ?? ''
  const params: SearchParams = {
    query: url.searchParams.get('q')?.trim() ?? '',
    options: {
      budget: numberParam(url, 'budget', Search.defaults.budget, 0.001, 0.5),
      model: MODELS.includes(model) ? model : MODELS[0]!,
    },
  }
  if (params.query === '')
    return view(new URL(viewHref(index, indexUrl.pathname), location.href), signal)
  if (apiKey === undefined)
    return errorPage(
      index,
      'API key required',
      'Enter your own TypeSafe API key above, then submit your search again.',
    )

  const started = performance.now()
  const calls: Array<Call> = []
  const exit = await runtime.runPromiseExit(
    Effect.gen(function* () {
      const docs = yield* Docs.make(indexUrl)
      const result = yield* docs.search(params.query, params.options)
      return searchPage({ docs, params, result, millis: performance.now() - started, calls })
    }).pipe(Effect.updateService(SystemOne.SystemOne, recording(calls, started))),
    { signal },
  )
  return Exit.isSuccess(exit)
    ? exit.value
    : errorPage(index, 'Search failed', safeFailure(exit.cause))
}

const style = document.createElement('style')
style.textContent = STYLE
document.head.append(style)

const keyInput = document.querySelector<HTMLInputElement>('#api-key')!
const keyStatus = document.querySelector<HTMLSpanElement>('#key-status')!
keyInput.addEventListener('input', () => {
  if (apiKey) Redacted.wipeUnsafe(apiKey)
  apiKey = keyInput.value.trim() ? Redacted.make(keyInput.value.trim()) : undefined
  keyStatus.textContent = apiKey ? 'Key in memory; not saved.' : 'Browsing needs no key.'
})
document.querySelector('#forget-key')!.addEventListener('click', () => {
  active?.abort()
  if (apiKey) Redacted.wipeUnsafe(apiKey)
  apiKey = undefined
  keyInput.value = ''
  keyStatus.textContent = 'Key forgotten. Browsing needs no key.'
})

let generation = 0
let active: AbortController | undefined
const render = async (url: URL) => {
  active?.abort()
  active = new AbortController()
  const signal = active.signal
  const current = ++generation
  app.innerHTML = '<p class="loading" role="status">Loading…</p>'
  try {
    const route = url.searchParams.get('route')
    const body =
      route === 'view'
        ? await view(url, signal)
        : route === 'search'
          ? await search(url, signal)
          : homePage()
    if (current !== generation) return
    app.innerHTML = body
    if (url.hash) document.getElementById(url.hash.slice(1))?.scrollIntoView()
  } catch {
    if (current === generation)
      app.innerHTML = errorPage(
        '',
        'Unable to open docs',
        'Use an HTTPS public documentation URL without credentials or query parameters.',
      )
  }
}

const navigate = (url: URL) => {
  // Questions stay in memory rather than leaking to Pages request URLs or browser history.
  const publicUrl = new URL(url)
  publicUrl.searchParams.delete('q')
  history.pushState(null, '', publicUrl)
  void render(url)
}

app.addEventListener('submit', (event) => {
  event.preventDefault()
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  const url = new URL(location.pathname, location.origin)
  url.searchParams.set('route', form.dataset['route'] ?? 'view')
  for (const [key, value] of new FormData(form))
    if (typeof value === 'string') url.searchParams.set(key, value)
  navigate(url)
})
app.addEventListener('click', (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const anchor = event.target instanceof Element ? event.target.closest('a') : null
  if (!anchor || anchor.target || anchor.getAttribute('href')?.startsWith('#')) return
  const url = new URL(anchor.href)
  if (url.origin !== location.origin || url.pathname !== location.pathname) return
  event.preventDefault()
  navigate(url)
})
window.addEventListener('popstate', () => {
  void render(new URL(location.href))
})
window.addEventListener('pagehide', () => {
  if (apiKey) Redacted.wipeUnsafe(apiKey)
  apiKey = undefined
  keyInput.value = ''
})

await render(new URL(location.href))
