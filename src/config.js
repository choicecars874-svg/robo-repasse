// Configuração fica em DATA_DIR/config.json e é editada pelo painel.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'dados');
fs.mkdirSync(DATA_DIR, { recursive: true });
const ARQ = path.join(DATA_DIR, 'config.json');

const PADRAO = {
  loja: {
    nome: 'CHOICE CARS',
    whatsapp: '5500000000000',
    cidade: 'Sua cidade - UF',
    mensagemLink: 'Olá! Vi no grupo o {modelo} {ano} e tenho interesse.',
    instagram: 'https://www.instagram.com/choicecarsbr/',
    endereco: 'Av. Maria Campos, 874 – Centro, Osasco - SP',
    maps: 'https://www.google.com/maps/search/?api=1&query=Av.%20Maria%20Campos%2C%20874%20-%20Centro%2C%20Osasco%20-%20SP%2C%2006010-065',
  },

  gruposOrigem: [],
  grupoDestino: '',

  // "auto": posta direto | "aprovacao": tudo passa pelo painel antes de postar
  modo: 'auto',
  numeroAprovador: '', // opcional: também manda a prévia no WhatsApp desse número

  margem: { tipo: 'fixo', valor: 3000, arredondarPara: 0 },

  // O que o comprador procura. Lista vazia = aceita qualquer carro.
  buscas: [
    // { modelo: 'onix', anoMin: 2018, anoMax: 0, precoMax: 0, kmMax: 0 }
  ],

  fipe: {
    consultarOnline: true,
    descontoMinimo: 15, // % mínimo abaixo da FIPE, calculado sobre o preço de venda (já com a margem)
    descontoMaximo: 50, // acima disso é suspeito (erro de leitura): não posta
  },

  filtros: {
    palavrasBloqueadas: ['sinistro', 'leilão', 'leilao', 'batido', 'recuperado', 'procuro', 'compro', 'troco'],
    exigirPreco: true,
    exigirFoto: true, // não posta anúncio sem foto
    anoMinimo: 2010,
    maxProblemas: 3, // mais que isso de coisas para resolver: não posta
  },

  logo: { ativo: true, posicao: 'inferior-direito', tamanho: 22, opacidade: 90 },

  // Quando o vendedor avisa no grupo de origem que vendeu, responde em cima do nosso post
  avisarVendido: true,
  textoVendido: '🚫 *VENDIDO*\n{modelo} {ano}',

  limiteDiario: 10, // máximo de posts por dia (0 = sem limite)

  segundosParaJuntarFotos: 25,
  segundosEsperandoFotos: 120, // quando o texto chega antes das fotos
  maxFotos: 10,
  intervaloEntrePostagens: [8, 20],

  modelo:
    '🚗 *{modelo}*\n{blindado}\n\n📅 Ano: {ano}\n🛣️ KM: {km}\n⛽ Combustível: {combustivel}\n⚙️ Câmbio: {cambio}\n🎨 Cor: {cor}\n\n{destaques}\n\n{afazer}\n\n📊 FIPE: {fipe}\n🌐 Preço Web: {web}\n💰 *Nosso preço: {preco}*\n🔥 *{abaixoFipe}*\n\n━━━━━━━━━━━━━━━\n🏁 *{loja}*\n📲 Interesse nesse carro? Chame no WhatsApp: {link}\n📸 Conheça nossa loja: {instagram}\n📍 {endereco} {maps}'
};

function mesclar(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra ?? base;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) out[k] = mesclar(base[k], extra[k]);
  return out;
}

let atual = mesclar(PADRAO, fs.existsSync(ARQ) ? JSON.parse(fs.readFileSync(ARQ, 'utf8')) : {});
// Modelos padrão antigos (não editados pelo usuário) passam para o padrão atual
const MODELOS_ANTIGOS = [
  '🚗 *{modelo}*\n{blindado}\n\n📅 Ano: {ano}\n🛣️ KM: {km}\n🎨 Cor: {cor}\n⚙️ Câmbio: {cambio}\n\n{detalhes}\n\n📊 FIPE: {fipe}\n🌐 Preço Web: {web}\n💰 *Nosso preço: {preco}*\n🔥 *{abaixoFipe}*\n\n━━━━━━━━━━━━━━━\n🏁 *{loja}*\n📍 {cidade}\n📲 Chame agora: {link}',,
  '🚗 *{modelo}*\n\n📅 Ano: {ano}\n🛣️ KM: {km}\n🎨 Cor: {cor}\n⚙️ Câmbio: {cambio}\n\n{detalhes}\n\n📊 FIPE: {fipe}\n💰 *Nosso preço: {preco}*\n🔥 *{abaixoFipe}*\n\n━━━━━━━━━━━━━━━\n🏁 *{loja}*\n📍 {cidade}\n📲 Chame agora: {link}',
  '🚗 *{modelo}*\n\n📅 Ano: {ano}\n🛣️ KM: {km}\n🎨 Cor: {cor}\n⚙️ Câmbio: {cambio}\n\n{detalhes}\n\n💰 *{preco}*\n📊 FIPE: {fipe}\n🔥 {abaixoFipe}\n\n━━━━━━━━━━━━━━━\n🏁 *{loja}*\n📍 {cidade}\n📲 Chame agora: {link}',
];
if (MODELOS_ANTIGOS.includes(atual.modelo)) atual.modelo = PADRAO.modelo;

module.exports = {
  DATA_DIR,
  get: () => atual,
  salvar(novo) {
    atual = mesclar(PADRAO, novo);
    fs.writeFileSync(ARQ, JSON.stringify(atual, null, 2));
    return atual;
  },
};
