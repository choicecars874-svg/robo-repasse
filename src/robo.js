// Conexão com o WhatsApp + fluxo: capturar -> filtrar -> FIPE -> logo -> aprovar -> postar.
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const config = require('./config');
const { parseAnuncio } = require('./parser');
const { montarTexto, aplicarMargem, formatarReais } = require('./modelo');
const { consultarFipe } = require('./fipe');
const { aplicarLogo } = require('./logo');
const { filtrarAntesDaFipe, filtrarFipe, descontoFipe } = require('./filtros');

const { DATA_DIR } = config;
const DIR_AUTH = path.join(DATA_DIR, 'auth');
const DIR_PEND = path.join(DATA_DIR, 'pendentes');
const ARQ_HIST = path.join(DATA_DIR, 'historico.json');
fs.mkdirSync(DIR_PEND, { recursive: true });

const logger = pino({ level: 'silent' });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const aleatorio = ([min, max]) => (min + Math.random() * (max - min)) * 1000;

const estado = { status: 'iniciando', qr: null, numero: null, grupos: [], eventos: [] };
const historico = fs.existsSync(ARQ_HIST) ? JSON.parse(fs.readFileSync(ARQ_HIST, 'utf8')) : { chaves: [], postados: [] };
const salvarHist = () => fs.writeFileSync(ARQ_HIST, JSON.stringify(historico));

const pendentes = new Map();
for (const id of fs.readdirSync(DIR_PEND)) {
  const meta = path.join(DIR_PEND, id, 'meta.json');
  if (fs.existsSync(meta)) pendentes.set(id, JSON.parse(fs.readFileSync(meta, 'utf8')));
}

let sock = null;
const buffers = new Map();
let fila = Promise.resolve();

function evento(tipo, texto) {
  console.log(new Date().toLocaleTimeString('pt-BR'), tipo, texto);
  estado.eventos.unshift({ quando: Date.now(), tipo, texto });
  estado.eventos = estado.eventos.slice(0, 200);
}

const textoDe = (m) => {
  const msg = m.message || {};
  return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
};
const chaveCarro = (c) => [c.modelo, c.ano, c.km, c.preco].map((x) => String(x || '').toLowerCase()).join('|');
const nomeGrupo = (jid) => estado.grupos.find((g) => g.id === jid)?.nome || jid;
const jidAprovador = () => {
  const n = String(config.get().numeroAprovador || '').replace(/\D/g, '');
  return n ? `${n}@s.whatsapp.net` : null;
};

async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState(DIR_AUTH);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger, markOnlineOnConnect: false });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      estado.status = 'aguardando-qr';
      estado.qr = await QRCode.toDataURL(qr);
    }
    if (connection === 'open') {
      estado.status = 'conectado';
      estado.qr = null;
      estado.numero = sock.user?.id?.split(':')[0];
      evento('ok', 'Conectado ao WhatsApp');
      atualizarGrupos().catch(() => {});
    }
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      estado.status = 'desconectado';
      if (codigo === DisconnectReason.loggedOut) {
        evento('erro', 'WhatsApp desconectado. Gere um novo QR no painel.');
        fs.rmSync(DIR_AUTH, { recursive: true, force: true });
      } else {
        evento('aviso', 'Conexão caiu, reconectando...');
      }
      setTimeout(iniciar, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        const jid = m.key.remoteJid;
        if (config.get().gruposOrigem.includes(jid) && !m.key.fromMe) await receber(m);
        else if (jid && jid === jidAprovador()) await comandoWhatsApp(textoDe(m));
      } catch (e) {
        evento('erro', 'Falha ao ler mensagem: ' + e.message);
      }
    }
  });
}

async function atualizarGrupos() {
  const g = await sock.groupFetchAllParticipating();
  estado.grupos = Object.values(g).map((x) => ({ id: x.id, nome: x.subject })).sort((a, b) => a.nome.localeCompare(b.nome));
  return estado.grupos;
}

// Fotos e texto do mesmo carro chegam em mensagens separadas: junta por remetente durante alguns segundos.
async function receber(m) {
  const cfg = config.get();
  const chave = `${m.key.remoteJid}|${m.key.participant || ''}`;
  const b = buffers.get(chave) || { grupo: m.key.remoteJid, vendedor: m.key.participant, fotos: [], textos: [], timer: null };
  buffers.set(chave, b);

  if (m.message?.imageMessage && b.fotos.length < cfg.maxFotos) {
    b.fotos.push(await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }));
  }
  const t = textoDe(m);
  if (t) b.textos.push(t);

  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    buffers.delete(chave);
    processar(b).catch((e) => evento('erro', 'Falha no anúncio: ' + e.message));
  }, cfg.segundosParaJuntarFotos * 1000);
}

async function processar({ grupo, vendedor, fotos, textos }) {
  const cfg = config.get();
  if (!textos.length) return;
  const carro = parseAnuncio(textos.join('\n'));
  const nome = `${carro.modelo || textos[0].slice(0, 40)} ${carro.ano || ''}`.trim();

  const motivo = filtrarAntesDaFipe(carro, cfg) || (historico.chaves.includes(chaveCarro(carro)) && 'já postado');
  if (motivo) return evento('ignorado', `${nome} — ${motivo}`);

  carro.fipeOrigem = carro.fipe ? 'anúncio' : null;
  if (!carro.fipe && cfg.fipe.consultarOnline) {
    try {
      const r = await consultarFipe(carro);
      if (r) Object.assign(carro, { fipe: r.valor, fipeVersao: r.versao, fipeOrigem: 'tabela FIPE' });
    } catch (e) {
      evento('aviso', `FIPE indisponível para ${nome}: ${e.message}`);
    }
  }
  const motivoFipe = filtrarFipe(carro, cfg);
  if (motivoFipe) return evento('ignorado', `${nome} — ${motivoFipe}`);
  // No automático, sem FIPE não dá para garantir que está abaixo: não posta
  if (cfg.modo === 'auto' && !carro.fipe) return evento('ignorado', `${nome} — FIPE não encontrada`);

  const id = Date.now().toString(36);
  const dir = path.join(DIR_PEND, id);
  fs.mkdirSync(dir, { recursive: true });
  const arquivos = [];
  for (let i = 0; i < fotos.length; i++) {
    const nomeArq = `${i}.jpg`;
    fs.writeFileSync(path.join(dir, nomeArq), await aplicarLogo(fotos[i], cfg.logo));
    arquivos.push(nomeArq);
  }

  const item = {
    id,
    criadoEm: Date.now(),
    carro,
    desconto: descontoFipe(carro, cfg),
    precoVenda: aplicarMargem(carro.preco, cfg.margem),
    fotos: arquivos,
    origem: { grupo: nomeGrupo(grupo), vendedor: vendedor?.split('@')[0] || null },
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(item));
  pendentes.set(id, item);
  evento('capturado', `${nome} — custo ${formatarReais(carro.preco)}, FIPE ${formatarReais(carro.fipe) || '?'}`);

  if (cfg.modo === 'auto') return aprovar(id);
  const aprovador = jidAprovador();
  if (aprovador && estado.status === 'conectado') {
    const texto = `🆕 *${id}* — custo ${formatarReais(carro.preco)} → venda ${formatarReais(item.precoVenda)}\nResponda: *ok ${id}* | *nao ${id}* | *preco ${id} 58000*\n\n${montarTexto(carro, cfg, item.precoVenda)}`;
    await enviar(aprovador, arquivos.slice(0, 1).map((f) => path.join(dir, f)), texto);
  }
}

async function comandoWhatsApp(texto) {
  const m = texto.trim().toLowerCase().match(/^(ok|sim|nao|não|preco|preço)\s+(\w+)\s*([\d.,]+)?/);
  if (!m || !pendentes.has(m[2])) return;
  const [, cmd, id, valor] = m;
  if (cmd.startsWith('n')) descartar(id);
  else await aprovar(id, cmd.startsWith('p') ? parseInt(valor.replace(/\D/g, ''), 10) : undefined);
  await sock.sendMessage(jidAprovador(), { text: cmd.startsWith('n') ? `🗑️ ${id} descartado` : `✅ ${id} postado` });
}

function aprovar(id, precoVenda) {
  const item = pendentes.get(id);
  if (!item) throw new Error('Anúncio não encontrado');
  if (precoVenda) item.precoVenda = precoVenda;
  pendentes.delete(id);
  const dir = path.join(DIR_PEND, id);

  // fila com pausa aleatória entre postagens para não parecer spam
  fila = fila.then(async () => {
    const cfg = config.get();
    if (!cfg.grupoDestino) throw new Error('Grupo de destino não configurado');
    await enviar(cfg.grupoDestino, item.fotos.map((f) => path.join(dir, f)), montarTexto(item.carro, cfg, item.precoVenda));
    historico.chaves = [...historico.chaves, chaveCarro(item.carro)].slice(-3000);
    historico.postados = [{ quando: Date.now(), modelo: item.carro.modelo, ano: item.carro.ano, custo: item.carro.preco, venda: item.precoVenda, fipe: item.carro.fipe, origem: item.origem }, ...historico.postados].slice(0, 500);
    salvarHist();
    fs.rmSync(dir, { recursive: true, force: true });
    evento('postado', `${item.carro.modelo} ${item.carro.ano || ''} por ${formatarReais(item.precoVenda)}`);
    await esperar(aleatorio(cfg.intervaloEntrePostagens));
  }).catch((e) => {
    pendentes.set(id, item); // volta para a lista se falhar
    evento('erro', `Não postou ${item.carro.modelo}: ${e.message}`);
  });
  return fila;
}

function descartar(id) {
  pendentes.delete(id);
  fs.rmSync(path.join(DIR_PEND, id), { recursive: true, force: true });
}

async function enviar(jid, caminhosFotos, texto) {
  if (estado.status !== 'conectado') throw new Error('WhatsApp não está conectado');
  if (!caminhosFotos.length) return sock.sendMessage(jid, { text: texto });
  for (let i = 0; i < caminhosFotos.length; i++) {
    await sock.sendMessage(jid, { image: fs.readFileSync(caminhosFotos[i]), ...(i === 0 ? { caption: texto } : {}) });
    await esperar(800);
  }
}

async function desconectar() {
  try { await sock?.logout(); } catch {}
  fs.rmSync(DIR_AUTH, { recursive: true, force: true });
}

module.exports = {
  iniciar,
  estado,
  historico,
  pendentes,
  aprovar,
  descartar,
  desconectar,
  atualizarGrupos,
  DIR_PEND,
};
