// Decide se o carro interessa: palavras bloqueadas, "o que o comprador busca" e desconto na FIPE.
const { normalizar } = require('./fipe');
const { aplicarMargem } = require('./modelo');

function bateBusca(carro, b) {
  const texto = normalizar(`${carro.modelo} ${carro.textoOriginal}`);
  const palavras = normalizar(b.modelo).split(/\s+/).filter(Boolean);
  if (!palavras.every((p) => texto.includes(p))) return false;
  const ano = carro.ano ? parseInt(carro.ano.split('/').pop().padStart(4, '20'), 10) : null;
  if (b.anoMin && (!ano || ano < b.anoMin)) return false;
  if (b.anoMax && (!ano || ano > b.anoMax)) return false;
  if (b.precoMax && carro.preco > b.precoMax) return false;
  const km = carro.km ? parseInt(carro.km.replace(/\D/g, ''), 10) : null;
  if (b.kmMax && km && km > b.kmMax) return false;
  return true;
}

// Conta quantas coisas o carro precisa resolver ("fazer 2 peças", "trocar embreagem", "amassado na porta"...).
// "Fazer 2 peças" conta 2. Frases com "sem" ("sem retoques", "sem detalhes") não contam. Laudo não conta.
const PROBLEMA = /\b(fazer|arrumar|reparo|repar|consert|trocar|troca de|pintar|pintura|funilaria|amassad|amassado|risc|ferrugem|vazament|barulho|ru[ií]do|luz acesa|n[aã]o gela|embreagem|suspens|retoc|detalhe|precisa|defeito|quebrad|trincad|desgast|polir|polimento|careca|motor\s*1\s*[\\/]\s*2|meia vida|batid)/i;
function contarProblemas(texto) {
  let total = 0;
  for (const linha of normalizar(texto).split('\n')) {
    if (/laudo|ecv|vistoria/.test(linha)) continue; // laudo não é "coisa para resolver"
    const quantidade = /\d+\s*(pecas?|pneus?)/.test(linha) && !/novo|bons?\b|otimo|zero/.test(linha);
    if (!PROBLEMA.test(linha) && !quantidade) continue;
    // "fazer 2 peças e faixa couro bancos": o verbo vale para todos os itens da linha
    for (const item of linha.split(/[,;]|\s+e\s+|\s+\+\s+/).map((t) => t.replace(/[^a-z0-9/\\ ]/g, '').trim())) {
      if (!item || /^(sem|nada|zero|nenhum)\b|\bsem (retoque|detalhe|nada|defeito|reparo)/.test(item)) continue;
      const pecas = item.match(/(\d+)\s*pecas?/);
      if (pecas && !/\d\s*[\\/]\s*\d/.test(item)) total += Math.min(Number(pecas[1]), 10);
      else if (item.replace(/\d/g, '').trim().length > 2) total += 1;
    }
  }
  return total;
}

// Retorna o motivo de rejeição, ou null se o carro passou.
function filtrarAntesDaFipe(carro, config) {
  const t = normalizar(carro.textoOriginal);
  const bloqueada = config.filtros.palavrasBloqueadas.find((p) => t.includes(normalizar(p)));
  if (bloqueada) return `palavra bloqueada "${bloqueada}"`;
  if (config.filtros.exigirPreco && !carro.preco) return 'sem preço';
  const anoMin = config.filtros.anoMinimo;
  if (anoMin) {
    const ano = carro.ano ? parseInt(carro.ano.split('/').pop().padStart(4, '20'), 10) : null;
    if (!ano) return 'ano não informado';
    if (ano < anoMin) return `ano ${ano} (mínimo ${anoMin})`;
  }
  const max = config.filtros.maxProblemas;
  if (max != null && max > 0) {
    const n = contarProblemas(carro.textoOriginal);
    if (n > max) return `${n} coisas para resolver (máximo ${max})`;
  }
  if (config.buscas.length && !config.buscas.some((b) => bateBusca(carro, b))) return 'não está na lista de buscas';
  return null;
}

// % abaixo da FIPE calculado sobre o preço de VENDA (repasse + margem)
function descontoFipe(carro, config) {
  const base = carro.referencia?.valor || carro.fipe;
  if (!base || !carro.preco) return null;
  const venda = aplicarMargem(carro.preco, config.margem);
  return Math.round(((base - venda) / base) * 1000) / 10;
}

function filtrarFipe(carro, config) {
  const d = descontoFipe(carro, config);
  if (d == null) return null; // sem FIPE: não rejeita, vai para aprovação manual
  // Desconto grande demais quase sempre é erro de leitura (preço/foto de outro anúncio), não oportunidade
  if (config.fipe.descontoMaximo && d > config.fipe.descontoMaximo) return `${d}% abaixo é suspeito (máximo ${config.fipe.descontoMaximo}%) — conferir o anúncio`;
  if (d < config.fipe.descontoMinimo) return `só ${d}% abaixo ${carro.referencia?.nome || 'da FIPE'} (mínimo ${config.fipe.descontoMinimo}%)`;
  return null;
}

module.exports = { filtrarAntesDaFipe, filtrarFipe, descontoFipe, contarProblemas, PROBLEMA };
