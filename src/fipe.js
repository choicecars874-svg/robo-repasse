// Consulta a tabela FIPE (API pública parallelum) tentando casar o texto do anúncio
// com marca/modelo/ano. É uma estimativa: o painel mostra qual versão FIPE foi usada.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const API = 'https://parallelum.com.br/fipe/api/v1/carros';
const ARQ_CACHE = path.join(DATA_DIR, 'fipe-cache.json');
const cache = fs.existsSync(ARQ_CACHE) ? JSON.parse(fs.readFileSync(ARQ_CACHE, 'utf8')) : {};
const salvarCache = () => fs.writeFileSync(ARQ_CACHE, JSON.stringify(cache));

// modelo popular -> como a marca aparece na FIPE
const MARCAS = {
  'GM - Chevrolet': ['onix', 'prisma', 'cruze', 'tracker', 'spin', 'cobalt', 's10', 'celta', 'corsa', 'classic', 'agile', 'montana', 'equinox', 'trailblazer', 'sonic', 'joy'],
  'VW - VolksWagen': ['gol', 'voyage', 'polo', 'virtus', 'fox', 'up!', 'up', 'saveiro', 'jetta', 'golf', 'tcross', 't-cross', 'nivus', 'taos', 'amarok', 'spacefox', 'crossfox', 'tiguan'],
  Fiat: ['uno', 'palio', 'siena', 'grand siena', 'strada', 'toro', 'argo', 'cronos', 'mobi', 'fiorino', 'punto', 'idea', 'doblo', 'pulse', 'fastback', 'weekend'],
  Ford: ['ka', 'fiesta', 'focus', 'ecosport', 'ranger', 'fusion', 'territory', 'maverick', 'bronco'],
  Hyundai: ['hb20', 'hb20s', 'creta', 'tucson', 'ix35', 'santa fe', 'azera', 'elantra', 'i30'],
  Toyota: ['corolla', 'etios', 'yaris', 'hilux', 'sw4', 'rav4', 'corolla cross'],
  Honda: ['civic', 'city', 'fit', 'hr-v', 'hrv', 'wr-v', 'wrv', 'cr-v', 'crv', 'accord'],
  Renault: ['sandero', 'logan', 'kwid', 'duster', 'captur', 'oroch', 'clio', 'stepway', 'fluence', 'megane'],
  Nissan: ['kicks', 'versa', 'march', 'sentra', 'frontier', 'livina', 'tiida'],
  Jeep: ['renegade', 'compass', 'commander'],
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

const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (s) => normalizar(s).replace(/[^a-z0-9.]+/g, ' ').split(' ').filter((t) => t.length > 1 || /\d/.test(t));

async function get(url) {
  if (cache[url]) return cache[url];
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`FIPE respondeu ${r.status}`);
  const json = await r.json();
  cache[url] = json;
  salvarCache();
  return json;
}

function acharMarca(texto) {
  const t = ' ' + tokens(texto).join(' ') + ' ';
  for (const [marca, modelos] of Object.entries(MARCAS)) {
    if (t.includes(' ' + normalizar(marca.split(' - ').pop()) + ' ')) return marca;
    if (modelos.some((m) => t.includes(' ' + m + ' '))) return marca;
  }
  return null;
}

function pontuar(nomeFipe, palavrasAnuncio) {
  const f = tokens(nomeFipe);
  let p = 0;
  for (const w of palavrasAnuncio) if (f.includes(w)) p += /^\d/.test(w) ? 2 : 3;
  if (palavrasAnuncio[0] && f[0] === palavrasAnuncio[0]) p += 5; // nome do modelo bate
  return p - f.length * 0.1; // desempata a favor da versão mais "simples"
}

async function consultarFipe(carro) {
  const anoModelo = carro.ano ? carro.ano.split('/').pop() : null;
  if (!carro.modelo || !anoModelo) return null;
  const anoNum = anoModelo.length === 2 ? '20' + anoModelo : anoModelo;

  const nomeMarca = acharMarca(`${carro.modelo} ${carro.textoOriginal || ''}`);
  if (!nomeMarca) return null;
  const marcas = await get(`${API}/marcas`);
  const alvo = normalizar(nomeMarca).replace(/[^a-z]/g, '');
  const marca = marcas.find((m) => normalizar(m.nome).replace(/[^a-z]/g, '') === alvo) || marcas.find((m) => normalizar(m.nome).replace(/[^a-z]/g, '').includes(alvo));
  if (!marca) return null;

  const { modelos } = await get(`${API}/marcas/${marca.codigo}/modelos`);
  const palavras = tokens(carro.modelo).filter((w) => !Object.keys(MARCAS).some((m) => normalizar(m).includes(w)));
  const candidatos = modelos
    .map((m) => ({ ...m, pontos: pontuar(m.nome, palavras) }))
    .filter((m) => m.pontos > 3)
    .sort((a, b) => b.pontos - a.pontos)
    .slice(0, 5);

  for (const mod of candidatos) {
    const anos = await get(`${API}/marcas/${marca.codigo}/modelos/${mod.codigo}/anos`);
    const ano = anos.find((a) => a.codigo.startsWith(anoNum));
    if (!ano) continue;
    const det = await get(`${API}/marcas/${marca.codigo}/modelos/${mod.codigo}/anos/${ano.codigo}`);
    const valor = parseInt(String(det.Valor).replace(/\D/g, ''), 10) / 100;
    return { valor: Math.round(valor), versao: `${det.Marca} ${det.Modelo} ${det.AnoModelo}`, codigo: det.CodigoFipe };
  }
  return null;
}

// Define carro.fipe: FIPE do anúncio > tabela FIPE online > preço "Web" do anúncio (só como referência)
async function completarFipe(carro, config, avisar = () => {}) {
  carro.fipeOrigem = carro.fipe ? 'anúncio' : null;
  if (!carro.fipe && config.fipe.consultarOnline) {
    try {
      const r = await consultarFipe(carro);
      if (r) Object.assign(carro, { fipe: r.valor, fipeVersao: r.versao, fipeOrigem: 'tabela FIPE' });
    } catch (e) {
      carro.fipeErro = e.message;
      avisar(e.message);
    }
  }
  if (!carro.fipe && carro.precoWeb) Object.assign(carro, { fipe: carro.precoWeb, fipeOrigem: 'preço web' });
  return carro;
}

module.exports = { consultarFipe, completarFipe, acharMarca, normalizar };
