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
if (fs.existsSync(path.join(RAIZ, '.git')) && fs.existsSync(path.join(RAIZ, 'atualizar.sh'))) {
  const atualizar = () => {
    const log = fs.openSync('/tmp/robo-atualizacao.log', 'a');
    spawn('bash', ['atualizar.sh'], { cwd: RAIZ, detached: true, stdio: ['ignore', log, log] }).unref();
  };
  setTimeout(atualizar, 2 * 60 * 1000);
  setInterval(atualizar, 30 * 60 * 1000);
}
