#!/usr/bin/env bash
# Instala o Robô de Repasse num servidor Ubuntu (Oracle Cloud Free, Google Cloud e2-micro, VPS...).
# Uso: dentro da pasta do projeto, rode:  bash instalar.sh
# Também roda sozinho na criação da máquina (cloud-init) com PAINEL_SENHA definida.
set -e
cd "$(dirname "$0")"
export DEBIAN_FRONTEND=noninteractive
export HOME="${HOME:-/root}"
USUARIO="${SUDO_USER:-$(whoami)}"

echo "== Robô de Repasse: instalação =="
SENHA="${PAINEL_SENHA:-}"
[ -z "$SENHA" ] && { read -rsp "Crie a senha do painel: " SENHA; echo; }
[ -z "$SENHA" ] && { echo "Senha não pode ser vazia"; exit 1; }

# 1) Node.js 22 + pm2 (mantém o robô ligado e reinicia sozinho)
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo -E apt-get install -y nodejs
fi
sudo npm install -g pm2
npm install --omit=dev

# 2) Memória extra (swap) para máquinas de 1 GB
if [ "$(free -m | awk '/Mem:/{print $2}')" -lt 1500 ] && ! swapon --show | grep -q .; then
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 3) Inicia o robô e configura para voltar sozinho se o servidor reiniciar
SENHA="$SENHA" node -e "
const env = { PAINEL_SENHA: process.env.SENHA, PORT: 3000, DATA_DIR: process.cwd() + '/dados' };
require('fs').writeFileSync('ecosystem.config.js', 'module.exports = ' + JSON.stringify({ apps: [{ name: 'repasse', script: 'src/index.js', max_memory_restart: '600M', env }] }, null, 2) + ';\n');"
chmod 600 ecosystem.config.js
pm2 delete repasse >/dev/null 2>&1 || true
pm2 start ecosystem.config.js
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$USUARIO" --hp "$HOME" >/dev/null

# 4) HTTPS grátis com Caddy + endereço sslip.io (ex.: https://129-146-10-20.sslip.io)
IP=$(curl -fsS https://api.ipify.org)
DOMINIO="$(echo "$IP" | tr . -).sslip.io"
if ! command -v caddy >/dev/null; then
  sudo -E apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update && sudo -E apt-get install -y caddy
fi
echo "$DOMINIO {
  reverse_proxy localhost:3000
}" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl reload caddy || sudo systemctl restart caddy

# Imagens Ubuntu da Oracle bloqueiam portas no próprio sistema: libera 80 e 443
if sudo iptables -L INPUT -n | grep -q REJECT; then
  sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT
  sudo -E apt-get install -y iptables-persistent && sudo netfilter-persistent save
fi

# 5) Atualização automática: a cada 30 min busca versão nova no GitHub
( crontab -l 2>/dev/null | grep -v atualizar.sh; echo "*/30 * * * * cd $(pwd) && bash atualizar.sh >> /var/log/robo-atualizacao.log 2>&1" ) | crontab -

echo
echo "✅ Pronto! Abra no celular:  https://$DOMINIO"
echo "https://$DOMINIO" > endereco-do-painel.txt
echo "   (se não abrir, libere as portas 80 e 443 no painel da nuvem — veja o LEIA-ME)"
echo "   Ver o que o robô está fazendo:  pm2 logs repasse"
