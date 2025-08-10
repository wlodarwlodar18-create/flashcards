# Flashcards (Vite + React + Supabase)

## 1) Supabase
- New Project (EU) → Settings → API: skopiuj Project URL + anon key.
- Authentication → Providers → Email: włącz Enable Email Sign In.
- Authentication → URL Configuration → SITE URL:
  - dev: http://localhost:5173
  - prod: https://twoj-adres.vercel.app
- Database → SQL Editor → New query → wklej supabase.sql → RUN.

## 2) Lokalnie
```bash
cp .env.example .env
# uzupełnij VITE_SUPABASE_URL i VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

## 3) Deploy na Vercel
1. Wypchnij do GitHub (albo użyj przycisku po podmianie URL repo):
   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=TU_WKLEJ_URL_REPO&env=VITE_SUPABASE_URL,VITE_SUPABASE_ANON_KEY&project-name=flashcards&repository-name=flashcards)
2. Ustaw Environment Variables: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (Production/Preview/Development).
3. Deploy. Framework: Vite, output: dist.

## 4) CSV
Plik z nagłówkami: front,back (patrz public/example.csv).
