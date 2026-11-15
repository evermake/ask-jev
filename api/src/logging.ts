import { DocsResolver, SystemOne } from 'ask-jev'
import { PublicError } from './security.ts'

/** Log a real Error for Workers' stack capture, without raw causes, bodies or unknown messages. */
export function logError(error: unknown) {
  const diagnostic = new Error(
    error instanceof PublicError || error instanceof DocsResolver.DocsResolverError || error instanceof SystemOne.SystemOneError
      ? error.message : 'Unexpected server error.',
  )
  if (error instanceof Error && error.stack) {
    const frames = error.stack.replace(`${error.name}: ${error.message}`, '')
      .split('\n').filter((line) => /^\s+at /.test(line))
    diagnostic.stack = `${diagnostic.name}: ${diagnostic.message}\n${frames.join('\n')}`
  }
  console.error(diagnostic, diagnostic.stack)
}
