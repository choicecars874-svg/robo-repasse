const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const robo = require('./robo');
const { iniciarPainel } = require('./painel');

iniciarPainel();
robo.iniciar();

process.on('unhandledRejection', (e) => console.error('Erro não tratado:', e));

// Atualização automática feita pelo próprio robô (não depende do cron do servidor):
// a cada 30 min busca versão nova no GitHub; se houver, baixa e reinicia.
const RAIZ = path.join(__dirname, '..');
// versão que está rodando de verdade: o atualizar.sh usa para saber se falta reiniciar
try {
  fs.writeFileSync(path.join(RAIZ, '.versao-rodando'), require('child_process').execSync('git rev-parse HEAD', { cwd: RAIZ }).toString().trim());
} catch {}
if (fs.existsSync(path.join(RAIZ, '.git')) && fs.existsSync(path.join(RAIZ, 'atualizar.sh'))) {
  const atualizar = () => {
    // roda solto (o bash intermediário sai na hora): quando o pm2 reinicia o robô, não mata a atualização junto
    spawn('bash', ['-c', 'nohup setsid bash atualizar.sh >> /tmp/robo-atualizacao.log 2>&1 < /dev/null &'], { cwd: RAIZ, detached: true, stdio: 'ignore' }).unref();
  };
  setTimeout(atualizar, 2 * 60 * 1000);
  setInterval(atualizar, 30 * 60 * 1000);
}
