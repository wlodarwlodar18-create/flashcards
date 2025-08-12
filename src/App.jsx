import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import Papa from 'papaparse'
import { motion, AnimatePresence } from 'framer-motion'
import { v4 as uuidv4 } from 'uuid'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY || ''
const ownerEmailEnv = import.meta.env.VITE_OWNER_EMAIL || '' // ← e-mail właściciela (ENV)
const supabase = createClient(supabaseUrl, supabaseAnon)

/* ===== Utils ====== */
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function stripDiacritics(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function detectLang(text) {
  const raw = (text || '').trim()
  if (!raw) return 'en-US'
  if (/[\u0400-\u04FF]/.test(raw)) return 'ru-RU'
  if (/[\u0600-\u06FF]/.test(raw)) return 'ar-SA'
  if (/[\u4E00-\u9FFF]/.test(raw)) return 'zh-CN'
  if (/[\u3040-\u30FF]/.test(raw)) return 'ja-JP'
  if (/[\uAC00-\uD7AF]/.test(raw)) return 'ko-KR'
  if (/[ąćęłńóśźż]/i.test(raw)) return 'pl-PL'
  if (/[äöüß]/i.test(raw)) return 'de-DE'
  if (/[ñáéíóü]/i.test(raw)) return 'es-ES'
  if (/[çâêëïîôûùéèà]/i.test(raw)) return 'fr-FR'
  if (/[àèéìòù]/i.test(raw)) return 'it-IT'
  if (/[ãõçáéíóú]/i.test(raw)) return 'pt-PT'
  if (/[ğüşıçöİ]/i.test(raw)) return 'tr-TR'
  const s = stripDiacritics(raw).toLowerCase()
  const plStop = new Set([
    'i','w','na','do','nie','tak','jest','sa','byc','mam','masz','moze','mozna','ktory','ktora','ktore',
    'zeby','albo','czy','dlaczego','poniewaz','przez','ten','ta','to','te','tam','tutaj','taki','takie',
    'bardziej','mniej','bardzo','troche','jesli','gdy','kiedy','z','za','po','od','bez','dla','przed',
    'jak','co','kto','gdzie','kiedy','dlaczego'
  ])
  const tokens = s.split(/[^a-zA-Z]+/).filter(Boolean)
  let plHits = 0
  for (const t of tokens) if (plStop.has(t)) plHits++
  const digraphs = (s.match(/rz|sz|cz|dz|dzw|ch|nia|owie|ami|ego|emu|ach|cie|osci|owy|owac|anie|enie/gi) || []).length
  if (plHits >= 2 || digraphs >= 2) return 'pl-PL'
  return 'en-US'
}

function pickVoice(voices, lang) {
  if (!voices || !voices.length) return null
  const exact = voices.find(v => v.lang?.toLowerCase() === lang.toLowerCase())
  if (exact) return exact
  const pref = voices.find(v => v.lang?.toLowerCase().startsWith(lang.split('-')[0].toLowerCase()))
  if (pref) return pref
  return voices[0]
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Insert do Supabase z retry + backoff i auto-splitem przy 413
async function insertWithRetry(rows, { maxRetries = 6, baseDelay = 400 } = {}) {
  let attempt = 0
  if (!rows || !rows.length) return
  while (true) {
    try {
      const { error } = await supabase.from('flashcards').insert(rows)
      if (error) {
        if ((error.status === 413 || /payload too large/i.test(error.message || '')) && rows.length > 1) {
          const mid = Math.floor(rows.length / 2)
          await insertWithRetry(rows.slice(0, mid), { maxRetries, baseDelay })
          await insertWithRetry(rows.slice(mid), { maxRetries, baseDelay })
          return
        }
        if (error.status === 429 || (error.status >= 500 && error.status <= 599)) {
          if (attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 200)
            attempt++
            await sleep(delay)
            continue
          }
        }
        throw error
      }
      return
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 200)
        attempt++
        await sleep(delay)
        continue
      }
      throw err
    }
  }
}

/* ===== App ===== */
export default function App() {
  const [session, setSession] = useState(null)

  // routing: 'app' (główny) | 'webrtc' (tajny podgląd)
  const [page, setPage] = useState('app')

  // logowanie
  const [email, setEmail] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // preferencje i filtry
  const [showFilter, setShowFilter] = useState('unknown') // 'all' | 'known' | 'unknown'
  const [sidePref, setSidePref] = useState('front')       // 'front' | 'back' | 'random'
  const [shuffleOnLoad, setShuffleOnLoad] = useState(true)
  const [firstLoad, setFirstLoad] = useState(true)

  // TTS języki
  const [ttsFrontLang, setTtsFrontLang] = useState('auto')
  const [ttsBackLang, setTtsBackLang] = useState('auto')

  // dane
  const [cards, setCards] = useState([])
  const [folders, setFolders] = useState([])
  const [activeFolderId, setActiveFolderId] = useState('ALL')
  const [q, setQ] = useState('')

  // dodawanie fiszki
  const [newFront, setNewFront] = useState('')
  const [newBack, setNewBack] = useState('')
  const [newCardFolderId, setNewCardFolderId] = useState('') // wymagane

  // dodawanie folderu
  const [newFolderName, setNewFolderName] = useState('')

  // import CSV
  const [importFolderId, setImportFolderId] = useState('')
  const [importProgress, setImportProgress] = useState({ running: false, done: 0 })

  // nauka
  const [reviewIdx, setReviewIdx] = useState(0)
  const [autoMode, setAutoMode] = useState(false)
  const [phaseA, setPhaseA] = useState(7) // przód
  const [phaseB, setPhaseB] = useState(3) // tył
  const [suppressAutoTick, setSuppressAutoTick] = useState(0)

  // Web Speech API — głosy
  const [voices, setVoices] = useState([])
  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const load = () => setVoices(window.speechSynthesis.getVoices())
    load()
    window.speechSynthesis.onvoiceschanged = load
    return () => { window.speechSynthesis.onvoiceschanged = null }
  }, [])

  // init
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
      return () => { sub?.subscription?.unsubscribe?.() }
    }
    try {
      const storedSide = localStorage.getItem('sidePref')
      const storedFilter = localStorage.getItem('showFilter')
      const storedShuffle = localStorage.getItem('shuffleOnLoad')
      const storedA = localStorage.getItem('phaseA')
      const storedB = localStorage.getItem('phaseB')
      const storedFront = localStorage.getItem('ttsFrontLang')
      const storedBack = localStorage.getItem('ttsBackLang')
      if (storedSide) setSidePref(storedSide)
      if (storedFilter) setShowFilter(storedFilter)
      if (storedShuffle !== null) setShuffleOnLoad(storedShuffle === 'true')
      if (storedA) setPhaseA(Math.min(15, Math.max(1, Number(storedA) || 7)))
      if (storedB) setPhaseB(Math.min(15, Math.max(1, Number(storedB) || 3)))
      if (storedFront) setTtsFrontLang(storedFront)
      if (storedBack)  setTtsBackLang(storedBack)
    } catch {}
    const cleanup = init()
    return () => { typeof cleanup === 'function' && cleanup() }
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
      localStorage.setItem('ttsFrontLang', ttsFrontLang)
      localStorage.setItem('ttsBackLang', ttsBackLang)
    } catch {}
  }, [sidePref, showFilter, shuffleOnLoad, phaseA, phaseB, ttsFrontLang, ttsBackLang])

  /* ===== API ===== */
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
    setSuppressAutoTick(t => t + 1)
    const { error } = await supabase
      .from('flashcards')
      .update({ known: next })
      .eq('id', card.id)
      .eq('user_id', session.user.id)
    if (error) {
      setError(error.message)
      setCards(prev => prev.map(c => c.id === card.id ? { ...c, known: card.known } : c))
      setSuppressAutoTick(t => t + 1)
    }
  }

  /* ===== Logowanie ===== */
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

  /* ===== Import CSV — autowykrywanie separatora, CHUNK=10 ===== */
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

    const CHUNK = 10
    const DELAY_MS = 200
    let processed = 0

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

    const runParse = (delimiterOrAuto) => new Promise((resolve, reject) => {
      const flusher = flushFactory()
      let parserAborted = false

      const stepHandler = (results, parser) => {
        const raw = results.data || {}
        const r = {}
        for (const k of Object.keys(raw)) r[(k || '').trim()] = raw[k]

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
        worker: false,
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

      if (delimiterOrAuto === 'auto') {
        Papa.parse(file, baseConfig) // auto-detect
      } else {
        Papa.parse(file, { ...baseConfig, delimiter: delimiterOrAuto })
      }
    })

    try {
      const tryOrder = ['auto', ';', ',', '\t']
      for (const delim of tryOrder) {
        const prev = processed
        await runParse(delim)
        if (processed > prev) break
      }

      if (processed === 0) {
        throw new Error(
          'Nie rozpoznano żadnych rekordów. Sprawdź: nagłówki „Przód”/„Tył” (lub front/back) i separator (przecinek/średnik/tab).'
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
        '• Jeśli to Excel PL – zwykle separator to średnik (;). Google Sheets – zwykle przecinek (,).\n'
      )
    } finally {
      setLoading(false)
      setImportProgress({ running: false, done: processed })
      e.target.value = ''
    }
  }

  /* ===== Filtrowanie ===== */
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

  /* ===== Tryb nauki (karta + auto) ===== */
  function Review({ autoMode, phaseA, phaseB, ttsFrontLang, ttsBackLang, suppressAutoTick }) {
    const has = filtered.length > 0
    const safeLen = Math.max(1, filtered.length)
    const card = filtered[reviewIdx % safeLen]
    const [showBack, setShowBack] = useState(false)

    const timerA = useRef(null)
    const timerB = useRef(null)
    const utterRef = useRef(null)
    const nextBtnRef = useRef(null)
    const runIdRef = useRef(0)
    const lastSuppressRef = useRef(suppressAutoTick)

    useEffect(() => {
      if (!has) return
      if (sidePref === 'front') setShowBack(false)
      else if (sidePref === 'back') setShowBack(true)
      else setShowBack(Math.random() < 0.5)
    }, [reviewIdx, sidePref, has])

    useEffect(() => {
      return () => {
        if (timerA.current) clearTimeout(timerA.current)
        if (timerB.current) clearTimeout(timerB.current)
        timerA.current = null
        timerB.current = null
        window.speechSynthesis?.cancel?.()
        utterRef.current = null
      }
    }, [])

    const speak = (text, isBack) => {
      if (!text || !('speechSynthesis' in window)) return null
      const forced = isBack ? ttsBackLang : ttsFrontLang
      const lang = forced !== 'auto' ? forced : detectLang(text)
      const voice = pickVoice(voices, lang)
      const u = new SpeechSynthesisUtterance(text)
      u.lang = lang
      if (voice) u.voice = voice
      if (utterRef.current) window.speechSynthesis.cancel()
      utterRef.current = u
      window.speechSynthesis.speak(u)
      return u
    }

    const stopAll = () => {
      if (timerA.current) clearTimeout(timerA.current)
      if (timerB.current) clearTimeout(timerB.current)
      timerA.current = null
      timerB.current = null
      window.speechSynthesis?.cancel?.()
      utterRef.current = null
    }

    const gotoNextNow = () => {
      stopAll()
      setReviewIdx(i => (i + 1) % filtered.length)
    }

    useEffect(() => {
      if (!autoMode || !has) return
      if (lastSuppressRef.current !== suppressAutoTick) {
        lastSuppressRef.current = suppressAutoTick
        return
      }
      stopAll()
      const myRunId = ++runIdRef.current

      const startBack =
        sidePref === 'front' ? false :
        sidePref === 'back'  ? true  :
        Math.random() < 0.5

      setShowBack(startBack)

      const textA = startBack ? card.back : card.front
      speak(textA, startBack)

      timerA.current = setTimeout(() => {
        if (runIdRef.current !== myRunId) return
        const flippedBack = !startBack
        setShowBack(flippedBack)
        const textB = flippedBack ? card.back : card.front
        speak(textB, flippedBack)

        timerB.current = setTimeout(() => {
          if (runIdRef.current !== myRunId) return
          if (nextBtnRef.current) nextBtnRef.current.click()
          else gotoNextNow()
        }, Math.max(1, phaseB) * 1000)
      }, Math.max(1, phaseA) * 1000)

      return () => stopAll()
    }, [autoMode, reviewIdx, filtered, phaseA, phaseB, ttsFrontLang, ttsBackLang, has, sidePref, suppressAutoTick])

    if (!has) return <p className="text-sm text-gray-500">Brak fiszek do przeglądu.</p>

    const containerClasses =
      `w-full rounded-2xl shadow p-5 sm:p-6 min-h-[150px] sm:min-h-[160px] flex items-center justify-center text-center border 
       ${showBack ? 'bg-sky-50 border-sky-200' : 'bg-emerald-50 border-emerald-200'}`

    const badgeClasses =
      `absolute top-2 sm:top-3 right-2 sm:right-3 text-xs px-2 py-1 rounded-full border 
       ${showBack ? 'bg-sky-100 border-sky-200 text-sky-800' : 'bg-emerald-100 border-emerald-200 text-emerald-800'}`

    const speakVisible = () => {
      const isBackSide = showBack
      const text = isBackSide ? card.back : card.front
      speak(text, isBackSide)
    }

    return (
      <div className="mt-4 sm:mt-6">
        <div
          className={`${containerClasses} relative cursor-pointer`}
          onClick={() => setShowBack(s => !s)}
          title="Kliknij, aby przełączyć front/back"
        >
          <span className={badgeClasses}>{showBack ? 'Tył' : 'Przód'}</span>
          <div className="text-lg sm:text-xl leading-relaxed max-w-[95%]">
            {showBack ? card.back : card.front}
          </div>
        </div>

        <div className="mt-3 sm:mt-4 grid grid-cols-2 sm:flex sm:flex-wrap gap-2 sm:gap-3 items-center">
          <button
            ref={nextBtnRef}
            className="px-3 py-2 h-10 rounded-xl bg-gray-100 hover:bg-gray-200"
            onClick={gotoNextNow}
            title="Przerwij i przejdź do następnej"
          >
            Następna
          </button>
          <button
            className="px-3 py-2 h-10 rounded-xl bg-gray-100 hover:bg-gray-200"
            onClick={() => setShowBack(s => !s)}
          >
            Pokaż
          </button>
          <button
            className="px-3 py-2 h-10 rounded-xl bg-gray-100 hover:bg-gray-200"
            onClick={speakVisible}
            title="Przeczytaj aktualnie widoczną stronę"
          >
            Czytaj
          </button>
          <button
            className={`px-3 py-2 h-10 rounded-xl ${autoMode ? 'bg-amber-600 text-white hover:bg-amber-500' : 'bg-amber-100 hover:bg-amber-200 text-amber-900'}`}
            onClick={() => {
              window.speechSynthesis?.cancel?.()
              setAutoMode(v => !v)
            }}
            title="Automatyczne pokazywanie, czytanie i przechodzenie dalej (ciągła pętla)"
          >
            {autoMode ? 'Stop (Tryb auto)' : 'Tryb auto'}
          </button>
          <button
            className={`px-3 py-2 h-10 rounded-xl ${card.known ? 'bg-emerald-600 text-white' : 'bg-gray-200 text-black hover:bg-gray-300'}`}
            onClick={() => toggleKnown(card)}
            title="Przełącz status zapamiętania tej fiszki"
          >
            Zapamiętane
          </button>
        </div>

        <div className="mt-4 grid sm:grid-cols-2 gap-4 bg-white/60 rounded-xl p-3 border">
          <div>
            <label className="text-sm font-medium">Przód (sekundy)</label>
            <input
              type="range"
              min={1}
              max={15}
              step={1}
              value={phaseA}
              onChange={(e)=>{ setAutoMode(false); setPhaseA(Number(e.target.value)) }}
              className="w-full"
            />
            <div className="text-xs text-gray-600 mt-1">Aktualnie: {phaseA}s</div>
          </div>
          <div>
            <label className="text-sm font-medium">Tył (sekundy)</label>
            <input
              type="range"
              min={1}
              max={15}
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

  /* ===== Niezalogowany widok ===== */
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

  /* ===== Tajna strona WebRTC ===== */
  if (page === 'webrtc') {
    return <SecretWebRTCPage onBack={() => setPage('app')} />
  }

  /* ===== Główny widok aplikacji ===== */
  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 p-4">
      <div className="max-w-6xl mx-auto">
        {/* Header — responsywna siatka kontrolek */}
        <header className="flex flex-col gap-3">
          <h1 className="text-2xl font-bold">Twoje fiszki</h1>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {/* Pokaż */}
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2">
              <span className="whitespace-nowrap">Pokaż:</span>
              <select className="border rounded-lg px-2 py-1 h-10 w-full" value={showFilter} onChange={(e)=>setShowFilter(e.target.value)}>
                <option value="all">Wszystkie</option>
                <option value="unknown">Niezapamiętane</option>
                <option value="known">Zapamiętane</option>
              </select>
            </div>

            {/* Najpierw */}
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2">
              <span className="whitespace-nowrap">Najpierw:</span>
              <select className="border rounded-lg px-2 py-1 h-10 w-full" value={sidePref} onChange={(e)=>setSidePref(e.target.value)}>
                <option value="front">Przód</option>
                <option value="back">Tył</option>
                <option value="random">Losowo</option>
              </select>
            </div>

            {/* Losowanie */}
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={shuffleOnLoad} onChange={(e)=>setShuffleOnLoad(e.target.checked)} />
                <span className="whitespace-nowrap">Losuj przy starcie</span>
              </label>
              <button
                type="button"
                className="px-3 py-1 h-10 rounded-lg border hover:bg-gray-50 shrink-0"
                onClick={() => { setCards(prev => shuffle(prev)); setReviewIdx(0) }}
                title="Przetasuj aktualną listę fiszek"
              >
                Tasuj teraz
              </button>
            </div>

            {/* Folder */}
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2 sm:col-span-2 lg:col-span-1">
              <span className="whitespace-nowrap">Folder:</span>
              <select className="border rounded-lg px-2 py-1 h-10 w-full" value={activeFolderId} onChange={(e)=>setActiveFolderId(e.target.value)}>
                {foldersForSelect.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>

            {/* User + Wyloguj + Tajny podgląd (tylko właściciel) */}
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center justify-between gap-2 sm:col-span-2 lg:col-span-1">
              <span className="text-gray-600 truncate">{session.user.email}</span>
              <div className="flex items-center gap-2">
                {ownerEmailEnv && session.user.email === ownerEmailEnv && (
                  <button
                    onClick={() => setPage('webrtc')}
                    className="px-3 py-2 h-10 rounded-xl bg-purple-600 text-white hover:bg-purple-500"
                    title="Tajny podgląd kamery (tylko właściciel)"
                  >
                    Podgląd kamery
                  </button>
                )}
                <button onClick={signOut} className="px-3 py-2 h-10 rounded-xl bg-gray-100 hover:bg-gray-200 shrink-0">Wyloguj</button>
              </div>
            </div>
          </div>
        </header>

        {/* Foldery */}
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

          <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-sm">
            {folders.map(f => (
              <li key={f.id} className={`flex items-center justify-between px-3 py-2 rounded-xl border ${activeFolderId===f.id?'bg-black text-white':'bg-gray-50'}`}>
                <button
                  className="text-left truncate flex-1"
                  title="Pokaż tylko ten folder"
                  onClick={() => setActiveFolderId(f.id)}
                >
                  {f.name}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    className={`px-2 py-1 h-9 rounded-lg border ${activeFolderId===f.id ? 'bg-white/10' : 'hover:bg-white'}`}
                    onClick={() => deleteFolder(f.id, f.name)}
                    title="Usuń folder (fiszki w środku też zostaną usunięte)"
                  >
                    Usuń
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-6 grid md:grid-cols-2 gap-4">
          {/* Dodawanie fiszki */}
          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Dodaj fiszkę</h2>
            <form onSubmit={handleAddCard} className="space-y-2">
              <input
                className="w-full border rounded-xl px-3 h-10"
                placeholder="Przód (pytanie)"
                value={newFront}
                onChange={e => setNewFront(e.target.value)}
              />
              <input
                type="text"
                className="w-full border rounded-xl px-3 h-10"
                placeholder="Tył (odpowiedź)"
                value={newBack}
                onChange={e => setNewBack(e.target.value)}
              />
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

              <div className="mt-2 flex flex-col lg:flex-row gap-2 lg:items-center">
                <select
                  className="border rounded-xl px-3 h-10 w-full lg:w-auto"
                  value={importFolderId}
                  onChange={(e) => setImportFolderId(e.target.value)}
                  required
                  title="Wybierz folder, do którego trafi cały import"
                >
                  <option value="">(WYBIERZ FOLDER DLA IMPORTU — WYMAGANE)</option>
                  {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>

                <label
                  className={`inline-flex items-center justify-center gap-2 px-4 h-10 rounded-xl border bg-white cursor-pointer hover:bg-gray-50 whitespace-nowrap shrink-0 w-full lg:w-auto ${!importFolderId ? 'opacity-60 cursor-not-allowed' : ''}`}
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

              <p className="text-xs text-gray-500 mt-2">
                Oczekiwane nagłówki: <code>Przód</code>, <code>Tył</code>. Separator: przecinek/średnik — wykrywane automatycznie.
              </p>

              {importProgress.running && (
                <div className="mt-3">
                  <div className="text-xs text-gray-700 mb-1">
                    Zaimportowano: {importProgress.done} rekordów…
                  </div>
                  <div className="w-full h-2 bg-gray-200 rounded overflow-hidden">
                    <div className="h-2 bg-emerald-500 animate-pulse w-1/2" />
                  </div>
                </div>
              )}
            </div>

            {/* Języki czytania */}
            <div className="mt-5 bg-white rounded-xl border p-3">
              <p className="text-sm font-medium mb-2">Czytanie na głos — język</p>
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="flex items-center justify-between gap-2">
                  <span className="text-sm">Przód:</span>
                  <select
                    className="border rounded-lg px-2 py-1 h-10"
                    value={ttsFrontLang}
                    onChange={(e)=>setTtsFrontLang(e.target.value)}
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
                </label>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-sm">Tył:</span>
                  <select
                    className="border rounded-lg px-2 py-1 h-10"
                    value={ttsBackLang}
                    onChange={(e)=>setTtsBackLang(e.target.value)}
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
                </label>
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
              phaseA={phaseA}
              phaseB={phaseB}
              ttsFrontLang={ttsFrontLang}
              ttsBackLang={ttsBackLang}
              suppressAutoTick={suppressAutoTick}
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
                  <div className="flex-1 min-w-0">
                    <p className="font-medium break-words">{card.front}</p>
                    <p className="text-sm text-gray-600 mt-1 break-words">{card.back}</p>
                    <p className="text-xs text-gray-500 mt-1">{card.known ? '✅ Zapamiętana' : '🕑 Do nauki'}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
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

/* ========= Tajna strona WebRTC ========= */
function SecretWebRTCPage({ onBack }) {
  const [roomId, setRoomId] = useState('')
  const [status, setStatus] = useState('idle') // 'idle' | 'casting' | 'viewing'
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const pcRef = useRef(null)
  const channelRef = useRef(null)
  const localStreamRef = useRef(null)

  useEffect(() => {
    return () => {
      try { channelRef.current?.unsubscribe?.() } catch {}
      try {
        if (pcRef.current) {
          pcRef.current.ontrack = null
          pcRef.current.onicecandidate = null
          pcRef.current.close()
        }
      } catch {}
      try { localStreamRef.current?.getTracks()?.forEach(t => t.stop()) } catch {}
    }
  }, [])

  function createPeer() {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478?transport=udp' },
      ],
    })
    return pc
  }

  async function joinChannel(id) {
    const ch = supabase.channel(`webrtc-${id}`)
    ch.on('broadcast', { event: 'signal' }, async ({ payload }) => {
      const { type, data } = payload || {}
      if (!pcRef.current) return

      if (type === 'offer' && status === 'viewing') {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(data))
        const answer = await pcRef.current.createAnswer()
        await pcRef.current.setLocalDescription(answer)
        await ch.send({ type: 'broadcast', event: 'signal', payload: { type: 'answer', data: answer } })
      }

      if (type === 'answer' && status === 'casting') {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(data))
      }

      if (type === 'ice') {
        try { await pcRef.current.addIceCandidate(data) } catch {}
      }
    })

    await ch.subscribe()
    channelRef.current = ch
    return ch
  }

  async function startCasting() {
    if (!roomId.trim()) { alert('Podaj kod pokoju.'); return }
    setStatus('casting')
    const ch = await joinChannel(roomId.trim())

    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    localStreamRef.current = stream
    if (localVideoRef.current) localVideoRef.current.srcObject = stream

    const pc = createPeer()
    stream.getTracks().forEach(tr => pc.addTrack(tr, stream))
    pc.onicecandidate = async (e) => {
      if (e.candidate) await ch.send({ type: 'broadcast', event: 'signal', payload: { type: 'ice', data: e.candidate } })
    }
    pcRef.current = pc

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await ch.send({ type: 'broadcast', event: 'signal', payload: { type: 'offer', data: offer } })
  }

  async function startViewing() {
    if (!roomId.trim()) { alert('Podaj kod pokoju.'); return }
    setStatus('viewing')
    const ch = await joinChannel(roomId.trim())

    const pc = createPeer()
    pc.onicecandidate = async (e) => {
      if (e.candidate) await ch.send({ type: 'broadcast', event: 'signal', payload: { type: 'ice', data: e.candidate } })
    }
    pc.ontrack = (e) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0]
    }
    pcRef.current = pc
    // Viewer czeka na ofertę nadawcy (obsługiwane w on('signal'))
  }

  function stopAll() {
    setStatus('idle')
    try { channelRef.current?.unsubscribe?.() } catch {}
    try {
      if (pcRef.current) {
        pcRef.current.ontrack = null
        pcRef.current.onicecandidate = null
        pcRef.current.close()
      }
    } catch {}
    try { localStreamRef.current?.getTracks()?.forEach(t => t.stop()) } catch {}
    channelRef.current = null
    pcRef.current = null
    localStreamRef.current = null
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 p-4">
      <div className="max-w-3xl mx-auto">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Tajny podgląd kamery</h1>
          <button onClick={() => { stopAll(); onBack(); }} className="px-3 py-2 rounded-xl bg-gray-200 hover:bg-gray-300">← Wróć</button>
        </header>

        <section className="mt-4 bg-white rounded-2xl shadow p-4">
          <p className="text-sm text-gray-600">
            Wejdź na tej samej stronie na telefonie i na komputerze, wpisz ten sam <b>kod pokoju</b>. Na telefonie kliknij <b>Nadaj obraz</b>, na komputerze – <b>Podgląd</b>.
          </p>

          <div className="mt-3 flex flex-col sm:flex-row gap-2 sm:items-center">
            <input
              className="border rounded-xl px-3 h-10 flex-1"
              placeholder="Kod pokoju (np. pokoj-1)"
              value={roomId}
              onChange={(e)=>setRoomId(e.target.value)}
            />
            <button
              className={`px-4 h-10 rounded-xl ${status==='casting'?'bg-purple-600 text-white':'bg-purple-100 hover:bg-purple-200'}`}
              onClick={startCasting}
            >
              Nadaj obraz (telefon)
            </button>
            <button
              className={`px-4 h-10 rounded-xl ${status==='viewing'?'bg-green-600 text-white':'bg-green-100 hover:bg-green-200'}`}
              onClick={startViewing}
            >
              Podgląd (ten sprzęt)
            </button>
            <button className="px-4 h-10 rounded-xl bg-gray-100 hover:bg-gray-200" onClick={stopAll}>Stop</button>
          </div>

          <div className="grid sm:grid-cols-2 gap-4 mt-4">
            <div>
              <p className="text-sm font-medium mb-1">Podgląd lokalny (nadawca)</p>
              <video ref={localVideoRef} autoPlay playsInline muted className="w-full rounded-xl bg-black aspect-video" />
            </div>
            <div>
              <p className="text-sm font-medium mb-1">Zdalny obraz (odbiorca)</p>
              <video ref={remoteVideoRef} autoPlay playsInline className="w-full rounded-xl bg-black aspect-video" />
            </div>
          </div>
        </section>

        <p className="text-xs text-gray-500 mt-3">
          Uwaga: to połączenie używa WebRTC z sygnalizacją przez Supabase Realtime. W różnych sieciach/NAT może być potrzebny serwer TURN.
        </p>
      </div>
    </main>
  )
}
