import { StrictMode, useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { ApiError, PageResult, SearchInput, SearchResult } from '@ask-jev/api/contracts'
import { DOCS, type DocsEntry, type DocsId } from '@ask-jev/shared'
import './style.css'

async function api<A>(path: 'page' | 'search', docs: DocsId, signal: AbortSignal, input?: SearchInput, key?: string, url?: string): Promise<A> {
  const endpoint = new URL(`/api/${path}`, window.location.origin)
  endpoint.searchParams.set('docs', docs)
  if (path === 'page' && url) endpoint.searchParams.set('url', url)
  const response = await fetch(endpoint, {
    method: input ? 'POST' : 'GET',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
    headers: input ? { 'content-type': 'application/json', authorization: `Bearer ${key ?? ''}` } : {},
    ...(input ? { body: JSON.stringify(input) } : {}),
  })
  const result = await response.json() as A | ApiError
  if (!response.ok) throw new Error((result as ApiError).error || 'Request failed.')
  return result as A
}

function App() {
  const [source, setSource] = useState<DocsEntry>(DOCS[0]!)
  const [key, setKey] = useState('')
  const [query, setQuery] = useState('')
  const [budget, setBudget] = useState('0.02')
  const [model, setModel] = useState<'jev-latest' | 'jev-preview'>('jev-latest')
  const [page, setPage] = useState<PageResult | null>(null)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState<'page' | 'search' | null>(null)
  const [error, setError] = useState('')
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])

  function changeSource(id: string) {
    const next = DOCS.find((entry) => entry.id === id)
    if (!next || next.id === source.id) return
    active.current?.abort()
    active.current = null
    setBusy(null)
    setSource(next)
    setPage(null)
    setResult(null)
    setError('')
  }

  async function run(kind: 'page' | 'search', url?: string) {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(kind)
    setError('')
    if (kind === 'search') setResult(null)
    try {
      if (kind === 'page') {
        const next = await api<PageResult>('page', source.id, controller.signal, undefined, undefined, url)
        if (!controller.signal.aborted && active.current === controller) setPage(next)
      } else {
        const next = await api<SearchResult>('search', source.id, controller.signal, { query, budget: Number(budget), model }, key)
        if (!controller.signal.aborted && active.current === controller) setResult(next)
      }
    } catch (cause) {
      if (!controller.signal.aborted && active.current === controller) setError(cause instanceof Error ? cause.message : 'Request failed.')
    } finally {
      if (active.current === controller) { setBusy(null); active.current = null }
    }
  }
  function search(event: FormEvent) { event.preventDefault(); void run('search') }

  return <main>
    <header><span className="eyebrow">DOCUMENTATION EXPLORER</span><h1>Ask Jev<span>.</span></h1>
      <p>Find the passages that matter. Search follows promising links and returns the docs as written—not generated answers.</p>
    </header>
    <section aria-label="Documentation source">
      <label htmlFor="docs">Documentation source</label>
      <div className="row"><select id="docs" aria-describedby="docs-index" disabled={busy !== null} value={source.id} onChange={(e) => changeSource(e.target.value)}>
        {DOCS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select><button disabled={busy !== null} onClick={() => void run('page')}>Browse</button></div>
      <small id="docs-index" className="meta">{source.indexUrl}</small>
    </section>
    <section>
      <form onSubmit={search}>
        <label htmlFor="key">Your TypeSafe API key</label>
        <div className="row"><input id="key" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} required />
          <button type="button" className="secondary" onClick={() => setKey('')}>Forget key</button></div>
        <small>Held in tab memory only. Sent to this server and then only to TypeSafe. Use a limited-spend key.</small>
        <label htmlFor="query">What are you looking for?</label>
        <textarea id="query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="How do retries and timeouts work?" maxLength={4000} required rows={3} />
        <div className="row settings"><label>Budget (USD)<input type="number" min="0.000001" max="1" step="any" value={budget} onChange={(e) => setBudget(e.target.value)} required /></label>
          <label>Model<select value={model} onChange={(e) => setModel(e.target.value as typeof model)}><option>jev-latest</option><option>jev-preview</option></select></label>
          <button type="submit" disabled={busy !== null || !key.trim() || !query.trim()}>Find passages</button></div>
        <small>Searches spend your TypeSafe credits. Budget is an estimate, not a billing cap. No automatic retries or speculative duplicate requests.</small>
      </form>
    </section>
    {busy && <p role="status">{busy === 'search' ? 'Reading documentation and evaluating passages…' : 'Loading documentation…'}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {result && <section aria-label="Search results">
      <div className="row"><h2>{result.answered >= 0.7 ? 'Answer found' : result.answered >= 0.35 ? 'Partially answered' : 'No confident answer'}</h2><span className="badge">{Math.round(result.answered * 100)}% confidence</span></div>
      <p className="meta">Stopped: {result.stopped} · {result.usage.requests} requests · {result.usage.inputTokens.toLocaleString()} input tokens · ${result.usage.cost.toFixed(6)} · {result.model || 'no model requests'}</p>
      {result.passages.map((passage) => <article key={`${passage.path}:${passage.start}`}>
        <div className="row"><button className="link" disabled={busy !== null} onClick={() => void run('page', `${new URL(source.indexUrl).origin}${passage.path}`)}>{passage.path}</button><span className="badge">{Math.round(passage.relevance * 100)}% relevance</span></div>
        {passage.headings.length > 0 && <p className="meta">{passage.headings.join(' › ')}</p>}<pre>{passage.text}</pre>
      </article>)}
      {result.passages.length === 0 && <p>No matching passages. Try a broader question or a larger budget.</p>}
      <details><summary>Pages explored ({result.pages.length})</summary><ul>{result.pages.map((entry) => <li key={entry.path}>
        <button className="link" disabled={busy !== null} onClick={() => void run('page', `${new URL(source.indexUrl).origin}${entry.path}`)}>{entry.path}</button>
        <span className="meta"> — {entry.error ?? (entry.round ? `read in round ${entry.round}` : 'not followed')}</span>
      </li>)}</ul></details>
    </section>}
    {page && <section aria-label="Documentation page"><h2>{new URL(page.url).pathname}</h2><p className="meta">{page.url}</p>
      {page.links.length > 0 && <details open><summary>Linked pages ({page.links.length})</summary><ul className="links">{page.links.map((link) => <li key={link.url}><button className="link" disabled={busy !== null} onClick={() => void run('page', link.url)}>{link.text}</button></li>)}</ul></details>}
      <details open><summary>Page content</summary><pre>{page.content}</pre></details>
    </section>}
    <footer>Public documentation is cached in Cloudflare Durable Object storage. Keys, questions and Jev responses are not persisted by this application.</footer>
  </main>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
