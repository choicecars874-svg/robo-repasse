#!/bin/bash
# Roda a cada 30 min (cron): se houver versão nova no GitHub, baixa e reinicia o robô.
cd "$(dirname "$0")"
git fetch -q origin main || exit 0
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
echo "$(date) atualizando para $(git rev-parse --short origin/main)"
git reset -q --hard origin/main
npm install --omit=dev --no-audit --no-fund
pm2 restart repasse
