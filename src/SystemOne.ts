/**
 * Client for TypeSafe's System One API (`POST /v1/systemone`): a model that answers typed questions
 * about a state with probabilities instead of generated text.
 *
 * @see https://docs.typesafe.ai/api.md
 */
import { Context, Effect, Layer, Redacted, Schedule, Schema } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from 'effect/http'

const DEFAULT_MODEL = 'jev-latest'
/**
 * Requests normally take under a second, but now and then one stalls for 10+ seconds. A duplicate
 * request is sent when the first is slow (whichever answers first wins; duplicates cost fractions
 * of a cent), and a stalled request is retried.
 */
const HEDGE_AFTER = '3 seconds'
const REQUEST_TIMEOUT = '10 seconds'

/** USD per input token (output tokens are free). */
export const PRICE_PER_TOKEN = 0.042 / 1_000_000

/** State, instructions and criteria may be text or any JSON. */
export type Content = Schema.Json

/** Yes/no question; answered with the probability of yes. */
export interface Noul {
  readonly type: 'noul'
  readonly instructions: Content
  readonly criteria?: { readonly true?: Content; readonly false?: Content }
}

/** Pick one of up to 255 options; answered with a probability per option. */
export interface Choice {
  readonly type: 'choice'
  readonly instructions: Content
  readonly criteria: Readonly<Record<string, Content | null>>
}

/** Rate along 2–10 ordered levels; answered with a probability per level. */
export interface Score {
  readonly type: 'score'
  readonly instructions: Content
  readonly criteria: ReadonlyArray<Content>
}

export type Question = Noul | Choice | Score

export interface Request {
  readonly state: Content
  readonly questions: Readonly<Record<string, Question>>
  readonly model?: string
}

const Probabilities = Schema.Record(Schema.String, Schema.Number)

export const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal('noul'), noul: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal('choice'),
    choice: Schema.String,
    probabilities: Probabilities,
    confidence: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal('score'),
    score: Schema.Number,
    probabilities: Probabilities,
    confidence: Schema.Number,
  }),
])
export type Answer = typeof Answer.Type

export class Response extends Schema.Class<Response>('@docs/SystemOne/Response')({
  /** Versioned ID of the model that answered, e.g. `jev-1.13.0`. */
  model: Schema.String,
  answers: Schema.Record(Schema.String, Answer),
  usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
}) {
  /** Probability of yes for a Noul question. */
  noul(id: string): number {
    const answer = this.answers[id]
    return answer?.type === 'noul' ? answer.noul : 0
  }

  /** Probability of each option for a Choice question. */
  probabilities(id: string): Readonly<Record<string, number>> {
    const answer = this.answers[id]
    return answer?.type === 'choice' ? answer.probabilities : {}
  }
}

export class SystemOneError extends Schema.TaggedError<SystemOneError>()('SystemOneError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SystemOne extends Context.Service<
  SystemOne,
  {
    evaluate: (request: Request) => Effect.Effect<Response, SystemOneError>
  }
>()('@docs/SystemOne') {}

/** TypeSafe answers `529` when overloaded; retry it like other transient statuses. */
const isOverloaded = (error: unknown) =>
  HttpClientError.isHttpClientError(error) && error.response?.status === 529

/**
 * Client that gets the API key from `apiKey` before each request, so the key can change (or be
 * added) while the client lives. When `apiKey` fails, the request fails with its error.
 */
export const makeWith = Effect.fnUntraced(function* (
  apiKey: Effect.Effect<Redacted.Redacted, SystemOneError>,
  endpoint: string,
) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.transformResponse(Effect.timeout(REQUEST_TIMEOUT)),
    HttpClient.retryTransient({
      schedule: Schedule.exponential('500 millis'),
      times: 4,
      while: isOverloaded,
    }),
  )

  const evaluate = Effect.fn('SystemOne.evaluate')(function* (request: Request) {
    const key = yield* apiKey
    const body = { model: DEFAULT_MODEL, ...request }
    yield* Effect.annotateCurrentSpan({ questions: Object.keys(request.questions).length })
    const send = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.bearerToken(Redacted.value(key)),
      HttpClientRequest.bodyJsonUnsafe(body),
      client.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provideService(FetchHttpClient.RequestInit, {
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      }),
    )
    return yield* Effect.race(send, Effect.delay(send, HEDGE_AFTER)).pipe(
      Effect.catch((cause) =>
        Effect.fail(
          new SystemOneError({
            message:
              HttpClientError.isHttpClientError(cause) && cause.response
                ? `System One returned HTTP ${cause.response.status}. Check your key and quota, or try again.`
                : 'System One request failed. Check your connection and try again.',
          }),
        ),
      ),
    )
  })

  return SystemOne.of({ evaluate })
})

/** Gets the API key from `apiKey` before each request; see {@link makeWith}. */
export const layerWith = (
  apiKey: Effect.Effect<Redacted.Redacted, SystemOneError>,
  endpoint: string,
) => Layer.effect(SystemOne, makeWith(apiKey, endpoint)).pipe(Layer.provide(FetchHttpClient.layer))
