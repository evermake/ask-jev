import { useEffect, useRef, useState } from 'react'
import type { PageResult, SearchResult } from '@ask-jev/api/contracts'
import { DOCS, type DocsEntry } from '@ask-jev/shared'
import { loadDocumentation, searchDocumentation, type SearchQuestion } from '../api'

export type RequestKind = 'page' | 'search'

type DocumentationRequest =
  | {
      kind: 'page'
      url?: string | undefined
    }
  | {
      kind: 'search'
      question: SearchQuestion
    }

export function useDocumentation() {
  const [source, setSource] = useState<DocsEntry>(DOCS[0]!)
  const [page, setPage] = useState<PageResult | null>(null)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState<RequestKind | null>(null)
  const [error, setError] = useState('')
  const active = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      active.current?.abort()
    }
  }, [])

  function changeSource(id: string): void {
    const next = DOCS.find((entry) => entry.id === id)
    if (!next || next.id === source.id) {
      return
    }

    active.current?.abort()
    active.current = null
    setBusy(null)
    setSource(next)
    setPage(null)
    setResult(null)
    setError('')
  }

  async function run(request: DocumentationRequest): Promise<void> {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(request.kind)
    setError('')
    if (request.kind === 'search') {
      setResult(null)
    }

    try {
      if (request.kind === 'page') {
        const next = await loadDocumentation({
          docs: source.id,
          signal: controller.signal,
          url: request.url,
        })
        if (!controller.signal.aborted && active.current === controller) {
          setPage(next)
        }
      } else {
        const next = await searchDocumentation({
          docs: source.id,
          signal: controller.signal,
          question: request.question,
        })
        if (!controller.signal.aborted && active.current === controller) {
          setResult(next)
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted && active.current === controller) {
        setError(cause instanceof Error ? cause.message : 'Request failed.')
      }
    } finally {
      if (active.current === controller) {
        setBusy(null)
        active.current = null
      }
    }
  }

  function browse(url?: string): void {
    void run({ kind: 'page', url })
  }

  function search(question: SearchQuestion): void {
    void run({ kind: 'search', question })
  }

  return {
    source,
    page,
    result,
    busy,
    error,
    changeSource,
    browse,
    search,
  }
}
