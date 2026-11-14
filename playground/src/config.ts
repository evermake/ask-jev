export const SEARCH_BUDGET = 0.02

export const MODELS = ['jev-latest', 'jev-preview'] as const

export type Model = typeof MODELS[number]
