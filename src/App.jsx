import React, { useEffect, useMemo, useRef, useState } from 'react'
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

/* Usuwanie diakrytyków (np. ą→a) */
function stripDiacritics(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

/* Heurystyczne wykrywanie języka + polskie wzorce bez ogonków */
function detectLang(text) {
  const raw = (text || '').trim()
  if (!raw) return 'en-US'

  // Skrypty
  if (/[\u0400-\u04FF]/.test(raw)) return 'ru-RU'
  if (/[\u0600-\u06FF]/.test(raw)) return 'ar-SA'
  if (/[\u4E00-\u9FFF]/.test(raw)) return 'zh-CN'
  if (/[\u3040-\u30FF]/.test(raw)) return 'ja-JP'
  if (/[\uAC00-\uD7AF]/.test(raw)) return 'ko-KR'

  // Diakrytyki łacińskie
  if (/[ąćęłńóśźż]/i.test(raw)) return 'pl-PL'
  if (/[äöüß]/i.test(raw)) return 'de-DE'
  if (/[ñáéíóúü]/i.test(raw)) return 'es-ES'
  if (/[çâêëïîôûùéèà]/i.test(raw)) return 'fr-FR'
  if (/[àèéìòù]/i.test(raw)) return 'it-IT'
  if (/[ãõçáéíóú]/i.test(raw)) return 'pt-PT'
  if (/[ğüşıçöİ]/i.test(raw)) return 'tr-TR'

  // Heurystyka PL bez ogonków (mocniejsza)
  const s = stripDiacritics(raw).toLowerCase()
  const plStop = new Set([
    'i','w','na','do','nie','tak','jest','sa','byc','mam','masz','moze','mozna','ktory','ktora','ktore',
    'zeby','albo','czy','dlaczego','poniewaz','przez','ten','ta','to','te','tam','tutaj','taki','takie',
    'bardziej','mniej','bardzo','troche','jesli','gdy','kiedy','z','za','po','od','bez','dla','przed',
    'tojest','jak','co','kto','gdzie','kiedy','dlaczego'
  ])
  const tokens = s.split(/[^a-zA-Z]+/).filter(Boolean)
  let plHits = 0
  for (const t of tokens) if (plStop.has(t)) plHits++

  // typowe dwuznaki i końcówki fleksyjne
  const digraphs = (s.match(/rz|sz|cz|dz|dzw|ch|nia|owie|ami|ego|emu|ach|cie|osci|alny|owy|owym|owie|ami|ami|cie|scy|liscie/gi) || []).length

  // dodatkowe sygnały: 'szcz', zakończenia -ować, -anie, -enie, -owy
  const endings = (s.match(/owac|anie|enie|owy|ami|owej|owego|nych|nymi|emu|cie|ciez|szcz/gi) || []).length

  if (plHits >= 2 || digraphs >= 2 || endings >= 1) return 'pl-PL'
  return 'en-US'
}

/* Dobór głosu do języka */
function pickVoice(voices, lang) {
  if (!voices || !voices.length) return null
  const exact = voices.find(v => v.lang?.toLowerCase() === lang.toLowerCase())
  if (exact) return exact
  const pref = voices.find(v => v.lang?.toLowerCase().startsWith(lang.split('-')[0].toLowerCase()))
  if (pref) return pref
  return voices[0]
}

export default function App() {
  const [session, setSession] = useState(null)
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // preferencje i filtry
  const [showFilter, setShowFilter] = useState('unknown') // 'all' | 'known' | 'unknown'
  const [sidePref, setSidePref] = useState('front')       // 'front' | 'back' | 'random'
  const [shuffleOnLoad, setShuffleOnLoad] = useState(true)
  const [firstLoad, setFirstLoad] = useState(true)

  // TTS override (Auto domyślnie)
  const [ttsLang, setTtsLang] = useState('auto') // 'auto' | 'pl-PL' | 'en-US' | ...

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

  // Web Speech API — głosy
  const [voices, setVoices] = useState([])
  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const load = () => setVoices(window.speechSynthesis.getVoices())
    load()
    window.speechSynthesis.onvoiceschanged = load
    return () => { window.speechSynthesis.onvoiceschanged = null }
  }, [])

  // Tryb auto (slidery)
  const [autoMode, setAutoMode] = useState(false)
  const [phaseA, setPhaseA] = useState(7) // sekundy — pierwsza strona
  const [phaseB, setPhaseB] = useState(3) // sekundy — druga strona

  // init
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    }
    try {
      const ls = (k, d) => localStorage.getItem(k) ?? d
      const storedSide = localStorage.getItem('sidePref')
      const storedFilter = localStorage.getItem('showFilter')
      const storedShuffle = localStorage.getItem('shuffleOnLoad')
      const storedA = localStorage.getItem('phaseA')
      const storedB = localStorage.getItem('phaseB')
      const storedTts = localStorage.getItem('ttsLang')
      if (storedSide) setSidePref(storedSide)
      if (storedFilter) setShowFilter(storedFilter)
      if (storedShuffle !== null) setShuffleOnLoad(storedShuffle === 'true')
      if (storedA) setPhaseA(Math.min(15, Math.max(3, Number(storedA) || 7)))
      if (storedB) setPhaseB(Math.min(10, Math.max(1, Number(storedB) || 3)))
      setTtsLang(storedTts || 'auto')
    } catch {}
    init()
  }, [])

  useEffect(() => {
    if (!session) return
    fetchFolders().then(() => fetchCards())
  }, [session])

  useEffect(() => {
    try {
      localStorage.setItem('sidePref', sidePref)
      localStorage.setItem('showFilter', showFilter)
      localStorage.setItem('shuffleOnLoad', String(shuffleOnLoad))
      localStorage.setItem('phaseA', String(phaseA))
      localStorage.setItem('phaseB', String(phaseB))
      localStorage.setItem('ttsLang', ttsLang)
    } catch {}
  }, [sidePref, showFilter, shuffleOnLoad, phaseA, phaseB, ttsLang])

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
    if (!newCardFolderId) { setError('Wybierz folder dla tej fiszki.'); return }
    try {
      await addCard(newFront.trim(), newBack.trim(), newCardFolderId)
      setNewFront(''); setNewBack(''); setNewCardFolderId('')
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
          const front = (r['Przód'] ?? r['Przod'] ?? r.front ?? '').toString().trim()
          const back  = (r['Tył']   ?? r['Tyl']   ?? r.back  ?? '').toString().trim()
          const known = String(r.known || '').toLowerCase() === 'true'
          return { front, back, known }
        })
        .filter(r => r.front && r.back)
      if (!cleaned.length) throw new Error('Plik nie zawiera poprawnych wierszy (kolumny „Przód/Tył”).')

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
    if (k) arr = arr.filter(c => c.front.toLowerCase().includes(k) || c.back.toLowerCase().includes(k))
    return arr
  }, [cards, activeFolderId, showFilter, q])

  // ===== Tryb nauki — karta + Tryb auto (slidery)
  function Review({ autoMode, onStopAuto, phaseA, phaseB }) {
    const has = filtered.length > 0
    const safeLen = Math.max(1, filtered.length)
    const card = filtered[reviewIdx % safeLen]
    const [showBack, setShowBack] = useState(false)

    // timery i mowa
    const timerA = useRef(null) // faza A
    const timerB = useRef(null) // faza B
    const utterRef = useRef(null)

    // startowa strona wg preferencji przy każdej karcie
    useEffect(() => {
      if (!has) return
      if (sidePref === 'front') setShowBack(false)
      else if (sidePref === 'back') setShowBack(true)
      else setShowBack(Math.random() < 0.5)
    }, [reviewIdx, sidePref, has])

    // sprzątanie
    useEffect(() => {
      return () => {
        if (timerA.current) clearTimeout(timerA.current)
        if (timerB.current) clearTimeout(timerB.current)
        if (utterRef.current) window.speechSynthesis.cancel()
      }
    }, [])

    const speak = (text) => {
      if (!text) return null
      if (!('speechSynthesis' in window)) return null
      const lang = ttsLang !== 'auto' ? ttsLang : detectLang(text)
      const voice = pickVoice(voices, lang)
      const u = new SpeechSynthesisUtterance(text)
      u.lang = lang
      if (voice) u.voice = voice
      if (utterRef.current) window.speechSynthesis.cancel()
      utterRef.current = u
      window.speechSynthesis.speak(u)
      return u
    }

    // LOGIKA TRYBU AUTO — CIĄGŁA PĘTLA:
    // - faza A (phaseA s): czytaj aktualną stronę
    // - faza B (phaseB s): flip, czytaj drugą stronę
    // - automatycznie przejdź do następnej i znów uruchom A→B, w kółko aż do Stop
    useEffect(() => {
      if (!autoMode || !has) return

      // czyść stare timery
      if (timerA.current) clearTimeout(timerA.current)
      if (timerB.current) clearTimeout(timerB.current)

      // FAZA A — pierwsza strona
      const textA = showBack ? card.back : card.front
      speak(textA)

      timerA.current = setTimeout(() => {
        // FAZA B — flip + druga strona
        const newShowBack = !showBack
        setShowBack(newShowBack)
        const textB = newShowBack ? card.back : card.front
        speak(textB)

        timerB.current = setTimeout(() => {
          // przejście do następnej (ciągła pętla)
          setReviewIdx(i => (i + 1) % filtered.length)
          // efekt odpali się ponownie, bo zależy od reviewIdx/autoMode
        }, Math.max(1, phaseB) * 1000)
      }, Math.max(1, phaseA) * 1000)

      return () => {
        if (timerA.current) clearTimeout(timerA.current)
        if (timerB.current) clearTimeout(timerB.current)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoMode, reviewIdx, filtered, showBack, phaseA, phaseB, ttsLang])

    if (!has) return <p className="text-sm text-gray-500">Brak fiszek do przeglądu.</p>

    const containerClasses =
      `w-full rounded-2xl shadow p-6 min-h-[160px] flex items-center justify-center text-center border 
       ${showBack ? 'bg-sky-50 border-sky-200' : 'bg-emerald-50 border-emerald-200'}`

    const badgeClasses =
      `absolute top-3 right-3 text-xs px-2 py-1 rounded-full border 
       ${showBack ? 'bg-sky-100 border-sky-200 text-sky-800' : 'bg-emerald-100 border-emerald-200 text-emerald-800'}`

    const speakVisible = () => {
      const text = showBack ? card.back : card.front
      speak(text)
    }

    return (
      <div className="mt-6">
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

        <div className="flex flex-wrap gap-2 mt-4 items-center">
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
            className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200"
            onClick={speakVisible}
            title="Przeczytaj aktualnie widoczną stronę"
          >
            Czytaj
          </button>

          {/* Język czytania */}
          <div className="flex items-center gap-2 bg-white rounded-xl border px-3 py-2">
            <span className="text-sm">Język:</span>
            <select
              className="border rounded-lg px-2 py-1 h-9"
              value={ttsLang}
              onChange={(e)=>setTtsLang(e.target.value)}
              title="Wymuś język syntezatora mowy"
            >
              <option value="auto">Auto</option>
              <option value="pl-PL">Polski (pl-PL)</option>
              <option value="en-US">English (en-US)</option>
              <option value="de-DE">Deutsch (de-DE)</option>
              <option value="es-ES">Español (es-ES)</option>
              <option value="fr-FR">Français (fr-FR)</option>
              <option value="it-IT">Italiano (it-IT)</option>
              <option value="pt-PT">Português (pt-PT)</option>
              <option value="tr-TR">Türkçe (tr-TR)</option>
            </select>
          </div>

          <button
            className={`px-3 py-2 rounded-xl ${autoMode ? 'bg-amber-600 text-white hover:bg-amber-500' : 'bg-amber-100 hover:bg-amber-200 text-amber-900'}`}
            onClick={() => {
              window.speechSynthesis?.cancel?.()
              setAutoMode(v => !v)
            }}
            title="Automatyczne pokazywanie, czytanie i przechodzenie dalej (ciągła pętla)"
          >
            {autoMode ? 'Stop (Tryb auto)' : 'Tryb auto'}
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

        {/* Suwaki czasu */}
        <div className="mt-4 grid sm:grid-cols-2 gap-4 bg-white/60 rounded-xl p-3 border">
          <div>
            <label className="text-sm font-medium">Faza 1 — pierwsza strona (sekundy)</label>
            <input
              type="range"
              min={3}
              max={15}
              step={1}
              value={phaseA}
              onChange={(e)=>{ setAutoMode(false); setPhaseA(Number(e.target.value)) }}
              className="w-full"
            />
            <div className="text-xs text-gray-600 mt-1">Aktualnie: {phaseA}s</div>
          </div>
          <div>
            <label className="text-sm font-medium">Faza 2 — druga strona (sekundy)</label>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={phaseB}
              onChange={(e)=>{ setAutoMode(false); setPhaseB(Number(e.target.value)) }}
              className="w-full"
            />
            <div className="text-xs text-gray-600 mt-1">Aktualnie: {phaseB}s</div>
          </div>
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
            <input type="email" required placeholder="twoj@email.pl" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full border rounded-xl px-3 py-2 h-10" />
            <button disabled={loading} className="w-full rounded-xl px-4 h-10 bg-black text-white disabled:opacity-50">
              {loading ? 'Wysyłanie…' : 'Wyślij link'}
            </button>
          </form>

          {/* Owner password */}
          <hr className="my-4" />
          <p className="text-sm font-semibold">Logowanie właściciela (e-mail + hasło)</p>
          <form onSubmit={signInWithPassword} className="mt-2 space-y-2">
            <input type="email" required placeholder="twoj@email.pl" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} className="w-full border rounded-xl px-3 py-2 h-10" />
            <input type="password" required placeholder="Hasło" value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)} className="w-full border rounded-xl px-3 py-2 h-10" />
            <button disabled={loading} className="w-full rounded-xl px-4 h-10 bg-blue-600 text-white disabled:opacity-50">
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
              <select className="border rounded-lg px-2 py-1 h-10" value={showFilter} onChange={(e)=>setShowFilter(e.target.value)}>
                <option value="all">Wszystkie</option>
                <option value="unknown">Niezapamiętane</option>
                <option value="known">Zapamiętane</option>
              </select>
            </div>
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2">
              <span>Najpierw:</span>
              <select className="border rounded-lg px-2 py-1 h-10" value={sidePref} onChange={(e)=>setSidePref(e.target.value)}>
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
                className="px-3 py-1 rounded-lg border hover:bg-gray-50 h-10"
                onClick={() => { setCards(prev => shuffle(prev)); setReviewIdx(0) }}
                title="Przetasuj aktualną listę fiszek"
              >
                Tasuj teraz
              </button>
            </div>
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2">
              <span>Folder:</span>
              <select className="border rounded-lg px-2 py-1 h-10" value={activeFolderId} onChange={(e)=>setActiveFolderId(e.target.value)}>
                {foldersForSelect.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-600 hidden sm:inline">{session.user.email}</span>
              <button onClick={signOut} className="px-3 py-2 h-10 rounded-xl bg-white shadow hover:bg-gray-50">Wyloguj</button>
            </div>
          </div>
        </header>

        {/* Foldery: dodawanie + lista (z usuwaniem) */}
        <section className="mt-6 bg-white rounded-2xl shadow p-4">
          <h2 className="font-semibold mb-3">Foldery</h2>
          <form onSubmit={addFolder} className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <input
              className="flex-1 border rounded-xl px-3 h-10"
              placeholder="Nazwa folderu (np. Angielski B1)"
              value={newFolderName}
              onChange={e=>setNewFolderName(e.target.value)}
            />
            <button className="px-4 h-10 rounded-xl bg-black text-white w-full sm:w-auto">
              Dodaj folder
            </button>
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
              <input className="w-full border rounded-xl px-3 h-10" placeholder="Przód (pytanie)" value={newFront} onChange={e => setNewFront(e.target.value)} />
              <textarea className="w-full border rounded-xl px-3 py-2 min-h-[100px]" placeholder="Tył (odpowiedź)" value={newBack} onChange={e => setNewBack(e.target.value)} />
              <select
                className="w-full border rounded-xl px-3 h-10"
                value={newCardFolderId}
                onChange={e => setNewCardFolderId(e.target.value)}
                required
                title="Wybierz folder dla tej fiszki"
              >
                <option value="" disabled>(WYBIERZ FOLDER — WYMAGANE)</option>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <button className="px-4 h-10 rounded-xl bg-black text-white">Dodaj</button>
            </form>

            {/* Import CSV – WYMAGA WYBORU FOLDERU */}
            <div className="mt-4">
              <label className="text-sm font-medium">Import CSV (Przód, Tył)</label>
              <div className="mt-2 flex flex-col sm:flex-row gap-2 sm:items-center">
                <select
                  className="border rounded-xl px-3 h-10"
                  value={importFolderId}
                  onChange={(e) => setImportFolderId(e.target.value)}
                  required
                  title="Wybierz folder, do którego trafi cały import"
                >
                  <option value="">(WYBIERZ FOLDER DLA IMPORTU — WYMAGANE)</option>
                  {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>

                {/* Stylizowany przycisk do wyboru pliku */}
                <label
                  className={`flex items-center justify-center px-4 h-10 rounded-xl border bg-white cursor-pointer hover:bg-gray-50 w-full sm:w-auto ${!importFolderId ? 'opacity-60 cursor-not-allowed' : ''}`}
                  title={!importFolderId ? 'Najpierw wybierz folder' : 'Wybierz plik CSV'}
                >
                  <span className="text-sm text-gray-700">Wybierz plik</span>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleCSVUpload}
                    className="hidden"
                    disabled={!importFolderId}
                  />
                </label>
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
            <input className="w-full border rounded-xl px-3 h-10 mb-3" placeholder="Szukaj w fiszkach…" value={q} onChange={e => setQ(e.target.value)} />
            <Review
              autoMode={autoMode}
              onStopAuto={() => setAutoMode(false)}
              phaseA={phaseA}
              phaseB={phaseB}
            />
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
                    <button onClick={() => removeCard(card.id)} className="px-3 py-2 h-10 rounded-xl bg-gray-100 hover:bg-gray-200">Usuń</button>
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
