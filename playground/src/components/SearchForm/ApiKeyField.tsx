import styles from './ApiKeyField.module.css'

interface ApiKeyFieldProps {
  value: string
  onChange: (value: string) => void
}

export function ApiKeyField({ value, onChange }: ApiKeyFieldProps) {
  return (
    <>
      <div className={styles.credentials}>
        <label htmlFor="key">using this TypeSafe API key</label>
        <div className={styles.field}>
          <input
            id="key"
            type="password"
            aria-describedby="key-privacy"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Your secret key"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          <button
            type="button"
            className={styles.forget}
            disabled={!value}
            onClick={() => onChange('')}
          >
            Forget key
          </button>
        </div>
      </div>
      <small id="key-privacy">
        Kept in this tab only. Sent to this server, then only to TypeSafe. Use a limited-spend key.
      </small>
    </>
  )
}
