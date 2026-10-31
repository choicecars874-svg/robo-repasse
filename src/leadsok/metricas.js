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

module.exports = { leads, time, agenda, marcarVisita, estoque, resumoHoje, diaSP };
