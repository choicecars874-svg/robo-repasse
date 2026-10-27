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

// Retorna o motivo de rejeição, ou null se o carro passou.
function filtrarAntesDaFipe(carro, config) {
  const t = normalizar(carro.textoOriginal);
  const bloqueada = config.filtros.palavrasBloqueadas.find((p) => t.includes(normalizar(p)));
  if (bloqueada) return `palavra bloqueada "${bloqueada}"`;
  if (config.filtros.exigirPreco && !carro.preco) return 'sem preço';
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
  if (d < config.fipe.descontoMinimo) return `só ${d}% abaixo ${carro.referencia?.nome || 'da FIPE'} (mínimo ${config.fipe.descontoMinimo}%)`;
  return null;
}

module.exports = { filtrarAntesDaFipe, filtrarFipe, descontoFipe };
