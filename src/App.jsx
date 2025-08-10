import React, { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import Papa from 'papaparse'
import { motion, AnimatePresence } from 'framer-motion'
import { v4 as uuidv4 } from 'uuid'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY || ''
const supabase = createClient(supabaseUrl, supabaseAnon)

export default function App() {
  const [session, setSession] = useState(null)
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // preferencje UI
  const [hideKnown, setHideKnown] = useState(true)
  const [sidePref, setSidePref] = useState('front') // 'front' | 'back' | 'random'

  // dane
  const [cards, setCards] = useState([])
  const [q, setQ] = useState('')
  const [newFront, setNewFront] = useState('')
  const [newBack, setNewBack] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [folderFilter, setFolderFilter] = useState('ALL')
  const [reviewIdx, setReviewIdx] = useState(0)

  // owner-login (opcjonalnie, jeśli masz)
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')

  // load session
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      supabase.auth.onAuthStateChange((_event, session) => setSession(session))
    }
    // preferencje z localStorage
    try {
      const storedHide = localStorage.getItem('hideKnown')
      const storedSide = localStorage.getItem('sidePref')
      if (storedHide !== null) setHideKnown(storedHide === 'true')
      if (storedSide) setSidePref(storedSide)
    } catch {}
    init()
  }, [])

  useEffect(() => {
    if (!session) return
    fetchCards()
  }, [session])

  useEffect(() => {
    try {
      localStorage.setItem('hideKnown', String(hideKnown))
      localStorage.setItem('sidePref', sidePref)
    } catch {}
  }, [hideKnown, sidePref])

  async function fetchCards() {
    setLoading(true)
    setError('')
    const { data, error } = await supabase
      .from('flashcards')
      .select('id, front, back, folder, known, created_at')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setCards(data || [])
    setLoading(false)
  }

  async function signInWithEmail(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    })
    setLoading(false)
    if (error) setError(error.message)
    else alert('Sprawdź skrzynkę – wysłałem link do logowania.')
  }

  // logowanie hasłem (jeśli dodałeś wcześniej)
  async function signInWithPassword(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({
      email: ownerEmail,
      password: ownerPassword
    })
    setLoading(false)
    if (error) setError(error.message)
  }

  async function signOut() {
    await supabase.auth.signOut()
    setCards([])
  }

  async function addCard(front, back, folder) {
    const payload = { id: uuidv4(), user_id: session.user.id, front, back, folder: folder || null }
    const { error } = await supabase.from('flashcards').insert(payload)
    if (error) throw error
  }

  async function handleAdd(e) {
    e.preventDefault()
    if (!newFront.trim() || !newBack.trim()) return
    try {
      await addCard(newFront.trim(), newBack.trim(), newFolder.trim())
      setNewFront(''); setNewBack(''); setNewFolder('')
      fetchCards()
    } catch (err) {
      setError(err.message)
    }
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
    // optimistic update
    setCards(prev => prev.map(c => c.id === card.id ? { ...c, known: next } : c))
    const { error } = await supabase
      .from('flashcards')
      .update({ known: next })
      .eq('id', card.id)
      .eq('user_id', session.user.id)
    if (error) {
      setError(error.message)
      // rollback
      setCards(prev => prev.map(c => c.id === card.id ? { ...c, known: card.known } : c))
    }
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

  async function handleCSVUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setLoading(true)
    setError('')
    try {
      const rows = await parseCSV(file) // expects columns: front, back, (opcjonalnie) folder, known
      const cleaned = rows
        .map(r => ({
          front: (r.front || '').toString().trim(),
          back: (r.back || '').toString().trim(),
          folder: (r.folder || '').toString().trim() || null,
          known: String(r.known || '').toLowerCase() === 'true'
        }))
        .filter(r => r.front && r.back)

      const payload = cleaned.map(r => ({ id: uuidv4(), user_id: session.user.id, ...r }))
      const chunkSize = 500
      for (let i = 0; i < payload.length; i += chunkSize) {
        const chunk = payload.slice(i, i + chunkSize)
        const { error } = await supabase.from('flashcards').insert(chunk)
        if (error) throw error
      }
      await fetchCards()
      alert(`Zaimportowano ${payload.length} fiszek.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      e.target.value = ''
    }
  }

  // grupy/foldery do filtra
  const folders = useMemo(() => {
    const set = new Set()
    cards.forEach(c => { if (c.folder && c.folder.trim()) set.add(c.folder.trim()) })
    return Array.from(set).sort()
  }, [cards])

  // filtrowanie
  const filtered = useMemo(() => {
    let arr = cards
    if (hideKnown) arr = arr.filter(c => !c.known)
    if (folderFilter !== 'ALL') arr = arr.filter(c => (c.folder || '') === folderFilter)
    const k = q.trim().toLowerCase()
    if (!k) return arr
    return arr.filter(c =>
      c.front.toLowerCase().includes(k) ||
      c.back.toLowerCase().includes(k) ||
      (c.folder || '').toLowerCase().includes(k)
    )
  }, [q, cards, hideKnown, folderFilter])

  function Review() {
    const has = filtered.length > 0
    const card = filtered[reviewIdx % Math.max(1, filtered.length)]
    const [showBack, setShowBack] = useState(false)

    // ustal stronę startową wg preferencji
    useEffect(() => {
      if (!has) return
      if (sidePref === 'front') setShowBack(false)
      else if (sidePref === 'back') setShowBack(true)
      else setShowBack(Math.random() < 0.5) // random
    }, [reviewIdx, sidePref, has])

    useEffect(() => { setShowBack(false) }, [reviewIdx])

    if (!has) return <p className="text-sm text-gray-500">Brak fiszek do przeglądu.</p>

    return (
      <div className="mt-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-500">{(reviewIdx % filtered.length) + 1} / {filtered.length}</span>
          <div className="flex items-center gap-2">
            <button className="text-xs underline" onClick={() => setReviewIdx((i) => (i + 1) % filtered.length)}>Pomiń →</button>
            <button className="text-xs underline" onClick={() => toggleKnown(card)}>{card.known ? 'Oznacz jako NIEznaną' : 'Oznacz jako zapamiętaną'}</button>
          </div>
        </div>
        <motion.div
          className="w-full bg-white rounded-2xl shadow p-6 cursor-pointer min-h-[140px] flex items-center justify-center text-center relative"
          onClick={() => setShowBack(!showBack)}
          initial={{ rotateY: 0 }}
          animate={{ rotateY: showBack ? 180 : 0 }}
          transition={{ duration: 0.4 }}
          style={{ transformStyle: 'preserve-3d' }}
        >
          <div style={{ backfaceVisibility: 'hidden' }} className="text-xl font-semibold">{card.front}</div>
          <div style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)', position: 'absolute' }} className="text-xl">{card.back}</div>
        </motion.div>
        <div className="flex gap-2 mt-4">
          <button className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200" onClick={() => setReviewIdx((i) => (i + 1) % filtered.length)}>Następna</button>
          <button className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200" onClick={() => setShowBack(true)}>Pokaż odpowiedź</button>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-6">
          <h1 className="text-2xl font-bold">Fiszki – logowanie</h1>
          <p className="text-sm text-gray-600 mt-2">Podaj e-mail, wyślę link do logowania (bez hasła).</p>
          <form onSubmit={signInWithEmail} className="mt-4 space-y-3">
            <input type="email" required placeholder="twoj@email.pl" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full border rounded-xl px-3 py-2" />
            <button disabled={loading} className="w-full rounded-xl px-4 py-2 bg-black text-white disabled:opacity-50">
              {loading ? 'Wysyłanie…' : 'Wyślij link'}
            </button>
          </form>

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
          <p className="text-xs text-gray-500 mt-4">Po zalogowaniu wrócisz na tę stronę.</p>
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
            <label className="text-sm flex items-center gap-2 bg-white rounded-xl shadow px-3 py-2">
              <input type="checkbox" checked={hideKnown} onChange={(e)=>setHideKnown(e.target.checked)} />
              Ukrywaj zapamiętane
            </label>
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2">
              <span>Pokaż najpierw:</span>
              <select className="border rounded-lg px-2 py-1" value={sidePref} onChange={(e)=>setSidePref(e.target.value)}>
                <option value="front">front</option>
                <option value="back">back</option>
                <option value="random">losowo</option>
              </select>
            </div>
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2">
              <span>Folder:</span>
              <select className="border rounded-lg px-2 py-1" value={folderFilter} onChange={(e)=>setFolderFilter(e.target.value)}>
                <option value="ALL">Wszystkie</option>
                {folders.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-600 hidden sm:inline">{session.user.email}</span>
              <button onClick={signOut} className="px-3 py-2 rounded-xl bg-white shadow hover:bg-gray-50">Wyloguj</button>
            </div>
          </div>
        </header>

        <section className="mt-6 grid md:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Dodaj fiszkę</h2>
            <form onSubmit={handleAdd} className="space-y-2">
              <input className="w-full border rounded-xl px-3 py-2" placeholder="Przód (pytanie)" value={newFront} onChange={e => setNewFront(e.target.value)} />
              <textarea className="w-full border rounded-xl px-3 py-2" placeholder="Tył (odpowiedź)" value={newBack} onChange={e => setNewBack(e.target.value)} />
              <input className="w-full border rounded-xl px-3 py-2" placeholder="Folder (np. Angielski/IT)" value={newFolder} onChange={e => setNewFolder(e.target.value)} />
              <button className="px-4 py-2 rounded-xl bg-black text-white">Dodaj</button>
            </form>
            <div className="mt-4">
              <label className="text-sm font-medium">Import CSV (nagłówki: front, back, folder?, known?)</label>
              <input type="file" accept=".csv" onChange={handleCSVUpload} className="mt-2 block" />
            </div>
            {loading && <p className="text-sm text-gray-600 mt-2">Pracuję…</p>}
            {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Tryb nauki</h2>
            <input className="w-full border rounded-xl px-3 py-2 mb-3" placeholder="Szukaj w fiszkach…" value={q} onChange={e => setQ(e.target.value)} />
            <Review />
          </div>
        </section>

        <section className="mt-6 bg-white rounded-2xl shadow p-4">
          <h2 className="font-semibold mb-3">Wszystkie fiszki ({filtered.length})</h2>
          <input className="w-full border rounded-xl px-3 py-2 mb-3" placeholder="Filtruj…" value={q} onChange={e => setQ(e.target.value)} />
          <ul className="divide-y">
            <AnimatePresence>
              {filtered.map(card => (
                <motion.li key={card.id} className="py-3 flex items-start justify-between gap-3"
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                  <div className="flex-1">
                    <p className="font-medium">{card.front}</p>
                    <p className="text-sm text-gray-600 mt-1">{card.back}</p>
                    <p className="text-xs text-gray-500 mt-1">{card.folder ? `Folder: ${card.folder}` : 'Folder: —'}</p>
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

        <footer className="text-xs text-gray-500 mt-8 text-center">
          React + Supabase • Foldery i „Zapamiętane” • CSV: nagłówki <code>front</code>, <code>back</code>, <code>folder?</code>, <code>known?</code>.
        </footer>
      </div>
    </main>
  )
}

