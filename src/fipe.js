// Consulta a tabela FIPE (API pública parallelum) tentando casar o texto do anúncio
// com marca/modelo/ano. É uma estimativa: o painel mostra qual versão FIPE foi usada.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const API = 'https://parallelum.com.br/fipe/api/v1/carros';
const API2 = 'https://fipe.parallelum.com.br/api/v2/cars';
const ARQ_CACHE = path.join(DATA_DIR, 'fipe-cache.json');
const cache = fs.existsSync(ARQ_CACHE) ? JSON.parse(fs.readFileSync(ARQ_CACHE, 'utf8')) : {};
const salvarCache = () => fs.writeFileSync(ARQ_CACHE, JSON.stringify(cache));

// modelo popular -> como a marca aparece na FIPE
const MARCAS = {
  'GM - Chevrolet': ['onix', 'prisma', 'cruze', 'tracker', 'spin', 'cobalt', 's10', 'celta', 'corsa', 'classic', 'agile', 'montana', 'equinox', 'trailblazer', 'sonic', 'joy', 'captiva', 'zafira', 'meriva', 'vectra', 'astra', 'blazer', 'silverado'],
  'VW - VolksWagen': ['gol', 'voyage', 'polo', 'virtus', 'fox', 'up!', 'up', 'saveiro', 'jetta', 'golf', 'tcross', 't-cross', 'nivus', 'taos', 'amarok', 'spacefox', 'crossfox', 'tiguan', 'passat', 'fusca', 'kombi', 'touareg'],
  Fiat: ['uno', 'palio', 'siena', 'grand siena', 'strada', 'toro', 'argo', 'cronos', 'mobi', 'fiorino', 'punto', 'idea', 'doblo', 'pulse', 'fastback', 'weekend', 'bravo', 'linea', 'stilo', 'freemont', 'titano'],
  Ford: ['ka', 'fiesta', 'focus', 'ecosport', 'ranger', 'fusion', 'territory', 'maverick', 'bronco'],
  Hyundai: ['hb20', 'hb20s', 'hb20x', 'creta', 'tucson', 'ix35', 'santa fe', 'azera', 'elantra', 'i30', 'veloster', 'sonata', 'vera cruz'],
  Toyota: ['corolla', 'etios', 'yaris', 'hilux', 'sw4', 'rav4', 'corolla cross', 'camry', 'prius'],
  Honda: ['civic', 'city', 'fit', 'hr-v', 'hrv', 'wr-v', 'wrv', 'cr-v', 'crv', 'accord'],
  Renault: ['sandero', 'logan', 'kwid', 'duster', 'captur', 'oroch', 'clio', 'stepway', 'fluence', 'megane', 'symbol', 'kardian', 'master', 'koleos'],
  Nissan: ['kicks', 'versa', 'march', 'sentra', 'frontier', 'livina', 'tiida'],
  Jeep: ['renegade', 'compass', 'commander', 'wrangler', 'cherokee'],
  Peugeot: ['208', '2008', '308', '3008', '207', '408'],
  'Citroën': ['c3', 'c4', 'aircross', 'c4 cactus', 'cactus'],
  Mitsubishi: ['lancer', 'asx', 'outlander', 'pajero', 'l200', 'eclipse'],
  'Kia Motors': ['sportage', 'cerato', 'picanto', 'soul', 'sorento', 'stonic'],
  'Caoa Chery': ['tiggo', 'arrizo', 'qq', 'celer'],
  Audi: ['a1', 'a3', 'a4', 'a5', 'a6', 'q2', 'q3', 'q5', 'q7', 'q8', 'tt', 'rs3', 'rs4', 'rs5', 'rs6'],
  BMW: ['118i', '120i', '320i', '328i', '330i', '330e', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'm3', 'm4'],
  'Mercedes-Benz': ['c180', 'c200', 'c250', 'c300', 'a200', 'a250', 'cla', 'gla', 'glb', 'glc', 'gle', 'sprinter', 'mercedes'],
  Volvo: ['xc40', 'xc60', 'xc90', 'ex30'],
  'Land Rover': ['evoque', 'velar', 'discovery', 'defender', 'range rover', 'freelander'],
  Porsche: ['cayenne', 'macan', 'panamera', '911'],
  BYD: ['dolphin', 'song', 'seal', 'yuan', 'king', 'tan'],
  GWM: ['haval', 'h6', 'ora'],
  RAM: ['rampage', '1500', '2500'],
  Suzuki: ['jimny', 'vitara', 'swift', 's-cross'],
  Subaru: ['forester', 'impreza', 'xv'],
  Mini: ['cooper', 'countryman'],
};

// Como a marca aparece no nosso anúncio
const NOME_MARCA = { 'GM - Chevrolet': 'Chevrolet', 'VW - VolksWagen': 'Volkswagen', 'Kia Motors': 'Kia', 'Caoa Chery': 'Chery' };
const nomeMarca = (m) => NOME_MARCA[m] || m;

const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (s) => normalizar(s).replace(/[^a-z0-9.]+/g, ' ').split(' ').filter((t) => t.length > 1 || /\d/.test(t));

const DIA = 24 * 3600 * 1000;
// Listas (marcas/modelos/anos) mudam pouco; o preço muda todo mês
async function get(url, validade = 30 * DIA) {
  const c = cache[url];
  if (c && c.t && Date.now() - c.t < validade) return c.d;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`FIPE respondeu ${r.status}`);
  const d = await r.json();
  cache[url] = { t: Date.now(), d };
  salvarCache();
  return d;
}

// Duas fontes da mesma API pública: se a v1 falhar (limite/fora do ar), tenta a v2
const FONTES = [
  {
    marcas: () => get(`${API}/marcas`),
    modelos: async (m) => (await get(`${API}/marcas/${m}/modelos`)).modelos,
    anos: (m, mod) => get(`${API}/marcas/${m}/modelos/${mod}/anos`),
    preco: async (m, mod, ano) => {
      const d = await get(`${API}/marcas/${m}/modelos/${mod}/anos/${ano}`, 7 * DIA);
      return { valor: d.Valor, versao: `${d.Marca} ${d.Modelo} ${d.AnoModelo}`, codigo: d.CodigoFipe, mes: d.MesReferencia };
    },
  },
  {
    marcas: async () => (await get(`${API2}/brands`)).map((x) => ({ nome: x.name, codigo: x.code })),
    modelos: async (m) => (await get(`${API2}/brands/${m}/models`)).map((x) => ({ nome: x.name, codigo: x.code })),
    anos: async (m, mod) => (await get(`${API2}/brands/${m}/models/${mod}/years`)).map((x) => ({ nome: x.name, codigo: x.code })),
    preco: async (m, mod, ano) => {
      const d = await get(`${API2}/brands/${m}/models/${mod}/years/${ano}`, 7 * DIA);
      return { valor: d.price, versao: `${d.brand} ${d.model} ${d.modelYear}`, codigo: d.codeFipe, mes: d.referenceMonth };
    },
  },
];

function acharMarca(texto) {
  const t = ' ' + tokens(texto).join(' ') + ' ';
  for (const [marca, modelos] of Object.entries(MARCAS)) {
    if (t.includes(' ' + normalizar(marca.split(' - ').pop()) + ' ')) return marca;
    if (modelos.some((m) => t.includes(' ' + m + ' '))) return marca;
  }
  return null;
}

const BLINDADO = /blind|security/i;

function pontuar(nomeFipe, palavrasAnuncio, anuncioBlindado) {
  const f = tokens(nomeFipe);
  // A FIPE às vezes separa o que o anúncio escreve junto ("IX 1 XDRIVE 30" x "iX1 xDrive30"):
  // considera também cada par de palavras vizinhas grudado
  const fJuntos = f.concat(f.slice(0, -1).map((t, i) => t + f[i + 1]));
  let p = 0;
  // Versão blindada da FIPE só quando o anúncio fala em blindagem (e vice-versa)
  if (BLINDADO.test(nomeFipe)) p += anuncioBlindado ? 6 : -20;
  palavrasAnuncio.forEach((w, i) => {
    const par = w + (palavrasAnuncio[i + 1] || '');
    if (fJuntos.includes(w)) p += /^\d/.test(w) ? 2 : 3;
    else if (palavrasAnuncio[i + 1] && f.includes(par)) p += 3; // anúncio separado, FIPE junto
    else if (w.length >= 3 && fJuntos.some((t) => t.length >= 3 && (t.startsWith(w) || w.startsWith(t)))) p += 1.5;
  });
  const primeiro = palavrasAnuncio[0];
  if (primeiro && (f[0] === primeiro || f[0] + (f[1] || '') === primeiro)) p += 5; // nome do modelo bate
  return p - f.length * 0.1; // desempata a favor da versão mais "simples"
}

const PALAVRAS_MARCA = new Set(Object.keys(MARCAS).flatMap((m) => tokens(m)).concat(['chevrolet', 'volkswagen', 'vw', 'gm', 'mercedes', 'benz']));

async function consultarNaFonte(fonte, carro, nomeMarca, anoNum) {
  const marcas = await fonte.marcas();
  const alvo = normalizar(nomeMarca).replace(/[^a-z]/g, '');
  const limpa = (n) => normalizar(n).replace(/[^a-z]/g, '');
  const marca = marcas.find((m) => limpa(m.nome) === alvo) || marcas.find((m) => limpa(m.nome).includes(alvo) || alvo.includes(limpa(m.nome)));
  if (!marca) return { motivo: `marca "${nomeMarca}" não está na tabela` };

  const modelos = await fonte.modelos(marca.codigo);
  const palavras = tokens(`${carro.modelo} ${carro.motor || ''}`).filter((w) => !PALAVRAS_MARCA.has(w));
  const anuncioBlindado = /blindad/i.test(carro.textoOriginal || '');
  const pontuados = modelos.map((m) => ({ ...m, pontos: pontuar(m.nome, palavras, anuncioBlindado) })).sort((a, b) => b.pontos - a.pontos);
  // Normal: só modelos bem parecidos; se nenhum, aceita os mais próximos que tenham alguma palavra em comum
  // Com a FIPE escrita no anúncio dá para conferir mais versões e escolher a que bate com ela
  const conferir = carro.fipeAnuncio ? 10 : 5;
  let candidatos = pontuados.filter((m) => m.pontos > 3).slice(0, conferir);
  if (!candidatos.length) candidatos = pontuados.filter((m) => m.pontos > 1).slice(0, 5);
  if (!candidatos.length) return { motivo: `nenhum modelo ${marca.nome} parecido com "${palavras.join(' ')}" na tabela` };

  // Primeiro o ano escrito; se a FIPE não tiver, tenta o ano seguinte
  // (anúncio "2024" costuma ser fabricação 2024 / modelo 2025, e a FIPE usa o ano-modelo)
  const anosTentar = [anoNum, String(Number(anoNum) + 1)];
  for (const anoBusca of anosTentar) {
    const achados = [];
    for (const mod of candidatos) {
      let anos, r;
      try {
        anos = await fonte.anos(marca.codigo, mod.codigo);
      } catch {
        continue; // um modelo com erro não derruba a busca: tenta o próximo
      }
      const ano = anos.find((a) => String(a.codigo).startsWith(anoBusca) && !String(a.codigo).startsWith('32000'));
      if (!ano) continue;
      try {
        r = await fonte.preco(marca.codigo, mod.codigo, ano.codigo);
      } catch {
        continue;
      }
      const valor = Math.round(parseInt(String(r.valor).replace(/\D/g, ''), 10) / 100);
      if (!(valor > 0)) continue;
      const achado = { ...r, valor, versao: anoBusca === anoNum ? r.versao : `${r.versao} (ano-modelo ${anoBusca}; anúncio dizia ${anoNum})` };
      if (!carro.fipeAnuncio) return achado; // sem FIPE no anúncio: fica com a versão mais parecida pelo nome
      achados.push(achado);
    }
    if (achados.length) {
      // Versão cujo valor mais se aproxima da FIPE escrita no anúncio (até 8% de diferença);
      // se nenhuma bate, fica com a mais parecida pelo nome
      const dif = (a) => Math.abs(a.valor - carro.fipeAnuncio) / carro.fipeAnuncio;
      const maisPerto = achados.reduce((a, b) => (dif(b) < dif(a) ? b : a));
      return dif(maisPerto) <= 0.08 ? maisPerto : achados[0];
    }
  }
  return { motivo: `modelos parecidos sem o ano ${anoNum} na tabela: ${candidatos.slice(0, 3).map((m) => m.nome).join(' | ')}` };
}

async function consultarFipe(carro) {
  const anoModelo = carro.ano ? carro.ano.split('/').pop() : null;
  if (!carro.modelo || !anoModelo) return { motivo: !anoModelo ? 'anúncio sem ano' : 'modelo não identificado' };
  const anoNum = anoModelo.length === 2 ? '20' + anoModelo : anoModelo;
  const nomeMarca = acharMarca(`${carro.modelo} ${carro.textoOriginal || ''}`);
  if (!nomeMarca) return { motivo: `marca não reconhecida em "${carro.modelo}"` };

  let ultimoErro;
  for (const fonte of FONTES) {
    try {
      return await consultarNaFonte(fonte, carro, nomeMarca, anoNum);
    } catch (e) {
      ultimoErro = e;
    }
  }
  throw ultimoErro;
}

// Define carro.fipe: tabela FIPE oficial primeiro; a FIPE escrita no anúncio só se a tabela não achar.
// O preço "Web" do anúncio nunca é usado como FIPE.
async function completarFipe(carro, config, avisar = () => {}) {
  carro.fipeAnuncio = carro.fipe;
  carro.fipe = null;
  carro.fipeOrigem = null;
  if (config.fipe.consultarOnline) {
    try {
      const r = await consultarFipe(carro);
      if (r?.valor) Object.assign(carro, { fipe: r.valor, fipeVersao: r.versao, fipeMes: r.mes, fipeOrigem: 'tabela FIPE' });
      else if (r?.motivo) carro.fipeMotivo = r.motivo;
    } catch (e) {
      carro.fipeErro = e.message;
      avisar(e.message);
    }
  }
  if (!carro.fipe && carro.fipeAnuncio) Object.assign(carro, { fipe: carro.fipeAnuncio, fipeOrigem: 'anúncio' });
  // Blindado: a FIPE não inclui a blindagem, então a conta dos 15% usa o preço Web do anúncio
  if (/blindad/i.test(carro.textoOriginal || '') && carro.precoWeb) carro.referencia = { valor: carro.precoWeb, nome: 'do preço Web (blindado)' };
  return carro;
}

module.exports = { consultarFipe, completarFipe, acharMarca, normalizar, MARCAS, nomeMarca };
