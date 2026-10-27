// Lê o texto livre de um anúncio de repasse e extrai os dados do carro.

const TELEFONE = /(\+?55[\s-]?)?\(?\b\d{2}\)?[\s-]?9?\s?\d{4}[\s.-]?\d{4}\b/g;
const LINK = /(https?:\/\/\S+|www\.\S+|wa\.me\/\S+|chat\.whatsapp\.com\/\S+)/gi;
const MENCAO = /@\d{6,}/g;
const ANO = /\b(19[89]\d|20[0-3]\d)\s*(?:\/\s*(\d{4}|\d{2}))?\b/;
const KM = /([\d.,]+)\s*(mil)?\s*(?:km|kms|quil[oô]metros)\b/i;
const CAMBIO = /\b(autom[aá]tico|automatizado|manual|cvt|aut\.?)\b/i;
const CORES = ['branco', 'branca', 'preto', 'preta', 'prata', 'cinza', 'vermelho', 'vermelha', 'azul', 'verde', 'amarelo', 'amarela', 'marrom', 'bege', 'vinho', 'dourado', 'dourada', 'laranja', 'grafite'];

// Linhas que falam do vendedor original e não devem ir para o nosso anúncio
const LINHA_DE_CONTATO = /(chama|chamar|contato|zap|whats|interessad|tratar com|falar com|pv|privado|ligar|fone|tel[:.]|endere[cç]o|loja\b|agência|agencia)/i;
const LINHA_DE_PRECO = /(r\$|valor|pre[cç]o|repasse|por\s+(r\$\s*)?\d|fipe|tabela|\d+\s*mil\b|\d+\s*k\b)/i;
// "160 por 114", "fipe 160 mil por 114 mil": o primeiro valor é a tabela, o segundo é o preço
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
  const emMil = (num, mil) => {
    const v = paraNumero(num, !!mil);
    return v < 1000 ? v * 1000 : v;
  };
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
    else if (/valor|pre[cç]o|repasse|\bpor\b/i.test(linha)) preco = preco ?? v; // "R$" sozinho não diz se é FIPE ou preço
    else soltos.push(v);
  }
  // Valores sem rótulo em linhas separadas ("160 mil" / "114 mil"): o maior é a FIPE, o menor é o preço
  if (soltos.length) {
    const menor = Math.min(...soltos);
    const maior = Math.max(...soltos);
    if (!preco) preco = menor;
    if (!fipe && soltos.length >= 2 && maior > preco) fipe = maior;
  }
  return { preco, fipe };
}

function limparLinha(linha) {
  return linha.replace(TELEFONE, '').replace(LINK, '').replace(MENCAO, '').replace(/\s{2,}/g, ' ').trim();
}

function semEmoji(s) {
  return s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}*_~]/gu, '').trim();
}

function parseAnuncio(textoOriginal) {
  const texto = (textoOriginal || '').trim();
  const linhas = texto.split('\n').map((l) => l.trim()).filter(Boolean);

  const { preco, fipe } = extrairPrecos(linhas);

  const mAno = texto.match(ANO);
  const ano = mAno ? (mAno[2] ? `${mAno[1]}/${mAno[2]}` : mAno[1]) : null;

  const mKm = texto.match(KM);
  let km = null;
  if (mKm) {
    const n = paraNumero(mKm[1], !!mKm[2]);
    km = n.toLocaleString('pt-BR');
  }

  const mCambio = texto.match(CAMBIO);
  const cambio = mCambio ? (/manual/i.test(mCambio[1]) ? 'Manual' : 'Automático') : null;

  const cor = CORES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(texto)) || null;

  // Modelo = primeira linha "de verdade" que não é preço/contato
  const linhaModelo = linhas.find((l) => {
    const t = semEmoji(l);
    return t.length >= 3 && !LINHA_DE_PRECO.test(t) && !LINHA_DE_CONTATO.test(t) && !/^(repasse|oportunidade|vendo|aten[cç][aã]o)\b/i.test(t);
  });
  const modelo = linhaModelo ? semEmoji(limparLinha(linhaModelo)).replace(ANO, '').trim() : null;

  // Detalhes = demais linhas úteis (opcionais, observações), sem preço e sem contato
  const detalhes = linhas
    .filter((l) => l !== linhaModelo)
    .filter((l) => !LINHA_DE_PRECO.test(l) && !LINHA_DE_CONTATO.test(l))
    .filter((l) => !KM.test(l) || l.length > 40)
    .map(limparLinha)
    .filter((l) => semEmoji(l).length > 2)
    .join('\n');

  return { modelo, ano, km, cor: cor ? cor[0].toUpperCase() + cor.slice(1) : null, cambio, preco, fipe, detalhes, textoOriginal: texto };
}

module.exports = { parseAnuncio };
