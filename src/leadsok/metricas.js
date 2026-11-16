// Números do comercial a partir do banco do LeadsOK. Datas no fuso de Brasília (UTC−3, sem horário de verão).
const banco = require('./banco');

const diaSP = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const VENDIDO = "COALESCE(lower(l.archive_reason), '') LIKE 'vendido%'";
const STATUS_FICHA = { 1: 'Pré-aprovado', 2: 'Pré-reprovado', 3: 'Em análise', 5: 'Erro' };
const nomeStatus = (s) => STATUS_FICHA[s] || 'Outros';

// Leads do período (pela data de criação). base: "entrada" (sem a base antiga de resgate) ou "resgate"
function coorte({ de, ate, origem, base = 'entrada' }) {
  const filtros = ["date(l.created_date, '-3 hours') BETWEEN ? AND ?", 'l.is_resgate = ?'];
  const args = [de, ate, base === 'resgate' ? 1 : 0];
  if (origem) {
    filtros.push('l.origem = ?');
    args.push(origem);
  }
  return { onde: filtros.join(' AND '), args };
}

// Expressões por lead (subconsultas): 1ª mensagem do vendedor/IA, cliente respondeu depois dela, etc.
const PRIMEIRA_LOJA = "(SELECT MIN(m.ts) FROM lk_mensagens m WHERE m.lead_id = l.id AND m.owner = 'salesman')";
const RESPONDEU = `EXISTS (SELECT 1 FROM lk_mensagens m WHERE m.lead_id = l.id AND m.owner = 'customers' AND m.ts > ${PRIMEIRA_LOJA})`;
const TEM_FICHA = 'EXISTS (SELECT 1 FROM lk_fichas f WHERE f.lead_id = l.id)';
const AGENDOU = "(l.agendado_alguma_vez = 1 OR EXISTS (SELECT 1 FROM lk_eventos e WHERE e.lead_id = l.id AND e.tipo = 'scheduled'))";
const VISITOU = 'EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = l.id AND v.compareceu = 1)';

function leads(filtro) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  const { onde, args } = coorte(filtro);
  const linha = (extra = '') => `SELECT COUNT(*) demanda,
      TOTAL(${PRIMEIRA_LOJA} IS NOT NULL) atendidos,
      TOTAL(${RESPONDEU}) responderam,
      TOTAL(${TEM_FICHA}) fichas,
      TOTAL(${AGENDOU}) agendados,
      TOTAL(${VISITOU}) visitas,
      TOTAL(${VENDIDO}) vendas,
      TOTAL(l.detalhe_em IS NOT NULL) detalhados
    FROM lk_leads l WHERE ${onde} ${extra}`;
  const total = d.prepare(linha()).get(...args);
  const agendamentos = d.prepare(`SELECT COUNT(*) n FROM lk_eventos e JOIN lk_leads l ON l.id = e.lead_id WHERE e.tipo = 'scheduled' AND ${onde}`).get(...args).n;
  const porOrigem = d.prepare(`SELECT l.origem, COUNT(*) demanda, TOTAL(${RESPONDEU}) responderam, TOTAL(${TEM_FICHA}) fichas, TOTAL(${AGENDOU}) agendados, TOTAL(${VENDIDO}) vendas
    FROM lk_leads l WHERE ${onde} GROUP BY l.origem ORDER BY demanda DESC`).all(...args);
  const porDia = d.prepare(`SELECT date(l.created_date, '-3 hours') dia, l.origem, COUNT(*) n FROM lk_leads l WHERE ${onde} GROUP BY dia, l.origem ORDER BY dia`).all(...args);
  const fichas = d.prepare(`SELECT f.banco, f.status, COUNT(DISTINCT f.lead_id) n FROM lk_fichas f JOIN lk_leads l ON l.id = f.lead_id WHERE ${onde} GROUP BY f.banco, f.status`).all(...args)
    .map((x) => ({ ...x, statusNome: nomeStatus(x.status) }));
  const origens = d.prepare('SELECT DISTINCT origem FROM lk_leads WHERE origem IS NOT NULL ORDER BY origem').all().map((x) => x.origem);
  return { filtro, total: { ...total, agendamentos }, porOrigem, porDia, fichas, origens };
}

// Por vendedor: o vendedor atual do lead (o LeadsOK não guarda quem estava com o lead em cada etapa
// de forma confiável no histórico; o "transfer" mostra quem transferiu, não sempre para quem)
function time(filtro, horasParado = 2) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  const { onde, args } = coorte(filtro);
  // 1ª resposta: do 1º "customers" até o próximo "salesman" (sem os leads da IA)
  const RESPOSTA_MIN = `(SELECT (julianday(MIN(s.ts)) - julianday(c.t)) * 1440 FROM lk_mensagens s,
      (SELECT MIN(ts) t FROM lk_mensagens WHERE lead_id = l.id AND owner = 'customers') c
     WHERE s.lead_id = l.id AND s.owner = 'salesman' AND s.ts > c.t)`;
  const linhas = d.prepare(`SELECT COALESCE(l.vendedor, 'Sem vendedor') vendedor, MAX(l.vendedor_is_ia) ia, COUNT(*) recebidos,
      AVG(CASE WHEN l.vendedor_is_ia = 0 THEN ${RESPOSTA_MIN} END) resposta_min,
      TOTAL(${RESPONDEU}) responderam, TOTAL(${TEM_FICHA}) fichas, TOTAL(${AGENDOU}) agendados, TOTAL(${VISITOU}) visitas, TOTAL(${VENDIDO}) vendas
    FROM lk_leads l WHERE ${onde} GROUP BY vendedor ORDER BY recebidos DESC`).all(...args);
  const limite = new Date(Date.now() - horasParado * 3600 * 1000).toISOString();
  const esperando = d.prepare(`SELECT COALESCE(vendedor, 'Sem vendedor') vendedor, COUNT(*) n FROM lk_leads
    WHERE aba_atual != 'arquivados' AND ultima_msg_owner = 'customers' AND ultima_msg_at < ? GROUP BY vendedor`).all(limite);
  const mapa = Object.fromEntries(esperando.map((x) => [x.vendedor, x.n]));
  return { horasParado, vendedores: linhas.map((v) => ({ ...v, esperandoAgora: mapa[v.vendedor] || 0 })), esperandoTotal: esperando.reduce((a, x) => a + x.n, 0) };
}

function agenda(dia = diaSP()) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  const itens = d.prepare(`SELECT a.id, a.lead_id, a.data, a.modalidade, a.concluido, a.pela_ia, l.nome, l.vendedor, l.origem, l.aba_atual,
      v.compareceu, v.marcado_por, v.marcado_em
    FROM lk_agenda a LEFT JOIN lk_leads l ON l.id = a.lead_id LEFT JOIN lk_visitas v ON v.lead_id = a.lead_id AND v.data_agendada = a.data
    WHERE date(a.data, '-3 hours') = ? ORDER BY a.data`).all(dia);
  return { dia, itens };
}

function marcarVisita({ leadId, data, compareceu, por }) {
  const d = banco.abrir();
  if (!d) throw new Error(banco.erro());
  if (compareceu === null) {
    d.prepare('DELETE FROM lk_visitas WHERE lead_id = ? AND data_agendada = ?').run(leadId, data);
  } else {
    d.prepare('INSERT OR REPLACE INTO lk_visitas (lead_id, data_agendada, compareceu, marcado_por, marcado_em) VALUES (?, ?, ?, ?, ?)').run(leadId, data, compareceu ? 1 : 0, por || 'painel', Date.now());
  }
  return { ok: true };
}

function estoque() {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  const agora = Date.now();
  const ativos = d.prepare('SELECT placa, marca, modelo, versao, ano, km, preco, imagem, primeira_vez FROM lk_estoque WHERE ativo = 1 ORDER BY primeira_vez').all()
    .map((c) => ({ ...c, dias: Math.floor((agora - c.primeira_vez) / 86400000) }));
  const saidas = d.prepare('SELECT placa, marca, modelo, ano, preco, primeira_vez, ultima_vez FROM lk_estoque WHERE ativo = 0 AND ultima_vez > ? ORDER BY ultima_vez DESC').all(agora - 30 * 86400000)
    .map((c) => ({ ...c, dias: Math.floor((c.ultima_vez - c.primeira_vez) / 86400000) }));
  const valor = ativos.reduce((a, c) => a + (c.preco || 0), 0);
  const desde = d.prepare('SELECT MIN(primeira_vez) t FROM lk_estoque').get().t;
  return { quantidade: ativos.length, valorTotal: valor, precoMedio: ativos.length ? valor / ativos.length : 0, ativos, saidas, acompanhandoDesde: desde };
}

// Resumo do dia para o Painel geral
function resumoHoje() {
  const d = banco.abrir();
  if (!d) return null;
  const hoje = diaSP();
  const mes = hoje.slice(0, 7);
  const leadsHoje = d.prepare("SELECT COUNT(*) n FROM lk_leads WHERE is_resgate = 0 AND date(created_date, '-3 hours') = ?").get(hoje).n;
  const agendHoje = d.prepare("SELECT COUNT(*) n FROM lk_agenda WHERE date(data, '-3 hours') = ?").get(hoje).n;
  // agendamentos FEITOS hoje: os que apareceram hoje na agenda + os do histórico com data de hoje (o maior dos dois)
  const naAgenda = d.prepare("SELECT COUNT(*) n FROM lk_agenda WHERE date(primeira_vez / 1000, 'unixepoch', '-3 hours') = ?").get(hoje).n;
  const noHistorico = d.prepare("SELECT COUNT(DISTINCT lead_id) n FROM lk_eventos WHERE tipo = 'scheduled' AND date(ts, '-3 hours') = ?").get(hoje).n;
  const agendFeitosHoje = Math.max(naAgenda, noHistorico);
  const vendasMes = d.prepare(`SELECT COUNT(*) n FROM lk_leads l WHERE ${VENDIDO}
    AND strftime('%Y-%m', COALESCE(datetime(l.vendido_em / 1000, 'unixepoch'), l.ultima_msg_at), '-3 hours') = ?`).get(mes).n;
  const visitasHoje = d.prepare('SELECT COUNT(*) n FROM lk_visitas WHERE compareceu = 1 AND date(data_agendada, \'-3 hours\') = ?').get(hoje).n;
  const total = d.prepare('SELECT COUNT(*) n FROM lk_leads').get().n;
  return { leadsHoje, agendamentosHoje: agendHoje, agendamentosFeitosHoje: agendFeitosHoje, vendasMes, visitasHoje, temDados: total > 0 };
}

// Totais do comercial num período (para o Painel geral): leads de entrada, agendamentos feitos, visitas e vendas
function resumoPeriodo(de, ate) {
  const d = banco.abrir();
  if (!d || !de || !ate) return null;
  const leads = d.prepare("SELECT COUNT(*) n FROM lk_leads WHERE is_resgate = 0 AND date(created_date, '-3 hours') BETWEEN ? AND ?").get(de, ate).n;
  const naAgenda = d.prepare("SELECT COUNT(*) n FROM lk_agenda WHERE date(primeira_vez / 1000, 'unixepoch', '-3 hours') BETWEEN ? AND ?").get(de, ate).n;
  const noHistorico = d.prepare("SELECT COUNT(DISTINCT lead_id) n FROM lk_eventos WHERE tipo = 'scheduled' AND date(ts, '-3 hours') BETWEEN ? AND ?").get(de, ate).n;
  const vendas = d.prepare(`SELECT COUNT(*) n FROM lk_leads l WHERE ${VENDIDO}
    AND date(COALESCE(datetime(l.vendido_em / 1000, 'unixepoch'), l.ultima_msg_at), '-3 hours') BETWEEN ? AND ?`).get(de, ate).n;
  const visitas = d.prepare("SELECT COUNT(*) n FROM lk_visitas WHERE compareceu = 1 AND date(data_agendada, '-3 hours') BETWEEN ? AND ?").get(de, ate).n;
  const total = d.prepare('SELECT COUNT(*) n FROM lk_leads').get().n;
  return { leads, agendamentos: Math.max(naAgenda, noHistorico), vendas, visitas, temDados: total > 0 };
}

// Fila do SDR: quem ligar ou chamar hoje, em ordem de urgência. Só leads de entrada (sem a base de resgate)
// e não arquivados. Cada lead aparece numa lista só (a mais urgente).
function filaSdr({ horasSemResposta = 1 } = {}) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  const hoje = diaSP();
  const amanha = diaSP(Date.now() + 86400000);
  const agora = Date.now();
  const iso = (ms) => new Date(agora - ms).toISOString();
  const campos = `l.id, l.nome, l.whatsapp, l.origem, l.vendedor, l.vendedor_is_ia ia, l.ultima_msg_owner, l.ultima_msg_at, l.created_date, l.aba_atual`;
  // lead encerrado pelo SDR (já comprou / sem interesse) sai da fila; quem agendou sai das listas de prospecção
  const base = `l.is_resgate = 0 AND l.aba_atual != 'arquivados' AND l.whatsapp IS NOT NULL
    AND l.id NOT IN (SELECT lead_id FROM lk_contatos WHERE resultado IN ('ja_comprou', 'sem_interesse'))`;
  const semAgendar = `AND l.id NOT IN (SELECT lead_id FROM lk_contatos WHERE resultado = 'agendou' AND em > ${agora - 14 * 86400000})`;
  const listas = {
    // 1) cliente mandou mensagem e ninguém respondeu
    responder: d.prepare(`SELECT ${campos} FROM lk_leads l WHERE ${base} AND l.ultima_msg_owner = 'customers' AND l.ultima_msg_at BETWEEN ? AND ? ${semAgendar} ORDER BY l.ultima_msg_at ASC LIMIT 100`).all(iso(7 * 86400000), iso(horasSemResposta * 3600000)),
    // 2) agendamentos de hoje e amanhã: confirmar presença
    confirmar: d.prepare(`SELECT ${campos}, a.data agenda_data, a.modalidade FROM lk_agenda a JOIN lk_leads l ON l.id = a.lead_id
      WHERE l.is_resgate = 0 AND date(a.data, '-3 hours') IN (?, ?) AND l.id NOT IN (SELECT lead_id FROM lk_contatos WHERE resultado IN ('ja_comprou', 'sem_interesse')) ORDER BY a.data ASC LIMIT 100`).all(hoje, amanha),
    // 3) leads novos (últimas 48 h) que ainda não responderam a loja: ligar
    novos: d.prepare(`SELECT ${campos} FROM lk_leads l WHERE ${base} AND l.created_date > ? AND COALESCE(l.ultima_msg_owner, 'salesman') != 'customers' ${semAgendar} ORDER BY l.created_date DESC LIMIT 100`).all(iso(48 * 3600000)),
    // 4) conversa parada: loja falou por último há 2 a 7 dias e o cliente sumiu, ou cliente sem resposta há 7 a 30 dias
    retomar: d.prepare(`SELECT ${campos} FROM lk_leads l WHERE ${base} AND ((l.ultima_msg_owner = 'salesman' AND l.ultima_msg_at BETWEEN ? AND ?) OR (l.ultima_msg_owner = 'customers' AND l.ultima_msg_at BETWEEN ? AND ?)) ${semAgendar} ORDER BY l.ultima_msg_at DESC LIMIT 100`).all(iso(7 * 86400000), iso(2 * 86400000), iso(30 * 86400000), iso(7 * 86400000)),
  };
  // um lead só na lista mais urgente
  const vistos = new Set();
  for (const k of ['responder', 'confirmar', 'novos', 'retomar']) listas[k] = listas[k].filter((l) => !vistos.has(l.id) && vistos.add(l.id));
  // contatos que o SDR já registrou hoje
  const contatos = d.prepare('SELECT lead_id, tipo, resultado, em, por FROM lk_contatos WHERE dia = ? ORDER BY em').all(hoje);
  const porLead = {};
  for (const c of contatos) (porLead[c.lead_id] ||= []).push(c);
  for (const k of Object.keys(listas)) for (const l of listas[k]) l.contatosHoje = porLead[l.id] || [];
  const resumo = { ligacoes: contatos.filter((c) => c.tipo === 'ligacao').length, atenderam: contatos.filter((c) => ['atendeu', 'agendou', 'ja_comprou', 'sem_interesse'].includes(c.resultado) && c.tipo === 'ligacao').length, mensagens: contatos.filter((c) => c.tipo === 'mensagem').length, agendou: contatos.filter((c) => c.resultado === 'agendou').length, leads: Object.keys(porLead).length };
  return { dia: hoje, horasSemResposta, listas, resumo };
}

const RESULTADOS = ['atendeu', 'nao_atendeu', 'enviada', 'agendou', 'ja_comprou', 'sem_interesse'];
function registrarContato({ leadId, tipo, resultado, por }) {
  const d = banco.abrir();
  if (!d) throw new Error(banco.erro());
  if (!['ligacao', 'mensagem'].includes(tipo)) throw new Error('Tipo de contato inválido');
  if (resultado && !RESULTADOS.includes(resultado)) throw new Error('Resultado inválido');
  d.prepare('INSERT INTO lk_contatos (lead_id, dia, tipo, resultado, em, por) VALUES (?, ?, ?, ?, ?, ?)').run(String(leadId), diaSP(), tipo, resultado || null, Date.now(), por || null);
  return { ok: true };
}

// Histórico de contatos registrados (para acompanhar o SDR): por dia e por pessoa
function historicoContatos({ dia, por } = {}) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  dia = dia || diaSP();
  const args = [dia];
  let filtro = '';
  if (por) {
    filtro = ' AND c.por = ?';
    args.push(por);
  }
  const contatos = d.prepare(`SELECT c.em, c.tipo, c.resultado, c.por, c.lead_id, l.nome, l.whatsapp, l.origem, l.vendedor, l.created_date
    FROM lk_contatos c LEFT JOIN lk_leads l ON l.id = c.lead_id WHERE c.dia = ?${filtro} ORDER BY c.em DESC LIMIT 500`).all(...args);
  const pessoas = d.prepare('SELECT DISTINCT por FROM lk_contatos WHERE por IS NOT NULL ORDER BY por').all().map((x) => x.por);
  return { dia, contatos, pessoas };
}

// Achar um lead pelo telefone (com ou sem 55/DDD) ou pelo nome, com todos os contatos já feitos
function buscarLead(q) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  q = String(q || '').trim();
  if (q.length < 3) return { leads: [] };
  const dig = q.replace(/\D/g, '');
  const leads = dig.length >= 8
    ? d.prepare("SELECT id, nome, whatsapp, origem, vendedor, aba_atual, archive_reason, created_date, ultima_msg_owner, ultima_msg_at, is_resgate FROM lk_leads WHERE replace(replace(replace(whatsapp, '+', ''), ' ', ''), '-', '') LIKE ? LIMIT 20").all('%' + dig.slice(-9))
    : d.prepare('SELECT id, nome, whatsapp, origem, vendedor, aba_atual, archive_reason, created_date, ultima_msg_owner, ultima_msg_at, is_resgate FROM lk_leads WHERE nome LIKE ? LIMIT 20').all('%' + q + '%');
  const cont = d.prepare('SELECT em, tipo, resultado, por FROM lk_contatos WHERE lead_id = ? ORDER BY em DESC');
  const ag = d.prepare('SELECT data, modalidade FROM lk_agenda WHERE lead_id = ? ORDER BY data DESC');
  return { leads: leads.map((l) => ({ ...l, contatos: cont.all(l.id), agenda: ag.all(l.id) })) };
}

module.exports = { filaSdr, registrarContato, historicoContatos, buscarLead, resumoPeriodo, leads, time, agenda, marcarVisita, estoque, resumoHoje, diaSP };
