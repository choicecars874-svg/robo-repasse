// Aplica a margem da loja e monta o texto final usando o "modelo" da configuração.

function formatarReais(v) {
  if (v == null) return null;
  return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
}

function aplicarMargem(preco, margem) {
  if (preco == null) return null;
  let novo = margem.tipo === 'percentual' ? preco * (1 + margem.valor / 100) : preco + margem.valor;
  const passo = margem.arredondarPara || 0;
  if (passo > 0) novo = Math.ceil(novo / passo) * passo;
  return Math.round(novo);
}

function linkWhatsApp(carro, config) {
  const numero = String(config.loja.whatsapp || '').replace(/\D/g, '');
  if (!numero) return null;
  const msg = (config.loja.mensagemLink || '')
    .replace('{modelo}', carro.modelo || '')
    .replace('{ano}', carro.ano || '')
    .replace(/\s+/g, ' ')
    .trim();
  return `https://wa.me/${numero}${msg ? '?text=' + encodeURIComponent(msg) : ''}`;
}

// precoVenda permite sobrescrever o preço (ex.: ajustado no painel)
function montarTexto(carro, config, precoVenda) {
  const venda = precoVenda ?? aplicarMargem(carro.preco, config.margem);
  const fipeReal = carro.fipeOrigem === 'preço web' ? null : carro.fipe;
  const abaixo = fipeReal && venda && venda < carro.fipe ? Math.floor(((fipeReal - venda) / fipeReal) * 100) : null;
  const campos = {
    modelo: carro.modelo || 'Consulte',
    ano: carro.ano,
    km: carro.km,
    cor: carro.cor,
    cambio: carro.cambio,
    detalhes: carro.detalhes,
    preco: formatarReais(venda) || 'Consulte',
    fipe: formatarReais(fipeReal),
    abaixoFipe: abaixo >= 3 ? `${abaixo}% abaixo da FIPE` : null,
    loja: config.loja.nome,
    cidade: config.loja.cidade,
    link: linkWhatsApp(carro, config),
  };

  return config.modelo
    .split('\n')
    // remove linhas cujo campo ficou vazio (ex.: anúncio sem FIPE)
    .filter((linha) => [...linha.matchAll(/\{(\w+)\}/g)].every((m) => campos[m[1]] != null && campos[m[1]] !== ''))
    .map((linha) => linha.replace(/\{(\w+)\}/g, (_, c) => campos[c]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { montarTexto, aplicarMargem, formatarReais };
