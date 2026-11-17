// Painel web com senha: QR Code, aprovação dos carros, configurações, logo e histórico.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const config = require('./config');
const robo = require('./robo');
const { parseAnuncio } = require('./parser');
const { montarTexto, aplicarMargem } = require('./modelo');
const { filtrarAntesDaFipe, filtrarFipe, descontoFipe } = require('./filtros');
const { completarFipe } = require('./fipe');
const { aplicarLogo, ARQ_LOGO } = require('./logo');
const estatisticas = require('./estatisticas');
const instagram = require('./instagram');
const leadsok = require('./leadsok/coletor');
const cockpit = require('./cockpit');
const comercial = require('./leadsok/metricas');

const SENHA = process.env.PAINEL_SENHA;
let VERSAO = '?';
try {
  VERSAO = require('child_process').execSync('git log -1 --format="%h %cd" --date=format:"%d/%m %H:%M"', { cwd: path.join(__dirname, '..') }).toString().trim();
} catch {}
const PUBLICO = path.join(__dirname, '..', 'public');

// Senha trocada pelo painel fica em DATA_DIR/senha.json (hash); senão vale a da instalação
const ARQ_SENHA = path.join(config.DATA_DIR, 'senha.json');
function senhaConfere(tentativa) {
  if (!tentativa) return false;
  if (fs.existsSync(ARQ_SENHA)) {
    const { sal, hash } = JSON.parse(fs.readFileSync(ARQ_SENHA, 'utf8'));
    return crypto.timingSafeEqual(crypto.scryptSync(tentativa, sal, 64), Buffer.from(hash, 'hex'));
  }
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(tentativa).digest(), crypto.createHash('sha256').update(SENHA).digest());
}
function gravarSenha(nova) {
  const sal = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(ARQ_SENHA, JSON.stringify({ sal, hash: crypto.scryptSync(nova, sal, 64).toString('hex') }), { mode: 0o600 });
}

function iniciarPainel() {
  try {
    const c = config.get();
    // textos antigos do lembrete automático (falavam de simulação): troca pelos novos uma vez
    if (/simulação sai na hora/.test(c.sdr?.lembreteAutoSemCarro || '') || /pra eu não liberar o carro pra outro cliente\. Combinado\?$/.test(c.sdr?.lembreteAutoCarro || '')) {
      const { lembreteAutoCarro, lembreteAutoSemCarro, ...resto } = c.sdr;
      config.salvar({ ...c, sdr: resto });
    }
    if (!c.sdr?.foraIniciado) config.salvar({ ...c, sdr: { ...c.sdr, vendedoresFora: [...new Set([...(c.sdr?.vendedoresFora || []), 'Lucas Ribeiro'])], foraIniciado: true } });
  } catch (e) {
    console.error('Configuração do SDR:', e.message);
  }
  if (!SENHA) {
    console.error('Defina a variável de ambiente PAINEL_SENHA antes de iniciar.');
    process.exit(1);
  }
  const app = express();
  app.set('trust proxy', 1);
  const json1mb = express.json({ limit: '1mb' });
  app.use((req, res, next) => (req.path === '/api/backup/restaurar' ? next() : json1mb(req, res, next))); // backup tem limite maior
  app.use(express.urlencoded({ extended: false }));

  // Login fica num cookie assinado (não na memória): continua valendo depois que o robô reinicia.
  // Trocar a senha invalida os logins antigos.
  const ARQ_SEGREDO = path.join(config.DATA_DIR, 'segredo-sessao.txt');
  if (!fs.existsSync(ARQ_SEGREDO)) fs.writeFileSync(ARQ_SEGREDO, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const SEGREDO = fs.readFileSync(ARQ_SEGREDO, 'utf8').trim();
  const versaoSenha = () => (fs.existsSync(ARQ_SENHA) ? fs.readFileSync(ARQ_SENHA, 'utf8') : SENHA);
  // Usuários extras (ex.: SDR) com senha própria; o administrador continua sendo a senha do painel
  const ARQ_USUARIOS = path.join(config.DATA_DIR, 'usuarios.json');
  const lerUsuarios = () => { try { return JSON.parse(fs.readFileSync(ARQ_USUARIOS, 'utf8')); } catch { return []; } };
  const salvarUsuarios = (l) => fs.writeFileSync(ARQ_USUARIOS, JSON.stringify(l), { mode: 0o600 });
  const chaveNome = (n) => String(n || '').trim().toLowerCase();
  const versaoDe = (usuario) => (usuario ? lerUsuarios().find((u) => chaveNome(u.nome) === chaveNome(usuario))?.hash || 'removido' : versaoSenha());
  const assinar = (validade, usuario = '') => crypto.createHmac('sha256', SEGREDO).update(`${validade}|${usuario}|${versaoDe(usuario)}`).digest('hex');
  const assinarAntigo = (validade) => crypto.createHmac('sha256', SEGREDO).update(`${validade}|${versaoSenha()}`).digest('hex');
  const TRINTA_DIAS = 30 * 24 * 3600 * 1000;
  const igual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  // devolve { nome, papel } de quem está logado, ou null
  const logado = (req) => {
    const c = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith('painel='));
    if (!c) return null;
    const partes = decodeURIComponent(c.slice(7)).split('.');
    const validade = partes[0];
    if (!validade || Number(validade) < Date.now()) return null;
    if (partes.length === 2) return igual(partes[1], assinarAntigo(validade)) ? { nome: 'Administrador', papel: 'admin' } : null; // login antigo
    const usuario = Buffer.from(partes[1] || '', 'base64url').toString();
    if (!igual(partes[2] || '', assinar(validade, usuario))) return null;
    if (!usuario) return { nome: 'Administrador', papel: 'admin' };
    const u = lerUsuarios().find((x) => chaveNome(x.nome) === chaveNome(usuario));
    return u ? { nome: u.nome, papel: u.papel || 'sdr' } : null;
  };

  app.get('/login', (_, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLICO, 'login.html')));
  app.get('/marca.png', (_, res) => res.sendFile(path.join(__dirname, '..', 'logo.png')));
  app.post('/login', (req, res) => {
    const nome = String(req.body.usuario || '').trim();
    let usuario = '';
    if (nome) {
      // entra pelo login (ex.: marcos@choicecars) ou pelo nome
      const u = lerUsuarios().find((x) => chaveNome(x.login) === chaveNome(nome)) || lerUsuarios().find((x) => chaveNome(x.nome) === chaveNome(nome));
      if (!u || !req.body.senha || !igual(crypto.scryptSync(req.body.senha, u.sal, 64).toString('hex'), u.hash)) return res.redirect('/login?erro=1');
      usuario = u.nome;
    } else if (!senhaConfere(req.body.senha)) return res.redirect('/login?erro=1');
    const validade = Date.now() + TRINTA_DIAS;
    res.cookie('painel', `${validade}.${Buffer.from(usuario).toString('base64url')}.${assinar(validade, usuario)}`, { maxAge: TRINTA_DIAS, httpOnly: true, sameSite: 'lax', secure: req.secure });
    res.redirect('/');
  });
  // Link do "Chame no WhatsApp" dos posts: conta o clique e manda para o WhatsApp da loja (não pede senha)
  const ROBOS = /whatsapp|facebookexternalhit|facebot|bot|crawler|spider|preview|telegram|slack|discord|twitter|curl|wget/i;
  app.get('/c/:id', (req, res) => {
    const ua = req.headers['user-agent'] || '';
    const l = ROBOS.test(ua) ? estatisticas.link(req.params.id) : estatisticas.clicar(req.params.id, req.ip);
    const numero = String(config.get().loja.whatsapp || '').replace(/\D/g, '');
    res.set('Cache-Control', 'no-store').redirect(l?.destino || `https://wa.me/${numero}`);
  });

  // Planilha do SDR por link com chave (para o Google Sheets puxar com IMPORTDATA). Sem chave configurada, não existe.
  app.get('/planilha-sdr/:chave.csv', (req, res) => {
    const chave = (config.get().sdr || {}).chavePlanilha;
    if (!chave || !igual(String(req.params.chave), chave)) return res.sendStatus(404);
    const hoje = comercial.diaSP();
    const de = /^\d{4}-\d{2}-\d{2}$/.test(req.query.de || '') ? req.query.de : comercial.diaSP(Date.now() - 29 * 86400000);
    const ate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate || '') ? req.query.ate : hoje;
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Cache-Control', 'no-store').send(comercial.planilhaCsv(comercial.planilhaSdr({ de, ate }), { sep: ',', bom: false }));
  });
  app.get('/sair', (_, res) => res.clearCookie('painel').redirect('/login'));

  app.use((req, res, next) => {
    req.usuario = logado(req);
    if (!req.usuario) {
      if (req.path.startsWith('/api')) return res.status(401).json({ erro: 'não autenticado' });
      return res.redirect('/login');
    }
    // SDR só enxerga o comercial (fila, agenda, leads) e o próprio estado do painel
    if (req.usuario.papel !== 'admin' && req.path.startsWith('/api') && !/^\/api\/(eu|estado|sdr|agenda|leads|time|estoque|comercial|leadsok\/estado)(\/|$)/.test(req.path)) {
      return res.status(403).json({ erro: 'Sem permissão para esta área' });
    }
    next();
  });
  app.get('/api/eu', (req, res) => res.json(req.usuario));
  // Usuários (só administrador): criar, trocar senha, remover
  app.get('/api/usuarios', (_, res) => res.json(lerUsuarios().map(({ nome, login, papel, criadoEm }) => ({ nome, login: login || null, papel, criadoEm }))));
  app.post('/api/usuarios', (req, res) => {
    const nome = String(req.body.nome || '').trim();
    const senha = String(req.body.senha || '');
    if (!/^[\p{L}\p{N} ._-]{2,30}$/u.test(nome)) return res.status(400).json({ erro: 'Nome de 2 a 30 letras ou números' });
    if (senha.length < 6) return res.status(400).json({ erro: 'Senha com pelo menos 6 caracteres' });
    if (/^admin/i.test(nome)) return res.status(400).json({ erro: 'Escolha outro nome' });
    const login = String(req.body.login || '').trim().toLowerCase();
    if (login && !/^[a-z0-9._@-]{3,60}$/.test(login)) return res.status(400).json({ erro: 'Login com 3 a 60 letras, números, ponto, @ ou hífen' });
    const sal = crypto.randomBytes(16).toString('hex');
    const lista = lerUsuarios().filter((u) => chaveNome(u.nome) !== chaveNome(nome));
    if (login && lista.some((u) => chaveNome(u.login) === login || chaveNome(u.nome) === login)) return res.status(400).json({ erro: 'Esse login já está em uso' });
    lista.push({ nome, ...(login ? { login } : {}), papel: 'sdr', sal, hash: crypto.scryptSync(senha, sal, 64).toString('hex'), criadoEm: Date.now() });
    salvarUsuarios(lista);
    res.json({ ok: true });
  });
  app.post('/api/usuarios/remover', (req, res) => {
    salvarUsuarios(lerUsuarios().filter((u) => chaveNome(u.nome) !== chaveNome(req.body.nome)));
    res.json({ ok: true });
  });

  // sem cache: depois de atualizar, o navegador sempre pega a tela nova
  app.get('/', (_, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLICO, 'index.html')));

  app.get('/api/diagnostico', (_, res) => res.type('text').send(robo.diagnostico.join('\n') || 'Nenhum aviso interno.'));

  app.get('/api/estado', (_, res) => {
    const { status, qr, numero, eventos, desde, ultimaLida, ultimaRecebida } = robo.estado;
    res.json({ versao: VERSAO, status, qr, numero, desde, ultimaLida, ultimaRecebida, eventos: eventos.slice(0, 60), pendentes: robo.pendentes.size, postados: robo.historico.postados.length });
  });

  app.get('/api/grupos', async (req, res) => {
    try {
      res.json(req.query.atualizar ? await robo.atualizarGrupos() : robo.estado.grupos);
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });

  app.get('/api/config', (_, res) => res.json(config.get()));
  app.post('/api/config', (req, res) => res.json(config.salvar(req.body)));

  app.get('/api/pendentes', (_, res) => {
    const cfg = config.get();
    const lista = [...robo.pendentes.values()]
      .sort((a, b) => b.criadoEm - a.criadoEm)
      .map((p) => ({ ...p, texto: montarTexto(p.carro, cfg, p.precoVenda) }));
    res.json(lista);
  });
  app.get('/fotos/:id/:arq', (req, res) => {
    const arq = path.join(robo.DIR_PEND, path.basename(req.params.id), path.basename(req.params.arq));
    fs.existsSync(arq) ? res.sendFile(arq) : res.sendStatus(404);
  });
  app.post('/api/pendentes/:id/aprovar', (req, res) => {
    try {
      robo.aprovar(req.params.id, Number(req.body.precoVenda) || undefined);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.post('/api/pendentes/:id/descartar', (req, res) => {
    robo.descartar(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/testar-envio', async (req, res) => {
    try {
      await robo.enviarTeste(req.body.grupo);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });

  // Busca a versão nova no GitHub na hora (o robô reinicia sozinho em ~1 min se houver)
  // Endereço próprio do painel (ex.: gestao.choicecars.com.br). Mantém o endereço antigo funcionando
  // junto (links dos posts antigos), o Caddy tira o certificado HTTPS sozinho.
  const ARQ_ENDERECO = path.join(__dirname, '..', 'endereco-do-painel.txt');
  const ARQ_ENDERECOS = path.join(config.DATA_DIR, 'enderecos.json');
  const lerEnderecos = () => { try { return JSON.parse(fs.readFileSync(ARQ_ENDERECOS, 'utf8')); } catch { return []; } };
  app.get('/api/dominio', (_, res) => {
    let atual = '';
    try { atual = fs.readFileSync(ARQ_ENDERECO, 'utf8').trim(); } catch {}
    res.json({ atual, todos: lerEnderecos() });
  });
  app.post('/api/dominio', async (req, res) => {
    const dominio = String(req.body.dominio || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(dominio)) return res.status(400).json({ erro: 'Endereço inválido. Exemplo: gestao.choicecars.com.br' });
    try {
      // IP deste servidor = o do endereço sslip.io da instalação (ex.: 137-131-197-47.sslip.io)
      const antigo = fs.readFileSync(ARQ_ENDERECO, 'utf8').trim().replace(/^https?:\/\//, '');
      const ipServidor = (lerEnderecos().concat(antigo).find((d) => /\.sslip\.io$/.test(d)) || '').replace('.sslip.io', '').replace(/-/g, '.');
      const ips = await require('dns').promises.resolve4(dominio).catch(() => []);
      if (!ips.length) return res.status(400).json({ erro: `O endereço ${dominio} ainda não existe no DNS. Crie o registro tipo A apontando para ${ipServidor} e espere alguns minutos.` });
      if (ipServidor && !ips.includes(ipServidor)) return res.status(400).json({ erro: `O endereço ${dominio} aponta para ${ips.join(', ')}, mas este servidor é ${ipServidor}. Corrija o registro A e tente de novo.` });
      const todos = [...new Set([...lerEnderecos(), antigo, dominio].filter(Boolean))];
      const caddy = `${todos.join(', ')} {\n  reverse_proxy localhost:3000\n}\n`;
      const { execSync } = require('child_process');
      const comoRoot = process.getuid && process.getuid() === 0 ? '' : 'sudo -n ';
      execSync(`${comoRoot}tee /etc/caddy/Caddyfile >/dev/null`, { input: caddy, timeout: 10000 });
      execSync(`${comoRoot}systemctl reload caddy`, { timeout: 20000 });
      fs.writeFileSync(ARQ_ENDERECOS, JSON.stringify(todos));
      fs.writeFileSync(ARQ_ENDERECO, `https://${dominio}\n`);
      res.json({ ok: true, endereco: `https://${dominio}`, todos });
    } catch (e) {
      res.status(500).json({ erro: `Não consegui ativar: ${e.message}` });
    }
  });

  app.post('/api/atualizar', (_, res) => {
    const raiz = path.join(__dirname, '..');
    // roda solto (o bash intermediário sai na hora): quando o pm2 reinicia o robô, não mata a atualização junto
    require('child_process').spawn('bash', ['-c', 'nohup setsid bash atualizar.sh >> /tmp/robo-atualizacao-manual.log 2>&1 < /dev/null &'], { cwd: raiz, detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  });

  // Backup para guardar fora do servidor: configuração, histórico de posts e números do painel.
  // Não leva a sessão do WhatsApp nem tokens (num servidor novo é só escanear o QR de novo).
  app.get('/api/backup', (_, res) => {
    const ler = (arq) => { try { return JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, arq), 'utf8')); } catch { return null; } };
    const dia = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    res.set('Content-Disposition', `attachment; filename="backup-gestao-choice-${dia}.json"`);
    res.json({ versao: 1, criadoEm: new Date().toISOString(), config: config.get(), historico: ler('historico.json'), estatisticas: ler('estatisticas.json') });
  });
  app.post('/api/backup/restaurar', express.json({ limit: '20mb' }), (req, res) => {
    const b = req.body || {};
    if (b.versao !== 1 || !b.config) return res.status(400).json({ erro: 'Arquivo de backup inválido' });
    config.salvar(b.config);
    if (b.historico) fs.writeFileSync(path.join(config.DATA_DIR, 'historico.json'), JSON.stringify(b.historico));
    if (b.estatisticas) fs.writeFileSync(path.join(config.DATA_DIR, 'estatisticas.json'), JSON.stringify(b.estatisticas));
    res.json({ ok: true });
    // reinicia para o robô carregar o histórico restaurado (o pm2 liga de novo)
    setTimeout(() => process.exit(0), 1500);
  });

  // Saúde do servidor (para descobrir travamento por memória sem abrir o console da Oracle)
  app.get('/api/sistema', (_, res) => {
    const ler = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    const mem = Object.fromEntries(ler('/proc/meminfo').split('\n').filter(Boolean).map((l) => { const [k, v] = l.split(':'); return [k, Math.round(parseInt(v, 10) / 1024)]; }));
    let disco = null;
    try { const d = fs.statfsSync('/'); disco = { totalMB: Math.round((d.blocks * d.bsize) / 1048576), livreMB: Math.round((d.bavail * d.bsize) / 1048576) }; } catch {}
    let oom = '';
    try { oom = require('child_process').execSync('dmesg -T 2>/dev/null | grep -iE "out of memory|killed process|oom-kill" | tail -5', { timeout: 3000 }).toString(); } catch {}
    let protecao = 'não instalada';
    try { protecao = require('child_process').execSync('systemctl is-active earlyoom 2>/dev/null || true', { timeout: 3000 }).toString().trim() === 'active' ? 'ativa' : 'instalada, mas parada'; } catch {}
    if (protecao === 'instalada, mas parada' && !fs.existsSync('/usr/bin/earlyoom')) protecao = 'não instalada';
    const ultimas = (t, n) => t.trim().split('\n').slice(-n).join('\n');
    res.json({
      memoria: { totalMB: mem.MemTotal, livreMB: mem.MemAvailable, swapTotalMB: mem.SwapTotal, swapLivreMB: mem.SwapFree },
      robo: { memoriaMB: Math.round(process.memoryUsage().rss / 1048576), ligadoHa: Math.round(process.uptime()) },
      servidor: { ligadoHa: Math.round(require('os').uptime()), carga: require('os').loadavg().map((x) => x.toFixed(2)) },
      disco,
      oom: oom.trim(),
      protecao,
      atualizacoes: ultimas(ler('/var/log/robo-atualizacao.log') + ler('/tmp/robo-atualizacao.log') + ler('/tmp/robo-atualizacao-manual.log'), 12),
    });
  });

  app.post('/api/senha', (req, res) => {
    const { atual, nova } = req.body;
    if (!senhaConfere(atual)) return res.status(400).json({ erro: 'Senha atual incorreta' });
    if (!nova || nova.length < 8) return res.status(400).json({ erro: 'A nova senha precisa ter pelo menos 8 caracteres' });
    gravarSenha(nova);
    res.json({ ok: true });
  });

  // Cockpit (Webmotors): a senha nunca volta para o navegador
  app.get('/api/cockpit', (_, res) => res.json(cockpit.resumo()));
  app.post('/api/cockpit/credenciais', async (req, res) => {
    try {
      res.json(await cockpit.salvarCredenciais(req.body));
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.post('/api/cockpit/sincronizar', (_, res) => {
    cockpit.sincronizar(true).catch(() => {});
    res.json({ ok: true });
  });
  app.post('/api/cockpit/desligar', (_, res) => {
    cockpit.desligar();
    res.json({ ok: true });
  });

  // LeadsOK (comercial): a senha nunca volta para o navegador
  app.post('/api/leadsok/acoes-manuais', (req, res) => {
    try {
      res.json({ ok: true, acoes: leadsok.definirAcoesManuais(String(req.body.texto || '')) });
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.post('/api/leadsok/testar-detalhes', async (_, res) => {
    try {
      res.json(await leadsok.testarDetalhes());
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.get('/api/leadsok/estado', (_, res) => res.json(leadsok.status()));
  app.post('/api/leadsok/credenciais', async (req, res) => {
    try {
      res.json(await leadsok.salvarCredenciais(req.body));
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.post('/api/leadsok/testar', async (_, res) => {
    try {
      res.json(await leadsok.testarConexao());
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.post('/api/leadsok/sincronizar', (_, res) => {
    leadsok.ciclo().catch(() => {});
    res.json({ ok: true });
  });
  app.post('/api/leadsok/desligar', (_, res) => {
    leadsok.desligar();
    res.json({ ok: true });
  });
  app.post('/api/leadsok/gravar-notas', (req, res) => {
    leadsok.definirGravarNotas(req.body.ativo);
    res.json({ ok: true });
  });
  app.post('/api/leadsok/horas-parado', (req, res) => {
    leadsok.definirHorasParado(req.body.horas);
    res.json({ ok: true });
  });
  const periodo = (q) => {
    const hoje = comercial.diaSP();
    return { de: q.de || comercial.diaSP(Date.now() - 29 * 86400000), ate: q.ate || hoje, origem: q.origem || null, base: q.base === 'resgate' ? 'resgate' : 'entrada' };
  };
  app.get('/api/leads', (req, res) => res.json(comercial.leads(periodo(req.query))));
  app.get('/api/time', (req, res) => res.json(comercial.time(periodo(req.query), leadsok.horasParado())));
  app.get('/api/agenda', (req, res) => res.json({ ...comercial.agenda({ de: req.query.de || req.query.dia, ate: req.query.ate || req.query.dia }), confirmacao: (config.get().sdr || {}).confirmacao || '', lembreteDia: (config.get().sdr || {}).lembreteDia || '', naoVeio: (config.get().sdr || {}).naoVeio || '' }));
  app.post('/api/agenda/visita', (req, res) => {
    try {
      const { leadId, data, resultado, compareceu } = req.body;
      const por = req.usuario?.nome || req.usuario?.usuario;
      res.json(comercial.marcarVisita({ leadId, data, resultado, compareceu: compareceu === undefined || compareceu === null ? compareceu : !!compareceu, por }));
      // resultado da visita também nas Notas internas do lead no LeadsOK (se estiver ligado)
      const TXT = { comprou: 'VEIO E COMPROU', nao_comprou: 'VEIO E NÃO COMPROU', nao_veio: 'NÃO VEIO (no-show)' };
      if (TXT[resultado] && leadsok.gravarNotasAtivo()) {
        const f = (t) => new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        leadsok.gravarNotaLeadsOK(String(leadId), `[${f(Date.now())} · ${por} · visita de ${f(Date.parse(data))}] ${TXT[resultado]}`).catch((e) => console.error('Nota da visita no LeadsOK:', e.message));
      }
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.post('/api/agenda/confirmar', (req, res) => {
    try {
      res.json(comercial.confirmarVisita({ leadId: req.body.leadId, data: req.body.data, tipo: req.body.tipo, por: req.usuario?.nome }));
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.get('/api/estoque', (_, res) => res.json(comercial.estoque()));
  app.get('/api/sdr', (req, res) => {
    const sdr = config.get().sdr || {};
    res.json({ ...comercial.filaSdr({ horasSemResposta: leadsok.horasParado(), vendedor: String(req.query.vendedor || '').slice(0, 80), cadencia: sdr, usuario: req.usuario.nome }), recado: sdr.recado || '', confirmacao: sdr.confirmacao || '', lembreteDia: sdr.lembreteDia || '', naoVeio: sdr.naoVeio || '', objecoes: sdr.objecoes || [], vendedoresFora: sdr.vendedoresFora || [] });
  });
  // resultado do SDR: o administrador vê todos; o SDR vê só o dele
  app.get('/api/sdr/resultado', (req, res) => {
    const hoje = comercial.diaSP();
    const por = req.usuario.papel === 'admin' ? String(req.query.por || '') : req.usuario.nome;
    res.json(comercial.resultadoSdr({ de: req.query.de || hoje, ate: req.query.ate || hoje, por }));
  });
  // cadência, recado e objeções (só o administrador muda)
  app.post('/api/sdr/config', (req, res) => {
    if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Só o administrador muda a configuração do SDR' });
    const b = req.body || {};
    const n = (v, min, max, pad) => Math.min(max, Math.max(min, Number(v) || pad));
    const objecoes = (Array.isArray(b.objecoes) ? b.objecoes : []).map((o) => ({ objecao: String(o.objecao || '').trim().slice(0, 120), resposta: String(o.resposta || '').trim().slice(0, 1500) })).filter((o) => o.objecao).slice(0, 40);
    const atual = config.get();
    res.json(config.salvar({ ...atual, sdr: { horasTentarDeNovo: n(b.horasTentarDeNovo, 0.5, 72, 3), horasAguardandoRecado: n(b.horasAguardandoRecado, 1, 168, 2), tentativasMax: n(b.tentativasMax, 1, 10, 3), diasNovos: n(b.diasNovos, 1, 30, 7), horasSemRespostaResgate: n(b.horasSemRespostaResgate, 0.25, 48, 1), vendedoresFora: (Array.isArray(b.vendedoresFora) ? b.vendedoresFora : atual.sdr.vendedoresFora || []).map((v) => String(v).trim().slice(0, 60)).filter(Boolean).slice(0, 20), foraIniciado: true, chavePlanilha: atual.sdr.chavePlanilha || null, lembreteAuto: atual.sdr.lembreteAuto, nomeSdr: atual.sdr.nomeSdr, lembreteAutoCarro: atual.sdr.lembreteAutoCarro, lembreteAutoSemCarro: atual.sdr.lembreteAutoSemCarro, recado: String(b.recado || '').slice(0, 1000) || atual.sdr.recado, confirmacao: String(b.confirmacao || '').slice(0, 1000) || atual.sdr.confirmacao, lembreteDia: String(b.lembreteDia || '').slice(0, 1000) || atual.sdr.lembreteDia, naoVeio: String(b.naoVeio || '').slice(0, 1000) || atual.sdr.naoVeio, objecoes } }).sdr);
  });
  app.post('/api/sdr/lead-teste', (req, res) => {
    try {
      if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Só o administrador cria leads de teste' });
      res.json(req.body.remover ? comercial.removerLeadsTeste() : comercial.criarLeadTeste(req.body));
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  // briefing: o que o painel sabe + (na hora, sem gravar) notas e conversa recente do LeadsOK
  app.get('/api/sdr/lead/:id', async (req, res) => {
    const b = comercial.briefingLead(req.params.id);
    if (b.erro) return res.status(404).json(b);
    const [conv, notas] = await Promise.all([
      leadsok.conversaRecente(req.params.id, 120).catch((e) => ({ mensagens: [], motivo: e.message })),
      leadsok.notasDoLead(req.params.id).catch(() => ''),
    ]);
    // fase do lead pela conversa (checklist); na tela vão só as últimas 30 mensagens
    const fase = require('./leadsok/fase').faseDoLead(conv.mensagens, { agenda: b.agenda, ficha: b.lead.ficha, nome: b.lead.nome });
    res.set('Cache-Control', 'no-store').json({ ...b, conversa: { ...conv, mensagens: conv.mensagens.slice(-30) }, notasLeadsOK: notas, fase });
  });
  app.post('/api/sdr/atualizar', async (_, res) => {
    try {
      res.json(await leadsok.atualizarAgora());
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.get('/api/sdr/planilha', (req, res) => {
    const hoje = comercial.diaSP();
    const por = req.usuario.papel === 'admin' ? String(req.query.por || '') : req.usuario.nome;
    const p = comercial.planilhaSdr({ de: req.query.de || hoje, ate: req.query.ate || hoje, por });
    if (req.query.formato === 'csv') return res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="planilha-sdr-${p.de}-a-${p.ate}.csv"`).send(comercial.planilhaCsv(p));
    res.json(p);
  });
  // chave do link da planilha para o Google Sheets (só o administrador; trocar a chave derruba o link antigo)
  app.post('/api/sdr/planilha/chave', (req, res) => {
    if (req.usuario.papel !== 'admin') return res.status(403).json({ erro: 'Só o administrador' });
    const c = config.get();
    const chave = req.body.remover ? null : crypto.randomBytes(18).toString('base64url');
    config.salvar({ ...c, sdr: { ...c.sdr, chavePlanilha: chave } });
    res.json({ chave });
  });
  app.get('/api/sdr/planilha/chave', (req, res) => res.json({ chave: req.usuario.papel === 'admin' ? (config.get().sdr || {}).chavePlanilha || null : null }));
  // WhatsApp do SDR (lembrete automático da visita)
  const sdrWhats = require('./sdrWhats');
  app.get('/api/sdr/whats', (_, res) => res.set('Cache-Control', 'no-store').json(sdrWhats.status()));
  app.post('/api/sdr/whats/conectar', async (req, res) => {
    try {
      const c = config.get();
      // o nome de quem conectou assina o lembrete ("Aqui é Marcos da Choice Cars")
      config.salvar({ ...c, sdr: { ...c.sdr, nomeSdr: req.usuario.papel === 'admin' ? c.sdr.nomeSdr || '' : req.usuario.nome } });
      await sdrWhats.conectar();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.post('/api/sdr/whats/desconectar', async (_, res) => res.json(await sdrWhats.desconectar().then(() => ({ ok: true }))));
  app.post('/api/sdr/whats/config', (req, res) => {
    const b = req.body || {};
    const c = config.get();
    const n = (v, min, max, pad) => Math.min(max, Math.max(min, Number(v) || pad));
    const lembreteAuto = { ativo: !!b.ativo, horasAntes: n(b.horasAntes, 0.5, 12, 2), horaInicio: n(b.horaInicio, 6, 12, 8), horaFim: n(b.horaFim, 14, 22, 20), maxDia: n(b.maxDia, 1, 30, 15), comFoto: b.comFoto !== false, estiloCard: b.estiloCard === 'pb' ? 'pb' : 'cor', modeloCard: ['story', 'reservado', 'premium'].includes(b.modeloCard) ? b.modeloCard : 'premium' };
    const nomeSdr = String(b.nomeSdr || '').trim().slice(0, 40) || c.sdr.nomeSdr || (req.usuario.papel !== 'admin' ? req.usuario.nome : '');
    const txt = (v, atual) => String(v || '').trim().slice(0, 1200) || atual;
    config.salvar({ ...c, sdr: { ...c.sdr, lembreteAuto, nomeSdr, lembreteAutoCarro: txt(b.lembreteAutoCarro, c.sdr.lembreteAutoCarro), lembreteAutoSemCarro: txt(b.lembreteAutoSemCarro, c.sdr.lembreteAutoSemCarro) } });
    res.json(sdrWhats.status());
  });
  // exemplo do card com um carro do estoque (para ver antes de ligar o automático)
  app.get('/api/sdr/whats/card-exemplo.png', async (req, res) => {
    try {
      const d = require('./leadsok/banco').abrir();
      const carro = d?.prepare('SELECT * FROM lk_estoque WHERE ativo = 1 AND imagem IS NOT NULL ORDER BY ultima_vez DESC LIMIT 1').get();
      if (!carro) return res.status(404).json({ erro: 'Nenhum carro com foto no estoque ainda (veja Comercial → Estoque)' });
      const png = await sdrWhats.cardDaVisita({ nome: 'João', carro, data: new Date(Date.now() + 2 * 3600000).toISOString(), modeloForcado: ['story', 'reservado', 'premium'].includes(req.query.modelo) ? req.query.modelo : undefined });
      res.set('Content-Type', 'image/png').set('Cache-Control', 'no-store').send(png);
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  // teste: manda o lembrete de exemplo para o próprio número conectado
  app.post('/api/sdr/whats/teste', async (_, res) => {
    try {
      const st = sdrWhats.status();
      if (!st.numero) throw new Error('Conecte o WhatsApp primeiro');
      const ex = require('./leadsok/banco').abrir()?.prepare('SELECT marca, modelo, versao, ano FROM lk_estoque WHERE ativo = 1 AND imagem IS NOT NULL LIMIT 1').get();
      const v = { lead_id: 'teste', nome: 'Teste', whatsapp: st.numero, carro: ex ? `${ex.marca} ${ex.modelo} ${ex.versao || ''} ${ex.ano || ''}` : '', data: new Date(Date.now() + 2 * 3600000).toISOString() };
      res.json(await sdrWhats.enviarLembrete(v, { teste: true }));
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.get('/api/sdr/historico', (req, res) => res.json(comercial.historicoContatos({ dia: req.query.dia, por: req.query.por })));
  app.get('/api/sdr/buscar', (req, res) => res.json(comercial.buscarLead(req.query.q)));
  app.post('/api/sdr/contato', (req, res) => {
    try {
      const r = comercial.registrarContato({ ...req.body, por: req.usuario.nome });
      // briefing também nas Notas internas do lead no LeadsOK (se estiver ligado)
      if (req.body.nota && leadsok.gravarNotasAtivo()) {
        const RES = { atendeu: 'atendeu', nao_atendeu: 'não atendeu', enviada: 'mensagem', agendou: 'AGENDOU', interesse_visita: 'TOPOU VISITAR (sem horário confirmado)', ja_comprou: 'JÁ COMPROU', sem_interesse: 'SEM INTERESSE' };
        const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const retorno = req.body.proximoEm ? ` · ${req.body.resultado === 'agendou' ? 'VISITA' : req.body.resultado === 'interesse_visita' ? 'confirmar horário até' : 'retorno'} ${new Date(Number(req.body.proximoEm)).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
        const linha = `[${quando} · ${req.usuario.nome} · ${req.body.tipo === 'mensagem' ? 'mensagem' : 'ligação'} · ${RES[req.body.resultado] || ''}${req.body.interesse ? ' · ' + req.body.interesse : ''}] ${String(req.body.nota).slice(0, 1500)}${retorno}`;
        leadsok.gravarNotaLeadsOK(String(req.body.leadId), linha).then(() => comercial.marcarNoLeadsOK(r.id, 'ok')).catch((e) => comercial.marcarNoLeadsOK(r.id, 'erro: ' + e.message));
      }
      res.json(r);
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.get('/api/comercial/painel', (req, res) => {
    const p = periodo(req.query);
    res.json({ ...comercial.painelComercial({ de: p.de, ate: p.ate, horasParado: leadsok.horasParado(), metas: config.get().metas || {} }), estado: { ativo: leadsok.status().ativo, problema: leadsok.status().problema } });
  });
  app.get('/api/comercial/gestor', (_, res) => res.json(comercial.gestorDoDia({ horasParado: leadsok.horasParado() })));
  app.get('/api/comercial/periodo', (req, res) => res.json(comercial.resumoPeriodo(req.query.de, req.query.ate) || {}));
  app.get('/api/comercial/hoje', (_, res) => res.json({ ...(comercial.resumoHoje() || {}), estado: { ativo: leadsok.status().ativo, problema: leadsok.status().problema } }));

  // Instagram: o token nunca volta para o navegador
  app.get('/api/instagram', async (req, res) => res.json(await instagram.resumo(req.query.de && req.query.ate ? `${req.query.de}_${req.query.ate}` : req.query.periodo)));
  app.get('/api/instagram/posts', async (_, res) => res.json(await instagram.posts()));
  app.get('/api/instagram/estado', (_, res) => res.json(instagram.estado()));
  app.post('/api/instagram/token', async (req, res) => {
    try {
      res.json(await instagram.guardarToken(req.body.token));
    } catch (e) {
      res.status(400).json({ erro: `Token não aceito pelo Instagram: ${e.message}` });
    }
  });
  app.post('/api/instagram/remover', (req, res) => {
    instagram.removerToken(req.body.usuario);
    res.json({ ok: true });
  });

  app.post('/api/historico/apagar', async (req, res) => {
    try {
      res.json(await robo.apagarPost(req.body.quando, req.body.codigo));
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });
  app.get('/api/historico', (_, res) => res.json(robo.historico.postados.map((h) => (h.idLink ? { ...h, cliques: estatisticas.cliquesDoLink(h.idLink) } : h))));

  app.get('/api/painel', (req, res) => {
    const { status, numero } = robo.estado;
    const { de, ate, grupo } = req.query;
    const ini = de ? Date.parse(de + 'T00:00:00-03:00') : 0;
    const fim = ate ? Date.parse(ate + 'T00:00:00-03:00') + 86400000 : Infinity;
    const ultimosPosts = robo.historico.postados.filter((h) => h.quando >= ini && h.quando < fim && (!grupo || h.origem?.grupo === grupo)).slice(0, 6).map((h) => ({ codigo: h.codigo, grupo: h.origem?.grupo, modelo: h.modelo, ano: h.ano, venda: h.venda, quando: h.quando, vendido: !!h.vendido, cliques: h.idLink ? estatisticas.cliquesDoLink(h.idLink) : null }));
    res.json({ ...estatisticas.resumo({ de, ate, grupo: grupo || null }), ultimosPosts, limiteDiario: config.get().limiteDiario, conexao: { status, numero }, pendentes: robo.pendentes.size });
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  app.post('/api/logo', upload.single('logo'), async (req, res) => {
    try {
      await sharp(req.file.buffer).png().toFile(ARQ_LOGO);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ erro: 'Imagem inválida: ' + e.message });
    }
  });
  app.get('/api/logo', (_, res) => (fs.existsSync(ARQ_LOGO) ? res.sendFile(ARQ_LOGO) : res.sendStatus(404)));
  app.get('/api/logo/previa', async (_, res) => {
    const base = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#8a9199' } }).jpeg().toBuffer();
    res.type('jpeg').send(await aplicarLogo(base, { ...config.get().logo, ativo: true }));
  });

  // Simula o fluxo com um texto colado, sem postar nada
  app.post('/api/testar', async (req, res) => {
    const cfg = config.get();
    const carro = parseAnuncio(req.body.texto || '');
    let motivo = filtrarAntesDaFipe(carro, cfg);
    if (!motivo) await completarFipe(carro, cfg);
    motivo = motivo || filtrarFipe(carro, cfg);
    const venda = aplicarMargem(carro.preco, cfg.margem);
    res.json({ carro, desconto: descontoFipe(carro, cfg), precoVenda: venda, aprovado: !motivo, motivo, texto: montarTexto(carro, cfg, venda) });
  });

  app.post('/api/desconectar', async (_, res) => {
    await robo.desconectar();
    res.json({ ok: true });
  });

  const porta = process.env.PORT || 3000;
  app.listen(porta, () => console.log(`Painel em http://localhost:${porta}`));
}

module.exports = { iniciarPainel };
