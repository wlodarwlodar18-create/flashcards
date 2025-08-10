#!/usr/bin/env bash
set -euo pipefail
git init
git add .
git commit -m "Initial commit: Flashcards (Vite + Supabase)"
# git branch -M main
# git remote add origin <URL_DO_TWOJEGO_REPO>
# git push -u origin main
echo "Repo zainicjalizowane. Dodaj remote i wypchnij na GitHub."
