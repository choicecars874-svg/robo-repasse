// Números do dia a dia para o Painel: anúncios lidos, postados, ignorados (por motivo), vendidos,
// cliques no "Chame no WhatsApp" — por dia e por grupo de origem.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const ARQ = path.join(DATA_DIR, 'estatisticas.json');
let dados = { dias: {}, links: {} };
try {
  dados = { dias: {}, links: {}, ...JSON.parse(fs.readFileSync(ARQ, 'utf8')) };
} catch {}

let timerSalvar = null;
function salvar() {
  clearTimeout(timerSalvar);
  timerSalvar = setTimeout(() => {
    // guarda 90 dias e os 3000 links mais recentes
    const dias = Object.keys(dados.dias).sort();
    for (const d of dias.slice(0, Math.max(0, dias.length - 90))) delete dados.dias[d];
    const links = Object.entries(dados.links).sort((a, b) => b[1].quando - a[1].quando);
    dados.links = Object.fromEntries(links.slice(0, 3000));
    try {
      fs.writeFileSync(ARQ, JSON.stringify(dados));
    } catch {}
  }, 2000);
}

const diaDe = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
function dia(d = diaDe()) {
  return (dados.dias[d] ||= { lidos: 0, postados: 0, cliques: 0, vendidos: 0, ignorados: {}, grupos: {} });
}

function contar(campo, grupo) {
  const d = dia();
  d[campo] = (d[campo] || 0) + 1;
  if (grupo && (campo === 'lidos' || campo === 'postados')) {
    const g = (d.grupos[grupo] ||= { lidos: 0, postados: 0 });
    g[campo]++;
  }
  salvar();
}

const CATEGORIAS = [
  [/suspeito/i, 'Desconto suspeito (erro de leitura)'],
  [/abaixo (da fipe|do pre)|m[ií]nimo agora/i, 'Desconto abaixo do mínimo'],
  [/fipe n[aã]o encontrada/i, 'FIPE não encontrada'],
  [/sem foto/i, 'Sem foto'],
  [/s[oó] fotos/i, 'Só fotos, sem texto'],
  [/sem pre[cç]o/i, 'Sem preço'],
  [/palavra bloqueada/i, 'Palavra bloqueada (sinistro, leilão…)'],
  [/^ano |ano n[aã]o informado/i, 'Ano abaixo do mínimo / sem ano'],
  [/ km \(m[aá]ximo/i, 'KM acima do limite'],
  [/utilit[aá]rio/i, 'Utilitário grande'],
  [/coisas para resolver/i, 'Muitos reparos'],
  [/limite de/i, 'Limite diário atingido'],
  [/j[aá] postado/i, 'Repetido'],
  [/vendido antes/i, 'Vendido antes de postar'],
];
function contarIgnorado(texto) {
  const motivo = String(texto).split(' — ').pop();
  const cat = (CATEGORIAS.find(([re]) => re.test(motivo)) || [null, 'Outros'])[1];
  const d = dia();
  d.ignorados[cat] = (d.ignorados[cat] || 0) + 1;
  salvar();
}

// ---------- Cliques no "Chame no WhatsApp" ----------
function registrarLink(id, info) {
  dados.links[id] = { ...info, quando: Date.now(), cliques: 0, ultimos: {} };
  salvar();
}
// Devolve o destino (wa.me) e conta o clique (mesma pessoa em 10 min conta 1 vez)
function clicar(id, ip) {
  const l = dados.links[id];
  if (!l) return null;
  const quem = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 12);
  const agora = Date.now();
  if (!l.ultimos[quem] || agora - l.ultimos[quem] > 10 * 60 * 1000) {
    l.cliques++;
    l.ultimoClique = agora;
    dia().cliques++;
    salvar();
  }
  l.ultimos[quem] = agora;
  // não guarda rastro de visitantes antigos
  for (const [k, t] of Object.entries(l.ultimos)) if (agora - t > 24 * 3600 * 1000) delete l.ultimos[k];
  return l;
}
const link = (id) => dados.links[id] || null;
const cliquesDoLink = (id) => dados.links[id]?.cliques || 0;

// Resumo de um período (de/ate = AAAA-MM-DD, Brasília), opcionalmente de um grupo de origem só
function resumo({ de, ate, grupo } = {}) {
  const hoje = diaDe();
  ate = ate || hoje;
  de = de || ate;
  const DIA = 24 * 3600 * 1000;
  const dias = [];
  for (let t = Date.parse(de + 'T12:00:00Z'); t <= Date.parse(ate + 'T12:00:00Z') && dias.length < 400; t += DIA) dias.push(diaDe(t));
  // gráfico: os dias do período (no mínimo os últimos 7 até a data final)
  const grafico = dias.length >= 7 ? dias.slice(-62) : Array.from({ length: 7 }, (_, i) => diaDe(Date.parse(ate + 'T12:00:00Z') - (6 - i) * DIA));
  const doDia = (d) => {
    const x = dados.dias[d] || { lidos: 0, postados: 0, cliques: 0, vendidos: 0, ignorados: {}, grupos: {} };
    if (!grupo) return x;
    const g = x.grupos?.[grupo] || { lidos: 0, postados: 0 };
    return { lidos: g.lidos, postados: g.postados, cliques: null, vendidos: null, ignorados: {}, grupos: { [grupo]: g } };
  };
  const inicio = Date.parse(de + 'T00:00:00-03:00');
  const fim = Date.parse(ate + 'T00:00:00-03:00') + DIA;
  const linksDoPeriodo = Object.entries(dados.links).filter(([, l]) => l.quando >= inicio && l.quando < fim && (!grupo || l.grupo === grupo));
  const periodo = { de, ate, lidos: 0, postados: 0, cliques: 0, vendidos: 0, ignorados: {}, grupos: {} };
  for (const d of dias) {
    const x = doDia(d);
    periodo.lidos += x.lidos || 0;
    periodo.postados += x.postados || 0;
    periodo.cliques += x.cliques || 0;
    periodo.vendidos += x.vendidos || 0;
    for (const [k, v] of Object.entries(x.ignorados || {})) periodo.ignorados[k] = (periodo.ignorados[k] || 0) + v;
    for (const [g, v] of Object.entries(x.grupos || {})) {
      const a = (periodo.grupos[g] ||= { lidos: 0, postados: 0 });
      a.lidos += v.lidos;
      a.postados += v.postados;
    }
  }
  // com filtro de grupo, os cliques vêm dos links dos posts daquele grupo
  if (grupo) periodo.cliques = linksDoPeriodo.reduce((a, [, l]) => a + (l.cliques || 0), 0);
  const maisClicados = linksDoPeriodo
    .map(([id, l]) => ({ id, codigo: l.codigo, modelo: l.modelo, ano: l.ano, grupo: l.grupo, cliques: l.cliques, quando: l.quando }))
    .filter((l) => l.cliques > 0)
    .sort((a, b) => b.cliques - a.cliques)
    .slice(0, 10);
  const ultimos = grafico.map((d) => {
    const x = doDia(d);
    const cl = grupo ? Object.values(dados.links).filter((l) => l.grupo === grupo && diaDe(l.quando) === d).reduce((a, l) => a + (l.cliques || 0), 0) : x.cliques;
    return { dia: d, ...x, cliques: cl || 0 };
  });
  const gruposTodos = [...new Set(Object.values(dados.dias).flatMap((x) => Object.keys(x.grupos || {})))].sort();
  return { hoje: periodo, periodo, ultimos, grupos7dias: periodo.grupos, maisClicados, gruposTodos, porGrupo: !!grupo };
}

module.exports = { contar, contarIgnorado, registrarLink, clicar, link, cliquesDoLink, resumo, diaDe };
