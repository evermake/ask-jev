import { DocumentationPage } from './components/DocumentationPage'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { RequestFeedback } from './components/RequestFeedback'
import { SearchForm } from './components/SearchForm/SearchForm'
import { SearchResults } from './components/SearchResults/SearchResults'
import { useDocumentation } from './hooks/useDocumentation'
import styles from './App.module.css'

export function App() {
  const { source, page, result, busy, error, changeSource, browse, search } = useDocumentation()
  const disabled = busy !== null

  function openResultPage(path: string) {
    browse(`${new URL(source.indexUrl).origin}${path}`)
  }

  return (
    <main className={styles.layout}>
      <Header />
      <SearchForm
        source={source}
        busy={busy}
        onSourceChange={changeSource}
        onBrowse={() => browse()}
        onSearch={search}
      />
      <RequestFeedback busy={busy} error={error} />
      {result && (
        <SearchResults result={result} disabled={disabled} onOpenPage={openResultPage} />
      )}
      {page && (
        <DocumentationPage page={page} disabled={disabled} onBrowse={browse} />
      )}
      <Footer />
    </main>
  )
}
