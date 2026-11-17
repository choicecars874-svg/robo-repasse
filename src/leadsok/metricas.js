// Números do comercial a partir do banco do LeadsOK. Datas no fuso de Brasília (UTC−3, sem horário de verão).
const banco = require('./banco');
const config = require('../config');

// Vendedores fora do processo de cobrança (ex.: consignado): não entram em alertas, Gestor do dia nem Fila do SDR
const foraDoProcesso = () => ((config.get().sdr || {}).vendedoresFora || []).map((v) => String(v).trim().toLowerCase()).filter(Boolean);
// compara pelo nome contido (o LeadsOK às vezes tem sobrenome a mais, espaço ou emoji): "lucas ribeiro" pega "Lucas Ribeiro 🚗"
const semFora = (col = 'l.vendedor') => foraDoProcesso().map((v) => `AND lower(COALESCE(${col}, '')) NOT LIKE '%${v.replace(/'/g, "''").replace(/[%_]/g, '')}%'`).join(' ');
const estaFora = (nome) => { const n = String(nome || '').toLowerCase(); return foraDoProcesso().some((v) => n.includes(v)); };

const diaSP = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const VENDIDO = "COALESCE(lower(l.archive_reason), '') LIKE 'vendido%'";
const STATUS_FICHA = { 1: 'Pré-aprovado', 2: 'Pré-reprovado', 3: 'Em análise', 5: 'Erro' };
const nomeStatus = (s) => STATUS_FICHA[s] || 'Outros';

// Leads do período (pela data de criação). base: "entrada" (sem a base antiga de resgate) ou "resgate"
// WhatsApp direto e cadastro manual não são canal de mídia: nas tabelas de canal aparecem juntos como "direto",
// mas contam como lead em todas as telas (senão o Painel, o Time e os canais não bateriam entre si)
const DIRETOS = ['whatsapp', 'manual'];
const ORIGEM = "CASE WHEN l.origem IN ('whatsapp', 'manual') THEN 'direto' ELSE l.origem END";
// Canal provável dos leads "diretos": 1º pela 1ª mensagem (guardado na coleta), 2º pelo mesmo telefone em outro lead com canal
const MESMO_TEL = "(SELECT o.origem FROM lk_leads o WHERE o.id != l.id AND o.origem NOT IN ('whatsapp', 'manual', 'resgate', 'teste', 'unknown') AND l.whatsapp IS NOT NULL AND substr(replace(replace(o.whatsapp, '+', ''), ' ', ''), -9) = substr(replace(replace(l.whatsapp, '+', ''), ' ', ''), -9) ORDER BY o.created_date DESC LIMIT 1)";
const CANAL_PROVAVEL = `CASE WHEN l.origem IN ('whatsapp', 'manual') THEN COALESCE(l.canal_provavel, ${MESMO_TEL}) END`;
function canaisProvaveis(d, onde, args) {
  const linhas = d.prepare(`SELECT ${CANAL_PROVAVEL} provavel, CASE WHEN l.canal_provavel IS NOT NULL THEN 'mensagem' WHEN ${CANAL_PROVAVEL} IS NOT NULL THEN 'telefone' END pista, COUNT(*) n
    FROM lk_leads l WHERE ${onde} AND l.origem IN ('whatsapp', 'manual') GROUP BY 1, 2 ORDER BY n DESC`).all(...args);
  return { total: linhas.reduce((a, x) => a + x.n, 0), semPista: linhas.filter((x) => !x.provavel).reduce((a, x) => a + x.n, 0), porCanal: linhas.filter((x) => x.provavel) };
}
function coorte({ de, ate, origem, base = 'entrada' }) {
  const filtros = ["date(l.created_date, '-3 hours') BETWEEN ? AND ?", 'l.is_resgate = ?', "COALESCE(l.origem, '') != 'teste'"];
  const args = [de, ate, base === 'resgate' ? 1 : 0];
  if (origem === 'direto') filtros.push("l.origem IN ('whatsapp', 'manual')");
  else if (origem) {
    filtros.push('l.origem = ?');
    args.push(origem);
  }
  return { onde: filtros.join(' AND '), args };
}

// Expressões por lead (subconsultas): 1ª mensagem do vendedor/IA, cliente respondeu depois dela, etc.
const PRIMEIRA_LOJA = "(SELECT MIN(m.ts) FROM lk_mensagens m WHERE m.lead_id = l.id AND m.owner = 'salesman')";
const RESPONDEU = `EXISTS (SELECT 1 FROM lk_mensagens m WHERE m.lead_id = l.id AND m.owner = 'customers' AND m.ts > ${PRIMEIRA_LOJA})`;
const TEM_FICHA = 'EXISTS (SELECT 1 FROM lk_fichas f WHERE f.lead_id = l.id)';
// ===================== DEFINIÇÕES ÚNICAS DAS MÉTRICAS (valem para todas as telas) =====================
// LEAD        lead de entrada (sem a base de resgate e sem leads de teste), pela data em que foi criado no LeadsOK.
// ATENDIDO    a loja (vendedor ou IA) mandou pelo menos uma mensagem. Precisa das conversas carregadas.
// RESPONDIDO  o cliente respondeu depois da 1ª mensagem da loja. Precisa das conversas carregadas.
// AGENDAMENTO de visita: agenda do LeadsOK com modalidade presencial ou online ("ligação" é lembrete de follow-up, não conta)
//             ou "Agendou visita" registrado na Fila do SDR.
//   - AGENDAMENTO FEITO: contado no dia em que foi CRIADO (dia em que apareceu na agenda do LeadsOK, ou dia do registro do SDR).
//     Um lead conta uma vez por dia. Agendamentos que já existiam na 1ª carga não têm data de criação e ficam fora.
//   - AGENDAMENTO PARA O DIA: contado no dia da VISITA (é o que a tela Agenda lista).
// COMPARECEU  visita marcada como "Veio" na Agenda (o LeadsOK não registra comparecimento).
// VENDA       lead arquivado como "Vendido" no LeadsOK ou visita marcada "Veio e comprou".
// FUNIL       dos leads criados no período, quantos chegaram PELO MENOS até cada etapa. Quem comprou conta como compareceu,
//             quem compareceu conta como agendou, e assim por diante: uma etapa nunca é maior que a anterior.
// SEM DADO    se as conversas estão carregadas para menos de 80% dos leads do período, Atendidos, Respondidos, Fichas e
//             1ª resposta saem como null ("sem dado") em vez de 0.
const AG_VISITA = "COALESCE(a.modalidade, 'presencial') != 'ligacao'";
const AGENDOU_VISITA = `(EXISTS (SELECT 1 FROM lk_agenda a WHERE a.lead_id = l.id AND ${AG_VISITA}) OR EXISTS (SELECT 1 FROM lk_contatos c WHERE c.lead_id = l.id AND c.resultado = 'agendou'))`;
const COBERTURA_MINIMA = 0.8;
const VISITOU = 'EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = l.id AND v.compareceu = 1)';
const NAO_VEIO = 'EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = l.id AND v.compareceu = 0)';
const VEIO_NAO_COMPROU = 'EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = l.id AND v.compareceu = 1 AND v.comprou = 0)';
// comprou: vendido no LeadsOK ou marcado "Veio e comprou" na Agenda
const COMPROU = `(${VENDIDO} OR EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = l.id AND v.comprou = 1))`;
// etapas do funil: "chegou pelo menos até"
const E_COMPARECEU = `(${VISITOU} OR ${COMPROU})`;
const AGENDOU = `(${AGENDOU_VISITA} OR ${E_COMPARECEU})`;
const E_RESPONDEU = `(${RESPONDEU} OR ${AGENDOU})`;
const E_ATENDIDO = `(${PRIMEIRA_LOJA} IS NOT NULL OR ${E_RESPONDEU})`;

// Agendamentos FEITOS no período (pela data de criação): linhas { lead_id, dia, vendedor, origem }
function agendamentosFeitos(d, { de, ate, origem }) {
  return d.prepare(`SELECT x.lead_id, x.dia, COALESCE(l.vendedor, 'Sem vendedor') vendedor, l.origem FROM (
      SELECT a.lead_id, date(a.primeira_vez / 1000, 'unixepoch', '-3 hours') dia FROM lk_agenda a WHERE ${AG_VISITA} AND a.primeira_vez IS NOT NULL AND a.lead_id IS NOT NULL
      UNION
      SELECT c.lead_id, c.dia FROM lk_contatos c WHERE c.resultado = 'agendou'
    ) x LEFT JOIN lk_leads l ON l.id = x.lead_id
    WHERE x.dia BETWEEN ? AND ? AND COALESCE(l.origem, '') != 'teste' AND COALESCE(l.is_resgate, 0) = 0 ${origem ? 'AND l.origem = ?' : ''}`).all(...(origem ? [de, ate, origem] : [de, ate]));
}
// Vendas no período: pela data em que o lead virou "Vendido" no LeadsOK ou em que a visita foi marcada "Veio e comprou"
function vendasNoPeriodo(d, de, ate) {
  return d.prepare(`SELECT COUNT(*) n FROM (
      SELECT l.id FROM lk_leads l WHERE ${VENDIDO} AND COALESCE(l.origem, '') != 'teste' AND date(COALESCE(datetime(l.vendido_em / 1000, 'unixepoch'), l.ultima_msg_at), '-3 hours') BETWEEN ? AND ?
      UNION
      SELECT v.lead_id FROM lk_visitas v WHERE v.comprou = 1 AND v.lead_id NOT LIKE 'teste-%' AND date(v.marcado_em / 1000, 'unixepoch', '-3 hours') BETWEEN ? AND ?)`).get(de, ate, de, ate).n;
}
// Visitas que aconteceram no período (marcadas "Veio"), pela data da visita
const visitasNoPeriodo = (d, de, ate) => d.prepare("SELECT COUNT(*) n FROM lk_visitas WHERE compareceu = 1 AND lead_id NOT LIKE 'teste-%' AND date(data_agendada, '-3 hours') BETWEEN ? AND ?").get(de, ate).n;

function leads(filtro) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  const { onde, args } = coorte(filtro);
  const etapas = `COUNT(*) demanda,
      TOTAL(${E_ATENDIDO}) atendidos,
      TOTAL(${E_RESPONDEU}) responderam,
      TOTAL(${TEM_FICHA}) fichas,
      TOTAL(${AGENDOU}) agendados,
      TOTAL(${E_COMPARECEU}) visitas,
      TOTAL(${VISITOU}) visitasMarcadas,
      TOTAL(${NAO_VEIO}) naoVieram,
      TOTAL(${VEIO_NAO_COMPROU}) vieramNaoCompraram,
      TOTAL(${COMPROU}) vendas,
      TOTAL(l.detalhe_em IS NOT NULL) detalhados`;
  // sem as conversas carregadas, o que depende delas vira "sem dado" (null), não 0
  const semDado = (x) => {
    x.semDadoConversa = x.demanda > 0 && x.detalhados / x.demanda < COBERTURA_MINIMA;
    if (x.semDadoConversa) x.atendidos = x.responderam = x.fichas = null;
    return x;
  };
  const total = semDado(d.prepare(`SELECT ${etapas} FROM lk_leads l WHERE ${onde}`).get(...args));
  const agendamentos = agendamentosFeitos(d, filtro).length;
  const porOrigem = d.prepare(`SELECT ${ORIGEM} origem, ${etapas} FROM lk_leads l WHERE ${onde} GROUP BY 1 ORDER BY demanda DESC`).all(...args).map(semDado);
  const porDia = d.prepare(`SELECT date(l.created_date, '-3 hours') dia, ${ORIGEM} origem, COUNT(*) n FROM lk_leads l WHERE ${onde} GROUP BY dia, 2 ORDER BY dia`).all(...args);
  const fichas = d.prepare(`SELECT f.banco, f.status, COUNT(DISTINCT f.lead_id) n FROM lk_fichas f JOIN lk_leads l ON l.id = f.lead_id WHERE ${onde} GROUP BY f.banco, f.status`).all(...args)
    .map((x) => ({ ...x, statusNome: nomeStatus(x.status) }));
  const origens = [...new Set(d.prepare('SELECT DISTINCT origem FROM lk_leads WHERE origem IS NOT NULL ORDER BY origem').all().map((x) => (DIRETOS.includes(x.origem) ? 'direto' : x.origem)).filter((o) => o !== 'teste'))];
  return { filtro, total: { ...total, agendamentos }, porOrigem, porDia, fichas, origens, diretos: canaisProvaveis(d, onde, args), cobertura: total.demanda ? total.detalhados / total.demanda : null };
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
      TOTAL(${E_RESPONDEU}) responderam, TOTAL(${TEM_FICHA}) fichas, TOTAL(${AGENDOU}) agendados, TOTAL(${E_COMPARECEU}) visitas, TOTAL(${COMPROU}) vendas,
      TOTAL(l.detalhe_em IS NOT NULL) detalhados
    FROM lk_leads l WHERE ${onde} GROUP BY vendedor ORDER BY recebidos DESC`).all(...args);
  // sem as conversas carregadas: 1ª resposta, responderam e fichas são "sem dado"
  const totRec = linhas.reduce((a, v) => a + v.recebidos, 0);
  const totDet = linhas.reduce((a, v) => a + v.detalhados, 0);
  const semDadoConversa = totRec > 0 && totDet / totRec < COBERTURA_MINIMA;
  if (semDadoConversa) for (const v of linhas) v.resposta_min = v.responderam = v.fichas = null;
  const esperando = esperandoAgora(d, horasParado);
  const mapa = Object.fromEntries(esperando.map((x) => [x.vendedor, x.n]));
  // agendamentos FEITOS e visitas no período (pela data do fato, não da criação do lead), por vendedor do lead
  const filtroOrigem = filtro.origem ? 'AND l.origem = ?' : '';
  const argsO = filtro.origem ? [filtro.origem] : [];
  // mesma regra de "agendamento feito" de todas as telas
  const feitos = agendamentosFeitos(d, filtro);
  const agPorVend = {};
  for (const x of feitos) agPorVend[x.vendedor] = (agPorVend[x.vendedor] || 0) + 1;
  const viPorVend = Object.fromEntries(d.prepare(`SELECT COALESCE(l.vendedor, 'Sem vendedor') vendedor, TOTAL(v.compareceu = 1) vieram, TOTAL(v.compareceu = 0) naoVieram, TOTAL(v.comprou = 1) compraram
    FROM lk_visitas v JOIN lk_leads l ON l.id = v.lead_id WHERE date(v.data_agendada, '-3 hours') BETWEEN ? AND ? ${filtroOrigem} GROUP BY vendedor`).all(filtro.de, filtro.ate, ...argsO).map((x) => [x.vendedor, x]));
  // por dia: leads que chegaram, tempo médio da 1ª resposta (só humanos), agendamentos feitos e visitas
  const porDia = {};
  const dia = (k) => (porDia[k] ||= { dia: k, leads: 0, resposta_min: null, agendamentos: 0, vieram: 0, naoVieram: 0, esperandoPico: null });
  for (const x of d.prepare(`SELECT date(l.created_date, '-3 hours') dia, COUNT(*) leads, AVG(CASE WHEN l.vendedor_is_ia = 0 THEN ${RESPOSTA_MIN} END) resposta_min
    FROM lk_leads l WHERE ${onde} GROUP BY dia`).all(...args)) Object.assign(dia(x.dia), { leads: x.leads, resposta_min: x.resposta_min });
  for (const x of feitos) dia(x.dia).agendamentos++;
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
    faixasResposta: semDadoConversa ? null : faixas,
    semDadoConversa,
    agendamentosFeitos: feitos.length,
  };
}

// Leads em que o cliente mandou a última mensagem há mais de X horas, por vendedor (agora)
function esperandoAgora(d, horasParado) {
  const limite = new Date(Date.now() - horasParado * 3600 * 1000).toISOString();
  return d.prepare(`SELECT COALESCE(vendedor, 'Sem vendedor') vendedor, COUNT(*) n FROM lk_leads
    WHERE aba_atual != 'arquivados' AND is_resgate = 0 AND ultima_msg_owner = 'customers' AND ultima_msg_at < ? AND ultima_msg_at > ? ${semFora('vendedor')} GROUP BY vendedor ORDER BY n DESC`).all(limite, new Date(Date.now() - 30 * 86400000).toISOString());
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
  // sem lead identificado: usa os dados que vieram no próprio agendamento e um id "agenda-..." para marcar a visita
  const itens = d.prepare(`SELECT a.id, COALESCE(a.lead_id, 'agenda-' || a.id) lead_id, a.lead_id IS NOT NULL identificado, a.data, a.modalidade, a.concluido, a.pela_ia,
      COALESCE(l.nome, a.nome) nome, COALESCE(l.whatsapp, a.telefone) whatsapp, COALESCE(l.carro, a.carro) carro, COALESCE(l.vendedor, a.vendedor) vendedor, l.origem, l.aba_atual,
      a.obs, a.confirmado, a.motivo, v.compareceu, v.comprou, v.marcado_por, v.marcado_em,
      (SELECT MAX(em) FROM lk_confirmacoes c WHERE c.lead_id = COALESCE(a.lead_id, 'agenda-' || a.id) AND c.data_agendada = a.data AND c.tipo = 'mensagem') confirmacao_enviada,
      (SELECT MAX(em) FROM lk_confirmacoes c WHERE c.lead_id = COALESCE(a.lead_id, 'agenda-' || a.id) AND c.data_agendada = a.data AND c.tipo = 'cliente') cliente_confirmou,
      (SELECT MAX(em) FROM lk_confirmacoes c WHERE c.lead_id = COALESCE(a.lead_id, 'agenda-' || a.id) AND c.data_agendada = a.data AND c.tipo = 'lembrete') lembrete_enviado
    FROM lk_agenda a LEFT JOIN lk_leads l ON l.id = a.lead_id LEFT JOIN lk_visitas v ON v.lead_id = COALESCE(a.lead_id, 'agenda-' || a.id) AND v.data_agendada = a.data
    WHERE COALESCE(a.modalidade, 'presencial') != 'ligacao' AND date(a.data, '-3 hours') BETWEEN ? AND ? ${semFora('COALESCE(l.vendedor, a.vendedor)')} ORDER BY a.data`).all(de, ate);
  // agendamentos tipo "ligação" no LeadsOK são lembretes de follow-up, não visita: ficam fora, só contados
  const followupsLigacao = d.prepare("SELECT COUNT(*) n FROM lk_agenda WHERE modalidade = 'ligacao' AND date(data, '-3 hours') BETWEEN ? AND ?").get(de, ate).n;
  // visitas agendadas pelo SDR no briefing (último "agendou" de cada lead) que não estão na agenda do LeadsOK no mesmo dia
  const doSdr = d.prepare(`SELECT c.lead_id, c.proximo_em, c.por, l.nome, l.whatsapp, l.carro, l.vendedor, l.origem, l.aba_atual
    FROM lk_contatos c JOIN lk_leads l ON l.id = c.lead_id
    WHERE c.resultado = 'agendou' AND c.proximo_em IS NOT NULL AND c.id = (SELECT MAX(id) FROM lk_contatos WHERE lead_id = c.lead_id AND resultado = 'agendou')
      AND date(c.proximo_em / 1000, 'unixepoch', '-3 hours') BETWEEN ? AND ? ${semFora()}`).all(de, ate);
  const visita = d.prepare('SELECT compareceu, comprou, marcado_por, marcado_em FROM lk_visitas WHERE lead_id = ? AND data_agendada = ?');
  const diaDe = (iso) => new Date(Date.parse(iso) - 3 * 3600000).toISOString().slice(0, 10);
  for (const c of doSdr) {
    const data = new Date(c.proximo_em).toISOString();
    if (itens.some((a) => a.lead_id === c.lead_id && diaDe(a.data) === diaDe(data))) continue;
    const v = visita.get(c.lead_id, data) || {};
    const cf = (tipo) => d.prepare('SELECT MAX(em) em FROM lk_confirmacoes WHERE lead_id = ? AND data_agendada = ? AND tipo = ?').get(c.lead_id, data, tipo).em;
    itens.push({ id: 'sdr-' + c.lead_id + '-' + c.proximo_em, lead_id: c.lead_id, data, modalidade: 'presencial', concluido: 0, pela_ia: 0, pelo_sdr: c.por || 'SDR',
      nome: c.nome, whatsapp: c.whatsapp, carro: c.carro, vendedor: c.vendedor, origem: c.origem, aba_atual: c.aba_atual,
      compareceu: v.compareceu ?? null, comprou: v.comprou ?? null, marcado_por: v.marcado_por || null, marcado_em: v.marcado_em || null,
      identificado: 1, confirmacao_enviada: cf('mensagem'), cliente_confirmou: cf('cliente') });
  }
  itens.sort((a, b) => (a.data < b.data ? -1 : 1));
  const agora = new Date().toISOString();
  const resumo = { agendados: itens.length, vieram: 0, compraram: 0, vieramNaoCompraram: 0, naoVieram: 0, aMarcar: 0, futuros: 0, concluidosLeadsOK: 0, confirmados: 0, iaSemConfirmar: 0 };
  for (const a of itens) {
    if (a.compareceu === 1) {
      resumo.vieram++;
      if (a.comprou === 1) resumo.compraram++;
      else resumo.vieramNaoCompraram++;
    } else if (a.compareceu === 0) resumo.naoVieram++;
    else if (a.concluido) resumo.concluidosLeadsOK++;
    else if (a.data < agora) resumo.aMarcar++;
    else {
      resumo.futuros++;
      if (a.cliente_confirmou) resumo.confirmados++;
      else if (a.pela_ia) resumo.iaSemConfirmar++;
    }
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
  return { de, ate, dia: de, itens, resumo, porDia: Object.values(porDia), followupsLigacao };
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
  const r = resumoPeriodo(hoje, hoje);
  const agendHoje = d.prepare(`SELECT COUNT(*) n FROM lk_agenda a WHERE ${AG_VISITA} AND date(a.data, '-3 hours') = ?`).get(hoje).n;
  return { leadsHoje: r.leads, agendamentosHoje: agendHoje, agendamentosFeitosHoje: r.agendamentos, vendasMes: vendasNoPeriodo(d, hoje.slice(0, 8) + '01', hoje), visitasHoje: r.visitas, temDados: r.temDados };
}

// Totais do comercial num período: leads, agendamentos FEITOS, visitas e vendas (mesmas regras das outras telas)
function resumoPeriodo(de, ate) {
  const d = banco.abrir();
  if (!d || !de || !ate) return null;
  const leads = d.prepare("SELECT COUNT(*) n FROM lk_leads WHERE is_resgate = 0 AND COALESCE(origem, '') != 'teste' AND date(created_date, '-3 hours') BETWEEN ? AND ?").get(de, ate).n;
  const total = d.prepare('SELECT COUNT(*) n FROM lk_leads').get().n;
  return { leads, agendamentos: agendamentosFeitos(d, { de, ate }).length, vendas: vendasNoPeriodo(d, de, ate), visitas: visitasNoPeriodo(d, de, ate), temDados: total > 0 };
}

// Gestor do dia: a varredura que um gestor faria toda manhã. Tudo o que está largado, em listas prontas para cobrar.
function gestorDoDia({ horasParado = 2 } = {}) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  const agora = Date.now();
  const hoje = diaSP();
  const iso = (ms) => new Date(agora - ms).toISOString();
  const campos = `l.id, l.nome, l.whatsapp, l.carro, ${ORIGEM} origem, COALESCE(l.vendedor, 'Sem vendedor') vendedor, l.vendedor_is_ia ia, l.ultima_msg_owner, l.ultima_msg_at, l.created_date, l.tem_financiamento`;
  const aberto = `l.is_resgate = 0 AND l.aba_atual != 'arquivados' AND COALESCE(l.origem, '') != 'teste' ${semFora()} AND l.id NOT IN (SELECT lead_id FROM lk_contatos WHERE resultado IN ('ja_comprou', 'sem_interesse'))`;
  // 1) leads de hoje: quantos, de onde, quantos fora do horário (antes das 8h, depois das 19h ou domingo) e sem informação
  const deHoje = d.prepare(`SELECT ${campos}, CAST(strftime('%H', l.created_date, '-3 hours') AS INTEGER) hora, CAST(strftime('%w', l.created_date, '-3 hours') AS INTEGER) semana
    FROM lk_leads l WHERE l.is_resgate = 0 AND COALESCE(l.origem, '') != 'teste' AND date(l.created_date, '-3 hours') = ? ORDER BY l.created_date DESC`).all(hoje);
  const foraHorario = deHoje.filter((l) => l.hora < 8 || l.hora >= 19 || l.semana === 0).length;
  const porCanal = {};
  for (const l of deHoje) porCanal[l.origem || 'unknown'] = (porCanal[l.origem || 'unknown'] || 0) + 1;
  // 2) cliente falou por último e ninguém respondeu (últimos 14 dias): o mais recente primeiro (ainda está quente)
  const semResposta = d.prepare(`SELECT ${campos} FROM lk_leads l WHERE ${aberto} AND l.ultima_msg_owner = 'customers' AND l.ultima_msg_at BETWEEN ? AND ? ORDER BY l.ultima_msg_at DESC LIMIT 300`).all(iso(14 * 86400000), iso(horasParado * 3600000));
  const semRespostaPorVend = {};
  for (const l of semResposta) semRespostaPorVend[l.vendedor] = (semRespostaPorVend[l.vendedor] || 0) + 1;
  // 3) agenda: visitas de hoje e amanhã, quais a IA marcou e o cliente ainda não confirmou; e as que passaram sem resultado
  const ag = agenda({ de: hoje, ate: diaSP(agora + 86400000) });
  const proximas = ag.itens.filter((a) => a.compareceu == null && !a.concluido && Date.parse(a.data) >= agora);
  const iaSemConfirmar = proximas.filter((a) => a.pela_ia && !a.cliente_confirmou);
  const semConfirmar = proximas.filter((a) => !a.cliente_confirmou);
  const pend = agenda({ de: diaSP(agora - 30 * 86400000), ate: hoje });
  const visitasPendentes = pend.itens.filter((a) => a.compareceu == null && !a.concluido && Date.parse(a.data) < agora);
  // 4) leads sem informação (últimos 3 dias, ainda abertos): sem vendedor, sem nome, sem carro
  const recentes = d.prepare(`SELECT ${campos}, l.vendedor vendedor_real FROM lk_leads l WHERE ${aberto} AND l.created_date > ? ORDER BY l.created_date DESC`).all(iso(3 * 86400000));
  const semInfo = { semVendedor: recentes.filter((l) => !l.vendedor_real), semNome: recentes.filter((l) => !l.nome), semCarro: recentes.filter((l) => !l.carro).length, total: recentes.length };
  // 5) leads quentes parados. Quente = respondeu (o cliente falou com a loja), tentou agendar visita (agenda do LeadsOK,
  // inclusive a IA, ou "topou visitar" no SDR), passou CPF (ficha de financiamento) ou o SDR marcou interesse "quente".
  // Parado = mais de 24 h sem mensagem e sem visita marcada para frente.
  const quentes = d.prepare(`SELECT ${campos},
      (SELECT COUNT(*) FROM lk_mensagens m WHERE m.lead_id = l.id AND m.owner = 'customers') msgsCliente,
      EXISTS (SELECT 1 FROM lk_agenda a WHERE a.lead_id = l.id) OR EXISTS (SELECT 1 FROM lk_contatos c WHERE c.lead_id = l.id AND c.resultado IN ('agendou', 'interesse_visita')) tentouAgendar,
      ${VISITOU} jaVeio,
      EXISTS (SELECT 1 FROM lk_contatos c WHERE c.lead_id = l.id AND c.interesse = 'quente') sdrQuente,
      (SELECT MAX(em) FROM lk_contatos c WHERE c.lead_id = l.id) ultimoSdr
    FROM lk_leads l WHERE ${aberto} AND l.ultima_msg_at BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM lk_agenda a WHERE a.lead_id = l.id AND a.data > ? AND COALESCE(a.concluido, 0) = 0)`).all(iso(21 * 86400000), iso(24 * 3600000), new Date(agora).toISOString())
    .map((l) => {
      const motivos = [];
      let pontos = 0;
      if (l.tem_financiamento) { pontos += 4; motivos.push('passou CPF (ficha de financiamento)'); }
      if (l.jaVeio) { pontos += 4; motivos.push('já veio à loja'); }
      else if (l.tentouAgendar) { pontos += 3; motivos.push('tentou agendar visita'); }
      if (l.sdrQuente) { pontos += 3; motivos.push('SDR marcou como quente'); }
      // respondeu: mensagens do cliente (quando as conversas estão carregadas) ou o cliente falou por último
      if (l.msgsCliente > 0 || l.ultima_msg_owner === 'customers') { pontos += l.msgsCliente >= 4 ? 3 : 2; motivos.push(l.msgsCliente > 0 ? `respondeu (${l.msgsCliente} mensagens)` : 'respondeu'); }
      const dias = Math.floor((agora - Date.parse(l.ultima_msg_at)) / 86400000);
      return { ...l, pontos, motivos, diasParado: dias, semSdr: !l.ultimoSdr };
    }).filter((l) => l.motivos.length).sort((a, b) => b.pontos - a.pontos || a.diasParado - b.diasParado).slice(0, 60);
  const curto = (l) => ({ id: l.id, nome: l.nome, whatsapp: l.whatsapp, carro: l.carro, origem: l.origem, vendedor: l.vendedor, ia: l.ia, ultima_msg_at: l.ultima_msg_at, created_date: l.created_date });
  return {
    dia: hoje, horasParado,
    hoje: { leads: deHoje.length, foraHorario, porCanal },
    semResposta: { total: semResposta.length, porVendedor: Object.entries(semRespostaPorVend).map(([vendedor, n]) => ({ vendedor, n })).sort((a, b) => b.n - a.n), lista: semResposta.slice(0, 60).map(curto) },
    agenda: { hoje: ag.itens.filter((a) => diaSP(Date.parse(a.data)) === hoje).length, amanha: ag.itens.filter((a) => diaSP(Date.parse(a.data)) !== hoje).length, semConfirmar: semConfirmar.length, iaSemConfirmar, visitasPendentes: visitasPendentes.length },
    semInfo: { total: semInfo.total, semVendedor: semInfo.semVendedor.map(curto), semNome: semInfo.semNome.length, semCarro: semInfo.semCarro },
    quentes: quentes.map((l) => ({ ...curto(l), pontos: l.pontos, motivos: l.motivos, diasParado: l.diasParado, semSdr: l.semSdr })),
  };
}

// Painel: tudo o que a tela inicial precisa, com as mesmas funções das telas de detalhe (os números batem por construção)
function painelComercial({ de, ate, horasParado = 2, metas = {} }) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  const hoje = diaSP();
  // período anterior equivalente (mesmo número de dias, imediatamente antes)
  const dias = Math.round((Date.parse(ate) - Date.parse(de)) / 86400000) + 1;
  const antAte = new Date(Date.parse(de) - 86400000).toISOString().slice(0, 10);
  const antDe = new Date(Date.parse(de) - dias * 86400000).toISOString().slice(0, 10);
  const L = leads({ de, ate });
  const LA = leads({ de: antDe, ate: antAte });
  const etapasDe = (t) => ({ leads: t.demanda, respondidos: t.responderam, agendou: t.agendados, compareceu: t.visitas, comprou: t.vendas, visitasMarcadas: t.visitasMarcadas, semDadoConversa: !!t.semDadoConversa });
  const T = time({ de, ate }, horasParado);
  // alertas (situação de agora, não dependem do período)
  const pend = agenda({ de: diaSP(Date.now() - 30 * 86400000), ate: hoje });
  const semVendedor = d.prepare(`SELECT COUNT(*) n FROM lk_leads l WHERE l.is_resgate = 0 AND COALESCE(l.origem, '') != 'teste' AND l.aba_atual != 'arquivados'
    AND (l.vendedor IS NULL OR trim(l.vendedor) = '') AND date(l.created_date, '-3 hours') = ?`).get(hoje).n;
  // meta x realizado: sempre o mês corrente
  const iniMes = hoje.slice(0, 8) + '01';
  const diasMes = new Date(Date.UTC(+hoje.slice(0, 4), +hoje.slice(5, 7), 0)).getUTCDate();
  const diaDoMes = +hoje.slice(8);
  const mes = resumoPeriodo(iniMes, hoje);
  const linhaMeta = (feito, meta) => ({ feito, meta: meta || 0, projecao: Math.round((feito / diaDoMes) * diasMes) });
  return {
    de, ate, anterior: { de: antDe, ate: antAte }, dias,
    cobertura: L.cobertura,
    alertas: {
      horasParado,
      esperando: { total: T.esperandoTotal, porVendedor: T.esperandoPorVendedor },
      visitasPendentes: pend.resumo.aMarcar,
      semVendedorHoje: semVendedor,
    },
    funil: { atual: etapasDe(L.total), anterior: etapasDe(LA.total) },
    agendamentosFeitos: L.total.agendamentos,
    metas: {
      mes: hoje.slice(0, 7), diaDoMes, diasMes,
      agendamentos: linhaMeta(mes.agendamentos, (metas.agendamentosDia || 0) * diasMes),
      visitas: linhaMeta(mes.visitas, (metas.visitasDia || 0) * diasMes),
      vendas: linhaMeta(mes.vendas, metas.vendasMes || 0),
    },
    canais: L.porOrigem,
    diretos: L.diretos,
    time: T.vendedores.filter((v) => !estaFora(v.vendedor)),
    semDadoConversa: !!L.total.semDadoConversa,
  };
}

// Fila do SDR: quem ligar ou chamar hoje, em ordem de urgência. Só leads de entrada (sem a base de resgate)
// e não arquivados. Cada lead aparece numa lista só (a mais urgente).
function filaSdr({ horasSemResposta = 1, vendedor = '', cadencia = {}, usuario = '' } = {}) {
  const hTentar = Number(cadencia.horasTentarDeNovo) || 3;
  const hRecado = Number(cadencia.horasAguardandoRecado) || 24;
  const maxTent = Number(cadencia.tentativasMax) || 3;
  const diasNovos = Number(cadencia.diasNovos) || 7;
  const hResgate = Number(cadencia.horasSemRespostaResgate) || 1;
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  const hoje = diaSP();
  const amanha = diaSP(Date.now() + 86400000);
  const agora = Date.now();
  const iso = (ms) => new Date(agora - ms).toISOString();
  const campos = `l.id, l.nome, l.whatsapp, l.carro, l.origem, l.vendedor, l.vendedor_is_ia ia, l.ultima_msg_owner, l.ultima_msg_at, l.created_date, l.aba_atual`;
  // lead encerrado pelo SDR (já comprou / sem interesse) sai da fila; quem agendou sai das listas de prospecção
  const base = `l.is_resgate = 0 AND l.aba_atual != 'arquivados' AND l.whatsapp IS NOT NULL ${semFora()}
    AND l.id NOT IN (SELECT lead_id FROM lk_contatos WHERE resultado IN ('ja_comprou', 'sem_interesse'))`;
  const semAgendar = `AND l.id NOT IN (SELECT lead_id FROM lk_contatos WHERE resultado = 'agendou' AND em > ${agora - 14 * 86400000})`;
  // carteira: só os leads que estão no nome do vendedor no LeadsOK (o Elyas transfere para o SDR o que ele não dá conta)
  const V = vendedor ? 'AND lower(l.vendedor) = lower(?)' : '';
  const daCarteira = (l) => !vendedor || String(l.vendedor || '').toLowerCase() === vendedor.toLowerCase();
  // da carteira OU que o próprio usuário trabalhou por último (ex.: lead de outro vendedor que ele resgatou e agendou)
  const meu = (l) => daCarteira(l) || (!!usuario && ultimos[l.id]?.por === usuario);
  const va = vendedor ? [vendedor] : [];
  // agenda do LeadsOK: "presencial"/"online" é visita; "ligacao" é lembrete de follow-up (vai para "Retornar hoje")
  const EH_VISITA = "COALESCE(a.modalidade, 'presencial') != 'ligacao'";
  const listas = {
    // 1) cliente mandou mensagem e ninguém respondeu
    responder: d.prepare(`SELECT ${campos} FROM lk_leads l WHERE ${base} AND l.ultima_msg_owner = 'customers' AND l.ultima_msg_at BETWEEN ? AND ? ${semAgendar} ${V} ORDER BY l.created_date DESC LIMIT 150`).all(iso(7 * 86400000), iso(horasSemResposta * 3600000), ...va),
    // 1b) com a carteira escolhida: leads de OUTROS vendedores que estão sem resposta (ninguém cuidando): ligar antes que esfrie
    abandonados: vendedor ? d.prepare(`SELECT ${campos} FROM lk_leads l WHERE ${base} AND l.ultima_msg_owner = 'customers' AND l.ultima_msg_at BETWEEN ? AND ? ${semAgendar}
      AND lower(COALESCE(l.vendedor, '')) != lower(?) ORDER BY l.ultima_msg_at DESC LIMIT 100`).all(iso(7 * 86400000), iso(hResgate * 3600000), vendedor) : [],
    // 2) follow-up de visitas (agenda do LeadsOK): confirmar as de hoje e amanhã; marcar o resultado das que já passaram (7 dias)
    visitas: d.prepare(`SELECT COALESCE(l.id, 'agenda-' || a.id) id, COALESCE(l.nome, a.nome) nome, COALESCE(l.whatsapp, a.telefone) whatsapp, COALESCE(l.carro, a.carro) carro, l.origem,
        COALESCE(l.vendedor, a.vendedor) vendedor, l.vendedor_is_ia ia, l.ultima_msg_owner, l.ultima_msg_at, l.created_date, l.aba_atual,
        a.data agenda_data, a.modalidade, a.obs agenda_obs, a.confirmado agenda_confirmado, a.lead_id IS NOT NULL identificado, 'leadsok' agenda_origem
      FROM lk_agenda a LEFT JOIN lk_leads l ON l.id = a.lead_id
      WHERE ${EH_VISITA} AND COALESCE(a.concluido, 0) = 0 AND date(a.data, '-3 hours') BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = COALESCE(a.lead_id, 'agenda-' || a.id) AND v.data_agendada = a.data)
        AND COALESCE(l.id, '') NOT IN (SELECT lead_id FROM lk_contatos WHERE resultado IN ('ja_comprou', 'sem_interesse')) ${semFora('COALESCE(l.vendedor, a.vendedor)')}
        ${vendedor ? "AND lower(COALESCE(l.vendedor, a.vendedor, '')) = lower(?)" : ''} ORDER BY a.data ASC LIMIT 150`).all(diaSP(agora - 7 * 86400000), amanha, ...va),
    // 3) ligar: leads dos últimos 7 dias que o SDR ainda não trabalhou e o cliente não respondeu (mais novos primeiro)
    novos: d.prepare(`SELECT ${campos} FROM lk_leads l WHERE ${base} AND l.created_date > ? AND COALESCE(l.ultima_msg_owner, 'salesman') != 'customers' ${semAgendar} ${V} ORDER BY l.created_date DESC LIMIT 200`).all(iso(diasNovos * 86400000), ...va),
    // 4) conversa parada: loja falou por último há 2 a 7 dias e o cliente sumiu, ou cliente sem resposta há 7 a 30 dias
    retomar: d.prepare(`SELECT ${campos} FROM lk_leads l WHERE ${base} AND l.created_date <= ? AND ((l.ultima_msg_owner = 'salesman' AND l.ultima_msg_at BETWEEN ? AND ?) OR (l.ultima_msg_owner = 'customers' AND l.ultima_msg_at BETWEEN ? AND ?)) ${semAgendar} ${V} ORDER BY l.created_date DESC LIMIT 150`).all(iso(diasNovos * 86400000), iso(30 * 86400000), iso(2 * 86400000), iso(30 * 86400000), iso(7 * 86400000), ...va),
    // 5) pós-visita (últimos 14 dias): não veio, ou veio e não comprou, e o SDR ainda não falou depois
    posVisita: d.prepare(`SELECT ${campos}, v.data_agendada agenda_data, v.compareceu, v.comprou FROM lk_visitas v JOIN lk_leads l ON l.id = v.lead_id
      WHERE l.is_resgate = 0 AND l.whatsapp IS NOT NULL AND v.marcado_em > ? AND (v.compareceu = 0 OR (v.compareceu = 1 AND v.comprou = 0))
        AND NOT (${VENDIDO}) AND NOT EXISTS (SELECT 1 FROM lk_visitas v2 WHERE v2.lead_id = l.id AND v2.comprou = 1)
        AND l.id NOT IN (SELECT lead_id FROM lk_contatos WHERE resultado IN ('ja_comprou', 'sem_interesse'))
        AND NOT EXISTS (SELECT 1 FROM lk_contatos c WHERE c.lead_id = l.id AND c.em > v.marcado_em) ${semFora()} ${V}
      ORDER BY v.data_agendada DESC LIMIT 100`).all(agora - 14 * 86400000, ...va),
  };
  // follow-ups marcados como "ligação" na agenda do LeadsOK (hoje e atrasados até 3 dias), sem contato do SDR depois
  const followLeadsOK = d.prepare(`SELECT ${campos}, a.data agenda_data FROM lk_agenda a JOIN lk_leads l ON l.id = a.lead_id
    WHERE COALESCE(a.modalidade, '') = 'ligacao' AND COALESCE(a.concluido, 0) = 0 AND date(a.data, '-3 hours') BETWEEN ? AND ? AND a.data <= ? AND ${base}
      AND NOT EXISTS (SELECT 1 FROM lk_contatos c WHERE c.lead_id = l.id AND c.em > CAST(strftime('%s', a.data) AS INTEGER) * 1000) ${V}
    ORDER BY a.data ASC LIMIT 100`).all(diaSP(agora - 3 * 86400000), hoje, new Date(Date.parse(hoje + 'T23:59:59-03:00')).toISOString(), ...va);
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
  // último resultado de visita marcado na Agenda (vale se for depois do último contato do SDR)
  const visitaMarcada = {};
  for (const v of d.prepare('SELECT lead_id, compareceu, comprou, marcado_em FROM lk_visitas ORDER BY marcado_em').all()) visitaMarcada[v.lead_id] = v;
  const todosLeads = {};
  const etapa = (id, lead) => {
    const c = ultimos[id];
    const v = visitaMarcada[id];
    if (v && v.comprou === 1) return 'encerrados';
    if (v && (!c || v.marcado_em > c.em)) return 'posVisita';
    if (!c) return 'fila';
    if (['ja_comprou', 'sem_interesse'].includes(c.resultado)) return 'encerrados';
    if (c.resultado === 'agendou') return 'agendados';
    // topou visitar mas não fechou dia e hora: fica em "interesse em agendar" até confirmar
    if (c.resultado === 'interesse_visita') return 'interesse';
    if (c.proximo_em) return c.proximo_em <= fimDeHoje ? 'retornar' : 'retorno';
    if (c.resultado === 'nao_atendeu') return tentativas[id] >= maxTent ? 'semContato' : agora - c.em >= hTentar * 3600000 ? 'retornar' : 'tentar';
    if (c.resultado === 'enviada') {
      const respondeu = lead && lead.ultima_msg_owner === 'customers' && Date.parse(lead.ultima_msg_at) > c.em;
      // recado sem resposta depois do prazo: follow-up; se o cliente respondeu, volta para a fila ("Cliente respondeu")
      return respondeu ? 'fila' : agora - c.em >= hRecado * 3600000 ? 'retornar' : 'aguardando';
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
  // visitas que o SDR agendou pelo briefing (data no "proximo_em"): entram no follow-up se não estão na agenda do LeadsOK
  const naLista = new Set(listas.visitas.map((l) => l.id));
  const jaMarcada = d.prepare('SELECT 1 FROM lk_visitas WHERE lead_id = ? AND data_agendada = ?');
  const fimAmanha = Date.parse(amanha + 'T23:59:59-03:00');
  for (const l of Object.values(todosLeads)) {
    const c = ultimos[l.id];
    if (c.resultado !== 'agendou' || !c.proximo_em || naLista.has(l.id) || !meu(l) || estaFora(l.vendedor)) continue;
    if (c.proximo_em < agora - 7 * 86400000 || c.proximo_em > fimAmanha) continue;
    const data = new Date(c.proximo_em).toISOString();
    if (jaMarcada.get(l.id, data)) continue;
    listas.visitas.push({ ...l, agenda_data: data, modalidade: 'presencial', agenda_origem: 'sdr' });
  }
  // pela_ia: quem marcou foi a IA (sem confirmação humana do horário é só interesse em agendar)
  const pelaIa = d.prepare(`SELECT 1 FROM lk_agenda a WHERE a.lead_id = ? AND a.data = ? AND a.pela_ia = 1`);
  for (const l of listas.visitas) l.pela_ia = l.agenda_origem === 'leadsok' && !!pelaIa.get(l.id, l.agenda_data);
  // primeiro as que já passaram (marcar o resultado), depois as próximas por horário
  const agoraIso = new Date(agora).toISOString();
  const conf = d.prepare('SELECT tipo, MAX(em) em FROM lk_confirmacoes WHERE lead_id = ? AND data_agendada = ? GROUP BY tipo');
  for (const l of listas.visitas) {
    l.passou = l.agenda_data < agoraIso;
    for (const c of conf.all(l.id, l.agenda_data)) l[{ cliente: 'cliente_confirmou', lembrete: 'lembrete_enviado', nao_veio: 'msg_nao_veio' }[c.tipo] || 'confirmacao_enviada'] = c.em;
  }
  listas.visitas.sort((a, b) => (a.passou !== b.passou ? (a.passou ? -1 : 1) : a.agenda_data < b.agenda_data ? -1 : 1));
  // interesse em agendar: a IA marcou, a visita ainda não aconteceu e o cliente não confirmou o horário
  listas.interesseIa = listas.visitas.filter((l) => l.pela_ia && !l.passou && !l.cliente_confirmou);
  const noInteresse = new Set(listas.interesseIa);
  listas.visitas = listas.visitas.filter((l) => !noInteresse.has(l));
  // + quem topou visitar numa ligação do SDR e ainda não fechou o horário (com o briefing do que foi dito)
  const idsInteresse = new Set(listas.interesseIa.map((l) => l.id));
  for (const l of Object.values(todosLeads)) if (meu(l) && !estaFora(l.vendedor) && etapa(l.id, l) === 'interesse' && !idsInteresse.has(l.id)) listas.interesseIa.push({ ...l, topouSemHorario: true });
  listas.retornar = Object.values(todosLeads).filter((l) => meu(l) && !estaFora(l.vendedor) && etapa(l.id, l) === 'retornar')
    .sort((a, b) => (ultimos[a.id].proximo_em || ultimos[a.id].em) - (ultimos[b.id].proximo_em || ultimos[b.id].em));
  const noRetornar = new Set(listas.retornar.map((l) => l.id));
  for (const l of followLeadsOK) if (!noRetornar.has(l.id) && noRetornar.add(l.id)) listas.retornar.push({ ...l, followLeadsOK: l.agenda_data });
  // fila de trabalho: um lead só na lista mais urgente, e só quem está na etapa "fila" (ou "retornar")
  const vistos = new Set();
  for (const k of ['retornar', 'responder', 'abandonados', 'interesseIa', 'visitas', 'posVisita', 'novos', 'retomar']) {
    listas[k] = listas[k].filter((l) => {
      const e = etapa(l.id, l);
      const pode = k === 'retornar' ? e === 'retornar' || (l.followLeadsOK && e !== 'encerrados') : k === 'visitas' ? e !== 'encerrados' : k === 'interesseIa' ? e !== 'encerrados' && (!l.topouSemHorario || e === 'interesse') : k === 'posVisita' ? e !== 'encerrados' : e === 'fila';
      return pode && !vistos.has(l.id) && vistos.add(l.id);
    });
  }
  // etapas (CRM): onde está cada lead que já foi trabalhado
  const etapas = { aguardando: [], tentar: [], retorno: [], interesse: [], agendados: [], posVisita: [], semContato: [], encerrados: [] };
  for (const l of Object.values(todosLeads)) {
    if (!meu(l) || estaFora(l.vendedor)) continue;
    const e = etapa(l.id, l);
    if (etapas[e]) etapas[e].push(l);
  }
  for (const k of Object.keys(etapas)) etapas[k].sort((a, b) => (ultimos[b.id]?.em || 0) - (ultimos[a.id]?.em || 0));
  const anexar = (l) => { l.ultimoContato = ultimos[l.id] || null; l.tentativas = tentativas[l.id] || 0; };
  for (const k of Object.keys(listas)) listas[k].forEach(anexar);
  for (const k of Object.keys(etapas)) etapas[k].forEach(anexar);
  // contatos que o SDR já registrou hoje
  const contatos = d.prepare('SELECT lead_id, tipo, resultado, em, por, nota FROM lk_contatos WHERE dia = ? ORDER BY em').all(hoje);
  const porLead = {};
  for (const c of contatos) (porLead[c.lead_id] ||= []).push(c);
  for (const k of Object.keys(listas)) for (const l of listas[k]) l.contatosHoje = porLead[l.id] || [];
  const resumo = { ligacoes: contatos.filter((c) => c.tipo === 'ligacao').length, atenderam: contatos.filter((c) => ['atendeu', 'agendou', 'interesse_visita', 'ja_comprou', 'sem_interesse'].includes(c.resultado) && c.tipo === 'ligacao').length, mensagens: contatos.filter((c) => c.tipo === 'mensagem').length, agendou: contatos.filter((c) => c.resultado === 'agendou').length, leads: Object.keys(porLead).length };
  // vendedores com leads em aberto (para escolher a carteira)
  const vendedores = d.prepare(`SELECT l.vendedor, COUNT(*) n FROM lk_leads l WHERE l.is_resgate = 0 AND l.aba_atual != 'arquivados' AND l.vendedor IS NOT NULL AND l.vendedor_is_ia = 0 AND l.created_date > ?
    ${semFora()} GROUP BY l.vendedor ORDER BY n DESC`).all(iso(30 * 86400000));
  return { dia: hoje, horasSemResposta, vendedor, vendedores, listas, etapas, resumo, cadencia: { horasTentarDeNovo: hTentar, horasAguardandoRecado: hRecado, tentativasMax: maxTent, diasNovos, horasSemRespostaResgate: hResgate } };
}

const RESULTADOS = ['atendeu', 'nao_atendeu', 'enviada', 'agendou', 'interesse_visita', 'ja_comprou', 'sem_interesse'];
function registrarContato({ leadId, tipo, resultado, por, nota, interesse, proximoEm }) {
  const d = banco.abrir();
  if (!d) throw new Error(banco.erro());
  if (!['ligacao', 'mensagem'].includes(tipo)) throw new Error('Tipo de contato inválido');
  if (!por || !String(por).trim()) throw new Error('Contato sem responsável: entre com o seu usuário');
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
// Resultado do SDR no período: por dia e por pessoa (ligações, atenderam, recados, agendou) e o que virou visita
function resultadoSdr({ de, ate, por } = {}) {
  const d = banco.abrir();
  if (!d) return { erro: banco.erro() };
  const filtro = por ? 'AND c.por = ?' : '';
  const args = por ? [de, ate, por] : [de, ate];
  const ATENDEU = "c.tipo = 'ligacao' AND c.resultado IN ('atendeu', 'agendou', 'interesse_visita', 'ja_comprou', 'sem_interesse')";
  const cols = `TOTAL(c.tipo = 'ligacao') ligacoes, TOTAL(${ATENDEU}) atenderam, TOTAL(c.resultado = 'nao_atendeu') naoAtenderam,
    TOTAL(c.tipo = 'mensagem') mensagens, TOTAL(c.resultado = 'agendou') agendou, TOTAL(c.resultado IN ('ja_comprou', 'sem_interesse')) encerrados,
    COUNT(DISTINCT c.lead_id) leads`;
  const porDia = d.prepare(`SELECT c.dia, ${cols} FROM lk_contatos c WHERE c.dia BETWEEN ? AND ? ${filtro} GROUP BY c.dia ORDER BY c.dia`).all(...args);
  const porPessoa = d.prepare(`SELECT COALESCE(c.por, 'Sem responsável (registro antigo)') por, ${cols} FROM lk_contatos c WHERE c.dia BETWEEN ? AND ? ${filtro} GROUP BY c.por ORDER BY ligacoes DESC`).all(...args);
  const total = d.prepare(`SELECT ${cols} FROM lk_contatos c WHERE c.dia BETWEEN ? AND ? ${filtro}`).get(...args);
  // visitas dos leads que o SDR agendou no período: quantas aconteceram, quantas compraram
  const vis = d.prepare(`SELECT COALESCE(c.por, 'Sem responsável (registro antigo)') por, COUNT(DISTINCT c.lead_id) agendados,
      COUNT(DISTINCT CASE WHEN v.compareceu = 1 THEN c.lead_id END) vieram, COUNT(DISTINCT CASE WHEN v.compareceu = 0 THEN c.lead_id END) naoVieram,
      COUNT(DISTINCT CASE WHEN v.comprou = 1 THEN c.lead_id END) compraram
    FROM lk_contatos c LEFT JOIN lk_visitas v ON v.lead_id = c.lead_id AND v.marcado_em > c.em
    WHERE c.resultado = 'agendou' AND c.dia BETWEEN ? AND ? ${filtro} GROUP BY c.por`).all(...args);
  const visMapa = Object.fromEntries(vis.map((x) => [x.por, x]));
  const visTot = vis.reduce((a, x) => ({ vieram: a.vieram + x.vieram, naoVieram: a.naoVieram + x.naoVieram, compraram: a.compraram + x.compraram }), { vieram: 0, naoVieram: 0, compraram: 0 });
  // horário das ligações (para ver em que hora ele mais atende)
  const porHora = d.prepare(`SELECT CAST(strftime('%H', c.em / 1000, 'unixepoch', '-3 hours') AS INTEGER) hora, TOTAL(c.tipo = 'ligacao') ligacoes, TOTAL(${ATENDEU}) atenderam
    FROM lk_contatos c WHERE c.dia BETWEEN ? AND ? ${filtro} GROUP BY hora ORDER BY hora`).all(...args);
  const pessoas = d.prepare('SELECT DISTINCT por FROM lk_contatos WHERE por IS NOT NULL ORDER BY por').all().map((x) => x.por);
  // funil do SDR (por lead, cada etapa conta quem chegou pelo menos até ela):
  // ativação = lead que recebeu ligação ou mensagem; conexão = atendeu, ou respondeu no WhatsApp depois do contato;
  // agendamento = agendou visita; comparecimento = veio; compra
  const f = d.prepare(`SELECT COUNT(*) ativados, TOTAL(conectou OR agendou OR veio OR comprou) conectados, TOTAL(agendou OR veio OR comprou) agendaram, TOTAL(veio OR comprou) compareceram, TOTAL(comprou) compraram FROM (
      SELECT c.lead_id,
        MAX(c.resultado IN ('atendeu', 'agendou', 'interesse_visita', 'ja_comprou', 'sem_interesse') OR (l.ultima_msg_owner = 'customers' AND l.ultima_msg_at > strftime('%Y-%m-%dT%H:%M:%fZ', c.em / 1000.0, 'unixepoch'))) conectou,
        MAX(c.resultado = 'agendou') agendou,
        MAX(EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = c.lead_id AND v.compareceu = 1 AND v.marcado_em > c.em)) veio,
        MAX(EXISTS (SELECT 1 FROM lk_visitas v WHERE v.lead_id = c.lead_id AND v.comprou = 1 AND v.marcado_em > c.em)) comprou
      FROM lk_contatos c LEFT JOIN lk_leads l ON l.id = c.lead_id WHERE c.dia BETWEEN ? AND ? AND c.lead_id NOT LIKE 'teste-%' ${filtro} GROUP BY c.lead_id)`).get(...args);
  return { de, ate, por: por || null, funil: f, total: { ...total, ...visTot }, porDia, porPessoa: porPessoa.map((p) => ({ ...p, vieram: visMapa[p.por]?.vieram || 0, naoVieram: visMapa[p.por]?.naoVieram || 0, compraram: visMapa[p.por]?.compraram || 0 })), porHora, pessoas };
}

// Confirmação da visita: "mensagem" = SDR mandou a confirmação; "cliente" = cliente confirmou o horário
function confirmarVisita({ leadId, data, tipo, por }) {
  const d = banco.abrir();
  if (!d) throw new Error(banco.erro());
  if (!leadId || !data || !['mensagem', 'cliente', 'lembrete', 'nao_veio'].includes(tipo)) throw new Error('Dados da confirmação inválidos');
  d.prepare('INSERT OR REPLACE INTO lk_confirmacoes (lead_id, data_agendada, tipo, por, em) VALUES (?, ?, ?, ?, ?)').run(String(leadId), String(data), tipo, por || null, Date.now());
  return { ok: true };
}

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

// Lead de teste (só no painel, não existe no LeadsOK): para treinar o SDR e ver o fluxo. Fica fora dos números.
function criarLeadTeste({ telefone, nome, carro }) {
  const d = banco.abrir();
  if (!d) throw new Error(banco.erro());
  let dig = String(telefone || '').replace(/\D/g, '');
  if (dig.length === 10 || dig.length === 11) dig = '55' + dig;
  if (dig.length < 12 || dig.length > 13) throw new Error('Telefone inválido (use DDD + número)');
  const id = 'teste-' + dig;
  const agora = new Date().toISOString();
  d.prepare(`INSERT OR REPLACE INTO lk_leads (id, nome, whatsapp, origem, vendedor, vendedor_is_ia, aba_atual, created_date, ultima_msg_owner, ultima_msg_at, is_resgate, first_seen_at, updated_at, carro)
    VALUES (?, ?, ?, 'teste', 'Teste', 0, 'leads_novos', ?, NULL, NULL, 0, ?, ?, ?)`).run(id, String(nome || 'Lead teste').slice(0, 60), '+' + dig, agora, Date.now(), Date.now(), String(carro || '').slice(0, 120) || null);
  // começa do zero: sem contatos nem visitas anteriores
  d.prepare('DELETE FROM lk_contatos WHERE lead_id = ?').run(id);
  d.prepare('DELETE FROM lk_visitas WHERE lead_id = ?').run(id);
  return { ok: true, id };
}
function removerLeadsTeste() {
  const d = banco.abrir();
  if (!d) throw new Error(banco.erro());
  for (const t of ['lk_contatos', 'lk_visitas']) d.prepare(`DELETE FROM ${t} WHERE lead_id LIKE 'teste-%'`).run();
  return { ok: true, removidos: Number(d.prepare("DELETE FROM lk_leads WHERE id LIKE 'teste-%'").run().changes) };
}

module.exports = { gestorDoDia, painelComercial, confirmarVisita, resultadoSdr, criarLeadTeste, removerLeadsTeste, registrarEsperando, filaSdr, registrarContato, marcarNoLeadsOK, historicoContatos, buscarLead, resumoPeriodo, leads, time, agenda, marcarVisita, estoque, resumoHoje, diaSP };
