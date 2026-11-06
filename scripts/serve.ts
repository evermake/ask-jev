const allowed = new Map([
  ['/', 'index.html'],
  ['/app.js', 'app.js'],
  ['/config.json', 'config.json'],
])
const server = Bun.serve({
  port: 3000,
  hostname: 'localhost',
  fetch(request) {
    const file = allowed.get(new URL(request.url).pathname)
    return file
      ? new Response(Bun.file(`site/${file}`))
      : new Response('Not found', { status: 404 })
  },
})
console.log(`Ask Jev at ${server.url}; run bun run worker:dev in another terminal`)
