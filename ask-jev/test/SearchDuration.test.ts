import { test } from 'node:test'
import { expect } from 'expect'
import { Clock, Effect, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'
import * as PagePath from '../src/PagePath.ts'
import * as Search from '../src/Search.ts'
import * as SystemOne from '../src/SystemOne.ts'

const path = PagePath.PagePath.make

const source = (
  pages: Record<string, string>,
  loadMs: (path: string) => number = () => 0,
): Search.Source => ({
  origin: 'https://x.dev',
  index: path('/index.md'),
  page: (p) =>
    Effect.sleep(loadMs(p)).pipe(
      Effect.as({ url: new URL(`https://x.dev${p}`), content: pages[p]! }),
    ),
})

const blocks = (count: number) =>
  Array.from({ length: count }, (_, i) => `Block ${i}`).join('\n\n')

const model = (
  delays: ReadonlyArray<number>,
  score: (id: string) => number = () => 0,
) => {
  let calls = 0
  const intervals: Array<{ startMs: number; endMs?: number }> = []
  const service = SystemOne.SystemOne.of({
    evaluate: Effect.fnUntraced(function* (request: SystemOne.Request) {
      const call = calls++
      const interval: { startMs: number; endMs?: number } = {
        startMs: Number(yield* Clock.monotonicTimeNanos) / 1_000_000,
      }
      intervals.push(interval)
      yield* Effect.sleep(delays[call]!)
      interval.endMs = Number(yield* Clock.monotonicTimeNanos) / 1_000_000
      return new SystemOne.Response({
        model: 'jev-test',
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, { type: 'noul' as const, noul: score(id) }]),
        ),
        usage: { input_tokens: 100, output_tokens: 0 },
      })
    }),
  })
  return { service, intervals }
}

const runTimed = async <A, E>(program: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* program.pipe(Effect.forkChild)
    yield* TestClock.adjust('1 day')
    return yield* Fiber.join(fiber)
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)

test('duration counts two simultaneous one-second evaluations as one second', async () => {
  const { service, intervals } = model([1_000, 1_000])
  const result = await runTimed(
    Search.search(source({ '/index.md': blocks(201) }, () => 250), 'query').pipe(
      Effect.provideService(SystemOne.SystemOne, service),
    ),
  )
  expect(intervals).toEqual([
    { startMs: 250, endMs: 1_250 },
    { startMs: 250, endMs: 1_250 },
  ])
  expect(result.usage.requests).toBe(2)
  expect(result.duration).toEqual({ totalMs: 1_250, jevMs: 1_000, restMs: 250 })
})

test('duration counts nested evaluation intervals only once', async () => {
  const { service, intervals } = model([1_000, 2_000, 3_000])
  const result = await runTimed(
    Search.search(source({ '/index.md': blocks(401) }), 'query').pipe(
      Effect.provideService(SystemOne.SystemOne, service),
    ),
  )
  expect(intervals).toEqual([
    { startMs: 0, endMs: 1_000 },
    { startMs: 0, endMs: 2_000 },
    { startMs: 0, endMs: 3_000 },
  ])
  expect(result.duration).toEqual({ totalMs: 3_000, jevMs: 3_000, restMs: 0 })
})

test('duration unions partially overlapping evaluations as queued windows start', async () => {
  const { service, intervals } = model([1_000, 2_000, 3_000, 3_000])
  const result = await runTimed(
    Search.search(source({ '/index.md': blocks(601) }), 'query').pipe(
      Effect.provideService(SystemOne.SystemOne, service),
    ),
  )
  expect(intervals).toEqual([
    { startMs: 0, endMs: 1_000 },
    { startMs: 0, endMs: 2_000 },
    { startMs: 0, endMs: 3_000 },
    { startMs: 1_000, endMs: 4_000 },
  ])
  expect(result.duration).toEqual({ totalMs: 4_000, jevMs: 4_000, restMs: 0 })
})

test('duration excludes docs-loading gaps between sequential evaluations from Jev time', async () => {
  const { service, intervals } = model([1_000, 500], (id) => (id.startsWith('L') ? 1 : 0))
  const result = await runTimed(
    Search.search(
      source(
        { '/index.md': '[Next](/next.md)', '/next.md': 'No answer.' },
        (p) => (p === '/index.md' ? 250 : 750),
      ),
      'query',
    ).pipe(Effect.provideService(SystemOne.SystemOne, service)),
  )
  expect(intervals).toEqual([
    { startMs: 250, endMs: 1_250 },
    { startMs: 2_000, endMs: 2_500 },
  ])
  expect(result.duration).toEqual({ totalMs: 2_500, jevMs: 1_500, restMs: 1_000 })
})

test('duration unions a chain of overlaps across successive window refills', async () => {
  const { service, intervals } = model([1_000, 1_500, 2_000, 1_500, 1_500, 1_500])
  const result = await runTimed(
    Search.search(source({ '/index.md': blocks(1_001) }), 'query').pipe(
      Effect.provideService(SystemOne.SystemOne, service),
    ),
  )
  expect(intervals).toEqual([
    { startMs: 0, endMs: 1_000 },
    { startMs: 0, endMs: 1_500 },
    { startMs: 0, endMs: 2_000 },
    { startMs: 1_000, endMs: 2_500 },
    { startMs: 1_500, endMs: 3_000 },
    { startMs: 2_000, endMs: 3_500 },
  ])
  expect(result.duration).toEqual({ totalMs: 3_500, jevMs: 3_500, restMs: 0 })
})

test('duration unions all nine concurrent evaluations across three pages', async () => {
  const { service, intervals } = model(
    [100, ...Array<number>(9).fill(1_000)],
    (id) => (id.startsWith('L') ? 1 : 0),
  )
  const result = await runTimed(
    Search.search(
      source(
        {
          '/index.md': '[A](/a.md)\n\n[B](/b.md)\n\n[C](/c.md)',
          '/a.md': blocks(401),
          '/b.md': blocks(401),
          '/c.md': blocks(401),
        },
        () => 250,
      ),
      'query',
    ).pipe(Effect.provideService(SystemOne.SystemOne, service)),
  )
  expect(intervals).toEqual([
    { startMs: 250, endMs: 350 },
    ...Array.from({ length: 9 }, () => ({ startMs: 600, endMs: 1_600 })),
  ])
  expect(result.usage.requests).toBe(10)
  expect(result.duration).toEqual({ totalMs: 1_600, jevMs: 1_100, restMs: 500 })
})

test('duration includes passage judging as well as page rating', async () => {
  const { service } = model([1_000, 250], () => 1)
  const result = await runTimed(
    Search.search(source({ '/index.md': 'The answer.' }, () => 500), 'query').pipe(
      Effect.provideService(SystemOne.SystemOne, service),
    ),
  )
  expect(result.stopped).toBe('answered')
  expect(result.passages.map((passage) => passage.text)).toEqual(['The answer.'])
  expect(result.usage.requests).toBe(2)
  expect(result.duration).toEqual({ totalMs: 1_750, jevMs: 1_250, restMs: 500 })
})

test('duration has zero Jev time when the budget prevents all evaluations', async () => {
  for (const budget of [0, 1e-9]) {
    const { service, intervals } = model([])
    const result = await runTimed(
      Search.search(source({ '/index.md': 'The answer.' }, () => 500), 'query', { budget }).pipe(
        Effect.provideService(SystemOne.SystemOne, service),
      ),
    )
    const totalMs = budget === 0 ? 0 : 500
    expect(result.stopped).toBe('budget')
    expect(intervals).toEqual([])
    expect(result.duration).toEqual({ totalMs, jevMs: 0, restMs: totalMs })
  }
})

test('duration is isolated when the same search effect is executed again', async () => {
  const { service } = model([1_000, 250])
  const search = Search.search(source({ '/index.md': 'No answer.' }, () => 100), 'query').pipe(
    Effect.provideService(SystemOne.SystemOne, service),
  )
  const results = await runTimed(
    Effect.gen(function* () {
      const first = yield* search
      yield* Effect.sleep(750)
      const second = yield* search
      return [first, second]
    }),
  )
  expect(results.map((result) => result.duration)).toEqual([
    { totalMs: 1_100, jevMs: 1_000, restMs: 100 },
    { totalMs: 350, jevMs: 250, restMs: 100 },
  ])
  expect(results.map((result) => result.usage.requests)).toEqual([1, 1])
})

test('duration excludes the delay between constructing and executing the search effect', async () => {
  const { service, intervals } = model([250])
  const search = Search.search(source({ '/index.md': 'No answer.' }, () => 100), 'query').pipe(
    Effect.provideService(SystemOne.SystemOne, service),
  )
  const result = await runTimed(
    Effect.gen(function* () {
      yield* Effect.sleep(700)
      return yield* search
    }),
  )
  expect(intervals).toEqual([{ startMs: 800, endMs: 1_050 }])
  expect(result.duration).toEqual({ totalMs: 350, jevMs: 250, restMs: 100 })
})

test('duration is isolated between concurrent executions of the same search effect', async () => {
  const { service } = model([1_000, 250])
  const search = Search.search(source({ '/index.md': 'No answer.' }, () => 100), 'query').pipe(
    Effect.provideService(SystemOne.SystemOne, service),
  )
  const results = await runTimed(Effect.all([search, search], { concurrency: 2 }))
  expect(results.map((result) => result.duration)).toEqual([
    { totalMs: 1_100, jevMs: 1_000, restMs: 100 },
    { totalMs: 350, jevMs: 250, restMs: 100 },
  ])
})

test('a failing evaluation interrupts its sibling and leaves reexecution unaffected', async () => {
  let calls = 0
  let finalized = 0
  const search = Search.search(source({ '/index.md': blocks(201) }, () => 100), 'query').pipe(
    Effect.provideService(SystemOne.SystemOne, {
      evaluate: Effect.fnUntraced(
        function* () {
          const call = calls++
          if (call === 0) return yield* Effect.never
          yield* Effect.sleep(call === 1 ? 500 : 250)
          if (call === 1) return yield* Effect.fail(new SystemOne.SystemOneError({ message: 'failed' }))
          return new SystemOne.Response({
            model: 'jev-test',
            answers: {},
            usage: { input_tokens: 100, output_tokens: 0 },
          })
        },
        Effect.ensuring(Effect.sync(() => finalized++)),
      ),
    }),
  )
  const result = await runTimed(
    Effect.gen(function* () {
      expect(Result.isFailure(yield* Effect.result(search))).toBe(true)
      expect(calls).toBe(2)
      expect(finalized).toBe(2)
      return yield* search
    }),
  )
  expect(calls).toBe(4)
  expect(finalized).toBe(4)
  expect(result.duration).toEqual({ totalMs: 350, jevMs: 250, restMs: 100 })
})

test('evaluation stays interruptible and cancellation does not affect reexecution', { timeout: 5_000 }, async () => {
  let calls = 0
  let finalized = 0
  const search = Search.search(source({ '/index.md': 'No answer.' }, () => 100), 'query').pipe(
    Effect.provideService(SystemOne.SystemOne, {
      evaluate: () => {
        const evaluation =
          calls++ === 0
            ? Effect.never
            : Effect.sleep(250).pipe(
                Effect.as(
                  new SystemOne.Response({
                    model: 'jev-test',
                    answers: {},
                    usage: { input_tokens: 100, output_tokens: 0 },
                  }),
                ),
              )
        return evaluation.pipe(Effect.ensuring(Effect.sync(() => finalized++)))
      },
    }),
  )
  const result = await Effect.gen(function* () {
    const interrupted = yield* search.pipe(Effect.forkChild)
    yield* TestClock.adjust(600)
    expect(calls).toBe(1)
    yield* Fiber.interrupt(interrupted)
    expect(finalized).toBe(1)
    const next = yield* search.pipe(Effect.forkChild)
    yield* TestClock.adjust(350)
    return yield* Fiber.join(next)
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
  expect(finalized).toBe(2)
  expect(result.duration).toEqual({ totalMs: 350, jevMs: 250, restMs: 100 })
})
