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
  normalizeMessageContent,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const config = require('./config');
const { parseAnuncio } = require('./parser');
const { montarTexto, aplicarMargem, formatarReais } = require('./modelo');
const { completarFipe, normalizar } = require('./fipe');
const { aplicarLogo } = require('./logo');
const { filtrarAntesDaFipe, filtrarFipe, descontoFipe } = require('./filtros');

const { DATA_DIR } = config;
const DIR_AUTH = path.join(DATA_DIR, 'auth');
const DIR_PEND = path.join(DATA_DIR, 'pendentes');
const ARQ_HIST = path.join(DATA_DIR, 'historico.json');
fs.mkdirSync(DIR_PEND, { recursive: true });

// Avisos/erros internos do WhatsApp ficam guardados (últimos 150) para o diagnóstico no painel
const diagnostico = [];
const logger = pino(
  { level: 'warn' },
  {
    write(linha) {
      try {
        const j = JSON.parse(linha);
        const extra = j.err?.message || j.error?.message || j.error || j.key?.remoteJid || j.jid || '';
        diagnostico.unshift(`${new Date(j.time).toLocaleTimeString('pt-BR')} ${j.level >= 50 ? 'ERRO' : 'aviso'}: ${j.msg || ''} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`.trim());
        diagnostico.length = Math.min(diagnostico.length, 150);
      } catch {}
    },
  }
);
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

const ARQ_EVENTOS = path.join(DATA_DIR, 'eventos.json');
try {
  estado.eventos = JSON.parse(fs.readFileSync(ARQ_EVENTOS, 'utf8'));
} catch {}

function evento(tipo, texto) {
  console.log(new Date().toLocaleTimeString('pt-BR'), tipo, texto);
  estado.eventos.unshift({ quando: Date.now(), tipo, texto });
  estado.eventos = estado.eventos.slice(0, 200);
  try {
    fs.writeFileSync(ARQ_EVENTOS, JSON.stringify(estado.eventos));
  } catch {}
}

// Tira "embrulhos" (mensagem temporária, visualização única, etc.) para chegar no conteúdo real
const conteudo = (m) => normalizeMessageContent(m.message) || {};
const textoDe = (m) => {
  const msg = conteudo(m);
  return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
};
const chaveCarro = (c) => [c.modelo, c.ano, c.km, c.preco].map((x) => String(x || '').toLowerCase()).join('|');
const nomeGrupo = (jid) => estado.grupos.find((g) => g.id === jid)?.nome || jid;
const jidAprovador = () => {
  const n = String(config.get().numeroAprovador || '').replace(/\D/g, '');
  return n ? `${n}@s.whatsapp.net` : null;
};

// Guarda as últimas mensagens (enviadas e recebidas): quando um celular não consegue abrir uma
// mensagem ele pede reenvio, e o WhatsApp precisa do conteúdo original (getMessage).
// Sem isso a mensagem fica "Aguardando mensagem" para quem recebe.
const guardadas = new Map();
function guardar(m) {
  if (!m?.key?.id || !m.message) return;
  guardadas.set(m.key.id, m.message);
  if (guardadas.size > 2000) guardadas.delete(guardadas.keys().next().value);
}

// Cache dos dados dos grupos (recomendado pela biblioteca para quem envia em grupos)
const cacheGrupos = new Map();
async function dadosGrupo(jid) {
  const c = cacheGrupos.get(jid);
  if (c && Date.now() - c.t < 5 * 60 * 1000) return c.d;
  return undefined;
}

async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState(DIR_AUTH);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    markOnlineOnConnect: false,
    getMessage: async (key) => guardadas.get(key.id),
    cachedGroupMetadata: dadosGrupo,
  });
  sock.ev.on('creds.update', saveCreds);
  const renovarGrupo = async (id) => {
    try {
      cacheGrupos.set(id, { t: Date.now(), d: await sock.groupMetadata(id) });
    } catch {}
  };
  sock.ev.on('groups.update', (lista) => lista.forEach((g) => renovarGrupo(g.id)));
  sock.ev.on('group-participants.update', (ev) => renovarGrupo(ev.id));

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
    for (const m of messages) {
      try {
        guardar(m);
        const jid = m.key.remoteJid;
        // 'append' = histórico/sincronização: só aceita se for mensagem dos últimos 2 minutos
        if (type !== 'notify' && Date.now() / 1000 - Number(m.messageTimestamp || 0) > 120) continue;
        if (config.get().gruposOrigem.includes(jid) && jid !== config.get().grupoDestino) {
          if (!m.message) {
            if (m.messageStubType === 2) evento('aviso', `Não consegui ler uma mensagem de ${nomeGrupo(jid)}: a criptografia do aparelho conectado ainda está sincronizando. Reenvie em alguns minutos.`);
            continue;
          }
          if (await tratarVendido(m)) continue;
          await receber(m);
        }
        else if (jid && jid === jidAprovador()) await comandoWhatsApp(textoDe(m));
      } catch (e) {
        evento('erro', 'Falha ao ler mensagem: ' + e.message);
      }
    }
  });
}

async function atualizarGrupos() {
  const g = await sock.groupFetchAllParticipating();
  for (const x of Object.values(g)) cacheGrupos.set(x.id, { t: Date.now(), d: x });
  estado.grupos = Object.values(g)
    .map((x) => ({
      id: x.id,
      nome: x.subject,
      membros: x.size || x.participants?.length || 0,
      sigla: siglaGrupo(x.id, x.subject),
      // grupos de Comunidade aparecem com o mesmo nome: diferencia para não confundir
      tipo: x.isCommunity ? 'comunidade (não recebe posts)' : x.isCommunityAnnounce ? 'avisos da comunidade' : x.announce ? 'só admins enviam' : '',
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
  return estado.grupos;
}

// Fotos e texto do mesmo carro chegam em mensagens separadas: junta por remetente durante alguns segundos.
// Separa os anúncios que a mesma pessoa manda em sequência. Há grupos que misturam os dois jeitos:
// "fotos e depois o texto" e "texto e depois as fotos". Regra: cada foto fica com o texto mais
// próximo dela no tempo. Ex.: texto HR-V ... (1 min) ... foto BYD ... (3 s) ... texto BYD
// -> a foto é do BYD, não do HR-V.
async function receber(m) {
  const cfg = config.get();
  const chave = `${m.key.remoteJid}|${m.key.participant || ''}`;
  const quando = Number(m.messageTimestamp) * 1000 || Date.now();
  const novo = () => ({ grupo: m.key.remoteJid, vendedor: m.key.participantAlt || m.key.participant, fotos: [], textos: [], ids: [], tTexto: null, t0: quando, timer: null });
  const fechar = (b) => {
    clearTimeout(b.timer);
    if (buffers.get(chave) === b) buffers.delete(chave);
    processar(b).catch((e) => evento('erro', 'Falha no anúncio: ' + e.message));
  };

  const ehFoto = !!conteudo(m).imageMessage;
  const t = textoDe(m);
  let b = buffers.get(chave);
  let herdadas = [];
  // um anúncio que já tem texto não recebe outro texto/legenda: é anúncio novo
  if (b && b.textos.length && t) {
    // fotos que chegaram depois do texto anterior, mas estão mais perto deste novo texto, são deste anúncio
    const anterior = b.tTexto;
    herdadas = b.fotos.filter((f) => f.t > anterior && quando - f.t <= 20000 && (quando - f.t) * 2 <= f.t - anterior);
    b.fotos = b.fotos.filter((f) => !herdadas.includes(f));
    b.ids = b.ids.filter((id) => !herdadas.some((f) => f.id === id));
    fechar(b);
    b = null;
  }
  if (!b) {
    b = novo();
    b.fotos.push(...herdadas);
    b.ids.push(...herdadas.map((f) => f.id));
    buffers.set(chave, b);
  }

  if (ehFoto && b.fotos.length < cfg.maxFotos) {
    b.fotos.push({
      t: quando,
      id: m.key.id,
      p: downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock?.updateMediaMessage }).catch((e) => {
        evento('aviso', `Não consegui baixar uma foto de ${nomeGrupo(m.key.remoteJid)}: ${e.message}`);
        return null;
      }),
    });
  }
  if (t) {
    b.textos.push(t);
    b.tTexto = quando;
  }
  b.ids.push(m.key.id);

  // texto solto depois das fotos = anúncio completo
  if (!ehFoto && t && b.fotos.length) return fechar(b);

  clearTimeout(b.timer);
  // Texto sem nenhuma foto ainda: o vendedor costuma mandar as fotos logo depois (álbum pode demorar)
  const espera = b.textos.length && !b.fotos.length ? cfg.segundosEsperandoFotos : cfg.segundosParaJuntarFotos;
  b.timer = setTimeout(() => fechar(b), espera * 1000);
}

// Limite diário de posts (conta o que já foi postado hoje + o que está na fila para postar)
let naFila = 0;
const diaSP = (t) => new Date(t).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
function postadosHoje() {
  const hoje = diaSP(Date.now());
  return historico.postados.filter((p) => diaSP(p.quando) === hoje).length + naFila;
}

// Código de origem no fim do post: sigla do grupo + hora em que o anúncio chegou. Ex.: #DR1001 = Danilo Repasse, 10:01
const PALAVRAS_SEM_SIGLA = new Set(['repasse', 'repasses', 'grupo', 'de', 'do', 'da', 'dos', 'das', 'sp', 'rj', 'mg', 'oficial', 'intermediacoes', 'intermediacao', 'automotive', 'veiculos', 'carros', 'multimarcas', 'the']);
function siglaAutomatica(nome, letras = 1) {
  const palavra = normalizar(nome).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).find((w) => w && !PALAVRAS_SEM_SIGLA.has(w));
  return `${palavra ? palavra.slice(0, letras) : 'X'}R`.toUpperCase();
}
function siglaGrupo(jid, nome = nomeGrupo(jid)) {
  const cfg = config.get();
  const manual = cfg.siglas?.[jid];
  if (manual) return manual.toUpperCase();
  const curta = siglaAutomatica(nome);
  // duas origens com a mesma sigla (ex.: Carol e REPASSE CHOICE = "CR"): a que vem depois na lista usa 2 letras ("CHR")
  const antes = cfg.gruposOrigem.slice(0, Math.max(0, cfg.gruposOrigem.indexOf(jid)));
  const conflito = antes.some((outro) => (cfg.siglas?.[outro] || siglaAutomatica(nomeGrupo(outro))).toUpperCase() === curta);
  return conflito ? siglaAutomatica(nome, 2) : curta;
}
function codigoOrigem(jid, quando) {
  // discreto, só a equipe entende: sigla + hora sem dois-pontos (#DR1001 = Danilo Repasse, 10:01)
  const hhmm = new Date(quando).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).replace(':', '');
  return `#${siglaGrupo(jid)}${hhmm}`;
}

async function processar({ grupo, vendedor, fotos: downloads, textos, ids = [], t0 = Date.now() }) {
  const cfg = config.get();
  const fotos = (await Promise.all(downloads.map((f) => f.p))).filter(Boolean);
  const falharam = downloads.length - fotos.length;
  evento('lendo', `${fotos.length} foto(s)${falharam ? ` (${falharam} não baixou)` : ''} e ${textos.length} texto(s) de ${nomeGrupo(grupo)}`);
  if (!textos.length) return evento('ignorado', `${nomeGrupo(grupo)} — só fotos, sem texto do anúncio`);
  if (!fotos.length && cfg.filtros.exigirFoto) {
    const inicio = textos[0].split('\n').find((l) => l.trim()) || '';
    return evento('ignorado', `${inicio.slice(0, 50)} — sem foto${falharam ? ' (a foto não baixou)' : ' (o vendedor não mandou foto)'}`);
  }
  const carro = parseAnuncio(textos.join('\n'));
  const nome = `${carro.modelo || textos[0].slice(0, 40)} ${carro.ano || ''}`.trim();

  const limite = cfg.limiteDiario;
  const motivo =
    filtrarAntesDaFipe(carro, cfg) ||
    (historico.chaves.includes(chaveCarro(carro)) && 'já postado') ||
    (limite > 0 && cfg.modo === 'auto' && postadosHoje() >= limite && `limite de ${limite} posts por dia atingido (volta amanhã)`);
  if (motivo) return evento('ignorado', `${nome} — ${motivo}`);

  await completarFipe(carro, cfg, (erro) => evento('aviso', `FIPE indisponível para ${nome}: ${erro}`));
  const motivoFipe = filtrarFipe(carro, cfg, postadosHoje());
  if (motivoFipe) return evento('ignorado', `${nome} — ${motivoFipe}`);
  // No automático, sem FIPE não dá para garantir que está abaixo: não posta
  if (cfg.modo === 'auto' && !carro.fipe) return evento('ignorado', `${nome} — FIPE não encontrada${carro.fipeMotivo ? ` (${carro.fipeMotivo})` : ''}`);

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
    origem: { grupo: nomeGrupo(grupo), vendedor: vendedor?.split('@')[0] || null, grupoJid: grupo, vendedorJid: vendedor, ids, recebidoEm: t0, codigo: codigoOrigem(grupo, t0) },
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
  naFila++;
  fila = fila.then(async () => {
    const cfg = config.get();
    if (!cfg.grupoDestino) throw new Error('Grupo de destino não configurado');
    item.carro.codigo = item.origem.codigo;
    const texto = montarTexto(item.carro, cfg, item.precoVenda);
    const msg = await enviar(cfg.grupoDestino, item.fotos.map((f) => path.join(dir, f)), texto);
    historico.chaves = [...historico.chaves, chaveCarro(item.carro)].slice(-3000);
    historico.postados = [
      {
        quando: Date.now(),
        modelo: item.carro.modelo,
        ano: item.carro.ano,
        custo: item.carro.preco,
        venda: item.precoVenda,
        fipe: item.carro.fipe,
        origem: item.origem,
        codigo: item.origem.codigo,
        textoOriginal: (item.carro.textoOriginal || '').slice(0, 2000),
        // para responder "VENDIDO" em cima do nosso post quando o vendedor avisar
        nosso: msg?.key ? { key: msg.key, texto: texto.slice(0, 300), grupo: cfg.grupoDestino } : null,
      },
      ...historico.postados,
    ].slice(0, 500);
    naFila--;
    salvarHist();
    fs.rmSync(dir, { recursive: true, force: true });
    evento('postado', `${item.carro.modelo} ${item.carro.ano || ''} por ${formatarReais(item.precoVenda)}`);
    await esperar(aleatorio(cfg.intervaloEntrePostagens));
  }).catch((e) => {
    naFila = Math.max(0, naFila - 1);
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
  if (!caminhosFotos.length) {
    const msg = await sock.sendMessage(jid, { text: texto });
    guardar(msg);
    return msg;
  }
  let principal;
  for (let i = 0; i < caminhosFotos.length; i++) {
    const msg = await sock.sendMessage(jid, { image: fs.readFileSync(caminhosFotos[i]), ...(i === 0 ? { caption: texto } : {}) });
    guardar(msg);
    if (i === 0) principal = msg;
    await esperar(800);
  }
  return principal;
}

async function desconectar() {
  try { await sock?.logout(); } catch {}
  fs.rmSync(DIR_AUTH, { recursive: true, force: true });
}

// ---------- Carro vendido ----------
// O vendedor avisa no grupo de origem: respondendo ao próprio anúncio, editando o anúncio,
// ou escrevendo "vendido" com o nome do carro. O robô responde em cima do nosso post.
const VENDIDO = /\bvendid[oa]s?\b|\bvendeu\b|\bsold\b/i;
const PALAVRAS_GENERICAS = new Set(['carro', 'vendido', 'vendida', 'vendeu', 'flex', 'manual', 'completo', 'automatico', 'aut', 'modelo', 'ano']);

function acharPostVendido(m, texto, refId) {
  const grupo = m.key.remoteJid;
  const vendedor = m.key.participantAlt || m.key.participant;
  const ativos = historico.postados.filter((p) => p.nosso && !p.vendido && p.origem?.grupoJid === grupo);
  // 1) resposta/edição do próprio anúncio: vínculo exato
  if (refId) {
    const exato = ativos.find((p) => p.origem.ids?.includes(refId));
    if (exato) return exato;
  }
  if (texto.length > 200) return null; // texto longo é anúncio, não aviso de venda
  const recentes = ativos.filter((p) => Date.now() - p.quando < 20 * 24 * 3600 * 1000);
  // 2) nome do carro no aviso: o post com mais palavras do modelo em comum
  const palavrasAviso = new Set(normalizar(texto).split(/[^a-z0-9.]+/).filter((w) => w.length >= 2 && !PALAVRAS_GENERICAS.has(w)));
  const pontos = (p) => normalizar(`${p.modelo} ${p.ano || ''}`).split(/[^a-z0-9.]+/).filter((w) => w.length >= 2 && palavrasAviso.has(w)).length;
  const comNome = recentes.map((p) => ({ p, n: pontos(p) + (p.origem.vendedorJid === vendedor ? 0.5 : 0) })).filter((x) => x.n >= 1).sort((a, b) => b.n - a.n);
  if (comNome.length && (comNome.length === 1 || comNome[0].n > comNome[1].n)) return comNome[0].p;
  // 3) só "vendido", sem nome: se o vendedor tem um único post nosso nas últimas 48h, é esse
  const doVendedor = recentes.filter((p) => p.origem.vendedorJid === vendedor && Date.now() - p.quando < 48 * 3600 * 1000);
  return doVendedor.length === 1 ? doVendedor[0] : null;
}

// Devolve true quando a mensagem não é anúncio (aviso de venda, edição, reação) e já foi tratada
async function tratarVendido(m) {
  const bruto = m.message || {};
  const protocolo = bruto.protocolMessage || bruto.editedMessage?.message?.protocolMessage;
  if (bruto.reactionMessage) return true;
  let texto;
  let refId;
  if (protocolo) {
    if (!protocolo.editedMessage) return true; // apagou mensagem etc.: nada a fazer
    texto = textoDe({ message: protocolo.editedMessage });
    refId = protocolo.key?.id;
  } else {
    const c = conteudo(m);
    texto = textoDe(m);
    const ctx = Object.values(c).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo;
    refId = ctx?.stanzaId;
  }
  if (!texto || !VENDIDO.test(normalizar(texto))) return !!protocolo; // edição sem "vendido" é ignorada
  // anúncio ainda em montagem: descarta
  for (const [chave, b] of buffers) {
    if (refId && b.ids.includes(refId)) {
      clearTimeout(b.timer);
      buffers.delete(chave);
      evento('ignorado', `anúncio de ${nomeGrupo(b.grupo)} foi vendido antes de postar`);
      return true;
    }
  }
  const post = acharPostVendido(m, texto, refId);
  if (!post) {
    if (refId || texto.length <= 200) evento('aviso', `"Vendido" em ${nomeGrupo(m.key.remoteJid)}, mas não achei qual post nosso é: "${texto.slice(0, 60)}"`);
    return refId || texto.length <= 200; // aviso curto não vira anúncio
  }
  const cfg = config.get();
  if (cfg.avisarVendido === false) return true;
  const aviso = cfg.textoVendido.replace('{modelo}', post.modelo || '').replace('{ano}', post.ano || '').trim();
  const msg = await sock.sendMessage(post.nosso.grupo, { text: aviso }, { quoted: { key: post.nosso.key, message: { conversation: post.nosso.texto } } });
  guardar(msg);
  post.vendido = Date.now();
  salvarHist();
  evento('vendido', `${post.modelo} ${post.ano || ''} — avisado no ${nomeGrupo(post.nosso.grupo)}`);
  return true;
}

async function enviarTeste(jid) {
  await enviar(jid, [], '✅ Teste do Robô de Repasse da Choice Cars. Pode apagar esta mensagem.');
  evento('ok', `Mensagem de teste enviada para ${nomeGrupo(jid)}`);
}

module.exports = {
  receber, // usado nos testes
  _teste: { usarSocket: (s) => (sock = s), tratarVendido, siglaGrupo },
  diagnostico,
  iniciar,
  enviarTeste,
  estado,
  historico,
  pendentes,
  aprovar,
  descartar,
  desconectar,
  atualizarGrupos,
  DIR_PEND,
};
