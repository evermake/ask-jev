import { Schema } from 'effect'

export type PagePath = typeof PagePath.Type
export const PagePath = Schema.String.check(Schema.isStartingWith('/')).pipe(
  Schema.brand('@docs/PagePath'),
)
