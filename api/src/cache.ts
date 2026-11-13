import { Documentation, DocsResolver, HttpCache } from 'ask-jev'
import { ByteSize, Duration, Effect, Layer, Schema } from 'effect'

const RETAIN_FOR = Duration.days(7)
const MAX_CACHE_SIZE = ByteSize.megabytes(8)
const MAX_CACHE_ENTRIES = 128
const decodeEntry = Schema.decodeUnknownSync(HttpCache.CachedResponse)

/** Cloudflare adapter only: the caching workflow and HTTP semantics live in ask-jev. */
export const cacheStorage = (storage: DurableObjectStorage) => {
  const sql = storage.sql
  sql.exec(`CREATE TABLE IF NOT EXISTS entries (
    url TEXT PRIMARY KEY, entry TEXT NOT NULL, updated INTEGER NOT NULL, bytes INTEGER NOT NULL
  )`)
  const remove = (url: string) => { sql.exec('DELETE FROM entries WHERE url = ?', url) }
  const cleanup = () => { sql.exec('DELETE FROM entries WHERE updated < ?', Date.now() - Duration.toMillis(RETAIN_FOR)) }
  const io = <A>(url: string, task: () => Promise<A> | A) => Effect.tryPromise({
    try: async () => task(),
    catch: () => new DocsResolver.DocsResolverError({ url, message: 'Documentation cache unavailable.', status: 502 }),
  })
  const layer = Layer.succeed(Documentation.CacheStorage, {
    get: (url) => io(url, () => {
      cleanup()
      const row = sql.exec<{ entry: string }>('SELECT entry FROM entries WHERE url = ?', url).toArray()[0]
      if (!row) return undefined
      try {
        const entry = decodeEntry(JSON.parse(row.entry))
        // A serialized entry cannot change the requested cache key (including legacy responseUrl:null entries).
        if (entry.url !== url) { remove(url); return undefined }
        return entry
      }
      catch { remove(url); return undefined }
    }),
    remove: (url) => io(url, () => remove(url)),
    set: (entry) => io(entry.url, async () => {
      cleanup()
      const json = JSON.stringify(entry)
      sql.exec('INSERT OR REPLACE INTO entries (url, entry, updated, bytes) VALUES (?, ?, ?, ?)',
        entry.url, json, Date.now(), new TextEncoder().encode(json).byteLength)
      let bytes = 0
      const rows = sql.exec<{ url: string; bytes: number }>('SELECT url, bytes FROM entries ORDER BY updated DESC').toArray()
      rows.forEach((row, i) => {
        bytes += row.bytes
        if (i >= MAX_CACHE_ENTRIES || bytes > ByteSize.toNumberUnsafe(MAX_CACHE_SIZE)) remove(row.url)
      })
      if ((await storage.getAlarm()) === null) await storage.setAlarm(Date.now() + Duration.toMillis(RETAIN_FOR))
    }),
  })
  return {
    layer,
    alarm: async () => {
      cleanup()
      const [{ count } = { count: 0 }] = sql.exec<{ count: number }>('SELECT count(*) AS count FROM entries').toArray()
      if (count > 0) await storage.setAlarm(Date.now() + Duration.toMillis(RETAIN_FOR))
    },
  }
}
