import styles from './QuestionInput.module.css'

interface QuestionInputProps {
  value: string
  onChange: (value: string) => void
}

export function QuestionInput({ value, onChange }: QuestionInputProps) {
  return (
    <div>
      <input
        id="query"
        type="text"
        className={styles.input}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="How do retries and timeouts work?"
        maxLength={4000}
        autoComplete="off"
        required
      />
      <span className={styles.characterCount} aria-hidden="true">
        {value.length.toLocaleString()} / 4,000
      </span>
    </div>
  )
}
