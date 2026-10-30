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
  if (!SENHA) {
    console.error('Defina a variável de ambiente PAINEL_SENHA antes de iniciar.');
    process.exit(1);
  }
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Login fica num cookie assinado (não na memória): continua valendo depois que o robô reinicia.
  // Trocar a senha invalida os logins antigos.
  const ARQ_SEGREDO = path.join(config.DATA_DIR, 'segredo-sessao.txt');
  if (!fs.existsSync(ARQ_SEGREDO)) fs.writeFileSync(ARQ_SEGREDO, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const SEGREDO = fs.readFileSync(ARQ_SEGREDO, 'utf8').trim();
  const versaoSenha = () => (fs.existsSync(ARQ_SENHA) ? fs.readFileSync(ARQ_SENHA, 'utf8') : SENHA);
  const assinar = (validade) => crypto.createHmac('sha256', SEGREDO).update(`${validade}|${versaoSenha()}`).digest('hex');
  const TRINTA_DIAS = 30 * 24 * 3600 * 1000;
  const logado = (req) => {
    const c = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith('painel='));
    if (!c) return false;
    const [validade, assinatura] = decodeURIComponent(c.slice(7)).split('.');
    if (!validade || !assinatura || Number(validade) < Date.now()) return false;
    const esperado = assinar(validade);
    return assinatura.length === esperado.length && crypto.timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperado));
  };

  app.get('/login', (_, res) => res.sendFile(path.join(PUBLICO, 'login.html')));
  app.get('/marca.png', (_, res) => res.sendFile(path.join(__dirname, '..', 'logo.png')));
  app.post('/login', (req, res) => {
    if (!senhaConfere(req.body.senha)) return res.redirect('/login?erro=1');
    const validade = Date.now() + TRINTA_DIAS;
    res.cookie('painel', `${validade}.${assinar(validade)}`, { maxAge: TRINTA_DIAS, httpOnly: true, sameSite: 'lax', secure: req.secure });
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

  app.get('/sair', (_, res) => res.clearCookie('painel').redirect('/login'));

  app.use((req, res, next) => {
    if (logado(req)) return next();
    if (req.path.startsWith('/api')) return res.status(401).json({ erro: 'não autenticado' });
    res.redirect('/login');
  });

  app.get('/', (_, res) => res.sendFile(path.join(PUBLICO, 'index.html')));

  app.get('/api/diagnostico', (_, res) => res.type('text').send(robo.diagnostico.join('\n') || 'Nenhum aviso interno.'));

  app.get('/api/estado', (_, res) => {
    const { status, qr, numero, eventos } = robo.estado;
    res.json({ versao: VERSAO, status, qr, numero, eventos: eventos.slice(0, 60), pendentes: robo.pendentes.size, postados: robo.historico.postados.length });
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
  app.post('/api/atualizar', (_, res) => {
    const raiz = path.join(__dirname, '..');
    const log = fs.openSync('/tmp/robo-atualizacao-manual.log', 'a');
    require('child_process').spawn('bash', ['atualizar.sh'], { cwd: raiz, detached: true, stdio: ['ignore', log, log] }).unref();
    res.json({ ok: true });
  });

  app.post('/api/senha', (req, res) => {
    const { atual, nova } = req.body;
    if (!senhaConfere(atual)) return res.status(400).json({ erro: 'Senha atual incorreta' });
    if (!nova || nova.length < 8) return res.status(400).json({ erro: 'A nova senha precisa ter pelo menos 8 caracteres' });
    gravarSenha(nova);
    res.json({ ok: true });
  });

  app.get('/api/historico', (_, res) => res.json(robo.historico.postados.map((h) => (h.idLink ? { ...h, cliques: estatisticas.cliquesDoLink(h.idLink) } : h))));

  app.get('/api/painel', (_, res) => {
    const { status, numero } = robo.estado;
    const ultimosPosts = robo.historico.postados.slice(0, 6).map((h) => ({ codigo: h.codigo, grupo: h.origem?.grupo, modelo: h.modelo, ano: h.ano, venda: h.venda, quando: h.quando, vendido: !!h.vendido, cliques: h.idLink ? estatisticas.cliquesDoLink(h.idLink) : null }));
    res.json({ ...estatisticas.resumo(), ultimosPosts, limiteDiario: config.get().limiteDiario, conexao: { status, numero }, pendentes: robo.pendentes.size });
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
