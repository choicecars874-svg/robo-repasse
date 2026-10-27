// Decide se o carro interessa: palavras bloqueadas, "o que o comprador busca" e desconto na FIPE.
const { normalizar } = require('./fipe');

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

function descontoFipe(carro) {
  if (!carro.fipe || !carro.preco) return null;
  return Math.round(((carro.fipe - carro.preco) / carro.fipe) * 1000) / 10;
}

function filtrarFipe(carro, config) {
  const d = descontoFipe(carro);
  if (d == null) return null; // sem FIPE: não rejeita, vai para aprovação manual
  if (d < config.fipe.descontoMinimo) return `só ${d}% abaixo da FIPE (mínimo ${config.fipe.descontoMinimo}%)`;
  return null;
}

module.exports = { filtrarAntesDaFipe, filtrarFipe, descontoFipe };
