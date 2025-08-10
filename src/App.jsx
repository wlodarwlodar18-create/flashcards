import React, { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import Papa from 'papaparse'
import { motion, AnimatePresence } from 'framer-motion'
import { v4 as uuidv4 } from 'uuid'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY || ''
const supabase = createClient(supabaseUrl, supabaseAnon)

/* Fisher–Yates shuffle */
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export default function App() {
  const [session, setSession] = useState(null)
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // preferencje i filtry
  const [showFilter, setShowFilter] = useState('unknown') // 'all' | 'known' | 'unknown'
  const [sidePref, setSidePref] = useState('front') // 'front' | 'back' | 'random'
  const [shuffleOnLoad, setShuffleOnLoad] = useState(true)
  const [firstLoad, setFirstLoad] = useState(true)

  // dane
  const [cards, setCards] = useState([])
  const [folders, setFolders] = useState([])
  const [activeFolderId, setActiveFolderId] = useState('ALL')
  const [q, setQ] = useState('')

  // dodawanie fiszki
  const [newFront, setNewFront] = useState('')
  const [newBack, setNewBack] = useState('')
  const [newCardFolderId, setNewCardFolderId] = useState('') // WYMAGANY

  // dodawanie folderu
  const [newFolderName, setNewFolderName] = useState('')

  // import CSV → WYBRANY FOLDER (WYMAGANY)
  const [importFolderId, setImportFolderId] = useState('')

  // owner-login (opcjonalnie)
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')

  const [reviewIdx, setReviewIdx] = useState(0)

  // init
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    }
    try {
      const storedSide = localStorage.getItem('sidePref')
      const storedFilter = localStorage.getItem('showFilter')
      const storedShuffle = localStorage.getItem('shuffleOnLoad')
      if (storedSide) setSidePref(storedSide)
      if (storedFilter) setShowFilter(storedFilter)
      if (storedShuffle !== null) setShuffleOnLoad(storedShuffle === 'true')
    } catch {}
    init()
  }, [])

  useEffect(() => {
    if (!session) return
    fetchFolders().then(() => fetchCards()) // najpierw foldery, potem fiszki
  }, [session])

  useEffect(() => {
    try {
      localStorage.setItem('sidePref', sidePref)
      localStorage.setItem('showFilter', showFilter)
      localStorage.setItem('shuffleOnLoad', String(shuffleOnLoad))
    } catch {}
  }, [sidePref, showFilter, shuffleOnLoad])

  // ===== API
  async function fetchFolders() {
    setError('')
    const { data, error } = await supabase
      .from('folders')
      .select('id, name, created_at')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setFolders(data || [])
  }

  async function fetchCards() {
    setLoading(true)
    setError('')
    const { data, error } = await supabase
      .from('flashcards')
      .select('id, front, back, known, folder_id, created_at')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else {
      let list = data || []
      if (firstLoad && shuffleOnLoad) {
        list = shuffle(list)
        setFirstLoad(false)
      }
      setCards(list)
      setReviewIdx(0)
    }
    setLoading(false)
  }

  async function addFolder(e) {
    e.preventDefault()
    if (!newFolderName.trim()) return
    const payload = { id: uuidv4(), user_id: session.user.id, name: newFolderName.trim() }
    const { error } = await supabase.from('folders').insert(payload)
    if (error) { setError(error.message); return }
    setNewFolderName('')
    fetchFolders()
  }

  async function deleteFolder(id, name) {
    if (!window.confirm(`Usunąć folder „${name}”? Wszystkie fiszki z tego folderu również zostaną usunięte (kaskadowo).`)) return
    const { error } = await supabase
      .from('folders')
      .delete()
      .eq('id', id)
      .eq('user_id', session.user.id)
    if (error) setError(error.message)
    else {
      fetchFolders()
      fetchCards()
    }
  }

  async function addCard(front, back, folderId) {
    const payload = { id: uuidv4(), user_id: session.user.id, front, back, folder_id: folderId || null }
    const { error } = await supabase.from('flashcards').insert(payload)
    if (error) throw error
  }

  async function handleAddCard(e) {
    e.preventDefault()
    if (!newFront.trim() || !newBack.trim()) return
    if (!newCardFolderId) { // folder WYMAGANY
      setError('Wybierz folder dla tej fiszki.')
      return
    }
    try {
      await addCard(newFront.trim(), newBack.trim(), newCardFolderId)
      setNewFront(''); setNewBack(''); setNewCardFolderId('') // reset wyboru
      fetchCards()
    } catch (err) { setError(err.message) }
  }

  async function removeCard(id) {
    const { error } = await supabase
      .from('flashcards')
      .delete()
      .eq('id', id)
      .eq('user_id', session.user.id)
    if (error) setError(error.message)
    else setCards(prev => prev.filter(c => c.id !== id))
  }

  async function toggleKnown(card) {
    const next = !card.known
    setCards(prev => prev.map(c => c.id === card.id ? { ...c, known: next } : c))
    const { error } = await supabase
      .from('flashcards')
      .update({ known: next })
      .eq('id', card.id)
      .eq('user_id', session.user.id)
    if (error) {
      setError(error.message)
      setCards(prev => prev.map(c => c.id === card.id ? { ...c, known: card.known } : c))
    }
  }

  async function markKnown(card) {
    if (card.known) return
    setCards(prev => prev.map(c => c.id === card.id ? { ...c, known: true } : c))
    const { error } = await supabase
      .from('flashcards')
      .update({ known: true })
      .eq('id', card.id)
      .eq('user_id', session.user.id)
    if (error) {
      setError(error.message)
      setCards(prev => prev.map(c => c.id === card.id ? { ...c, known: false } : c))
    }
  }

  async function signInWithEmail(e) {
    e.preventDefault()
    setLoading(true); setError('')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    })
    setLoading(false)
    if (error) setError(error.message)
    else alert('Sprawdź skrzynkę – wysłałem link do logowania.')
  }

  async function signInWithPassword(e) {
    e.preventDefault()
    setLoading(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({
      email: ownerEmail,
      password: ownerPassword
    })
    setLoading(false)
    if (error) setError(error.message)
  }

  async function signOut() {
    await supabase.auth.signOut()
    setCards([]); setFolders([])
  }

  function parseCSV(file) {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => resolve(results.data),
        error: (err) => reject(err)
      })
    })
  }

  // ===== IMPORT CSV — WYMAGA WYBRANIA FOLDERU
  async function handleCSVUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return

    if (!importFolderId) {
      setError('Wybierz folder dla importu.')
      alert('Najpierw wybierz folder, do którego zaimportuję fiszki.')
      e.target.value = ''
      return
    }

    setLoading(true); setError('')
    try {
      const rows = await parseCSV(file) // oczekuje: Przód, Tył (lub front, back)

      const cleaned = rows
        .map(r => {
          // PL + kompatybilność ENG
          const front = (r['Przód'] ?? r['Przod'] ?? r.front ?? '').toString().trim()
          const back  = (r['Tył']   ?? r['Tyl']   ?? r.back  ?? '').toString().trim()
          const known = String(r.known || '').toLowerCase() === 'true'
          return { front, back, known }
        })
        .filter(r => r.front && r.back)

      if (!cleaned.length) {
        throw new Error('Plik nie zawiera poprawnych wierszy (kolumny „Przód/Tył” lub „front/back”).')
      }

      // WSZYSTKO trafia do WYBRANEGO folderu
      const payload = cleaned.map(r => ({
        id: uuidv4(),
        user_id: session.user.id,
        front: r.front,
        back: r.back,
        known: r.known,
        folder_id: importFolderId
      }))

      const chunkSize = 500
      for (let i = 0; i < payload.length; i += chunkSize) {
        const chunk = payload.slice(i, i + chunkSize)
        const { error } = await supabase.from('flashcards').insert(chunk)
        if (error) throw error
      }

      await fetchCards()
      alert(`Zaimportowano ${payload.length} fiszek do wybranego folderu.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      e.target.value = ''
    }
  }

  // ===== Filtrowanie
  const foldersForSelect = useMemo(() => [{ id: 'ALL', name: 'Wszystkie' }, ...folders], [folders])

  const filtered = useMemo(() => {
    let arr = cards
    if (activeFolderId !== 'ALL') arr = arr.filter(c => (c.folder_id || null) === activeFolderId)
    if (showFilter === 'known') arr = arr.filter(c => c.known)
    if (showFilter === 'unknown') arr = arr.filter(c => !c.known)
    const k = q.trim().toLowerCase()
    if (k) {
      arr = arr.filter(c => c.front.toLowerCase().includes(k) || c.back.toLowerCase().includes(k))
    }
    return arr
  }, [cards, activeFolderId, showFilter, q])

  // ===== Tryb nauki — bez animacji, pastelowe kolory
  function Review() {
    const has = filtered.length > 0
    const safeLen = Math.max(1, filtered.length)
    const card = filtered[reviewIdx % safeLen]
    const [showBack, setShowBack] = useState(false)

    // ustaw startową stronę zgodnie z sidePref
    useEffect(() => {
      if (!has) return
      if (sidePref === 'front') setShowBack(false)
      else if (sidePref === 'back') setShowBack(true)
      else setShowBack(Math.random() < 0.5) // random
    }, [reviewIdx, sidePref, has])

    if (!has) return <p className="text-sm text-gray-500">Brak fiszek do przeglądu.</p>

    const containerClasses =
      `w-full rounded-2xl shadow p-6 min-h-[160px] flex items-center justify-center text-center border 
       ${showBack ? 'bg-sky-50 border-sky-200' : 'bg-emerald-50 border-emerald-200'}`

    const badgeClasses =
      `absolute top-3 right-3 text-xs px-2 py-1 rounded-full border 
       ${showBack ? 'bg-sky-100 border-sky-200 text-sky-800' : 'bg-emerald-100 border-emerald-200 text-emerald-800'}`

    return (
      <div className="mt-6">
        {/* Karta */}
        <div
          className={`${containerClasses} relative cursor-pointer`}
          onClick={() => setShowBack(s => !s)}
          title="Kliknij, aby przełączyć front/back"
        >
          <span className={badgeClasses}>{showBack ? 'Tył' : 'Przód'}</span>
          <div className="text-xl leading-relaxed max-w-[95%]">
            {showBack ? card.back : card.front}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-4">
          <button
            className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200"
            onClick={() => setReviewIdx(i => (i + 1) % filtered.length)}
          >
            Następna
          </button>
          <button
            className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200"
            onClick={() => setShowBack(s => !s)}
          >
            Pokaż
          </button>
          <button
            className="px-3 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-50"
            onClick={() => markKnown(card)}
            disabled={!!card.known}
            title={card.known ? 'Już zapamiętana' : 'Oznacz tę fiszkę jako zapamiętaną'}
          >
            Zapamiętana
          </button>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-6">
          <h1 className="text-2xl font-bold">Fiszki – logowanie</h1>
          <p className="text-sm text-gray-600 mt-2">Podaj e-mail (magic link) albo zaloguj hasłem właściciela.</p>

        {/* Magic link */}
          <form onSubmit={signInWithEmail} className="mt-4 space-y-3">
            <input type="email" required placeholder="twoj@email.pl" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full border rounded-xl px-3 py-2" />
            <button disabled={loading} className="w-full rounded-xl px-4 py-2 bg-black text-white disabled:opacity-50">
              {loading ? 'Wysyłanie…' : 'Wyślij link'}
            </button>
          </form>

          {/* Owner password */}
          <hr className="my-4" />
          <p className="text-sm font-semibold">Logowanie właściciela (e-mail + hasło)</p>
          <form onSubmit={signInWithPassword} className="mt-2 space-y-2">
            <input type="email" required placeholder="twoj@email.pl" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} className="w-full border rounded-xl px-3 py-2" />
            <input type="password" required placeholder="Hasło" value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)} className="w-full border rounded-xl px-3 py-2" />
            <button disabled={loading} className="w-full rounded-xl px-4 py-2 bg-blue-600 text-white disabled:opacity-50">
              {loading ? 'Logowanie…' : 'Zaloguj się hasłem'}
            </button>
          </form>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 p-4">
      <div className="max-w-5xl mx-auto">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <h1 className="text-2xl font-bold">Twoje fiszki</h1>
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2">
              <span>Pokaż:</span>
              <select className="border rounded-lg px-2 py-1" value={showFilter} onChange={(e)=>setShowFilter(e.target.value)}>
                <option value="all">Wszystkie</option>
                <option value="unknown">Niezapamiętane</option>
                <option value="known">Zapamiętane</option>
              </select>
            </div>
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2">
              <span>Najpierw:</span>
              <select className="border rounded-lg px-2 py-1" value={sidePref} onChange={(e)=>setSidePref(e.target.value)}>
                <option value="front">Przód</option>
                <option value="back">Tył</option>
                <option value="random">Losowo</option>
              </select>
            </div>
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={shuffleOnLoad} onChange={(e)=>setShuffleOnLoad(e.target.checked)} />
                Losuj przy starcie
              </label>
              <button
                type="button"
                className="px-3 py-1 rounded-lg border hover:bg-gray-50"
                onClick={() => { setCards(prev => shuffle(prev)); setReviewIdx(0) }}
                title="Przetasuj aktualną listę fiszek"
              >
                Tasuj teraz
              </button>
            </div>
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2">
              <span>Folder:</span>
              <select className="border rounded-lg px-2 py-1" value={activeFolderId} onChange={(e)=>setActiveFolderId(e.target.value)}>
                {foldersForSelect.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-600 hidden sm:inline">{session.user.email}</span>
              <button onClick={signOut} className="px-3 py-2 rounded-xl bg-white shadow hover:bg-gray-50">Wyloguj</button>
            </div>
          </div>
        </header>

        {/* Foldery: dodawanie + lista (z usuwaniem) */}
        <section className="mt-6 bg-white rounded-2xl shadow p-4">
          <h2 className="font-semibold mb-3">Foldery</h2>
          <form onSubmit={addFolder} className="flex gap-2">
            <input className="flex-1 border rounded-xl px-3 py-2" placeholder="Nazwa folderu (np. Angielski B1)" value={newFolderName} onChange={e=>setNewFolderName(e.target.value)} />
            <button className="px-4 py-2 rounded-xl bg-black text-white">Dodaj folder</button>
          </form>

          <ul className="mt-3 grid sm:grid-cols-2 lg:grid-cols-3 gap-2 text-sm">
            {folders.map(f => (
              <li key={f.id} className={`flex items-center justify-between px-3 py-2 rounded-xl border ${activeFolderId===f.id?'bg-black text-white':'bg-gray-50'}`}>
                <button
                  className="text-left truncate flex-1"
                  title="Pokaż tylko ten folder"
                  onClick={() => setActiveFolderId(f.id)}
                >
                  {f.name}
                </button>
                <button
                  className={`ml-2 px-2 py-1 rounded-lg border ${activeFolderId===f.id ? 'bg-white/10' : 'hover:bg-white'}`}
                  onClick={() => deleteFolder(f.id, f.name)}
                  title="Usuń folder"
                >
                  Usuń
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-6 grid md:grid-cols-2 gap-4">
          {/* Dodawanie fiszki */}
          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Dodaj fiszkę</h2>
            <form onSubmit={handleAddCard} className="space-y-2">
              <input className="w-full border rounded-xl px-3 py-2" placeholder="Przód (pytanie)" value={newFront} onChange={e => setNewFront(e.target.value)} />
              <textarea className="w-full border rounded-xl px-3 py-2" placeholder="Tył (odpowiedź)" value={newBack} onChange={e => setNewBack(e.target.value)} />
              <select
                className="w-full border rounded-xl px-3 py-2"
                value={newCardFolderId}
                onChange={e => setNewCardFolderId(e.target.value)}
                required
                title="Wybierz folder dla tej fiszki"
              >
                <option value="" disabled>(WYBIERZ FOLDER — WYMAGANE)</option>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <button className="px-4 py-2 rounded-xl bg-black text-white">Dodaj</button>
            </form>

            {/* Import CSV – WYMAGA WYBORU FOLDERU */}
            <div className="mt-4">
              <label className="text-sm font-medium">Import CSV (Przód, Tył)</label>
              <div className="mt-2 flex flex-col sm:flex-row gap-2 items-start">
                <select
                  className="border rounded-xl px-3 py-2"
                  value={importFolderId}
                  onChange={(e) => setImportFolderId(e.target.value)}
                  required
                  title="Wybierz folder, do którego trafi cały import"
                >
                  <option value="">(WYBIERZ FOLDER DLA IMPORTU — WYMAGANE)</option>
                  {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>

                <input
                  type="file"
                  accept=".csv"
                  onChange={handleCSVUpload}
                  className="block"
                  disabled={!importFolderId}
                  title={!importFolderId ? 'Najpierw wybierz folder' : 'Wybierz plik CSV'}
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Oczekiwane nagłówki: <code>Przód</code>, <code>Tył</code>.
              </p>
              {!importFolderId && (
                <p className="text-xs text-red-600 mt-1">Wybór folderu jest wymagany, aby wczytać plik.</p>
              )}
            </div>

            {loading && <p className="text-sm text-gray-600 mt-2">Pracuję…</p>}
            {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          </div>

          {/* Tryb nauki */}
          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Tryb nauki</h2>
            <input className="w-full border rounded-xl px-3 py-2 mb-3" placeholder="Szukaj w fiszkach…" value={q} onChange={e => setQ(e.target.value)} />
            <Review />
          </div>
        </section>

        {/* Lista fiszek */}
        <section className="mt-6 bg-white rounded-2xl shadow p-4">
          <h2 className="font-semibold mb-3">Wszystkie fiszki ({filtered.length})</h2>
          <ul className="divide-y">
            <AnimatePresence>
              {filtered.map(card => (
                <motion.li key={card.id} className="py-3 flex items-start justify-between gap-3"
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                  <div className="flex-1">
                    <p className="font-medium">{card.front}</p>
                    <p className="text-sm text-gray-600 mt-1">{card.back}</p>
                    <p className="text-xs text-gray-500 mt-1">{card.known ? '✅ Zapamiętana' : '🕑 Do nauki'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs flex items-center gap-1">
                      <input type="checkbox" checked={!!card.known} onChange={() => toggleKnown(card)} />
                      Zapamiętana
                    </label>
                    <button onClick={() => removeCard(card.id)} className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200">Usuń</button>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </section>
      </div>
    </main>
  )
}
