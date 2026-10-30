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
# Liga o robô: reinicia se existir no pm2; se não existir (apagado/caiu), cria de novo
ligar() {
  if pm2 describe repasse >/dev/null 2>&1; then pm2 restart repasse; else pm2 start ecosystem.config.js; fi
  pm2 save >/dev/null 2>&1
}

# Guarda contra travamento da máquina de 1 GB: quando a memória acaba, o earlyoom encerra o robô
# (o pm2 liga de novo) antes de o sistema afundar no swap e parar de responder. Instala uma vez só.
proteger_maquina() {
  command -v earlyoom >/dev/null 2>&1 && return
  echo "$(date) instalando proteção contra falta de memória (earlyoom)"
  nice -n 19 apt-get install -y -qq earlyoom >/dev/null 2>&1 || { nice -n 19 apt-get update -qq >/dev/null 2>&1 && nice -n 19 apt-get install -y -qq earlyoom >/dev/null 2>&1; } || return
  # age quando sobra menos de 8% de memória, sem esperar o swap encher; prefere matar o node do robô
  echo 'EARLYOOM_ARGS="-m 8 -s 100 -r 3600 --prefer ^(node|npm)$ --avoid ^(sshd|systemd|caddy|pm2)$"' > /etc/default/earlyoom
  systemctl enable --now earlyoom >/dev/null 2>&1 && systemctl restart earlyoom
  sysctl -qw vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/99-robo.conf
}

main() {
  cd "$(dirname "$0")"
  exec 9>/tmp/robo-atualizacao.lock
  flock -n 9 || { echo "$(date) outra atualização já está rodando"; exit 0; }

  git fetch -q origin main || true
  RODANDO=$(cat .versao-rodando 2>/dev/null)   # versão que o robô está executando (gravada ao iniciar)
  ATUAL=$(git rev-parse HEAD)
  NOVA=$(git rev-parse origin/main 2>/dev/null || echo "$ATUAL")
  [ "$ATUAL" = "$NOVA" ] && [ "$RODANDO" = "$ATUAL" ] && { proteger_maquina; exit 0; }
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
    pm2 delete repasse >/dev/null 2>&1
  fi
  ligar

  # confere se o painel voltou; se não, volta para a versão anterior
  for i in $(seq 1 18); do
    sleep 5
    curl -fsS -m 5 -o /dev/null http://localhost:3000/login && { echo "$(date) ok, painel respondendo"; proteger_maquina; exit 0; }
  done
  echo "$NOVA" > .versao-ruim
  echo "$(date) painel não respondeu na versão nova: voltando para $(git rev-parse --short "$VOLTAR")"
  git reset -q --hard "$VOLTAR"
  git diff --quiet "$VOLTAR" "$NOVA" -- package.json package-lock.json 2>/dev/null || nice -n 19 npm install --omit=dev --no-audit --no-fund
  ligar
}
main "$@"
exit
