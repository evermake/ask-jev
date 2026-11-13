import { Documentation } from 'ask-jev'
import { DOCS, type DocsEntry } from '@ask-jev/shared'
import { ByteSize } from 'effect'

export const MAX_DOC_SIZE = ByteSize.megabytes(1)
export const MAX_API_SIZE = ByteSize.kilobytes(512)

export class PublicError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** Catalog selection is mandatory; neither an arbitrary URL nor a default selects a source. */
export const docsSource = (params: URLSearchParams): DocsEntry => {
  const ids = params.getAll('docs')
  const source = ids.length === 1 ? DOCS.find((entry) => entry.id === ids[0]) : undefined
  if (!source) throw new PublicError('Select a registered documentation source with ?docs=<id>.')
  return source
}

/** Every request, redirect, fallback and cache hit is restricted to this source's origin. */
export const docsUrl = (input: string, source: DocsEntry): URL => {
  const url = URL.parse(input)
  const authority = /^https:\/\/([^/?#]+)/i.exec(input)?.[1]
  if (
    !url || url.protocol !== 'https:' || url.port || url.username || url.password ||
    !authority || /[@:]/.test(authority) || /[?#\\\s]/.test(input) ||
    url.search || url.hash || url.origin !== new URL(source.indexUrl).origin ||
    !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname) ||
    url.hostname === 'api.typesafe.ai'
  ) {
    throw new PublicError('Use an HTTPS URL on the selected documentation origin, without credentials, port, query, or fragment.')
  }
  return url
}

/** Search always starts at the registered index; its optional URL is not an override. */
export const docsTarget = (params: URLSearchParams, source: DocsEntry, search: boolean): URL => {
  const urls = params.getAll('url')
  if (urls.length > 1 || (search && urls.length === 1 && urls[0] !== source.indexUrl)) {
    throw new PublicError('Search must use the selected documentation index URL.')
  }
  return docsUrl(urls[0] ?? source.indexUrl, source)
}

export const limitedText = async (body: ReadableStream<Uint8Array> | null, limit: number) => {
  try { return await Documentation.limitedText(body, limit) }
  catch { throw new PublicError('Response or request is too large or could not be read.', 413) }
}
