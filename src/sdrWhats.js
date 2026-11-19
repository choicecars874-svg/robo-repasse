// WhatsApp do SDR: segunda conexão (QR Code próprio, separada do robô de repasse) usada só para o
// lembrete automático da visita. Limites para não arriscar o número: só clientes com visita marcada,
// uma mensagem por visita, das 8h às 20h, intervalo aleatório entre envios e teto por dia.
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const config = require('./config');
const banco = require('./leadsok/banco');

const logger = pino({ level: 'silent' });
// Uma conexão por pessoa (SDR, vendedores, gestor). Chave 'sdr' = a conexão antiga do SDR (pasta whats-sdr);
// as outras ficam em whats-u-<nome>. Dono e carteira de cada uma ficam em config.sdr.whatsDonos.
const sessoes = new Map(); // chave -> { sock, estado }
const log = [];
let enviando = false;
const slug = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const dirAuth = (chave) => path.join(config.DATA_DIR, chave === 'sdr' ? 'whats-sdr' : 'whats-u-' + slug(chave));
const donos = () => (config.get().sdr || {}).whatsDonos || {};
function sessao(chave = 'sdr') {
  if (!sessoes.has(chave)) sessoes.set(chave, { sock: null, estado: { status: 'desligado', qr: null, numero: null, desde: Date.now(), ultimoErro: null, enviadosHoje: 0, diaContagem: null } });
  return sessoes.get(chave);
}
// quem assina o lembrete de cada conexão
const nomeDe = (chave) => donos()[chave]?.nome || (chave === 'sdr' ? (config.get().sdr || {}).nomeSdr : '') || 'a equipe';
// conversa no WhatsApp do SDR (só em memória, nada é gravado): número -> última mensagem e se o cliente desmarcou
const conversas = new Map();
const meusEnvios = new Map(); // número -> quando o lembrete começou a ser enviado (não conta como conversa)
const chaveNum = (n) => String(n || '').replace(/\D/g, '').slice(-8);
// cliente avisando que não vem / quer mudar / já resolveu
const DESMARCOU = /\b(n[aã]o\s+(vou|vai|consigo|posso|irei|d[aá]\b|tenho como|estarei|vou mais)|desmarc|cancel|remarc|outro dia|fica pra outr|imprevisto|j[aá] comprei|comprei outro|desist|adiar|semana que vem)/i;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = () => ({ ativo: false, horasAntes: 2, horaInicio: 8, horaFim: 20, maxDia: 15, comFoto: true, estiloCard: 'cor', modeloCard: 'premium', ...((config.get().sdr || {}).lembreteAuto || {}) });
const horaSP = (t = Date.now()) => Number(new Date(t).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false })) % 24;
const diaSP = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
function registrar(tipo, texto, chave = null) {
  log.unshift({ em: Date.now(), tipo, texto: chave ? `[${String(nomeDe(chave)).split(' ')[0]}] ${texto}` : texto, chave });
  log.length = Math.min(log.length, 80);
}

// ---------- Conexão ----------
async function conectar(chave = 'sdr', dono = null) {
  const se = sessao(chave);
  const estado = se.estado;
  if (dono) {
    const c = config.get();
    config.salvar({ ...c, sdr: { ...c.sdr, whatsDonos: { ...donos(), [chave]: { nome: dono.nome, carteira: dono.carteira || null } } } });
  }
  if (se.sock) return;
  const DIR_AUTH = dirAuth(chave);
  fs.mkdirSync(DIR_AUTH, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(DIR_AUTH);
  const { version } = await fetchLatestBaileysVersion();
  estado.status = 'conectando';
  const sock = (se.sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  }));
  sock.ev.on('creds.update', saveCreds);
  // anota quando houve conversa com cada número (para o lembrete não cair no meio de uma conversa)
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages || []) {
      const k = m.key || {};
      const msg = m.message || {};
      const texto = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || '';
      if (!Object.keys(msg).length || msg.protocolMessage || msg.reactionMessage) continue;
      const em = Number(m.messageTimestamp) ? Number(m.messageTimestamp) * 1000 : Date.now();
      for (const jid of [k.remoteJid, k.remoteJidAlt, k.senderPn]) {
        if (!jid || !/@s\.whatsapp\.net$/.test(jid)) continue;
        const n = chaveNum(jid.split('@')[0]);
        if (k.fromMe && Date.now() - (meusEnvios.get(n) || 0) < 120000) continue; // o próprio lembrete
        const c = conversas.get(n) || { em: 0, desmarcou: 0 };
        c.em = Math.max(c.em, em);
        if (!k.fromMe && DESMARCOU.test(texto)) c.desmarcou = em;
        conversas.set(n, c);
      }
    }
  });
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      estado.status = 'aguardando-qr';
      estado.qr = await QRCode.toDataURL(qr);
    }
    if (connection === 'open') {
      estado.status = 'conectado';
      estado.qr = null;
      estado.desde = Date.now();
      estado.numero = sock.user?.id?.split(':')[0] || null;
      registrar('ok', 'WhatsApp conectado', chave);
    }
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (se.sock === sock) se.sock = null;
      if (estado.status === 'desligado') return; // desconectado pelo painel
      if (codigo === DisconnectReason.loggedOut) {
        estado.status = 'desligado';
        estado.numero = null;
        fs.rmSync(DIR_AUTH, { recursive: true, force: true });
        registrar('erro', 'WhatsApp foi desconectado no celular. Conecte de novo pelo QR.', chave);
        return;
      }
      estado.status = 'reconectando';
      setTimeout(() => conectar(chave).catch((e) => (estado.ultimoErro = e.message)), 5000);
    }
  });
}
async function desconectar(chave = 'sdr') {
  const se = sessao(chave);
  se.estado.status = 'desligado';
  try {
    await se.sock?.logout();
  } catch {}
  se.sock = null;
  fs.rmSync(dirAuth(chave), { recursive: true, force: true });
  se.estado.numero = null;
  se.estado.qr = null;
  registrar('aviso', 'WhatsApp desconectado pelo painel', chave);
}
const temSessao = (chave = 'sdr') => fs.existsSync(path.join(dirAuth(chave), 'creds.json'));
// conexões salvas no disco (para reconectar quando o servidor reinicia)
function chavesSalvas() {
  const l = [];
  if (temSessao('sdr')) l.push('sdr');
  for (const k of Object.keys(donos())) if (k !== 'sdr' && temSessao(k)) l.push(k);
  return l;
}
const conectada = (chave) => { const se = sessoes.get(chave); return !!se?.sock && se.estado.status === 'conectado'; };
// Por qual WhatsApp sai o lembrete: o de quem tem o lead na carteira (vendedor ou SDR); se ele não conectou, o do SDR
function quemEnvia(v) {
  const vend = semAcento(v.vendedor);
  if (vend) for (const [k, dn] of Object.entries(donos())) if (dn.carteira && semAcento(dn.carteira) === vend) {
    if (conectada(k)) return k;
    break;
  }
  return conectada('sdr') ? 'sdr' : null;
}
// dono da carteira do lead (mesmo sem conexão), para mostrar "esperando o WhatsApp do Murilo"
function donoDoLead(v) {
  const vend = semAcento(v.vendedor);
  for (const [k, dn] of Object.entries(donos())) if (dn.carteira && semAcento(dn.carteira) === vend) return k;
  return null;
}

// ---------- Carro do lead no estoque (foto) ----------
// Webmotors manda a placa no texto ("... | Placa: ABC1D23"); nos outros, procura pelo modelo e ano
function carroNoEstoque(textoCarro) {
  const d = banco.abrir();
  if (!d || !textoCarro) return null;
  const t = String(textoCarro).toUpperCase();
  const placa = t.match(/\b([A-Z]{3}-?\d[A-Z0-9]\d{2})\b/)?.[1]?.replace('-', '');
  if (placa) {
    const c = d.prepare('SELECT * FROM lk_estoque WHERE replace(upper(placa), \'-\', \'\') = ? AND imagem IS NOT NULL').get(placa);
    if (c) return c;
  }
  const ano = t.match(/\b(19|20)\d{2}\b/)?.[0];
  const palavras = t.replace(/\|.*$/, '').split(/[^A-Z0-9.]+/).filter((p) => p.length >= 2 && !/^(19|20)\d{2}$/.test(p));
  if (!palavras.length) return null;
  let melhor = null;
  for (const c of d.prepare('SELECT * FROM lk_estoque WHERE ativo = 1 AND imagem IS NOT NULL').all()) {
    const nome = `${c.marca || ''} ${c.modelo || ''} ${c.versao || ''}`.toUpperCase();
    let pontos = palavras.filter((p) => nome.includes(p)).length;
    if (!c.modelo || !nome.includes(String(c.modelo).toUpperCase()) || !t.includes(String(c.modelo).toUpperCase())) continue; // o modelo tem que bater
    if (ano && String(c.ano || '').includes(ano)) pontos += 2;
    if (!melhor || pontos > melhor.pontos) melhor = { ...c, pontos };
  }
  return melhor && melhor.pontos >= 2 ? melhor : null;
}

// ---------- Card da visita ----------
// "João, seu Jeep Compass está pronto te esperando" + "HOJE · 15H"
function fraseDoCard({ nome, carro, data }) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  const modelo = carro ? `${carro.marca || ''} ${carro.modelo || ''}`.trim() : '';
  const hora = new Date(data).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).replace(':00', 'h').replace(':', 'h');
  const dia = diaSP(Date.parse(data)) === diaSP() ? 'Hoje' : new Date(data).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' }).replace('-feira', '');
  return { titulo: `${primeiro ? primeiro + ', s' : 'S'}eu ${modelo || 'carro'} está pronto te esperando`, subtitulo: `${dia} · ${hora}` };
}
async function cardDaVisita({ nome, carro, data, modeloForcado }) {
  const { gerarCard, FOTO_LOJA } = require('./card');
  const f = fraseDoCard({ nome, carro, data });
  const modeloSem = modeloForcado || cfg().modeloCard;
  if (!carro?.imagem) {
    // sem o carro: fachada da Choice + "estamos te esperando"
    const primeiroSem = String(nome || '').trim().split(/\s+/)[0] || '';
    const ruaSem = String((config.get().loja || {}).endereco || '').split(/\s[–-]\s/)[0].trim();
    return gerarCard({ foto: fs.readFileSync(FOTO_LOJA), pb: cfg().estiloCard === 'pb', modelo: modeloSem, nome: primeiroSem, frase: 'estamos te esperando',
      titulo: `${primeiroSem ? primeiroSem + ', e' : 'E'}stamos te esperando`, subtitulo: f.subtitulo,
      quando: modeloSem === 'premium' ? `${f.subtitulo.replace(' · ', ' às ')}${ruaSem ? ' · ' + ruaSem : ''}` : f.subtitulo });
  }
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  const descricao = `${carro.marca || ''} ${carro.modelo || ''} ${carro.versao || ''} ${carro.ano || ''}`.replace(/\s+/g, ' ').trim();
  const modelo = modeloForcado || cfg().modeloCard;
  // "premium": frase curta (marca e modelo) e, no rodapé, dia, hora e a rua da loja ("HOJE ÀS 15H · AV. MARIA CAMPOS, 874")
  const curto = `${carro.marca || ''} ${carro.modelo || ''}`.replace(/\s+/g, ' ').trim();
  const rua = String((config.get().loja || {}).endereco || '').split(/\s[–-]\s/)[0].trim();
  const quando = modelo === 'premium' ? `${f.subtitulo.replace(' · ', ' às ')}${rua ? ' · ' + rua : ''}` : f.subtitulo;
  return gerarCard({ foto: carro.imagem, ...f, pb: cfg().estiloCard === 'pb', modelo, nome: primeiro, carro: modelo === 'premium' ? curto : descricao, quando });
}

// ---------- Texto do lembrete ----------
// Texto do lembrete automático: com o carro (reservado no seu nome) ou sem (loja te esperando)
function textoLembrete({ nome, carro, data, sdr, temCarro }) {
  const c = config.get().sdr || {};
  const modelo = (temCarro ? c.lembreteAutoCarro : c.lembreteAutoSemCarro) || c.lembreteDia ||
    'Fala {lead}, {saudacao}! Aqui é {sdr} da Choice Cars. Passando pra lembrar que hoje às {hora} você tem a visita marcada. Te espero na {endereco}!';
  const primeiro = (t) => String(t || '').trim().split(/\s+/)[0] || '';
  const carroCurto = String(carro || '').replace(/\s*\|.*$/, '').trim();
  const hora = new Date(data).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const h = horaSP();
  const saudacao = h < 12 ? 'bom dia' : h < 18 ? 'boa tarde' : 'boa noite';
  const endereco = String((config.get().loja || {}).endereco || 'nossa loja').trim();
  return modelo.replace(/bom dia/i, saudacao).replace(/\{saudacao\}/g, saudacao).replace(/\{lead\}/g, primeiro(nome) || 'tudo bem').replace(/\{sdr\}/g, primeiro(sdr) || 'a equipe')
    .replace(/\{hora\}/g, hora).replace(/\{carro\}/g, carroCurto || 'carro').replace(/\{endereco\}/g, endereco).replace(/\{quando\}/g, 'hoje');
}

// ---------- Quem recebe hoje ----------
// Visitas de hoje (agenda do LeadsOK presencial/online e visitas marcadas pelo SDR), ainda não aconteceram,
// sem resultado marcado e sem lembrete enviado. Envia a partir de (visita - horasAntes), dentro da janela.
function pendentesHoje() {
  const d = banco.abrir();
  if (!d) return [];
  const c = cfg();
  const hoje = diaSP();
  const agora = Date.now();
  const doLeadsOK = d.prepare(`SELECT a.lead_id, a.data, COALESCE(l.nome, a.nome) nome, COALESCE(l.whatsapp, a.telefone) whatsapp, COALESCE(l.carro, a.carro) carro, COALESCE(l.vendedor, a.vendedor) vendedor, COALESCE(a.primeira_vez, 0) primeira_vez
    FROM lk_agenda a LEFT JOIN lk_leads l ON l.id = a.lead_id
    WHERE a.lead_id IS NOT NULL AND COALESCE(a.modalidade, 'presencial') = 'presencial' AND COALESCE(a.concluido, 0) = 0 AND date(a.data, '-3 hours') = ?`).all(hoje);
  const doSdr = d.prepare(`SELECT c.lead_id, c.proximo_em, l.nome, l.whatsapp, l.carro, l.vendedor FROM lk_contatos c JOIN lk_leads l ON l.id = c.lead_id
    WHERE c.resultado = 'agendou' AND c.proximo_em IS NOT NULL AND c.id = (SELECT MAX(id) FROM lk_contatos WHERE lead_id = c.lead_id AND resultado = 'agendou')
      AND COALESCE(c.modalidade, 'presencial') = 'presencial' AND date(c.proximo_em / 1000, 'unixepoch', '-3 hours') = ?`).all(hoje).map((x) => ({ ...x, data: new Date(x.proximo_em).toISOString() }));
  const vistos = new Set();
  const lista = [];
  const jaEnviado = d.prepare("SELECT tipo, por FROM lk_confirmacoes WHERE lead_id = ? AND data_agendada = ? AND tipo IN ('lembrete', 'lembrete_erro', 'lembrete_pulado') ORDER BY tipo = 'lembrete' DESC");
  const excluida = d.prepare("SELECT 1 FROM lk_confirmacoes WHERE lead_id = ? AND data_agendada = ? AND tipo = 'excluido'");
  const ultAg = d.prepare("SELECT em, proximo_em FROM lk_contatos WHERE lead_id = ? AND resultado = 'agendou' AND proximo_em IS NOT NULL ORDER BY id DESC LIMIT 1");
  // venda já fechada (LeadsOK "Vendido", "Veio e comprou" na Agenda ou "já comprou" no briefing) ou "sem interesse" depois do agendamento
  const encerrado = d.prepare(`SELECT CASE WHEN lower(COALESCE(l.archive_reason, '')) LIKE 'vendido%' OR EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = l.id AND v.comprou = 1)
        OR EXISTS (SELECT 1 FROM lk_contatos c WHERE c.lead_id = l.id AND c.resultado = 'ja_comprou') THEN 'venda já fechada'
      WHEN EXISTS (SELECT 1 FROM lk_contatos c WHERE c.lead_id = l.id AND c.resultado = 'sem_interesse' AND c.em > ?) THEN 'cliente sem interesse' END motivo
    FROM lk_leads l WHERE l.id = ?`);
  const temResultado = d.prepare('SELECT 1 FROM lk_visitas WHERE lead_id = ? AND data_agendada = ?');
  const fora = ((config.get().sdr || {}).vendedoresFora || []).map((v) => String(v).toLowerCase());
  for (const v of [...doLeadsOK, ...doSdr]) {
    if (vistos.has(v.lead_id) || !v.whatsapp) continue;
    // agendamento do LeadsOK remarcado pelo SDR para outro horário de hoje: vale o do SDR (vem depois na lista)
    const ult0 = v.primeira_vez != null ? ultAg.get(v.lead_id) : null;
    if (ult0 && ult0.em > v.primeira_vez && new Date(ult0.proximo_em).toISOString() !== v.data && diaSP(ult0.proximo_em) === hoje) continue;
    vistos.add(v.lead_id);
    if (fora.some((f) => String(v.vendedor || '').toLowerCase().includes(f))) continue;
    const quando = Date.parse(v.data);
    if (quando <= agora) continue;
    const enviarEm = Math.max(quando - c.horasAntes * 3600000, Date.parse(`${hoje}T${String(c.horaInicio).padStart(2, '0')}:00:00-03:00`));
    const env = jaEnviado.get(v.lead_id, v.data);
    const ult = ultAg.get(v.lead_id);
    const remarcada = v.primeira_vez != null && ult && ult.em > v.primeira_vez && new Date(ult.proximo_em).toISOString() !== v.data;
    const pular = excluida.get(v.lead_id, v.data) ? 'excluído da agenda' : remarcada ? 'visita remarcada pelo SDR para outro horário' : encerrado.get(quando - 7 * 86400000, v.lead_id)?.motivo || (env?.tipo === 'lembrete_pulado' ? env.por : null);
    lista.push({ ...v, enviarEm, pular, enviado: env?.tipo === 'lembrete', falhou: env?.tipo === 'lembrete_erro', comResultado: !!temResultado.get(v.lead_id, v.data) });
  }
  return lista.sort((a, b) => a.enviarEm - b.enviarEm);
}

// ---------- Antes de enviar: a conversa está rolando? o cliente desmarcou? ----------
// Olha o WhatsApp do SDR (memória) e a conversa no LeadsOK (só leitura, nada é gravado).
// Devolve o motivo para NÃO mandar, ou null.
async function motivoParaNaoEnviar(v) {
  const janela = (Number(cfg().horasConversa) || 3) * 3600000;
  const agora = Date.now();
  const c = conversas.get(chaveNum(v.whatsapp));
  if (c?.desmarcou && agora - c.desmarcou < 48 * 3600000) return 'o cliente falou em desmarcar/não vir no seu WhatsApp';
  if (c?.em && agora - c.em < janela) return 'conversa em andamento no seu WhatsApp';
  if (String(v.lead_id).startsWith('agenda-') || String(v.lead_id).startsWith('teste-')) return null;
  try {
    const { mensagens } = await require('./leadsok/coletor').conversaRecente(v.lead_id, 20);
    const recentes = (mensagens || []).filter((m) => m.em && agora - Date.parse(m.em) < 48 * 3600000);
    if (recentes.some((m) => m.de === 'cliente' && DESMARCOU.test(m.texto))) return 'o cliente falou em desmarcar/não vir na conversa do LeadsOK';
    const ultima = recentes[recentes.length - 1];
    if (ultima && agora - Date.parse(ultima.em) < janela) return 'conversa em andamento no LeadsOK';
  } catch (e) {
    registrar('aviso', `Não consegui ler a conversa de ${v.nome || 'cliente'} no LeadsOK (${e.message}); conferi só o seu WhatsApp`);
  }
  return null;
}

// ---------- Envio ----------
async function enviarLembrete(v, { teste = false, chave = null } = {}) {
  chave = chave || quemEnvia(v);
  if (!chave || !conectada(chave)) throw new Error('Nenhum WhatsApp conectado para enviar');
  const sock = sessoes.get(chave).sock;
  const numero = String(v.whatsapp).replace(/\D/g, '');
  const [existe] = await sock.onWhatsApp(numero);
  if (!existe?.exists) throw new Error(`O número ${numero} não tem WhatsApp`);
  const sdr = nomeDe(chave);
  const carro = carroNoEstoque(v.carro);
  // no texto, o nome do carro do estoque (marca e modelo) quando achado; senão o que veio do lead
  const nomeCarro = carro ? `${carro.marca || ''} ${carro.modelo || ''}`.trim() : v.carro;
  const texto = textoLembrete({ nome: v.nome, carro: nomeCarro, data: v.data, sdr, temCarro: !!carro });
  meusEnvios.set(chaveNum(numero), Date.now());
  let card = null;
  if (cfg().comFoto) {
    // card com a foto do carro do cliente; sem carro no estoque, a foto da fachada da loja e "estamos te esperando"
    card = await cardDaVisita({ nome: v.nome, carro, data: v.data }).catch((e) => { registrar('aviso', `Card não foi montado (${e.message})`, chave); return null; });
  }
  if (card) await sock.sendMessage(existe.jid, { image: card, caption: texto });
  else if (carro?.imagem) await sock.sendMessage(existe.jid, { image: { url: carro.imagem }, caption: texto });
  else await sock.sendMessage(existe.jid, { text: texto });
  if (!teste) banco.abrir().prepare('INSERT OR REPLACE INTO lk_confirmacoes (lead_id, data_agendada, tipo, por, em) VALUES (?, ?, ?, ?, ?)').run(String(v.lead_id), v.data, 'lembrete', 'automático · ' + String(sdr).split(' ')[0], Date.now());
  return { chave, comFoto: !!carro?.imagem, comCard: !!card, fotoDaLoja: !!card && !carro?.imagem, texto };
}

async function rodada() {
  const c = cfg();
  if (!c.ativo || enviando || ![...sessoes.keys()].some(conectada)) return;
  const h = horaSP();
  if (h < c.horaInicio || h >= c.horaFim) return;
  for (const se of sessoes.values()) if (se.estado.diaContagem !== diaSP()) {
    se.estado.diaContagem = diaSP();
    se.estado.enviadosHoje = 0;
  }
  enviando = true;
  try {
    for (const v of pendentesHoje()) {
      if (v.enviado || v.falhou || v.pular || v.comResultado || v.enviarEm > Date.now()) continue;
      const chave = quemEnvia(v);
      if (!chave) continue; // ninguém conectado para este lead: espera
      const estado = sessoes.get(chave).estado;
      const motivo = await motivoParaNaoEnviar(v);
      if (motivo) {
        // não manda: o SDR já está falando com o cliente (ou ele desmarcou). Fica anotado e não tenta de novo.
        banco.abrir().prepare('INSERT OR REPLACE INTO lk_confirmacoes (lead_id, data_agendada, tipo, por, em) VALUES (?, ?, ?, ?, ?)').run(String(v.lead_id), v.data, 'lembrete_pulado', motivo.slice(0, 80), Date.now());
        registrar('aviso', `Lembrete de ${v.nome || 'cliente'} não foi enviado: ${motivo}`, chave);
        continue;
      }
      if (estado.enviadosHoje >= c.maxDia) {
        registrar('aviso', `Limite de ${c.maxDia} lembretes por dia atingido neste WhatsApp`, chave);
        continue;
      }
      try {
        const r = await enviarLembrete(v, { chave });
        estado.enviadosHoje++;
        registrar('ok', `Lembrete enviado para ${v.nome || 'cliente'} (visita ${new Date(v.data).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })})${r.comFoto ? ' com a foto do carro' : ''}`, chave);
      } catch (e) {
        registrar('erro', `Lembrete de ${v.nome || 'cliente'} não foi: ${e.message}`, chave);
        // não tenta de novo o mesmo número a cada minuto
        banco.abrir().prepare('INSERT OR REPLACE INTO lk_confirmacoes (lead_id, data_agendada, tipo, por, em) VALUES (?, ?, ?, ?, ?)').run(String(v.lead_id), v.data, 'lembrete_erro', e.message.slice(0, 80), Date.now());
      }
      await esperar(20000 + Math.random() * 70000); // 20 s a 1,5 min entre um envio e outro
    }
  } finally {
    enviando = false;
  }
}

function iniciar() {
  // reconecta uma por vez (não pesa no servidor na hora de subir)
  chavesSalvas().forEach((k, i) => setTimeout(() => conectar(k).catch((e) => (sessao(k).estado.ultimoErro = e.message)), i * 8000));
  setInterval(() => rodada().catch((e) => registrar('erro', e.message)), 60000);
}

// status da conexão de uma pessoa; todos = true (gestor/SDR) mostra todas as conexões e todos os lembretes do dia
function status(chave = 'sdr', { todos = true } = {}) {
  const se = sessao(chave);
  const nome1 = (k) => String(nomeDe(k)).split(' ')[0];
  const conexoes = [...new Set(['sdr', ...Object.keys(donos()), ...sessoes.keys()])].filter((k) => temSessao(k) || conectada(k) || (sessoes.get(k)?.estado.status || 'desligado') !== 'desligado')
    .map((k) => ({ chave: k, nome: nomeDe(k), carteira: donos()[k]?.carteira || null, status: sessao(k).estado.status, numero: sessao(k).estado.numero, enviadosHoje: sessao(k).estado.enviadosHoje }));
  const hoje = pendentesHoje().map((v) => {
    const vai = quemEnvia(v);
    const dono = donoDoLead(v);
    return { nome: v.nome, data: v.data, vendedor: v.vendedor || null, enviarEm: v.enviarEm, enviado: v.enviado, falhou: v.falhou, pular: v.pular, comResultado: v.comResultado, carro: v.carro, fotoDoCarro: !!carroNoEstoque(v.carro)?.imagem,
      vaiPor: vai ? nome1(vai) : null, meu: vai === chave || dono === chave, esperando: !vai ? (dono ? `esperando o WhatsApp de ${nome1(dono)} (ou o do SDR) conectar` : 'esperando o WhatsApp do SDR conectar') : null };
  }).filter((v) => todos || v.meu);
  const c = config.get().sdr || {};
  return { ...se.estado, chave, temSessao: temSessao(chave), conectado: conectada(chave), config: cfg(), nomeSdr: nomeDe(chave) === 'a equipe' ? '' : nomeDe(chave), textos: { carro: c.lembreteAutoCarro || '', semCarro: c.lembreteAutoSemCarro || '' },
    conexoes: todos ? conexoes : conexoes.filter((x) => x.chave === chave), hoje, log: log.filter((x) => todos || x.chave === chave || !x.chave).slice(0, 40) };
}

// só para teste automatizado: usa um socket falso
const _usarSock = (s, chave = 'sdr', numero = '5511999990000') => { const se = sessao(chave); se.sock = s; se.estado.status = 'conectado'; se.estado.numero = numero; };

const _conversas = conversas;
module.exports = { quemEnvia, chavesSalvas, _conversas, motivoParaNaoEnviar, cardDaVisita, fraseDoCard, _usarSock, rodada, iniciar, conectar, desconectar, status, enviarLembrete, carroNoEstoque, textoLembrete, pendentesHoje };
