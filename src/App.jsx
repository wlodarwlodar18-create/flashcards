async function handleCSVUpload(e) {
  const file = e.target.files?.[0]
  if (!file) return
  if (!importFolderId) {
    setError('Wybierz folder dla importu.')
    alert('Najpierw wybierz folder, do którego zaimportuję fiszki.')
    e.target.value = ''
    return
  }

  setLoading(true)
  setError('')
  setImportProgress({ running: true, done: 0 })

  // stabilne wysyłanie
  const CHUNK = 10
  const DELAY_MS = 200

  let processed = 0

  // Wspólne: insert paczki z retry + pauza
  const flushFactory = () => {
    let batch = []
    return {
      push(row) { batch.push(row) },
      size() { return batch.length },
      async flush() {
        if (!batch.length) return
        const toSend = batch
        batch = []
        await insertWithRetry(toSend, { maxRetries: 6, baseDelay: 400 })
        processed += toSend.length
        setImportProgress({ running: true, done: processed })
        await sleep(DELAY_MS)
      }
    }
  }

  // Jeden przebieg Papą z zadanym separatorem (albo auto)
  const runParse = (delimiterOrAuto) => new Promise((resolve, reject) => {
    const flusher = flushFactory()
    let parserAborted = false

    const stepHandler = (results, parser) => {
      const raw = results.data || {}
      const r = {}
      for (const k of Object.keys(raw)) r[(k || '').trim()] = raw[k]

      // Obsługujemy różne warianty nagłówków
      const front = (r['Przód'] ?? r['Przod'] ?? r['front'] ?? r['Front'] ?? '').toString().trim()
      const back  = (r['Tył']   ?? r['Tyl']   ?? r['back']  ?? r['Back']  ?? '').toString().trim()

      if (front && back) {
        flusher.push({
          id: uuidv4(),
          user_id: session.user.id,
          front,
          back,
          known: String(r.known || '').toLowerCase() === 'true',
          folder_id: importFolderId
        })
      }

      if (flusher.size() >= CHUNK) {
        parser.pause()
        Promise.resolve().then(async () => {
          try {
            await flusher.flush()
            parser.resume()
          } catch (err) {
            parserAborted = true
            parser.abort()
            reject(err)
          }
        })
      }
    }

    const baseConfig = {
      header: true,
      skipEmptyLines: 'greedy',
      worker: false,   // stabilnie
      fastMode: false,
      step: stepHandler,
      complete: async () => {
        if (parserAborted) return
        try {
          await flusher.flush()
          resolve(null)
        } catch (err) {
          reject(err)
        }
      },
      error: (err) => reject(err)
    }

    // autowykrywanie: NIE ustawiamy delimiter
    if (delimiterOrAuto === 'auto') {
      Papa.parse(file, baseConfig)
    } else {
      Papa.parse(file, { ...baseConfig, delimiter: delimiterOrAuto })
    }
  })

  try {
    // Kolejno próbujemy: auto → ; → , → tab
    const tried = []
    const tryOrder = ['auto', ';', ',', '\t']
    const before = processed

    for (const delim of tryOrder) {
      tried.push(delim === 'auto' ? 'auto' : JSON.stringify(delim))
      const prevCount = processed
      await runParse(delim)
      if (processed > prevCount) {
        // ten delimiter zadziałał – wychodzimy z pętli
        break
      }
    }

    if (processed === 0) {
      throw new Error(
        'Nie rozpoznano żadnych rekordów. Sprawdź, czy nagłówki to „Przód” i „Tył” (lub front/back) ' +
        'i czy separator to przecinek lub średnik. Próbowałem delimiterów: ' + tried.join(', ')
      )
    }

    await fetchCards()
    alert(`Zaimportowano ${processed} fiszek do wybranego folderu.`)
  } catch (err) {
    console.error('CSV import error:', err)
    setError(err.message || 'Nie udało się zaimportować pliku.')
    alert(
      'Import przerwany: ' + (err.message || 'nieznany błąd') +
      '\n\nWskazówki:\n' +
      '• Upewnij się, że nagłówki to „Przód” i „Tył” (lub front/back).\n' +
      '• Jeśli plik z Excela ma średniki – format CSV (separator: średnik) działa.\n' +
      '• Jeśli to przecinki – też wykryje (auto/domyślnie).'
    )
  } finally {
    setLoading(false)
    setImportProgress({ running: false, done: processed })
    e.target.value = ''
  }
}
