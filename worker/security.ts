export const MAX_DOC_BYTES = 1_000_000
export const MAX_API_BYTES = 512_000

export class PublicError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Exact, operator-managed hosts: this is deliberately not an arbitrary URL proxy. */
export const docsUrl = (input: string, hosts: string): URL => {
  const url = URL.parse(input)
  const allowed = hosts
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowed.includes(url.hostname) ||
    !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname) ||
    url.hostname === 'api.typesafe.ai'
  ) {
    throw new PublicError(
      'Use an HTTPS public-docs URL on a configured DOCS_HOSTS host, without credentials, query, or fragment.',
    )
  }
  return url
}

/** Enforces the limit while streaming, not just on the untrusted Content-Length header. */
export const limitedText = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string> => {
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new PublicError('Response or request is too large.', 413)
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

export const isSharedCacheable = (headers: Headers): boolean =>
  !headers.has('set-cookie') &&
  !/(?:^|,)\s*(?:private|no-store)\b/i.test(headers.get('cache-control') ?? '') &&
  !(headers.get('vary') ?? '')
    .split(',')
    .some((value) => ['*', 'cookie', 'authorization'].includes(value.trim().toLowerCase()))

export const markdownAlternatives = (url: URL): Array<URL> => {
  const path = url.pathname
  const paths = path.endsWith('/')
    ? [`${path}index.md`, ...(path === '/' ? [] : [`${path.slice(0, -1)}.md`])]
    : !path.slice(path.lastIndexOf('/') + 1).includes('.')
      ? [`${path}.md`, `${path}/index.md`]
      : /\.html?$/i.test(path)
        ? [path.replace(/\.html?$/i, '.md')]
        : []
  return paths.map((path) => new URL(path, url.origin))
}
