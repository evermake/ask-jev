import type { ApiError, PageResult, SearchResult } from '@ask-jev/api/contracts'
import type { DocsId } from '@ask-jev/shared'
import { SEARCH_BUDGET, type Model } from './config.ts'

export type SearchQuestion = {
  query: string
  model: Model
}

type DocumentationRequest = {
  docs: DocsId
  signal: AbortSignal
}

type LoadDocumentationRequest = DocumentationRequest & {
  url?: string | undefined
}

type SearchDocumentationRequest = DocumentationRequest & {
  question: SearchQuestion
  apiKey: string
}

async function request<A>(
  path: 'page' | 'search',
  docs: DocsId,
  options: RequestInit,
  url?: string,
): Promise<A> {
  const endpoint = new URL(`/api/${path}`, window.location.origin)
  endpoint.searchParams.set('docs', docs)
  if (path === 'page' && url) {
    endpoint.searchParams.set('url', url)
  }

  const response = await fetch(endpoint, {
    method: 'GET',
    ...options,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  let result: A | ApiError
  try {
    result = await response.json() as A | ApiError
  } catch (cause) {
    if (options.signal?.aborted) throw cause

    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    const hint = local
      ? ' Make sure the local API is running: pnpm --filter @ask-jev/api dev.'
      : ' Please try again.'
    throw new Error(`API returned an invalid response (HTTP ${response.status}).${hint}`)
  }
  if (!response.ok) {
    throw new Error((result as ApiError).error || 'Request failed.')
  }
  return result as A
}

export function loadDocumentation({
  docs,
  signal,
  url,
}: LoadDocumentationRequest): Promise<PageResult> {
  return request<PageResult>('page', docs, { signal }, url)
}

export function searchDocumentation({
  docs,
  signal,
  question,
  apiKey,
}: SearchDocumentationRequest): Promise<SearchResult> {
  return request<SearchResult>('search', docs, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: question.query,
      budget: SEARCH_BUDGET,
      model: question.model,
    }),
  })
}
