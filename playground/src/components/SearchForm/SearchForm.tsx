import { useState, type FormEvent } from 'react'
import { DOCS, type DocsEntry } from '@ask-jev/shared'
import type { SearchQuestion } from '../../api'
import { MODELS, SEARCH_BUDGET, type Model } from '../../config'
import type { RequestKind } from '../../hooks/useDocumentation'
import { LinkButton } from '../LinkButton'
import { ApiKeyField } from './ApiKeyField'
import { InlineSelect } from './InlineSelect'
import { QuestionInput } from './QuestionInput'
import styles from './SearchForm.module.css'

const MODEL_OPTIONS = MODELS.map((value) => ({ value, label: value }))
const DOCS_OPTIONS = DOCS.map(({ id, label }) => ({ value: id, label }))

interface SearchFormProps {
  source: DocsEntry
  busy: RequestKind | null
  onSourceChange: (id: string) => void
  onBrowse: () => void
  onSearch: (question: SearchQuestion, apiKey: string) => void
}

export function SearchForm({ source, busy, onSourceChange, onBrowse, onSearch }: SearchFormProps) {
  const [model, setModel] = useState<Model>(MODELS[0])
  const [query, setQuery] = useState('')
  const [apiKey, setApiKey] = useState('')
  const disabled = busy !== null
  const canSearch = !disabled && Boolean(apiKey.trim()) && Boolean(query.trim())

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (canSearch) onSearch({ query, model }, apiKey)
  }

  return (
    <section className={styles.composer} aria-label="Ask Jev">
      <form onSubmit={submit}>
        <div className={styles.prompt}>
          <InlineSelect
            id="model"
            label="Model"
            disabled={disabled}
            value={model}
            options={MODEL_OPTIONS}
            onChange={setModel}
          />
          <span>, please search </span>
          <InlineSelect
            id="docs"
            label="Documentation source"
            describedBy="docs-index"
            disabled={disabled}
            value={source.id}
            options={DOCS_OPTIONS}
            onChange={onSourceChange}
          />
          <span> docs</span>
          <label htmlFor="query">for an answer to:</label>
        </div>
        <QuestionInput value={query} onChange={setQuery} />
        <ApiKeyField value={apiKey} onChange={setApiKey} />
        <div className={styles.actions}>
          <p className={styles.note}>
            Original passages, not generated answers.<br />
            <span>${SEARCH_BUDGET.toFixed(2)} search estimate · paid with your TypeSafe credits.</span>
          </p>
          <button className={styles.searchButton} type="submit" disabled={!canSearch}>
            {busy === 'search' ? 'Searching…' : 'Find passages'}
            <span aria-hidden="true"> ↵</span>
          </button>
        </div>
        <div className={styles.sourceStrip}>
          <span id="docs-index">{source.indexUrl}</span>
          <LinkButton disabled={disabled} onClick={onBrowse}>
            Browse index <span aria-hidden="true">↗</span>
          </LinkButton>
        </div>
      </form>
    </section>
  )
}
