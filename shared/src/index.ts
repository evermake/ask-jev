/** The single catalog of public documentation available in the deployed app. */
export const DOCS = [
  { id: 'typesafe', label: 'TypeSafe', indexUrl: 'https://docs.typesafe.ai/llms.txt' },
  { id: 'telegram', label: 'Telegram', indexUrl: 'https://core.telegram.org/llms.txt' },
  { id: 'cloudflare', label: 'Cloudflare', indexUrl: 'https://developers.cloudflare.com/llms.txt' },
  { id: 'react', label: 'React', indexUrl: 'https://react.dev/llms.txt' },
  { id: 'vue', label: 'Vue', indexUrl: 'https://vuejs.org/llms.txt' },
  { id: 'vite', label: 'Vite', indexUrl: 'https://vite.dev/llms.txt' },
  { id: 'bun', label: 'Bun', indexUrl: 'https://bun.com/llms.txt' },
] as const

export type DocsEntry = (typeof DOCS)[number]
export type DocsId = DocsEntry['id']
