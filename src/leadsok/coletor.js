// Coletor do LeadsOK: roda sozinho no servidor (sem navegador, sem IA), só lendo.
// - a cada 15 min: páginas 1 a 3 de cada aba + detalhes (histórico, conversa, ficha) dos leads novos/alterados
// - 1x por hora: estoque e vendedores
// - de madrugada: reconciliação completa das listas
// Modo leve para a máquina de 1 GB: uma requisição por vez, pausa entre elas e para se faltar memória.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../config');
const { criarCliente } = require('./cliente');
const banco = require('./banco');

const ARQ = path.join(DATA_DIR, 'leadsok.json');
const ARQ_CHAVE = path.join(DATA_DIR, 'leadsok.chave');
const ABAS = ['leads_novos', 'em_conversacao', 'agendados', 'arquivados'];
const PAUSA_MS = 250;
const DETALHES_POR_CICLO = 60;
const MIN = 60 * 1000;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const memoriaLivreMB = () => {
  try {
    return parseInt(fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)[1], 10) / 1024;
  } catch {
    return 9999;
  }
};

// ---------- Configuração e senha (criptografada no disco, nunca volta para o navegador) ----------
let cfg = { email: '', senha: null, ativo: false, horasParado: 2 };
try {
  cfg = { ...cfg, ...JSON.parse(fs.readFileSync(ARQ, 'utf8')) };
} catch {}
const salvarCfg = () => fs.writeFileSync(ARQ, JSON.stringify(cfg), { mode: 0o600 });

function chave() {
  if (!fs.existsSync(ARQ_CHAVE)) fs.writeFileSync(ARQ_CHAVE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(ARQ_CHAVE, 'utf8').trim(), 'hex');
}
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const dado = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), dado: dado.toString('hex') };
}
function decifrar(s) {
  if (!s) return '';
  const d = crypto.createDecipheriv('aes-256-gcm', chave(), Buffer.from(s.iv, 'hex'));
  d.setAuthTag(Buffer.from(s.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(s.dado, 'hex')), d.final()]).toString('utf8');
}
const credenciais = () => ({
  email: process.env.LEADSOK_EMAIL || cfg.email,
  senha: process.env.LEADSOK_SENHA || decifrar(cfg.senha),
});

// ---------- Estado (o painel mostra) ----------
const estado = {
  rodando: false,
  fase: '',
  ultimaSync: null,
  ultimoOk: null,
  ultimoErro: null,
  falhasSeguidas: 0,
  totaisLeadsOK: {},
  chavesAgenda: null,
};
let cliente = null;
const obterCliente = () => (cliente ||= criarCliente(credenciais()));

function registrar(tipo, inicio, ok, erro, contagens) {
  try {
    banco.abrir().prepare('INSERT INTO lk_sync_log (inicio, fim, tipo, ok, erro, contagens) VALUES (?, ?, ?, ?, ?, ?)').run(inicio, Date.now(), tipo, ok ? 1 : 0, erro || null, JSON.stringify(contagens || {}));
    banco.abrir().prepare('DELETE FROM lk_sync_log WHERE inicio < ?').run(Date.now() - 30 * 24 * 60 * MIN);
  } catch {}
}

// ---------- Gravação ----------
const bool = (v) => (v === true || v === 'true' || v === 1 ? 1 : 0);
const ehVenda = (motivo) => /^vendido/i.test(String(motivo || '').trim());
function gravarLeads(d, aba, leads) {
  const agora = Date.now();
  // depois da 1ª carga, sabemos o momento em que o lead virou venda; na 1ª carga usa a última mensagem
  const marcaVenda = d.prepare('UPDATE lk_leads SET vendido_em = ? WHERE id = ? AND vendido_em IS NULL');
  const sel = d.prepare('SELECT agendado_alguma_vez FROM lk_leads WHERE id = ?');
  const up = d.prepare(`INSERT INTO lk_leads (id, conversa_id, nome, whatsapp, origem, vendedor, vendedor_is_ia, aba_atual, agendado_alguma_vez,
      archive_reason, tem_financiamento, created_date, ultima_msg_owner, ultima_msg_at, is_resgate, first_seen_at, updated_at, assinatura)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET conversa_id = excluded.conversa_id, nome = excluded.nome, whatsapp = excluded.whatsapp, origem = excluded.origem,
      vendedor = excluded.vendedor, vendedor_is_ia = excluded.vendedor_is_ia, aba_atual = excluded.aba_atual,
      agendado_alguma_vez = MAX(lk_leads.agendado_alguma_vez, excluded.agendado_alguma_vez), archive_reason = excluded.archive_reason,
      tem_financiamento = excluded.tem_financiamento, created_date = excluded.created_date, ultima_msg_owner = excluded.ultima_msg_owner,
      ultima_msg_at = excluded.ultima_msg_at, is_resgate = excluded.is_resgate, updated_at = excluded.updated_at, assinatura = excluded.assinatura`);
  let novos = 0;
  for (const l of leads) {
    const origem = String(l.customers_origin || 'unknown').trim().toLowerCase();
    const arquivo = l.archive_reason_name || null;
    if (!sel.get(l.id)) novos++;
    up.run(
      l.id, l.conversa_id || null, l.first_name || null, l.whatsapp || null, origem, l.vendedor_nome || null, bool(l.vendedor_is_ia), aba,
      aba === 'agendados' || bool(l.has_pending_schedule) ? 1 : 0, arquivo, bool(l.tem_financiamento), l.created_date || null,
      l.ultima_msg_owner || null, l.ultima_msg_at || null, origem === 'resgate' || bool(l.em_resgate) ? 1 : 0, agora, agora,
      [l.ultima_msg_at || '', aba, arquivo || ''].join('|')
    );
    if (ehVenda(arquivo) && cfg.cargaInicialFeita) marcaVenda.run(agora, l.id);
  }
  return novos;
}

// O item da agenda traz o lead num campo cujo nome não está documentado: tenta os mais prováveis
const idDoLead = (a) => a.customer_id || a.customerId || a.customers_id || a.lead_id || a.leadId || a.cliente_id || a.id_customer || a.customer?.id || null;
function gravarAgenda(d, agenda) {
  if (!Array.isArray(agenda)) return 0;
  estado.chavesAgenda = agenda[0] ? Object.keys(agenda[0]) : estado.chavesAgenda;
  const up = d.prepare(`INSERT INTO lk_agenda (id, lead_id, data, modalidade, concluido, pela_ia, visto_em, primeira_vez) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET lead_id = excluded.lead_id, data = excluded.data, modalidade = excluded.modalidade, concluido = excluded.concluido, pela_ia = excluded.pela_ia, visto_em = excluded.visto_em`);
  const marca = d.prepare('UPDATE lk_leads SET agendado_alguma_vez = 1 WHERE id = ?');
  const agora = Date.now();
  for (const a of agenda) {
    const lead = idDoLead(a);
    // primeira_vez = quando o agendamento apareceu (só depois da 1ª carga; antes não dá para saber quando foi feito)
    up.run(String(a.id), lead, a.date_scheduled || null, a.modality || null, bool(a.is_concluido), bool(a.scheduled_by_ia), agora, cfg.cargaInicialFeita ? agora : null);
    if (lead) marca.run(lead);
  }
  return agenda.length;
}

// ---------- Listas ----------
async function sincronizarListas(paginasMax) {
  const c = obterCliente();
  const cont = { paginas: 0, leads: 0, novos: 0, agenda: 0 };
  for (const aba of ABAS) {
    estado.fase = `lendo ${aba}`;
    const primeira = await c.pagina(aba, 1);
    const totalPaginas = Math.max(1, Math.ceil(primeira.total / (primeira.pageSize || 20)));
    estado.totaisLeadsOK[aba] = primeira.total;
    const ate = Math.min(totalPaginas, paginasMax);
    for (let n = 1; n <= ate; n++) {
      if (memoriaLivreMB() < 120) throw new Error('memória do servidor baixa: coleta pausada');
      const p = n === 1 ? primeira : await c.pagina(aba, n);
      estado.fase = `lendo ${aba} (${n}/${ate})`;
      banco.transacao((d) => {
        cont.novos += gravarLeads(d, aba, p.leads);
        if (n === 1 && p.agenda) cont.agenda = gravarAgenda(d, p.agenda); // a agenda inteira vem em toda página
      });
      cont.paginas++;
      cont.leads += p.leads.length;
      await esperar(PAUSA_MS);
    }
  }
  return cont;
}

// ---------- Detalhes de cada lead (histórico, conversa sem texto, ficha só com bancos) ----------
async function detalharLead(c, d, lead) {
  // histórico (paginado por limit/offset)
  const evs = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const r = await c.acao('getCustomerJourneyLog', [{ customerId: lead.id, limit: 100, offset }]);
    evs.push(...(r?.events || []));
    if (!r?.hasMore) break;
    await esperar(PAUSA_MS);
  }
  // conversa: só id, horário, quem mandou e tipo (o texto não é salvo)
  const msgs = [];
  let r = await c.acao('getChatMessages', [{ customerId: lead.id }]);
  msgs.push(...(r?.rows || []));
  let paginas = 1;
  // sem a conversa completa ainda: volta no tempo com "before" até o começo (no máximo 30 páginas por vez)
  while (r?.hasMore && !lead.chat_completo && paginas < 30) {
    const maisAntiga = msgs.reduce((a, m) => (!a || m.created_at < a ? m.created_at : a), null);
    await esperar(PAUSA_MS);
    r = await c.acao('getChatMessages', [{ customerId: lead.id, before: maisAntiga }]);
    msgs.push(...(r?.rows || []));
    paginas++;
  }
  const chatCompleto = lead.chat_completo || !r?.hasMore ? 1 : 0;
  await esperar(PAUSA_MS);
  // ficha: só os bancos (sem CPF, nome da mãe, nascimento, e-mail, dados do veículo)
  const f = await c.acao('getCustomerFinancing', [{ customerId: lead.id }]);

  banco.transacao(() => {
    const ev = d.prepare('INSERT OR REPLACE INTO lk_eventos (id, lead_id, tipo, ts, actor, conteudo) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of evs) ev.run(String(e.id), lead.id, e.eventType || null, e.eventTimestamp || null, e.actorLabel || null, e.eventContent == null ? null : (typeof e.eventContent === 'string' ? e.eventContent : JSON.stringify(e.eventContent)).slice(0, 300));
    if (evs.some((e) => e.eventType === 'scheduled')) d.prepare('UPDATE lk_leads SET agendado_alguma_vez = 1 WHERE id = ?').run(lead.id);
    const ms = d.prepare('INSERT OR IGNORE INTO lk_mensagens (id, lead_id, ts, owner, owner_name, tipo) VALUES (?, ?, ?, ?, ?, ?)');
    for (const m of msgs) ms.run(String(m.id), lead.id, m.created_at || null, m.messenger_owner || null, m.owner_name || null, m.type_message || null);
    d.prepare('DELETE FROM lk_fichas WHERE lead_id = ?').run(lead.id);
    const fi = d.prepare('INSERT OR REPLACE INTO lk_fichas (lead_id, banco, status, created_at, valor_financiado) VALUES (?, ?, ?, ?, ?)');
    for (const b of f?.banks || []) fi.run(lead.id, String(b.bank || '').toLowerCase(), String(b.status ?? ''), b.created_at || '', Number(b.value_financed) || null);
    d.prepare('UPDATE lk_leads SET detalhe_em = ?, detalhe_assinatura = assinatura, chat_completo = ? WHERE id = ?').run(Date.now(), chatCompleto, lead.id);
  });
  return { eventos: evs.length, mensagens: msgs.length, bancos: (f?.banks || []).length };
}

async function detalharPendentes(limite) {
  const d = banco.abrir();
  const c = obterCliente();
  // primeiro os leads de entrada mais recentes; a base de resgate fica por último
  const fila = d.prepare(`SELECT id, chat_completo FROM lk_leads WHERE detalhe_assinatura IS NULL OR detalhe_assinatura != assinatura
    ORDER BY is_resgate ASC, ultima_msg_at DESC LIMIT ?`).all(limite);
  let feitos = 0;
  let erros = 0;
  for (const lead of fila) {
    if (memoriaLivreMB() < 120) break;
    estado.fase = `detalhes ${feitos + 1}/${fila.length}`;
    try {
      await detalharLead(c, d, lead);
      feitos++;
      erros = 0;
    } catch (e) {
      estado.ultimoErro = `detalhe de um lead: ${e.message}`;
      if (++erros >= 3) throw new Error(`3 leads seguidos com erro (${e.message})`);
    }
    await esperar(PAUSA_MS);
  }
  const restantes = d.prepare('SELECT COUNT(*) n FROM lk_leads WHERE detalhe_assinatura IS NULL OR detalhe_assinatura != assinatura').get().n;
  return { detalhados: feitos, faltam: restantes };
}

// ---------- Estoque e vendedores ----------
async function sincronizarEstoque() {
  const c = obterCliente();
  const inv = await c.acao('listStoreInventory', []);
  const vend = await c.acao('listStoreSalesmen', []).catch(() => null);
  const agora = Date.now();
  banco.transacao((d) => {
    const up = d.prepare(`INSERT INTO lk_estoque (placa, marca, modelo, versao, ano, km, preco, imagem, primeira_vez, ultima_vez, ativo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(placa) DO UPDATE SET marca = excluded.marca, modelo = excluded.modelo, versao = excluded.versao, ano = excluded.ano, km = excluded.km,
        preco = excluded.preco, imagem = excluded.imagem, ultima_vez = excluded.ultima_vez, ativo = 1`);
    const vistas = [];
    for (const v of inv?.vehicles || []) {
      const placa = String(v.plate || '').toUpperCase().replace(/\s/g, '');
      if (!placa) continue;
      vistas.push(placa);
      up.run(placa, v.brand || null, v.model || null, v.version || null, String(v.year || ''), Number(v.mileage) || null, Number(v.price) || null, v.image || null, agora, agora);
    }
    // carro que sumiu da lista = saiu do estoque (data de saída = última vez visto)
    if (vistas.length) d.prepare(`UPDATE lk_estoque SET ativo = 0 WHERE ativo = 1 AND placa NOT IN (${vistas.map(() => '?').join(',')})`).run(...vistas);
    if (vend?.salesmen) {
      const vs = d.prepare('INSERT OR REPLACE INTO lk_vendedores (id, nome, setor) VALUES (?, ?, ?)');
      for (const s of vend.salesmen) vs.run(String(s.id), `${s.firstName || ''} ${s.lastName || ''}`.trim(), s.sector || null);
    }
  });
  return { carros: (inv?.vehicles || []).length };
}

// ---------- Ciclos ----------
let ultimaEstoque = 0;
let ultimaNoite = null;
async function ciclo(tipo = 'incremental') {
  if (estado.rodando || !cfg.ativo || banco.erro()) return;
  if (memoriaLivreMB() < 150) {
    estado.ultimoErro = 'memória do servidor baixa: coleta adiada para o próximo ciclo';
    return;
  }
  estado.rodando = true;
  const inicio = Date.now();
  const cont = {};
  try {
    const completo = tipo !== 'incremental' || !cfg.cargaInicialFeita;
    Object.assign(cont, await sincronizarListas(completo ? 9999 : 3));
    if (completo) {
      cfg.cargaInicialFeita = true;
      salvarCfg();
    }
    // cada etapa falha sozinha: estoque com problema não impede conversas e fichas
    const avisos = [];
    if (Date.now() - ultimaEstoque > 60 * MIN) {
      try {
        Object.assign(cont, await sincronizarEstoque());
        ultimaEstoque = Date.now();
      } catch (e) {
        avisos.push(`estoque: ${e.message}`);
      }
    }
    // com memória sobrando, detalha mais leads por ciclo (o funil completa mais rápido)
    const lote = memoriaLivreMB() > 300 ? 200 : DETALHES_POR_CICLO;
    try {
      Object.assign(cont, await detalharPendentes(lote));
    } catch (e) {
      avisos.push(`detalhes: ${e.message}`);
    }
    if (avisos.length) cont.avisos = avisos;
    estado.ultimoOk = Date.now();
    estado.falhasSeguidas = 0;
    estado.ultimoErro = cont.avisos ? cont.avisos.join(' · ') : null;
    registrar(completo ? 'completo' : 'incremental', inicio, true, null, cont);
  } catch (e) {
    estado.falhasSeguidas++;
    estado.ultimoErro = e.message;
    registrar(tipo, inicio, false, e.message, cont);
  } finally {
    estado.rodando = false;
    estado.fase = '';
    estado.ultimaSync = Date.now();
  }
}

function iniciar() {
  setTimeout(() => ciclo().catch(() => {}), 2 * MIN);
  setInterval(() => {
    // reconciliação completa 1x por noite (entre 3h e 4h de Brasília)
    const h = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const tipo = h === 3 && ultimaNoite !== hoje ? 'noturna' : 'incremental';
    if (tipo === 'noturna') ultimaNoite = hoje;
    ciclo(tipo).catch(() => {});
  }, 15 * MIN);
}

// ---------- Para o painel ----------
async function salvarCredenciais({ email, senha }) {
  email = String(email || '').trim();
  if (!email) throw new Error('Informe o e-mail');
  // testa antes de salvar
  const teste = criarCliente({ email, senha: senha || credenciais().senha });
  await teste.login();
  cfg.email = email;
  if (senha) cfg.senha = cifrar(senha);
  cfg.ativo = true;
  salvarCfg();
  cliente = null;
  setTimeout(() => ciclo().catch(() => {}), 1000);
  return { ok: true };
}
async function testarConexao() {
  const c = criarCliente(credenciais());
  await c.login();
  const p = await c.pagina('leads_novos', 1);
  return { ok: true, leadsNovos: p.total, acoes: Object.keys(c.acoes || {}).length };
}
function desligar() {
  cfg.ativo = false;
  salvarCfg();
}
function status() {
  const d = banco.abrir();
  let base = {};
  if (d) {
    base = d.prepare(`SELECT COUNT(*) leads, SUM(detalhe_em IS NOT NULL) detalhados, SUM(is_resgate) resgate FROM lk_leads`).get();
    base.ultimas = d.prepare('SELECT inicio, fim, tipo, ok, erro, contagens FROM lk_sync_log ORDER BY inicio DESC LIMIT 5').all();
  }
  return {
    configurado: !!(credenciais().email && credenciais().senha),
    email: credenciais().email || null,
    ativo: !!cfg.ativo,
    cargaInicialFeita: !!cfg.cargaInicialFeita,
    horasParado: cfg.horasParado,
    erroBanco: banco.erro(),
    problema: estado.falhasSeguidas >= 2 ? `Integração LeadsOK com problema: ${estado.ultimoErro}` : null,
    ...estado,
    base,
  };
}
function definirHorasParado(h) {
  cfg.horasParado = Math.max(0.5, Number(h) || 2);
  salvarCfg();
}

module.exports = { iniciar, ciclo, salvarCredenciais, testarConexao, desligar, status, definirHorasParado, horasParado: () => cfg.horasParado };
