#!/bin/bash
###############################################################################
###############################################################################
###############################################################################
###############################################################################
###############################################################################
###############################################################################
###############################################################################
###############################################################################
###############################################################################
###############################################################################
# Roda a cada 30 min (cron e o próprio robô): se houver versão nova no GitHub, baixa e reinicia o robô.
# Proteções para a máquina de 1 GB: uma atualização por vez, npm só quando as dependências mudam,
# prioridade baixa, e volta para a versão anterior se o painel não responder depois de reiniciar.
# Todo o código fica dentro de main(): o bash lê a função inteira antes de rodar, então trocar este
# arquivo no meio da atualização não quebra nada. As linhas de # abaixo protegem a troca da versão antiga.
main() {
  cd "$(dirname "$0")"
  exec 9>/tmp/robo-atualizacao.lock
  flock -n 9 || { echo "$(date) outra atualização já está rodando"; exit 0; }

  git fetch -q origin main || true
  RODANDO=$(cat .versao-rodando 2>/dev/null)   # versão que o robô está executando (gravada ao iniciar)
  ATUAL=$(git rev-parse HEAD)
  NOVA=$(git rev-parse origin/main 2>/dev/null || echo "$ATUAL")
  [ "$ATUAL" = "$NOVA" ] && [ "$RODANDO" = "$ATUAL" ] && exit 0
  # versão que já falhou no teste: espera uma correção nova
  [ "$(cat .versao-ruim 2>/dev/null)" = "$NOVA" ] && exit 0

  # memória muito baixa: deixa para a próxima rodada
  LIVRE=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  if [ "${LIVRE:-0}" -lt 120 ]; then echo "$(date) pouca memória livre (${LIVRE} MB), atualização adiada"; exit 0; fi

  VOLTAR=${RODANDO:-$ATUAL}
  echo "$(date) atualizando $(git rev-parse --short "$VOLTAR") -> $(git rev-parse --short "$NOVA")"
  git reset -q --hard "$NOVA"
  if ! git diff --quiet "$VOLTAR" "$NOVA" -- package.json package-lock.json 2>/dev/null; then
    nice -n 19 npm install --omit=dev --no-audit --no-fund || { echo "$(date) npm falhou, voltando"; git reset -q --hard "$VOLTAR"; exit 1; }
  fi

  # limite de memória do robô mais seguro para 1 GB (uma vez só)
  if grep -q '"max_memory_restart": "600M"' ecosystem.config.js 2>/dev/null; then
    sed -i 's/"max_memory_restart": "600M"/"max_memory_restart": "420M"/' ecosystem.config.js
    pm2 delete repasse >/dev/null 2>&1; pm2 start ecosystem.config.js && pm2 save
  else
    pm2 restart repasse
  fi

  # confere se o painel voltou; se não, volta para a versão anterior
  for i in $(seq 1 18); do
    sleep 5
    curl -fsS -m 5 -o /dev/null http://localhost:3000/login && { echo "$(date) ok, painel respondendo"; exit 0; }
  done
  echo "$NOVA" > .versao-ruim
  echo "$(date) painel não respondeu na versão nova: voltando para $(git rev-parse --short "$VOLTAR")"
  git reset -q --hard "$VOLTAR"
  git diff --quiet "$VOLTAR" "$NOVA" -- package.json package-lock.json 2>/dev/null || nice -n 19 npm install --omit=dev --no-audit --no-fund
  pm2 restart repasse
}
main "$@"
exit
