import styles from './InlineSelect.module.css'

interface InlineSelectProps<Value extends string> {
  id: string
  label: string
  describedBy?: string
  value: Value
  options: ReadonlyArray<{ value: Value; label: string }>
  disabled: boolean
  onChange: (value: Value) => void
}

export function InlineSelect<Value extends string>({
  id,
  label,
  describedBy,
  value,
  options,
  disabled,
  onChange,
}: InlineSelectProps<Value>) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value

  return (
    <span className={styles.container}>
      {/* Size to the selected label, not the longest option, in every browser. */}
      <span className={styles.sizingText} aria-hidden="true">{selectedLabel}</span>
      <select
        id={id}
        className={styles.select}
        aria-label={label}
        aria-describedby={describedBy}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = options.find((option) => option.value === event.target.value)
          if (next) onChange(next.value)
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </span>
  )
}
