import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import Papa from 'papaparse'
import { v4 as uuidv4 } from 'uuid'

/* ======================= CONFIG ======================= */
/* Supabase */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY || ''
const ownerEmailEnv = import.meta.env.VITE_OWNER_EMAIL || ''
const supabase = createClient(supabaseUrl, supabaseAnon)

/* Metered (TURN/STUN) */
const METERED_DOMAIN =
  import.meta.env.VITE_METERED_DOMAIN || 'kw-24.metered.live'
const METERED_API_KEY =
  import.meta.env.VITE_METERED_API_KEY || 'PASTE_YOUR_API_KEY'

/* ======================= UTILS ======================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
async function insertWithRetry(rows, { maxRetries = 6, baseDelay = 400 } = {}) {
  if (!rows?.length) return
  let attempt = 0
  while (true) {
    try {
      const { error } = await supabase.from('flashcards').insert(rows)
      if (!error) return
      if ((error.status === 413 || /payload too large/i.test(error.message || '')) && rows.length > 1) {
        const mid = Math.floor(rows.length / 2)
        await insertWithRetry(rows.slice(0, mid), { maxRetries, baseDelay })
        await insertWithRetry(rows.slice(mid), { maxRetries, baseDelay })
        return
      }
      if (error.status === 429 || (error.status >= 500 && error.status <= 599)) {
        if (attempt < maxRetries) {
          const wait = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 200)
          attempt++
          await sleep(wait)
          continue
        }
      }
      throw error
    } catch (err) {
      if (attempt < maxRetries) {
        const wait = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 200)
        attempt++
        await sleep(wait)
        continue
      }
      throw err
    }
  }
}

/* ======================= APP ======================= */
export default function App() {
  const [session, setSession] = useState(null)
  const [page, setPage] = useState('app') // 'app' | 'webrtc'

  // logowanie
  const [email, setEmail] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // dane
  const [folders, setFolders] = useState([])
  const [cards, setCards] = useState([])

  // filtry
  const [activeFolderId, setActiveFolderId] = useState('ALL')
  const [showFilter, setShowFilter] = useState('unknown') // 'all' | 'known' | 'unknown'
  const [sidePref, setSidePref] = useState('front') // 'front' | 'back' | 'random'
  const [shuffleOnLoad, setShuffleOnLoad] = useState(true)
  const [q, setQ] = useState('')

  // dodawanie
  const [newFront, setNewFront] = useState('')
  const [newBack, setNewBack] = useState('')
  const [newCardFolderId, setNewCardFolderId] = useState('')
  const [newFolderName, setNewFolderName] = useState('')

  // import
  const [importFolderId, setImportFolderId] = useState('')
  const [importProgress, setImportProgress] = useState({ running: false, done: 0 })

  // nauka
  const [reviewIdx, setReviewIdx] = useState(0)
  const [autoMode, setAutoMode] = useState(false)
  const [phaseA, setPhaseA] = useState(7) // przód
  const [phaseB, setPhaseB] = useState(3) // tył
  const [suppressAutoTick, setSuppressAutoTick] = useState(0)

  /* init */
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
      return () => sub?.subscription?.unsubscribe?.()
    }
    try {
      const s1 = localStorage.getItem('sidePref'); if (s1) setSidePref(s1)
      const s2 = localStorage.getItem('showFilter'); if (s2) setShowFilter(s2)
      const s3 = localStorage.getItem('shuffleOnLoad'); if (s3 !== null) setShuffleOnLoad(s3 === 'true')
      const a = Number(localStorage.getItem('phaseA')); if (a) setPhaseA(Math.min(15, Math.max(1, a)))
      const b = Number(localStorage.getItem('phaseB')); if (b) setPhaseB(Math.min(15, Math.max(1, b)))
    } catch {}
    const cleanup = init()
    return () => { typeof cleanup === 'function' && cleanup() }
  }, [])

  useEffect(() => { if (session) fetchFolders().then(fetchCards) }, [session])

  useEffect(() => {
    try {
      localStorage.setItem('sidePref', sidePref)
      localStorage.setItem('showFilter', showFilter)
      localStorage.setItem('shuffleOnLoad', String(shuffleOnLoad))
      localStorage.setItem('phaseA', String(phaseA))
      localStorage.setItem('phaseB', String(phaseB))
    } catch {}
  }, [sidePref, showFilter, shuffleOnLoad, phaseA, phaseB])

  /* API */
  async function fetchFolders() {
    setError('')
    const { data, error } = await supabase
      .from('folders').select('id,name,created_at')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setFolders(data || [])
  }
  async function fetchCards() {
    setLoading(true); setError('')
    const { data, error } = await supabase
      .from('flashcards')
      .select('id,front,back,known,folder_id,created_at')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else {
      let list = data || []
      if (shuffleOnLoad) list = shuffle(list)
      setCards(list); setReviewIdx(0)
    }
    setLoading(false)
  }
  async function addFolder(e) {
    e.preventDefault()
    if (!newFolderName.trim()) return
    const payload = { id: uuidv4(), user_id: session.user.id, name: newFolderName.trim() }
    const { error } = await supabase.from('folders').insert(payload)
    if (error) { setError(error.message); return }
    setNewFolderName(''); fetchFolders()
  }
  async function deleteFolder(id, name) {
    if (!window.confirm(`Usunąć folder „${name}”? Fiszki w nim też zostaną usunięte.`)) return
    const { error } = await supabase.from('folders').delete().eq('id', id).eq('user_id', session.user.id)
    if (error) setError(error.message); else { fetchFolders(); fetchCards() }
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
    const { error } = await supabase.from('flashcards').delete().eq('id', id).eq('user_id', session.user.id)
    if (error) setError(error.message)
    else setCards(prev => prev.filter(c => c.id !== id))
  }
  async function toggleKnown(card) {
    const next = !card.known
    setCards(prev => prev.map(c => c.id === card.id ? { ...c, known: next } : c))
    setSuppressAutoTick(t => t + 1)
    const { error } = await supabase.from('flashcards').update({ known: next }).eq('id', card.id).eq('user_id', session.user.id)
    if (error) {
      setError(error.message)
      setCards(prev => prev.map(c => c.id === card.id ? { ...c, known: card.known } : c))
      setSuppressAutoTick(t => t + 1)
    }
  }

  /* Logowanie */
  async function signInWithEmail(e) {
    e.preventDefault()
    setLoading(true); setError('')
    const { error } = await supabase.auth.signInWithOtp({
      email, options: { emailRedirectTo: window.location.origin }
    })
    setLoading(false)
    if (error) setError(error.message)
    else alert('Sprawdź skrzynkę – wysłałem link do logowania.')
  }
  async function signInWithPassword(e) {
    e.preventDefault()
    setLoading(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({
      email: ownerEmail, password: ownerPassword
    })
    setLoading(false)
    if (error) setError(error.message)
  }
  async function signOut() {
    await supabase.auth.signOut()
    setCards([]); setFolders([])
  }

  /* Import CSV (Przód, Tył) — wymaga wybranego folderu */
  async function handleCSVUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!importFolderId) { setError('Wybierz folder do importu.'); alert('Najpierw wybierz folder.'); e.target.value=''; return }

    setLoading(true); setError(''); setImportProgress({ running: true, done: 0 })
    const CHUNK = 10, DELAY_MS = 200
    let processed = 0
    const flushFactory = () => {
      let batch = []
      return {
        push(r){ batch.push(r) },
        size(){ return batch.length },
        async flush(){
          if (!batch.length) return
          const toSend = batch; batch=[]
          await insertWithRetry(toSend, { maxRetries: 6, baseDelay: 400 })
          processed += toSend.length
          setImportProgress({ running: true, done: processed })
          await sleep(DELAY_MS)
        }
      }
    }
    const runParse = (delim) => new Promise((resolve,reject)=>{
      const flusher = flushFactory(); let aborted=false
      const stepHandler = (results, parser) => {
        const raw = results.data || {}
        const rec = {}
        for (const k of Object.keys(raw)) rec[(k||'').trim()] = raw[k]
        const front = (rec['Przód'] ?? rec['Przod'] ?? rec['front'] ?? rec['Front'] ?? '').toString().trim()
        const back  = (rec['Tył']   ?? rec['Tyl']   ?? rec['back']  ?? rec['Back']  ?? '').toString().trim()
        if (front && back) {
          flusher.push({
            id: uuidv4(), user_id: session.user.id,
            front, back, known: String(rec.known||'').toLowerCase()==='true',
            folder_id: importFolderId
          })
        }
        if (flusher.size() >= CHUNK) {
          parser.pause()
          Promise.resolve().then(async ()=>{
            try { await flusher.flush(); parser.resume() }
            catch(err){ aborted=true; parser.abort(); reject(err) }
          })
        }
      }
      const base = {
        header:true, skipEmptyLines:'greedy', step:stepHandler,
        complete: async()=>{ if (aborted) return; try{ await flusher.flush(); resolve(null) } catch(e){ reject(e) } },
        error: (err)=>reject(err)
      }
      if (delim==='auto') Papa.parse(file, base)
      else Papa.parse(file, { ...base, delimiter: delim })
    })

    try {
      for (const d of ['auto','; ',',','\t']) {
        const prev = processed; await runParse(d); if (processed>prev) break
      }
      if (processed===0) throw new Error('Nie wykryto rekordów. Nagłówki: „Przód”, „Tył”.')
      await fetchCards()
      alert(`Zaimportowano ${processed} fiszek.`)
    } catch (err) {
      console.error(err)
      setError(err.message || 'Import nie powiódł się.')
      alert('Import przerwany: ' + (err.message || 'błąd nieznany'))
    } finally {
      setLoading(false); setImportProgress({ running:false, done: processed }); e.target.value=''
    }
  }

  /* Filtrowanie */
  const foldersForSelect = useMemo(() => [{ id:'ALL', name:'Wszystkie' }, ...folders], [folders])
  const filtered = useMemo(() => {
    let arr = cards
    if (activeFolderId !== 'ALL') arr = arr.filter(c => (c.folder_id||null) === activeFolderId)
    if (showFilter==='known') arr = arr.filter(c => c.known)
    if (showFilter==='unknown') arr = arr.filter(c => !c.known)
    const k = q.trim().toLowerCase()
    if (k) arr = arr.filter(c => c.front.toLowerCase().includes(k) || c.back.toLowerCase().includes(k))
    return arr
  }, [cards, activeFolderId, showFilter, q])

  /* Tryb nauki (bez animacji) */
  function Review() {
    const has = filtered.length > 0
    const safeLen = Math.max(1, filtered.length)
    const card = filtered[reviewIdx % safeLen]
    const [showBack, setShowBack] = useState(false)
    useEffect(() => {
      if (!has) return
      if (sidePref==='front') setShowBack(false)
      else if (sidePref==='back') setShowBack(true)
      else setShowBack(Math.random()<0.5)
    }, [reviewIdx, sidePref, has])

    const timerA = useRef(null), timerB = useRef(null), utterRef = useRef(null), nextBtnRef = useRef(null)
    const runIdRef = useRef(0); const lastSupRef = useRef(suppressAutoTick)
    const speak = (t)=>{ if(!t||!('speechSynthesis'in window))return; const u=new SpeechSynthesisUtterance(t); window.speechSynthesis.cancel(); utterRef.current=u; window.speechSynthesis.speak(u) }
    const stopAll = ()=>{ if(timerA.current)clearTimeout(timerA.current); if(timerB.current)clearTimeout(timerB.current); timerA.current=null; timerB.current=null; window.speechSynthesis?.cancel?.(); utterRef.current=null }
    const nextNow = ()=>{ stopAll(); setReviewIdx(i => (i+1)%filtered.length) }

    useEffect(()=>{
      if(!autoMode||!has) return
      if(lastSupRef.current!==suppressAutoTick){ lastSupRef.current=suppressAutoTick; return }
      stopAll(); const myRun=++runIdRef.current
      const startBack = sidePref==='front'?false: sidePref==='back'?true: Math.random()<0.5
      setShowBack(startBack); speak(startBack?card.back:card.front)
      timerA.current=setTimeout(()=>{
        if(runIdRef.current!==myRun) return
        const flipped=!startBack; setShowBack(flipped); speak(flipped?card.back:card.front)
        timerB.current=setTimeout(()=>{
          if(runIdRef.current!==myRun) return
          if(nextBtnRef.current) nextBtnRef.current.click(); else nextNow()
        }, Math.max(1,phaseB)*1000)
      }, Math.max(1,phaseA)*1000)
      return ()=>stopAll()
    },[autoMode,reviewIdx,filtered,phaseA,phaseB,has,sidePref,suppressAutoTick])

    if (!has) return <p className="text-sm text-gray-500">Brak fiszek do przeglądu.</p>

    const cardBg = showBack ? 'bg-sky-50 border-sky-200' : 'bg-emerald-50 border-emerald-200'
    const badgeBg = showBack ? 'bg-sky-100 border-sky-200 text-sky-800' : 'bg-emerald-100 border-emerald-200 text-emerald-800'

    return (
      <div className="mt-4">
        <div
          className={`w-full rounded-2xl shadow p-5 min-h-[150px] flex items-center justify-center text-center border relative ${cardBg}`}
          onClick={() => setShowBack(s=>!s)}
          title="Kliknij, aby przełączyć front/back"
        >
          <span className={`absolute top-2 right-2 text-xs px-2 py-1 rounded-full border ${badgeBg}`}>{showBack?'Tył':'Przód'}</span>
          <div className="text-lg leading-relaxed max-w-[95%] break-words">
            {showBack ? card.back : card.front}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 sm:flex sm:flex-wrap gap-2 items-center">
          <button ref={nextBtnRef} className="px-3 py-2 h-10 rounded-xl bg-gray-100 hover:bg-gray-200" onClick={()=>setReviewIdx(i=>(i+1)%filtered.length)}>Następna</button>
          <button className="px-3 py-2 h-10 rounded-xl bg-gray-100 hover:bg-gray-200" onClick={()=>setShowBack(s=>!s)}>Pokaż</button>
          <button className={`px-3 py-2 h-10 rounded-xl ${autoMode?'bg-amber-600 text-white hover:bg-amber-500':'bg-amber-100 hover:bg-amber-200 text-amber-900'}`} onClick={()=>{window.speechSynthesis?.cancel?.(); setAutoMode(v=>!v)}}>
            {autoMode?'Stop (Tryb auto)':'Tryb auto'}
          </button>
          <button className={`px-3 py-2 h-10 rounded-xl ${card.known?'bg-emerald-600 text-white':'bg-gray-200 text-black hover:bg-gray-300'}`} onClick={()=>toggleKnown(card)}>
            Zapamiętane
          </button>
        </div>

        <div className="mt-4 grid sm:grid-cols-2 gap-4 bg-white/60 rounded-xl p-3 border">
          <div>
            <label className="text-sm font-medium">Przód (sekundy)</label>
            <input type="range" min={1} max={15} step={1} value={phaseA} onChange={(e)=>{ setAutoMode(false); setPhaseA(Number(e.target.value)) }} className="w-full"/>
            <div className="text-xs text-gray-600 mt-1">Aktualnie: {phaseA}s</div>
          </div>
          <div>
            <label className="text-sm font-medium">Tył (sekundy)</label>
            <input type="range" min={1} max={15} step={1} value={phaseB} onChange={(e)=>{ setAutoMode(false); setPhaseB(Number(e.target.value)) }} className="w-full"/>
            <div className="text-xs text-gray-600 mt-1">Aktualnie: {phaseB}s</div>
          </div>
        </div>
      </div>
    )
  }

  /* Niezalogowany */
  if (!session) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-6">
          <h1 className="text-2xl font-bold">Fiszki – logowanie</h1>
          <p className="text-sm text-gray-600 mt-2">Podaj e-mail (magic link) albo zaloguj hasłem właściciela.</p>

          <form onSubmit={signInWithEmail} className="mt-4 space-y-3">
            <input type="email" required placeholder="twoj@email.pl" value={email} onChange={(e)=>setEmail(e.target.value)} className="w-full border rounded-xl px-3 py-2 h-10"/>
            <button disabled={loading} className="w-full rounded-xl px-4 h-10 bg-black text-white disabled:opacity-50">{loading?'Wysyłanie…':'Wyślij link'}</button>
          </form>

          <hr className="my-4" />
          <p className="text-sm font-semibold">Logowanie właściciela (e-mail + hasło)</p>
          <form onSubmit={signInWithPassword} className="mt-2 space-y-2">
            <input type="email" required placeholder="twoj@email.pl" value={ownerEmail} onChange={(e)=>setOwnerEmail(e.target.value)} className="w-full border rounded-xl px-3 py-2 h-10"/>
            <input type="password" required placeholder="Hasło" value={ownerPassword} onChange={(e)=>setOwnerPassword(e.target.value)} className="w-full border rounded-xl px-3 py-2 h-10"/>
            <button disabled={loading} className="w-full rounded-xl px-4 h-10 bg-blue-600 text-white disabled:opacity-50">{loading?'Logowanie…':'Zaloguj się hasłem'}</button>
          </form>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>
      </main>
    )
  }

  /* Routing do kamerki */
  if (page === 'webrtc') return <SecretWebRTCPage onBack={()=>setPage('app')} />

  /* Główny widok */
  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 p-4">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="flex flex-col gap-3">
          <h1 className="text-2xl font-bold">Twoje fiszki</h1>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2">
              <span className="whitespace-nowrap">Pokaż:</span>
              <select className="border rounded-lg px-2 py-1 h-10 w-full" value={showFilter} onChange={(e)=>setShowFilter(e.target.value)}>
                <option value="all">Wszystkie</option>
                <option value="unknown">Niezapamiętane</option>
                <option value="known">Zapamiętane</option>
              </select>
            </div>

            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2">
              <span className="whitespace-nowrap">Najpierw:</span>
              <select className="border rounded-lg px-2 py-1 h-10 w-full" value={sidePref} onChange={(e)=>setSidePref(e.target.value)}>
                <option value="front">Przód</option>
                <option value="back">Tył</option>
                <option value="random">Losowo</option>
              </select>
            </div>

            <div className="text-sm bg-white rounded-2xl shadow px-3 py-2 flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={shuffleOnLoad} onChange={(e)=>setShuffleOnLoad(e.target.checked)} />
                <span className="whitespace-nowrap">Losuj przy starcie</span>
              </label>
              <button type="button" className="px-3 py-1 h-10 rounded-lg border hover:bg-gray-50 shrink-0" onClick={()=>{ setCards(prev=>shuffle(prev)); setReviewIdx(0) }}>
                Tasuj teraz
              </button>
            </div>

            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center gap-2 sm:col-span-2 lg:col-span-1">
              <span className="whitespace-nowrap">Folder:</span>
              <select className="border rounded-lg px-2 py-1 h-10 w-full" value={activeFolderId} onChange={(e)=>setActiveFolderId(e.target.value)}>
                {[{ id:'ALL', name:'Wszystkie' }, ...folders].map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>

            <div className="text-sm bg-white rounded-xl shadow px-3 py-2 flex items-center justify-between gap-2 sm:col-span-2 lg:col-span-1">
              <span className="text-gray-600 truncate">{session.user.email}</span>
              <div className="flex items-center gap-2">
                {ownerEmailEnv && session.user.email === ownerEmailEnv && (
                  <button onClick={()=>setPage('webrtc')} className="px-3 py-2 h-10 rounded-xl bg-purple-600 text-white hover:bg-purple-500">
                    Kamerka
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
            <input className="flex-1 border rounded-xl px-3 h-10" placeholder="Nazwa folderu (np. Angielski B1)" value={newFolderName} onChange={e=>setNewFolderName(e.target.value)} />
            <button className="px-4 h-10 rounded-xl bg-black text-white w-full sm:w-auto">Dodaj folder</button>
          </form>
          <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-sm">
            {folders.map(f=>(
              <li key={f.id} className={`flex items-center justify-between px-3 py-2 rounded-xl border ${activeFolderId===f.id?'bg-black text-white':'bg-gray-50'}`}>
                <button className="text-left truncate flex-1" onClick={()=>setActiveFolderId(f.id)}>{f.name}</button>
                <button className={`px-2 py-1 h-9 rounded-lg border ${activeFolderId===f.id?'bg-white/10':'hover:bg-white'}`} onClick={()=>deleteFolder(f.id,f.name)}>Usuń</button>
              </li>
            ))}
          </ul>
        </section>

        {/* Dodawanie + Nauka */}
        <section className="mt-6 grid md:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Dodaj fiszkę</h2>
            <form onSubmit={handleAddCard} className="space-y-2">
              <input className="w-full border rounded-xl px-3 h-10" placeholder="Przód (pytanie)" value={newFront} onChange={e=>setNewFront(e.target.value)} />
              <input type="text" className="w-full border rounded-xl px-3 h-10" placeholder="Tył (odpowiedź)" value={newBack} onChange={e=>setNewBack(e.target.value)} />
              <select className="w-full border rounded-xl px-3 h-10" value={newCardFolderId} onChange={e=>setNewCardFolderId(e.target.value)} required>
                <option value="" disabled>(WYBIERZ FOLDER — WYMAGANE)</option>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <button className="px-4 h-10 rounded-xl bg-black text-white">Dodaj</button>
            </form>

            {/* Import CSV */}
            <div className="mt-4">
              <label className="text-sm font-medium">Import CSV (Przód, Tył)</label>
              <div className="mt-2 flex flex-col lg:flex-row gap-2 lg:items-center">
                <select className="border rounded-xl px-3 h-10 w-full lg:w-auto" value={importFolderId} onChange={(e)=>setImportFolderId(e.target.value)} required>
                  <option value="">(WYBIERZ FOLDER DLA IMPORTU — WYMAGANE)</option>
                  {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <label className={`inline-flex items-center justify-center gap-2 px-4 h-10 rounded-xl border bg-white cursor-pointer hover:bg-gray-50 whitespace-nowrap shrink-0 w-full lg:w-auto ${!importFolderId?'opacity-60 cursor-not-allowed':''}`}>
                  <span className="text-sm text-gray-700">Wybierz plik</span>
                  <input type="file" accept=".csv" onChange={handleCSVUpload} className="hidden" disabled={!importFolderId}/>
                </label>
              </div>
              <p className="text-xs text-gray-500 mt-2">Nagłówki: <code>Przód</code>, <code>Tył</code>. Separator wykrywany automatycznie.</p>
              {importProgress.running && (
                <div className="mt-3">
                  <div className="text-xs text-gray-700 mb-1">Zaimportowano: {importProgress.done}…</div>
                  <div className="w-full h-2 bg-gray-200 rounded overflow-hidden"><div className="h-2 bg-emerald-500 animate-pulse w-1/2" /></div>
                </div>
              )}
            </div>

            {loading && <p className="text-sm text-gray-600 mt-2">Pracuję…</p>}
            {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          </div>

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold mb-3">Tryb nauki</h2>
            <input className="w-full border rounded-xl px-3 h-10 mb-3" placeholder="Szukaj w fiszkach…" value={q} onChange={e=>setQ(e.target.value)} />
            <Review />
          </div>
        </section>

        {/* Lista */}
        <section className="mt-6 bg-white rounded-2xl shadow p-4">
          <h2 className="font-semibold mb-3">Wszystkie fiszki ({filtered.length})</h2>
          <ul className="divide-y">
            {filtered.map(card=>(
              <li key={card.id} className="py-3 flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium break-words">{card.front}</p>
                  <p className="text-sm text-gray-600 mt-1 break-words">{card.back}</p>
                  <p className="text-xs text-gray-500 mt-1">{card.known?'✅ Zapamiętana':'🕑 Do nauki'}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <label className="text-xs flex items-center gap-1">
                    <input type="checkbox" checked={!!card.known} onChange={()=>toggleKnown(card)} />
                    Zapamiętana
                  </label>
                  <button onClick={()=>removeCard(card.id)} className="px-3 py-2 h-10 rounded-xl bg-gray-100 hover:bg-gray-200">Usuń</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  )
}

/* ======================= KAMERKA (auto-połączenie, SDP/ICE jako JSON) ======================= */
function SecretWebRTCPage({ onBack }) {
  const videoRef = useRef(null)
  const pcRef = useRef(null)
  const localStreamRef = useRef(null)
  const channelRef = useRef(null)
  const lastOfferRef = useRef(null) // { type:'offer', sdp:'...' }

  const [room, setRoom] = useState('')
  const [role, setRole] = useState('idle') // 'idle' | 'caster' | 'viewer'
  const [useBackCam, setUseBackCam] = useState(true)
  const [pcState, setPcState] = useState('new')
  const [needsManualPlay, setNeedsManualPlay] = useState(false)
  const [logLines, setLogLines] = useState([])

  useEffect(()=>()=>stopAll(),[])

  const log = (...a) => setLogLines(l => [...l.slice(-200), `[${new Date().toLocaleTimeString()}] ${a.join(' ')}`])

  // --- ICE servers (TURN/STUN via Metered) ---
  async function fetchIceServers() {
    try {
      if (!METERED_DOMAIN || !METERED_API_KEY) {
        log('ICE','fallback STUN')
        return [{ urls: 'stun:stun.l.google.com:19302' }]
      }
      const url = `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`
      const res = await fetch(url)
      if (!res.ok) throw new Error('fetch ice failed')
      const json = await res.json()
      log('ICE','metered ok')
      return json
    } catch (e) {
      log('ICE','error', e.message)
      return [{ urls: 'stun:stun.l.google.com:19302' }]
    }
  }

  async function makePC() {
    const iceServers = await fetchIceServers()
    const pc = new RTCPeerConnection({ iceServers })
    pc.onconnectionstatechange = () => {
      setPcState(pc.connectionState || 'unknown')
      log('PC state:', pc.connectionState)
    }
    return pc
  }

  async function preferH264(pc) {
    try {
      const senders = pc.getSenders().filter(s => s.track && s.track.kind === 'video')
      for (const s of senders) {
        const params = s.getParameters() || {}
        const codecs = RTCRtpSender.getCapabilities('video')?.codecs || []
        const h264 = codecs.filter(c => /H264/i.test(c.mimeType))
        const rest = codecs.filter(c => !/H264/i.test(c.mimeType))
        if (h264.length) {
          params.codecs = [...h264, ...rest]
          await s.setParameters(params)
        }
      }
    } catch {}
  }

  function camConstraints() {
    const video = useBackCam ? { facingMode: { ideal: 'environment' } } : { facingMode: { ideal: 'user' } }
    return { video, audio: false }
  }

  // --- Supabase Realtime: czekamy na SUBSCRIBED i normalizujemy payloady ---
  function normalizedRoom(name) {
    return (name || '').trim().toLowerCase()
  }

  // --- Supabase Realtime: czekamy na SUBSCRIBED i normalizujemy payloady ---
// DODAJ powyżej ensureChannel:
const channelRoomRef = useRef(null)

function normalizedRoom(name) {
  return (name || '').trim().toLowerCase()
}

function ensureChannel(roomNameRaw) {
  const wanted = normalizedRoom(roomNameRaw)

  // jeśli mamy kanał ALE dla innego pokoju → odsubskrybuj i wyczyść
  if (channelRef.current && channelRoomRef.current !== wanted) {
    try { channelRef.current.unsubscribe() } catch {}
    channelRef.current = null
    channelRoomRef.current = null
  }

  if (channelRef.current) {
    // już właściwy pokój
    return Promise.resolve(channelRef.current)
  }

  // tworzymy nowy kanał dla tego pokoju i zwracamy Promise SUBSCRIBED
  return new Promise((resolve) => {
    const ch = supabase.channel(`webrtc:${wanted}`, { config: { broadcast: { self: false } } })

    ch.subscribe((status) => {
      log('RT ch status:', status, `(room=${wanted})`)
      if (status === 'SUBSCRIBED') {
        channelRef.current = ch
        channelRoomRef.current = wanted
        resolve(ch)
      }
    })

    ch.on('broadcast', { event: 'webrtc' }, async ({ payload }) => {
      const pc = pcRef.current
      if (!pc) return
      try {
        switch (payload.kind) {
          case 'ping': {
            if (role === 'caster' && lastOfferRef.current) {
              log('RX ping → TX offer')
              ch.send({ type: 'broadcast', event: 'webrtc', payload: { kind: 'offer', desc: lastOfferRef.current } })
            }
            break
          }
          case 'offer': {
            if (role === 'viewer') {
              log('RX offer → setRemote + createAnswer')
              const remote = payload.desc // { type:'offer', sdp:'...' }
              await pc.setRemoteDescription(remote)
              const answer = await pc.createAnswer()
              await pc.setLocalDescription(answer)
              ch.send({ type: 'broadcast', event: 'webrtc', payload: { kind: 'answer', desc: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } })
              log('TX answer')
            }
            break
          }
          case 'answer': {
            if (role === 'caster') {
              log('RX answer → setRemote')
              const remote = payload.desc // { type:'answer', sdp:'...' }
              await pc.setRemoteDescription(remote)
            }
            break
          }
          case 'ice': {
            const cand = payload.candidate // { candidate, sdpMid, sdpMLineIndex, usernameFragment? }
            log('RX ice')
            await pc.addIceCandidate(cand)
            break
          }
        }
      } catch (e) {
        log('Signal err:', e.message)
      }
    })
  })
}


      channelRef.current = ch
    })

    return channelReady
  }

  async function startCaster() {
    if (!room.trim()) { alert('Podaj nazwę pokoju'); return }
    setRole('caster')
    const pc = await makePC()
    pcRef.current = pc

    const ch = await ensureChannel(room.trim())

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        // Wysyłaj ICE jako JSON
        ch.send({ type: 'broadcast', event: 'webrtc', payload: { kind: 'ice', candidate: e.candidate.toJSON() } })
        log('TX ice')
      }
    }

    // tylko addTrack → brak dublowania m-line
    const stream = await navigator.mediaDevices.getUserMedia(camConstraints())
    localStreamRef.current = stream
    const videoTrack = stream.getVideoTracks()[0]
    pc.addTrack(videoTrack, stream)

    await preferH264(pc)

    if (videoRef.current) {
      videoRef.current.srcObject = stream
      videoRef.current.muted = true
      videoRef.current.playsInline = true
      try { await videoRef.current.play() } catch {}
    }

    const offer = await pc.createOffer({ offerToReceiveVideo: false })
    await pc.setLocalDescription(offer)

    // zapamiętaj „suchy” opis, a nie obiekt RTC
    lastOfferRef.current = { type: pc.localDescription.type, sdp: pc.localDescription.sdp }

    // i wyślij jako JSON
    ch.send({ type: 'broadcast', event: 'webrtc', payload: { kind: 'offer', desc: lastOfferRef.current } })
    log('TX offer (initial)')

    // re-TX co 3s, dopóki nie dostanie „answer”
    const resend = setInterval(() => {
      const pcc = pcRef.current
      if (!pcc) { clearInterval(resend); return }
      const stable = pcc.signalingState === 'stable' && pcc.currentRemoteDescription
      if (stable) { clearInterval(resend); return }
      if (lastOfferRef.current) {
        log('Re-TX offer (retry)')
        ch.send({ type: 'broadcast', event: 'webrtc', payload: { kind: 'offer', desc: lastOfferRef.current } })
      }
    }, 3000)
  }

  async function startViewer() {
    if (!room.trim()) { alert('Podaj nazwę pokoju'); return }
    setRole('viewer')
    const pc = await makePC()
    pcRef.current = pc

    const ch = await ensureChannel(room.trim())

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        ch.send({ type: 'broadcast', event: 'webrtc', payload: { kind: 'ice', candidate: e.candidate.toJSON() } })
        log('TX ice')
      }
    }

    pc.ontrack = async (e) => {
      const stream = e.streams[0]
      if (!videoRef.current) return
      videoRef.current.srcObject = stream
      videoRef.current.playsInline = true
      try { await videoRef.current.play(); setNeedsManualPlay(false) }
      catch { setNeedsManualPlay(true) }
      log('ontrack stream')
    }

    // ping co 2s, aż dostaniemy offer
    const pingInt = setInterval(() => {
      const pcc = pcRef.current
      if (!pcc) { clearInterval(pingInt); return }
      if (pcc.remoteDescription) { clearInterval(pingInt); return }
      ch.send({ type: 'broadcast', event: 'webrtc', payload: { kind: 'ping' } })
      log('TX ping (request offer)')
    }, 2000)
  }

  async function switchCamera() {
    if (role !== 'caster') { setUseBackCam(v=>!v); return }
    setUseBackCam(v=>!v)
    try {
      const newStream = await navigator.mediaDevices.getUserMedia(camConstraints())
      const pc = pcRef.current
      const senders = pc.getSenders()
      const newVideo = newStream.getVideoTracks()[0]
      const vSender = senders.find(s => s.track && s.track.kind === 'video')
      if (vSender && newVideo) await vSender.replaceTrack(newVideo)
      localStreamRef.current?.getTracks()?.forEach(t => t.stop())
      localStreamRef.current = newStream
      if (videoRef.current) {
        videoRef.current.srcObject = newStream
        try { await videoRef.current.play() } catch {}
      }
      log('camera switched')
    } catch {
      alert('Nie udało się przełączyć kamery.')
    }
  }

  function stopAll() {
    try { pcRef.current?.close?.() } catch {}
    try { localStreamRef.current?.getTracks()?.forEach(t=>t.stop()) } catch {}
    try { channelRef.current?.unsubscribe?.() } catch {}
    pcRef.current = null; localStreamRef.current = null; channelRef.current = null
    lastOfferRef.current = null
    setRole('idle'); setNeedsManualPlay(false); setPcState('new')
    log('stopped')
  }

  async function manualPlay() {
    try { await videoRef.current?.play(); setNeedsManualPlay(false) } catch {}
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 p-4">
      <div className="max-w-2xl mx-auto">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Kamerka (auto-połączenie)</h1>
          <button onClick={()=>{ stopAll(); onBack(); }} className="px-3 py-2 rounded-xl bg-gray-200 hover:bg-gray-300">← Wróć</button>
        </header>

        <section className="mt-4 bg-white rounded-2xl shadow p-4">
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <input
              className="border rounded-xl px-3 h-10 flex-1"
              placeholder="Nazwa pokoju (np. pokoj1)"
              value={room}
              onChange={(e)=>setRoom(e.target.value)}
            />
            <button className={`px-4 h-10 rounded-xl ${role==='caster'?'bg-purple-600 text-white':'bg-purple-100 hover:bg-purple-200'}`} onClick={startCaster}>
              Start (telefon)
            </button>
            <button className={`px-4 h-10 rounded-xl ${role==='viewer'?'bg-green-600 text-white':'bg-green-100 hover:bg-green-200'}`} onClick={startViewer}>
              Podgląd (komputer)
            </button>
            <button className="px-4 h-10 rounded-xl bg-gray-100 hover:bg-gray-200" onClick={stopAll}>Stop</button>
            <button className="px-4 h-10 rounded-xl bg-blue-100 hover:bg-blue-200 disabled:opacity-50" onClick={switchCamera} disabled={role!=='caster'}>
              Przełącz kamera: {useBackCam?'Tył':'Przód'}
            </button>
            <span className="text-xs text-gray-600">Stan: <b>{pcState}</b></span>
          </div>

          <div className="mt-4 relative">
            <video ref={videoRef} autoPlay playsInline className="w-full rounded-xl bg-black aspect-video" />
            {needsManualPlay && role==='viewer' && (
              <button onClick={manualPlay} className="absolute inset-0 m-auto h-12 w-40 rounded-xl bg-black/70 text-white">
                Odtwórz wideo
              </button>
            )}
          </div>

          <details className="mt-3">
            <summary className="text-sm cursor-pointer">Pokaż log</summary>
            <pre className="text-xs bg-slate-50 border rounded p-2 max-h-64 overflow-auto">
{logLines.map((l,i)=>(<div key={i}>{l}</div>))}
            </pre>
          </details>

          <p className="text-xs text-gray-500 mt-3">
            Wpisz tę samą nazwę pokoju (małe/duże litery są ważne – używamy wersji z małych liter).  
            Viewer pinguje co 2s, a telefon re-wysyła ofertę co 3s, dopóki nie przyjdzie odpowiedź.
          </p>
        </section>
      </div>
    </main>
  )
}

