/**
 * Client for System One through TypeSafe or OpenRouter: a model that answers typed questions about
 * a state with probabilities instead of generated text.
 *
 * @see https://docs.typesafe.ai/api.md
 */
import { Context, Duration, Effect, Layer, Redacted, Schedule, Schema } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from 'effect/http'

export const DEFAULT_MODEL = 'jev-latest'
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/systemone'
/** No speculative duplicates; paid retries must be explicitly enabled by the integrator. */
export interface ClientOptions {
  readonly retries?: number
}
const REQUEST_TIMEOUT = Duration.seconds(30)

/** Fallback estimated USD per input token (output tokens are free). */
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

export class Response extends Schema.Class<Response>('ask-jev/SystemOne/Response')({
  /** Versioned ID of the model that answered, optionally provider-qualified. */
  model: Schema.String,
  answers: Schema.Record(Schema.String, Answer),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    /** Provider-reported USD cost, when available (including zero). */
    cost: Schema.optional(
      Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
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
>()('ask-jev/SystemOne') {}

/** TypeSafe answers `529` when overloaded; retry it like other transient statuses. */
const isOverloaded = (error: unknown) =>
  HttpClientError.isHttpClientError(error) && error.response?.status === 529

/**
 * Client that gets the API key from `apiKey` before each request, so the key can change (or be
 * added) while the client lives. When `apiKey` fails, the request fails with its error.
 */
export const makeWith = Effect.fnUntraced(function* (
  apiKey: Effect.Effect<Redacted.Redacted, SystemOneError>,
  endpoint = TYPESAFE_ENDPOINT,
  options: ClientOptions = {},
) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.transformResponse(Effect.timeout(REQUEST_TIMEOUT)),
    HttpClient.retryTransient({
      schedule: Schedule.exponential(Duration.millis(500)),
      times: options.retries ?? 0,
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
    return yield* send.pipe(
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
  endpoint = TYPESAFE_ENDPOINT,
  options: ClientOptions = {},
) => Layer.effect(SystemOne, makeWith(apiKey, endpoint, options)).pipe(Layer.provide(FetchHttpClient.layer))

/** OpenRouter client with injectable `HttpClient`; bare Jev model IDs are accepted. */
export const makeOpenRouter = (
  apiKey: Effect.Effect<Redacted.Redacted, SystemOneError>,
  options: ClientOptions = {},
) => makeWith(apiKey, OPENROUTER_ENDPOINT, options)

/** OpenRouter client using Fetch; gets the key before each request, like {@link layerWith}. */
export const layerOpenRouter = (
  apiKey: Effect.Effect<Redacted.Redacted, SystemOneError>,
  options: ClientOptions = {},
) => layerWith(apiKey, OPENROUTER_ENDPOINT, options)
