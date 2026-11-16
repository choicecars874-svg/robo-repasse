// Números do comercial a partir do banco do LeadsOK. Datas no fuso de Brasília (UTC−3, sem horário de verão).
const banco = require('./banco');

const diaSP = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const VENDIDO = "COALESCE(lower(l.archive_reason), '') LIKE 'vendido%'";
const STATUS_FICHA = { 1: 'Pré-aprovado', 2: 'Pré-reprovado', 3: 'Em análise', 5: 'Erro' };
const nomeStatus = (s) => STATUS_FICHA[s] || 'Outros';

// Leads do período (pela data de criação). base: "entrada" (sem a base antiga de resgate) ou "resgate"
// Canais que não entram na visão de Leads e canais (contato direto, não é mídia paga)
const FORA_DOS_CANAIS = ['whatsapp', 'manual'];
function coorte({ de, ate, origem, base = 'entrada', ocultar = [] }) {
  const filtros = ["date(l.created_date, '-3 hours') BETWEEN ? AND ?", 'l.is_resgate = ?'];
  const args = [de, ate, base === 'resgate' ? 1 : 0];
  if (origem) {
    filtros.push('l.origem = ?');
    args.push(origem);
  } else if (ocultar.length) {
    filtros.push(`COALESCE(l.origem, '') NOT IN (${ocultar.map(() => '?').join(',')})`);
    args.push(...ocultar);
  }
  return { onde: filtros.join(' AND '), args };
}

// Expressões por lead (subconsultas): 1ª mensagem do vendedor/IA, cliente respondeu depois dela, etc.
const PRIMEIRA_LOJA = "(SELECT MIN(m.ts) FROM lk_mensagens m WHERE m.lead_id = l.id AND m.owner = 'salesman')";
const RESPONDEU = `EXISTS (SELECT 1 FROM lk_mensagens m WHERE m.lead_id = l.id AND m.owner = 'customers' AND m.ts > ${PRIMEIRA_LOJA})`;
const TEM_FICHA = 'EXISTS (SELECT 1 FROM lk_fichas f WHERE f.lead_id = l.id)';
const AGENDOU = "(l.agendado_alguma_vez = 1 OR EXISTS (SELECT 1 FROM lk_eventos e WHERE e.lead_id = l.id AND e.tipo = 'scheduled'))";
const VISITOU = 'EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = l.id AND v.compareceu = 1)';
const NAO_VEIO = 'EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = l.id AND v.compareceu = 0)';
const VEIO_NAO_COMPROU = 'EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = l.id AND v.compareceu = 1 AND v.comprou = 0)';
// comprou: vendido no LeadsOK ou marcado "Veio e comprou" na Agenda
const COMPROU = `(${VENDIDO} OR EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = l.id AND v.comprou = 1))`;

function leads(filtro) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  const { onde, args } = coorte({ ...filtro, ocultar: filtro.todosCanais ? [] : FORA_DOS_CANAIS });
  const linha = (extra = '') => `SELECT COUNT(*) demanda,
      TOTAL(${PRIMEIRA_LOJA} IS NOT NULL) atendidos,
      TOTAL(${RESPONDEU}) responderam,
      TOTAL(${TEM_FICHA}) fichas,
      TOTAL(${AGENDOU}) agendados,
      TOTAL(${VISITOU}) visitas,
      TOTAL(${NAO_VEIO}) naoVieram,
      TOTAL(${VEIO_NAO_COMPROU}) vieramNaoCompraram,
      TOTAL(${COMPROU}) vendas,
      TOTAL(l.detalhe_em IS NOT NULL) detalhados
    FROM lk_leads l WHERE ${onde} ${extra}`;
  const total = d.prepare(linha()).get(...args);
  const agendamentos = d.prepare(`SELECT COUNT(*) n FROM lk_eventos e JOIN lk_leads l ON l.id = e.lead_id WHERE e.tipo = 'scheduled' AND ${onde}`).get(...args).n;
  const porOrigem = d.prepare(`SELECT l.origem, COUNT(*) demanda, TOTAL(${RESPONDEU}) responderam, TOTAL(${TEM_FICHA}) fichas, TOTAL(${AGENDOU}) agendados, TOTAL(${VISITOU}) visitas, TOTAL(${COMPROU}) vendas
    FROM lk_leads l WHERE ${onde} GROUP BY l.origem ORDER BY demanda DESC`).all(...args);
  const porDia = d.prepare(`SELECT date(l.created_date, '-3 hours') dia, l.origem, COUNT(*) n FROM lk_leads l WHERE ${onde} GROUP BY dia, l.origem ORDER BY dia`).all(...args);
  const fichas = d.prepare(`SELECT f.banco, f.status, COUNT(DISTINCT f.lead_id) n FROM lk_fichas f JOIN lk_leads l ON l.id = f.lead_id WHERE ${onde} GROUP BY f.banco, f.status`).all(...args)
    .map((x) => ({ ...x, statusNome: nomeStatus(x.status) }));
  const origens = d.prepare('SELECT DISTINCT origem FROM lk_leads WHERE origem IS NOT NULL ORDER BY origem').all().map((x) => x.origem).filter((o) => filtro.todosCanais || !FORA_DOS_CANAIS.includes(o));
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
      TOTAL(${RESPONDEU}) responderam, TOTAL(${TEM_FICHA}) fichas, TOTAL(${AGENDOU}) agendados, TOTAL(${VISITOU}) visitas, TOTAL(${COMPROU}) vendas
    FROM lk_leads l WHERE ${onde} GROUP BY vendedor ORDER BY recebidos DESC`).all(...args);
  const esperando = esperandoAgora(d, horasParado);
  const mapa = Object.fromEntries(esperando.map((x) => [x.vendedor, x.n]));
  // agendamentos FEITOS e visitas no período (pela data do fato, não da criação do lead), por vendedor do lead
  const filtroOrigem = filtro.origem ? 'AND l.origem = ?' : '';
  const argsO = filtro.origem ? [filtro.origem] : [];
  const agPorVend = Object.fromEntries(d.prepare(`SELECT COALESCE(l.vendedor, 'Sem vendedor') vendedor, COUNT(DISTINCT e.lead_id || date(e.ts, '-3 hours')) n
    FROM lk_eventos e JOIN lk_leads l ON l.id = e.lead_id WHERE e.tipo = 'scheduled' AND date(e.ts, '-3 hours') BETWEEN ? AND ? ${filtroOrigem} GROUP BY vendedor`).all(filtro.de, filtro.ate, ...argsO).map((x) => [x.vendedor, x.n]));
  const viPorVend = Object.fromEntries(d.prepare(`SELECT COALESCE(l.vendedor, 'Sem vendedor') vendedor, TOTAL(v.compareceu = 1) vieram, TOTAL(v.compareceu = 0) naoVieram, TOTAL(v.comprou = 1) compraram
    FROM lk_visitas v JOIN lk_leads l ON l.id = v.lead_id WHERE date(v.data_agendada, '-3 hours') BETWEEN ? AND ? ${filtroOrigem} GROUP BY vendedor`).all(filtro.de, filtro.ate, ...argsO).map((x) => [x.vendedor, x]));
  // por dia: leads que chegaram, tempo médio da 1ª resposta (só humanos), agendamentos feitos e visitas
  const porDia = {};
  const dia = (k) => (porDia[k] ||= { dia: k, leads: 0, resposta_min: null, agendamentos: 0, vieram: 0, naoVieram: 0, esperandoPico: null });
  for (const x of d.prepare(`SELECT date(l.created_date, '-3 hours') dia, COUNT(*) leads, AVG(CASE WHEN l.vendedor_is_ia = 0 THEN ${RESPOSTA_MIN} END) resposta_min
    FROM lk_leads l WHERE ${onde} GROUP BY dia`).all(...args)) Object.assign(dia(x.dia), { leads: x.leads, resposta_min: x.resposta_min });
  for (const x of d.prepare(`SELECT date(e.ts, '-3 hours') dia, COUNT(DISTINCT e.lead_id) n FROM lk_eventos e JOIN lk_leads l ON l.id = e.lead_id
    WHERE e.tipo = 'scheduled' AND date(e.ts, '-3 hours') BETWEEN ? AND ? ${filtroOrigem} GROUP BY dia`).all(filtro.de, filtro.ate, ...argsO)) dia(x.dia).agendamentos = x.n;
  for (const x of d.prepare(`SELECT date(a.primeira_vez / 1000, 'unixepoch', '-3 hours') dia, COUNT(*) n FROM lk_agenda a LEFT JOIN lk_leads l ON l.id = a.lead_id
    WHERE a.primeira_vez IS NOT NULL AND date(a.primeira_vez / 1000, 'unixepoch', '-3 hours') BETWEEN ? AND ? ${filtroOrigem} GROUP BY dia`).all(filtro.de, filtro.ate, ...argsO)) dia(x.dia).agendamentos = Math.max(dia(x.dia).agendamentos, x.n);
  for (const x of d.prepare(`SELECT date(v.data_agendada, '-3 hours') dia, TOTAL(v.compareceu = 1) vieram, TOTAL(v.compareceu = 0) naoVieram FROM lk_visitas v JOIN lk_leads l ON l.id = v.lead_id
    WHERE date(v.data_agendada, '-3 hours') BETWEEN ? AND ? ${filtroOrigem} GROUP BY dia`).all(filtro.de, filtro.ate, ...argsO)) Object.assign(dia(x.dia), { vieram: x.vieram, naoVieram: x.naoVieram });
  // pico de leads esperando em cada dia (das fotos tiradas a cada coleta)
  for (const x of d.prepare(`SELECT dia, MAX(total) pico FROM (SELECT date(em / 1000, 'unixepoch', '-3 hours') dia, em, SUM(n) total FROM lk_esperando GROUP BY em)
    WHERE dia BETWEEN ? AND ? GROUP BY dia`).all(filtro.de, filtro.ate)) dia(x.dia).esperandoPico = x.pico;
  // tempo da 1ª resposta em faixas (só humanos)
  const faixas = d.prepare(`SELECT TOTAL(m <= 5) ate5, TOTAL(m > 5 AND m <= 15) ate15, TOTAL(m > 15 AND m <= 60) ate60, TOTAL(m > 60 AND m <= 180) ate180, TOTAL(m > 180) mais
    FROM (SELECT ${RESPOSTA_MIN} m FROM lk_leads l WHERE ${onde} AND l.vendedor_is_ia = 0) WHERE m IS NOT NULL`).get(...args);
  // leads esperando ao longo das últimas 24 h, por vendedor
  const desde = Date.now() - 24 * 3600000;
  const hist = d.prepare('SELECT em, vendedor, n FROM lk_esperando WHERE em > ? ORDER BY em').all(desde);
  const fotos = {};
  for (const h of hist) (fotos[h.em] ||= { em: h.em, total: 0, porVendedor: {} }), (fotos[h.em].total += h.n), (fotos[h.em].porVendedor[h.vendedor] = h.n);
  return {
    horasParado,
    vendedores: linhas.map((v) => ({ ...v, esperandoAgora: mapa[v.vendedor] || 0, agendamentosFeitos: agPorVend[v.vendedor] || 0, vieram: viPorVend[v.vendedor]?.vieram || 0, naoVieram: viPorVend[v.vendedor]?.naoVieram || 0, compraramVisita: viPorVend[v.vendedor]?.compraram || 0 })),
    esperandoTotal: esperando.reduce((a, x) => a + x.n, 0),
    esperandoPorVendedor: esperando,
    esperando24h: Object.values(fotos),
    porDia: Object.values(porDia).sort((a, b) => (a.dia < b.dia ? -1 : 1)),
    faixasResposta: faixas,
  };
}

// Leads em que o cliente mandou a última mensagem há mais de X horas, por vendedor (agora)
function esperandoAgora(d, horasParado) {
  const limite = new Date(Date.now() - horasParado * 3600 * 1000).toISOString();
  return d.prepare(`SELECT COALESCE(vendedor, 'Sem vendedor') vendedor, COUNT(*) n FROM lk_leads
    WHERE aba_atual != 'arquivados' AND is_resgate = 0 AND ultima_msg_owner = 'customers' AND ultima_msg_at < ? AND ultima_msg_at > ? GROUP BY vendedor ORDER BY n DESC`).all(limite, new Date(Date.now() - 30 * 86400000).toISOString());
}
// Foto dos leads esperando, tirada a cada coleta (guarda 60 dias)
function registrarEsperando(horasParado = 2) {
  const d = banco.abrir();
  if (!d) return;
  const agora = Date.now();
  const lista = esperandoAgora(d, horasParado);
  banco.transacao((db) => {
    const ins = db.prepare('INSERT INTO lk_esperando (em, vendedor, n) VALUES (?, ?, ?)');
    if (!lista.length) ins.run(agora, '—', 0);
    for (const x of lista) ins.run(agora, x.vendedor, x.n);
    db.prepare('DELETE FROM lk_esperando WHERE em < ?').run(agora - 60 * 86400000);
  });
}

// Agenda de um período (de/ate, padrão hoje) com o resumo de comparecimento
function agenda({ de, ate } = {}) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  de ||= diaSP();
  ate ||= de;
  const itens = d.prepare(`SELECT a.id, a.lead_id, a.data, a.modalidade, a.concluido, a.pela_ia, l.nome, l.whatsapp, l.carro, l.vendedor, l.origem, l.aba_atual,
      v.compareceu, v.comprou, v.marcado_por, v.marcado_em
    FROM lk_agenda a LEFT JOIN lk_leads l ON l.id = a.lead_id LEFT JOIN lk_visitas v ON v.lead_id = a.lead_id AND v.data_agendada = a.data
    WHERE date(a.data, '-3 hours') BETWEEN ? AND ? ORDER BY a.data`).all(de, ate);
  const agora = new Date().toISOString();
  const resumo = { agendados: itens.length, vieram: 0, compraram: 0, vieramNaoCompraram: 0, naoVieram: 0, aMarcar: 0, futuros: 0 };
  for (const a of itens) {
    if (a.compareceu === 1) {
      resumo.vieram++;
      if (a.comprou === 1) resumo.compraram++;
      else resumo.vieramNaoCompraram++;
    } else if (a.compareceu === 0) resumo.naoVieram++;
    else if (a.data < agora) resumo.aMarcar++;
    else resumo.futuros++;
  }
  // por dia (para o gráfico da semana/mês)
  const porDia = {};
  for (const a of itens) {
    const dia = new Date(Date.parse(a.data) - 3 * 3600000).toISOString().slice(0, 10);
    const x = (porDia[dia] ||= { dia, agendados: 0, vieram: 0, compraram: 0, naoVieram: 0 });
    x.agendados++;
    if (a.compareceu === 1) x.vieram++;
    if (a.comprou === 1) x.compraram++;
    if (a.compareceu === 0) x.naoVieram++;
  }
  return { de, ate, dia: de, itens, resumo, porDia: Object.values(porDia) };
}
// resultado: 'comprou' (veio e comprou), 'nao_comprou' (veio e não comprou), 'nao_veio' ou null (limpar)
const RESULTADOS_VISITA = { comprou: [1, 1], nao_comprou: [1, 0], nao_veio: [0, null] };
function marcarVisita({ leadId, data, resultado, compareceu, por }) {
  const d = banco.abrir();
  if (!d) throw new Error(banco.erro());
  if (!leadId || !data) throw new Error('Lead e data do agendamento são obrigatórios');
  // compatível com o botão antigo (compareceu true/false)
  if (resultado === undefined && compareceu !== undefined) resultado = compareceu === null ? null : compareceu ? 'nao_comprou' : 'nao_veio';
  if (resultado === null || resultado === '') {
    d.prepare('DELETE FROM lk_visitas WHERE lead_id = ? AND data_agendada = ?').run(leadId, data);
    return { ok: true };
  }
  const v = RESULTADOS_VISITA[resultado];
  if (!v) throw new Error('Resultado da visita inválido');
  d.prepare('INSERT OR REPLACE INTO lk_visitas (lead_id, data_agendada, compareceu, comprou, marcado_por, marcado_em) VALUES (?, ?, ?, ?, ?, ?)').run(leadId, data, v[0], v[1], por || 'painel', Date.now());
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
  const campos = `l.id, l.nome, l.whatsapp, l.carro, l.origem, l.vendedor, l.vendedor_is_ia ia, l.ultima_msg_owner, l.ultima_msg_at, l.created_date, l.aba_atual`;
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
    // 5) pós-visita (últimos 14 dias): não veio, ou veio e não comprou, e o SDR ainda não falou depois
    posVisita: d.prepare(`SELECT ${campos}, v.data_agendada agenda_data, v.compareceu, v.comprou FROM lk_visitas v JOIN lk_leads l ON l.id = v.lead_id
      WHERE l.is_resgate = 0 AND l.whatsapp IS NOT NULL AND v.marcado_em > ? AND (v.compareceu = 0 OR (v.compareceu = 1 AND v.comprou = 0))
        AND NOT (${VENDIDO}) AND NOT EXISTS (SELECT 1 FROM lk_visitas v2 WHERE v2.lead_id = l.id AND v2.comprou = 1)
        AND l.id NOT IN (SELECT lead_id FROM lk_contatos WHERE resultado IN ('ja_comprou', 'sem_interesse'))
        AND NOT EXISTS (SELECT 1 FROM lk_contatos c WHERE c.lead_id = l.id AND c.em > v.marcado_em)
      ORDER BY v.data_agendada DESC LIMIT 100`).all(agora - 14 * 86400000),
  };
  // CRM do SDR: o último contato de cada lead decide em que etapa ele está.
  // Só fica na fila de trabalho quem precisa de contato agora; o resto vai para a etapa da ação feita.
  const fimDeHoje = Date.parse(hoje + 'T23:59:59-03:00');
  const ultimos = {};
  const tentativas = {};
  for (const c of d.prepare('SELECT lead_id, em, por, tipo, resultado, nota, interesse, proximo_em FROM lk_contatos ORDER BY em').all()) {
    ultimos[c.lead_id] = c;
    // tentativas seguidas sem atender (zera quando atende ou agenda)
    tentativas[c.lead_id] = c.resultado === 'nao_atendeu' ? (tentativas[c.lead_id] || 0) + 1 : 0;
  }
  const todosLeads = {};
  const etapa = (id, lead) => {
    const c = ultimos[id];
    if (!c) return 'fila';
    if (['ja_comprou', 'sem_interesse'].includes(c.resultado)) return 'encerrados';
    if (c.resultado === 'agendou') return 'agendados';
    if (c.proximo_em) return c.proximo_em <= fimDeHoje ? 'retornar' : 'retorno';
    if (c.resultado === 'nao_atendeu') return tentativas[id] >= 3 ? 'semContato' : agora - c.em >= 3 * 3600000 ? 'retornar' : 'tentar';
    if (c.resultado === 'enviada') {
      const respondeu = lead && lead.ultima_msg_owner === 'customers' && Date.parse(lead.ultima_msg_at) > c.em;
      return respondeu || agora - c.em >= 24 * 3600000 ? 'fila' : 'aguardando';
    }
    // atendeu sem retorno marcado: volta em 24 h
    return agora - c.em >= 24 * 3600000 ? 'fila' : 'aguardando';
  };
  // leads com algum contato registrado que não estão nas listas acima (para as etapas e para "Retornar hoje")
  const comContato = Object.keys(ultimos);
  if (comContato.length) {
    for (let i = 0; i < comContato.length; i += 500) {
      const parte = comContato.slice(i, i + 500);
      for (const l of d.prepare(`SELECT ${campos} FROM lk_leads l WHERE l.id IN (${parte.map(() => '?').join(',')})`).all(...parte)) todosLeads[l.id] = l;
    }
  }
  listas.retornar = Object.values(todosLeads).filter((l) => etapa(l.id, l) === 'retornar')
    .sort((a, b) => (ultimos[a.id].proximo_em || ultimos[a.id].em) - (ultimos[b.id].proximo_em || ultimos[b.id].em));
  // fila de trabalho: um lead só na lista mais urgente, e só quem está na etapa "fila" (ou "retornar")
  const vistos = new Set();
  for (const k of ['retornar', 'responder', 'confirmar', 'posVisita', 'novos', 'retomar']) {
    listas[k] = listas[k].filter((l) => {
      const e = etapa(l.id, l);
      const pode = k === 'retornar' ? e === 'retornar' : k === 'confirmar' || k === 'posVisita' ? e !== 'encerrados' : e === 'fila';
      return pode && !vistos.has(l.id) && vistos.add(l.id);
    });
  }
  // etapas (CRM): onde está cada lead que já foi trabalhado
  const etapas = { aguardando: [], tentar: [], retorno: [], agendados: [], semContato: [], encerrados: [] };
  for (const l of Object.values(todosLeads)) {
    const e = etapa(l.id, l);
    if (etapas[e]) etapas[e].push(l);
  }
  for (const k of Object.keys(etapas)) etapas[k].sort((a, b) => ultimos[b.id].em - ultimos[a.id].em);
  const anexar = (l) => { l.ultimoContato = ultimos[l.id] || null; l.tentativas = tentativas[l.id] || 0; };
  for (const k of Object.keys(listas)) listas[k].forEach(anexar);
  for (const k of Object.keys(etapas)) etapas[k].forEach(anexar);
  // contatos que o SDR já registrou hoje
  const contatos = d.prepare('SELECT lead_id, tipo, resultado, em, por, nota FROM lk_contatos WHERE dia = ? ORDER BY em').all(hoje);
  const porLead = {};
  for (const c of contatos) (porLead[c.lead_id] ||= []).push(c);
  for (const k of Object.keys(listas)) for (const l of listas[k]) l.contatosHoje = porLead[l.id] || [];
  const resumo = { ligacoes: contatos.filter((c) => c.tipo === 'ligacao').length, atenderam: contatos.filter((c) => ['atendeu', 'agendou', 'ja_comprou', 'sem_interesse'].includes(c.resultado) && c.tipo === 'ligacao').length, mensagens: contatos.filter((c) => c.tipo === 'mensagem').length, agendou: contatos.filter((c) => c.resultado === 'agendou').length, leads: Object.keys(porLead).length };
  return { dia: hoje, horasSemResposta, listas, etapas, resumo };
}

const RESULTADOS = ['atendeu', 'nao_atendeu', 'enviada', 'agendou', 'ja_comprou', 'sem_interesse'];
function registrarContato({ leadId, tipo, resultado, por, nota, interesse, proximoEm }) {
  const d = banco.abrir();
  if (!d) throw new Error(banco.erro());
  if (!['ligacao', 'mensagem'].includes(tipo)) throw new Error('Tipo de contato inválido');
  if (resultado && !RESULTADOS.includes(resultado)) throw new Error('Resultado inválido');
  if (interesse && !['quente', 'morno', 'frio'].includes(interesse)) throw new Error('Interesse inválido');
  const proximo = proximoEm ? Number(proximoEm) : null;
  if (proximo && !(proximo > Date.now() - 3600000)) throw new Error('Data de retorno inválida');
  const r = d.prepare('INSERT INTO lk_contatos (lead_id, dia, tipo, resultado, em, por, nota, interesse, proximo_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(String(leadId), diaSP(), tipo, resultado || null, Date.now(), por || null, nota ? String(nota).slice(0, 2000) : null, interesse || null, proximo);
  return { ok: true, id: Number(r.lastInsertRowid) };
}
function marcarNoLeadsOK(id, situacao) {
  banco.abrir()?.prepare('UPDATE lk_contatos SET no_leadsok = ? WHERE id = ?').run(String(situacao).slice(0, 200), id);
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
  const contatos = d.prepare(`SELECT c.em, c.tipo, c.resultado, c.por, c.nota, c.interesse, c.proximo_em, c.no_leadsok, c.lead_id, l.nome, l.whatsapp, l.origem, l.vendedor, l.created_date
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
    ? d.prepare("SELECT id, nome, whatsapp, carro, origem, vendedor, aba_atual, archive_reason, created_date, ultima_msg_owner, ultima_msg_at, is_resgate FROM lk_leads WHERE replace(replace(replace(whatsapp, '+', ''), ' ', ''), '-', '') LIKE ? LIMIT 20").all('%' + dig.slice(-9))
    : d.prepare('SELECT id, nome, whatsapp, carro, origem, vendedor, aba_atual, archive_reason, created_date, ultima_msg_owner, ultima_msg_at, is_resgate FROM lk_leads WHERE nome LIKE ? OR carro LIKE ? LIMIT 20').all('%' + q + '%', '%' + q + '%');
  const cont = d.prepare('SELECT em, tipo, resultado, por, nota, interesse, proximo_em FROM lk_contatos WHERE lead_id = ? ORDER BY em DESC');
  const ag = d.prepare('SELECT data, modalidade FROM lk_agenda WHERE lead_id = ? ORDER BY data DESC');
  return { leads: leads.map((l) => ({ ...l, contatos: cont.all(l.id), agenda: ag.all(l.id) })) };
}

module.exports = { registrarEsperando, filaSdr, registrarContato, marcarNoLeadsOK, historicoContatos, buscarLead, resumoPeriodo, leads, time, agenda, marcarVisita, estoque, resumoHoje, diaSP };
