import { mkdir } from 'node:fs/promises'

const workerUrl = process.env['PUBLIC_WORKER_URL'] ?? 'http://localhost:8787'
const url = new URL(workerUrl)
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) {
  throw new Error('PUBLIC_WORKER_URL must use HTTPS (or localhost for development)')
}
if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
  throw new Error('PUBLIC_WORKER_URL must be an origin without credentials, a path, or a query')
}
if (process.env['GITHUB_ACTIONS'] && url.protocol !== 'https:') {
  throw new Error('Set the PUBLIC_WORKER_URL repository variable before deploying Pages')
}

await mkdir('site', { recursive: true })
const result = await Bun.build({
  entrypoints: ['./src/app.ts'],
  outdir: './site',
  naming: 'app.js',
  target: 'browser',
  minify: true,
  sourcemap: 'none',
  env: 'disable',
})
if (!result.success) throw new AggregateError(result.logs, 'Build failed')
await Bun.write('site/config.json', JSON.stringify({ workerUrl: url.origin }))
await Bun.write('site/.nojekyll', '')
await Bun.write('site/index.html', await Bun.file('src/index.html').text())
console.log('Built static frontend in site/ (no environment values bundled)')
