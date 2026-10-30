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
  // o código do post (#DR1001) vai junto na mensagem do cliente: quem atende já sabe de onde veio o carro
  const codigo = (carro.codigo || '').replace('#', '');
  let msg = (config.loja.mensagemLink || '')
    .replace('{modelo}', carro.modelo || '')
    .replace('{ano}', carro.ano || '')
    .replace('{codigo}', codigo)
    .replace(/\s+/g, ' ')
    .trim();
  if (codigo && !(config.loja.mensagemLink || '').includes('{codigo}')) msg = `${msg} (${codigo})`;
  return `https://wa.me/${numero}${msg ? '?text=' + encodeURIComponent(msg) : ''}`;
}

// precoVenda permite sobrescrever o preço (ex.: ajustado no painel)
function montarTexto(carro, config, precoVenda) {
  const venda = precoVenda ?? aplicarMargem(carro.preco, config.margem);
  // Blindado com preço Web: o anúncio mostra o Web e o % abaixo dele (a FIPE não inclui a blindagem)
  const usaWeb = !!carro.referencia;
  const fipeReal = usaWeb ? null : carro.fipe;
  const base = carro.referencia?.valor || carro.fipe;
  const abaixo = base && venda && venda < base ? Math.floor(((base - venda) / base) * 100) : null;
  const campos = {
    modelo: (carro.modelo || 'Consulte').toUpperCase(),
    combustivel: carro.combustivel,
    destaques: carro.destaques?.length ? `✅ *Destaques*\n${carro.destaques.map((d) => `• ${d}`).join('\n')}` : null,
    afazer: carro.afazer?.length ? `🔧 *Para fazer*\n${carro.afazer.map((d) => `• ${d}`).join('\n')}` : null,
    instagram: (config.loja.instagram || '').match(/instagram\.com\/([^/?#]+)/i) ? `@${config.loja.instagram.match(/instagram\.com\/([^/?#]+)/i)[1]}` : config.loja.instagram,
    codigo: carro.codigo || null,
    aviso: config.aviso || null,
    endereco: config.loja.endereco,
    maps: config.loja.maps,
    ano: carro.ano,
    km: carro.km,
    cor: carro.cor,
    cambio: carro.cambio,
    detalhes: carro.detalhes,
    preco: formatarReais(venda) || 'Consulte',
    fipe: formatarReais(fipeReal),
    web: usaWeb ? formatarReais(carro.referencia.valor) : null,
    blindado: carro.blindagem ? `🛡️ *${carro.blindagem}*` : null,
    abaixoFipe: abaixo >= 3 ? `${abaixo}% abaixo ${usaWeb ? 'do preço Web' : 'da FIPE'}` : null,
    loja: config.loja.nome,
    cidade: config.loja.cidade,
    link: carro.linkCurto || linkWhatsApp(carro, config),
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

module.exports = { montarTexto, aplicarMargem, formatarReais, linkWhatsApp };
