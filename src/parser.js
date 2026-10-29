// Lê o texto livre de um anúncio de repasse e extrai os dados do carro.
const { acharMarca } = require('./fipe');

const TELEFONE = /(\+?55[\s-]?)?\(?\b\d{2}\)?[\s-]?9?\s?\d{4}[\s.-]?\d{4}\b/g;
const LINK = /(https?:\/\/\S+|www\.\S+|wa\.me\/\S+|chat\.whatsapp\.com\/\S+)/gi;
const MENCAO = /@\d{6,}/g;
const ANO = /\b(19[89]\d|20[0-3]\d)\s*(?:\/\s*(\d{4}|\d{2}))?\b/;
const KM = /([\d.,]+)[ \t]*(mil|m)?[ \t]*(?:km|kms|quil[oô]metros)\b/i; // "90 Mkm" = 90 mil km
const CAMBIO = /\b(autom[aá]tico|automatizado|manual|cvt|aut\.?)\b/i;
const CORES = ['branco', 'branca', 'preto', 'preta', 'prata', 'cinza', 'vermelho', 'vermelha', 'azul', 'verde', 'amarelo', 'amarela', 'marrom', 'bege', 'vinho', 'dourado', 'dourada', 'laranja', 'grafite'];

// Linhas que falam do vendedor original e não devem ir para o nosso anúncio
const LINHA_DE_CONTATO = /(chama|chamar|contato|zap|whats|interessad|tratar com|falar com|\bpv\b|privado|ligar|fone|tel[:.]|endere[cç]o|loja\b|agência|agencia)/i;
// Palavras que indicam o preço pedido pelo vendedor
const ROTULO_PRECO = /valor|pre[cç]o|repasse|\bpor\b|preciso|pe[cç]o|aceito|quero|\bvend[ao]\b|[àa]\s*vista|\bsai\s+(por|a)\b|custa|oferta|investimento/i;
const LINHA_DE_PRECO = new RegExp(`(r\\$|${ROTULO_PRECO.source}|por\\s+(r\\$\\s*)?\\d|fipe|tabela|\\d+\\s*mil\\b|\\d+\\s*k\\b)`, 'i');
// "160 por 114", "fipe 160 mil por 114 mil": o primeiro valor é a tabela, o segundo é o preço
// Preço anunciado na internet: não é FIPE, serve só de referência se a FIPE não for encontrada
const PRECO_WEB = /\b(web|site|internet|webmotors|olx|mercado\s*livre|anunciad[oa]|loja|revenda)\b/i;
const DE_POR = /(\d[\d.,]*)\s*(mil|k)?\s*(?:reais)?\s*[,-]?\s*por\s*(?:apenas\s*)?(?:r\$\s*)?(\d[\d.,]*)\s*(mil|k)?/i;

function paraNumero(texto, multiplicadorMil) {
  let s = texto.replace(/\s/g, '');
  // "45.900,00" -> 45900 | "45,9" + mil -> 45900 | "45.900" -> 45900
  if (/,\d{2}$/.test(s)) s = s.replace(/,\d{2}$/, '');
  if (multiplicadorMil) {
    s = s.replace(/\./g, '').replace(',', '.');
    return Math.round(parseFloat(s) * 1000);
  }
  return parseInt(s.replace(/[.,]/g, ''), 10);
}

function acharValor(linha) {
  const m = linha.match(/(?:r\$\s*)?(\d{1,3}(?:[.\s]\d{3})+(?:,\d{2})?|\d+(?:[.,]\d+)?)\s*(mil|k)?\b/i);
  if (!m) return null;
  const valor = paraNumero(m[1], !!m[2]);
  // valores menores que 1000 sem "mil" provavelmente são "45" = 45 mil
  if (!m[2] && valor < 1000 && /r\$|valor|pre[cç]o|repasse|fipe/i.test(linha)) return valor * 1000;
  return valor;
}

function extrairPrecos(linhas) {
  let preco = null;
  let fipe = null;
  const soltos = [];
  let precoWeb = null;
  const emMil = (num, mil) => {
    const v = paraNumero(num, !!mil);
    return v < 1000 ? v * 1000 : v;
  };
  // "FIPE" sozinho numa linha e o valor na linha de baixo: junta as duas
  linhas = linhas.map((l, i) => (/\bfipe\b|tabela/i.test(l) && !/\d/.test(l) && /^\W*(r\$\s*)?\d[\d.,]*\s*(mil|k)?\W*$/i.test(linhas[i + 1] || '') ? `${l} ${linhas[i + 1]}` : l))
    .filter((l, i, arr) => !(i > 0 && arr[i - 1].endsWith(` ${l}`) && /\bfipe\b|tabela/i.test(arr[i - 1])));
  for (const linha of linhas) {
    const dp = linha.replace(ANO, ' ').match(DE_POR);
    if (dp) {
      const tabela = emMil(dp[1], dp[2] || dp[4]);
      const valor = emMil(dp[3], dp[4] || dp[2]);
      if (valor >= 3000 && tabela > valor) {
        preco = preco ?? valor;
        fipe = fipe ?? tabela;
        continue;
      }
    }
    const soNumero = /^\W*(r\$\s*)?\d[\d.,]*\s*(mil|k)?\W*$/i.test(linha);
    if (!LINHA_DE_PRECO.test(linha) && !soNumero) continue;
    if (ANO.test(linha) && !/r\$|valor|pre[cç]o|fipe|tabela/i.test(linha)) continue;
    if (KM.test(linha)) continue;
    let v = acharValor(linha.replace(ANO, ' '));
    if (v && v < 1000 && soNumero) v *= 1000; // "160" sozinho na linha = 160 mil
    if (!v || v < 3000 || v > 5000000) continue;
    if (/fipe|tabela/i.test(linha)) fipe = fipe ?? v;
    else if (PRECO_WEB.test(linha)) precoWeb = precoWeb ?? v;
    else if (ROTULO_PRECO.test(linha)) preco = preco ?? v; // "R$" sozinho não diz se é FIPE ou preço
    else soltos.push(v);
  }
  // Valores sem rótulo em linhas separadas ("160 mil" / "114 mil"): o maior é a FIPE, o menor é o preço
  if (soltos.length) {
    const menor = Math.min(...soltos);
    const maior = Math.max(...soltos);
    if (!preco) preco = menor;
    if (!fipe && soltos.length >= 2 && maior > preco) fipe = maior;
  }
  return { preco, fipe, precoWeb };
}

// Laudo/ECV: só pode ir "laudo aprovado", "laudo reprovado" ou "laudo com apontamento".
// "Último ECV", "último laudo", laudo com quilometragem etc. saem do texto (não pode parecer que
// incentivamos baixar km). O carro continua sendo postado.
function regraLaudo(linha) {
  const n = linha.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!/laudo|ecv|vistoria|cautelar/.test(n)) return linha;
  if (/ultim|km|quilometr/.test(n) || /ecv/.test(n) || (/\d/.test(n) && !/100\s*%/.test(n))) return null;
  if (/reprovad/.test(n)) return '📋 Laudo reprovado';
  if (/apontament|ressalva/.test(n)) return '📋 Laudo com apontamento';
  if (/aprovad|aprova\b|ok\b|\btop\b|100\s*%/.test(n)) return '📋 Laudo aprovado';
  return null;
}

function limparLinha(linha) {
  return linha.replace(TELEFONE, '').replace(LINK, '').replace(MENCAO, '').replace(/\s{2,}/g, ' ').trim();
}

function semEmoji(s) {
  return s.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}*_~]/gu, '').trim();
}

function parseAnuncio(textoOriginal) {
  const texto = (textoOriginal || '').trim();
  const linhas = texto.split('\n').map((l) => l.trim()).filter(Boolean);

  const { preco, fipe, precoWeb } = extrairPrecos(linhas);

  const mAno = texto.match(ANO);
  const ano = mAno ? (mAno[2] ? `${mAno[1]}/${mAno[2]}` : mAno[1]) : null;

  const textoKm = linhas.filter((l) => !/laudo|ecv|vistoria|cautelar/i.test(l)).join('\n');
  const mKm = textoKm.match(KM) || textoKm.match(/\bkm\s*[:.-]?\s*(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(mil)?/i);
  let km = null;
  if (mKm) {
    const n = paraNumero(mKm[1], !!mKm[2]);
    km = n.toLocaleString('pt-BR');
  }

  const mCambio = texto.match(CAMBIO);
  const cambio = mCambio ? (/manual/i.test(mCambio[1]) ? 'Manual' : 'Automático') : null;

  const cor = CORES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(texto)) || null;

  // Modelo = primeira linha "de verdade" que não é preço/contato
  const candidatas = linhas.filter((l) => {
    const t = semEmoji(l).replace(/^[•\-–·]\s*/, '');
    return (
      t.length >= 3 &&
      // linha de preço só se tiver um valor de verdade ("Vendo Onix 2019" é modelo, "venda 140.000" é preço)
      !(LINHA_DE_PRECO.test(t) && /\d[\d.,]{2,}|\d+\s*(mil|k)\b/i.test(t.replace(ANO, ' '))) &&
      !LINHA_DE_CONTATO.test(t) &&
      !/^(repasse|oportunidade|aten[cç][aã]o|pronta entrega|urgente|baixou|imperd[ií]vel|abaixo da fipe|ipva|blindad|[uú]nico dono|revisad|derret|ano\b|km\b|cor\b|c[aâ]mbio|combust|portas|placa|final\b|\d\s*\/\s*\d|motor|pneus?|laudo|doc\b|documento|marca\s*:)/i.test(t) &&
      !/\bpe[cç]as?\b/i.test(t) &&
      !/^\d{4}$/.test(t)
    );
  });
  // Prefere a linha que cita marca/modelo conhecido (ex.: "AUDI Q5 2.0 TFSI")
  let linhaModelo = candidatas.find((l) => acharMarca(l)) || candidatas[0];
  const usadasNoModelo = [linhaModelo];
  // Só a marca na linha (ex.: "Nissan"): junta com a linha seguinte (ex.: "Kicks SV 1.6")
  const iCand = candidatas.indexOf(linhaModelo);
  if (linhaModelo && semEmoji(linhaModelo).split(/\s+/).filter(Boolean).length === 1 && candidatas[iCand + 1]) {
    usadasNoModelo.push(candidatas[iCand + 1]);
    linhaModelo = `${semEmoji(linhaModelo)} ${candidatas[iCand + 1]}`;
  }
  const modelo = linhaModelo ? semEmoji(limparLinha(linhaModelo)).replace(/^\s*(modelo|ve[ií]culo|carro)\s*[:\-]\s*/i, '').replace(ANO, '').replace(/\b(vendo|vende-se|fipe|tabela|repasse)\b/gi, '').replace(/\s{2,}/g, ' ').trim() || null : null;

  // Detalhes = demais linhas úteis (opcionais, observações), sem preço e sem contato
  const detalhes = linhas
    .filter((l) => !usadasNoModelo.includes(l))
    .filter((l) => !LINHA_DE_PRECO.test(l) && !LINHA_DE_CONTATO.test(l))
    .filter((l) => !KM.test(l) || l.length > 40)
    .filter((l) => !/blindad/i.test(l)) // a blindagem aparece em destaque no topo
    .map(regraLaudo)
    .filter(Boolean)
    .filter((l) => !/^\W*km\b/i.test(l)) // o km já aparece no campo KM
    .filter((l, i, todas) => todas.indexOf(l) === i) // sem linhas repetidas
    // tira o que já aparece nos campos do modelo (ano, câmbio)
    .filter((l) => !/^\W*(19|20)\d{2}(\s*\/\s*\d{2,4})?\W*$/.test(l) && !/^\W*c[aâ]mbio\s+\S+\W*$/i.test(l))
    .map(limparLinha)
    .filter((l) => semEmoji(l).length > 2)
    .join('\n');

  // Motor/versão em linhas próprias logo abaixo do nome (ex.: "5.0 V8") ajudam a achar a versão certa na FIPE
  const iModelo = linhas.indexOf(usadasNoModelo[usadasNoModelo.length - 1]);
  const motor = linhas
    .slice(iModelo + 1, iModelo + 5)
    .map((l) => semEmoji(l))
    .filter((l) => l.length <= 40 && /\b\d\.\d\b|\bv\s?[68]\b|\b(turbo|tsi|tfsi|tdi|hse|flex|diesel|hybrid|h[ií]brido|el[eé]trico|xdrive\d*|sdrive\d*|\d{3}i)\b/i.test(l) && !LINHA_DE_PRECO.test(l))
    .join(' ');

  const mBlind = texto.match(/blindad[oa]s?\s*(?:n[ií]vel\s*)?(iii\s*-?\s*a|iii|ii\s*-?\s*a|ii|3\s*-?\s*a)?/i);
  const blindagem = mBlind ? `BLINDADO${mBlind[1] ? ' ' + mBlind[1].toUpperCase().replace(/\s+/g, '') : ''}` : null;

  return { modelo, motor, blindagem, ano, km, cor: cor ? cor[0].toUpperCase() + cor.slice(1) : null, cambio, preco, fipe, precoWeb, detalhes, textoOriginal: texto };
}

module.exports = { parseAnuncio };
