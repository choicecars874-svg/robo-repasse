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
    // "mais oportunidade": [a partir do Nº post do dia, desconto mínimo %]
    escada: [
      [6, 20],
      [9, 25],
    ],
  },

  filtros: {
    palavrasBloqueadas: ['sinistro', 'leilão', 'leilao', 'batido', 'recuperado', 'procuro', 'compro', 'troco'],
    exigirPreco: true,
    exigirFoto: true, // não posta anúncio sem foto
    anoMinimo: 2010,
    maxProblemas: 3, // mais que isso de coisas para resolver: não posta
    kmMaximo: 180000,
    // utilitários grandes ficam de fora (picapes continuam)
    utilitarios: ['sprinter', 'master', 'ducato', 'daily', 'boxer', 'jumper', 'transit', 'hr', 'bongo', 'kombi', 'trafic', 'accelo', 'delivery', 'iveco', 'besta', 'topic', 'van', 'furgao', 'furgão', 'bau', 'baú', 'caminhao', 'caminhão', 'micro-onibus'],
  },

  logo: { ativo: true, posicao: 'inferior-direito', tamanho: 22, opacidade: 90 },

  // Quando o vendedor avisa no grupo de origem que vendeu, responde em cima do nosso post
  avisarVendido: true,
  textoVendido: '🚫 *VENDIDO*\n{modelo} {ano}',

  // aviso fixo em todo post (proteção contra erro de digitação / CDC). Vazio = sem aviso
  aviso:
    '_Obs.: Sujeito a eventuais erros de digitação ou divergências nas informações. Consulte e confirme os dados antes de fechar negócio._',

  limiteDiario: 10, // máximo de posts por dia (0 = sem limite)

  // metas do dia que o Painel acompanha (0 = não acompanhar)
  metas: { postsDia: 10, cliquesDia: 0, alcanceDia: 0, interacoesDia: 0, seguidoresDia: 0, leadsDia: 0, agendamentosDia: 0, visitasDia: 0, vendasMes: 0 },

  // investimento mensal em cada canal (R$), para calcular custo por lead, agendamento e venda
  investimento: {},

  // cadência do SDR (Fila do SDR), texto do recado de "Não atendeu" e argumentário de objeções
  sdr: {
    horasTentarDeNovo: 3, // não atendeu: volta para o follow-up depois disso
    horasAguardandoRecado: 24, // mandou recado e o cliente não respondeu: volta para o follow-up
    tentativasMax: 3, // tentativas seguidas sem atender até ir para "Sem contato"
    diasNovos: 7, // "Ligar agora": leads de até tantos dias
    vendedoresFora: [], // fora do processo de cobrança (ex.: consignado): não aparecem em alertas, Gestor do dia nem Fila do SDR
    horasSemRespostaResgate: 1, // lead de outro vendedor sem resposta há mais que isso cai na fila do SDR
    recado:
      'Fala {lead}, aqui é {sdr} da Choice Cars, prazer falar com você! Notamos seu interesse {carro} e tentei te ligar pra entender melhor se é esse veículo mesmo que você procura. Vai ser um prazer te atender e te dar uma atenção especial. Qual o melhor horário pra gente conversar?',
    confirmacao:
      'Fala {lead}, tudo bem? Aqui é {sdr} da Choice Cars! Passando pra confirmar sua visita {quando} às {hora} pra ver {carro}. Estaremos te aguardando! Qualquer imprevisto, é só me avisar por aqui.',
    objecoes: [
      { objecao: 'Já comprei o carro', resposta: 'Que bom, parabéns! Posso te perguntar qual você pegou e o que pesou na escolha? (ouça) Muita gente que acabou de comprar ainda tem um carro pra vender ou alguém da família procurando. Se precisar avaliar seu usado ou indicar alguém, a gente faz uma avaliação justa e rápida. Posso te mandar meu contato?' },
      { objecao: 'Só estou pesquisando', resposta: 'Perfeito, é o melhor momento pra conversar: você compara sem pressa. Me conta, o que é mais importante pra você no próximo carro: parcela, ano ou modelo? (ouça) Tenho duas ou três opções nesse perfil. Que tal vir ver pessoalmente sábado de manhã, sem compromisso? Dá pra fazer uma simulação na hora.' },
      { objecao: 'Achei caro / tem desconto?', resposta: 'Entendo. Comparado com qual referência? (ouça) Nosso preço já está abaixo da FIPE em muitos casos e o carro vai revisado. O valor final a gente fecha pessoalmente, olhando entrada, troca e forma de pagamento. Consegue passar aqui pra gente montar a melhor condição?' },
      { objecao: 'Não tenho entrada', resposta: 'Sem problema, temos opções com entrada baixa e às vezes sem entrada, depende da análise. Você tem algum carro pra dar na troca? (ouça) Posso já fazer uma simulação: me passa só seu nome completo e data de nascimento? Com o resultado a gente marca pra você vir ver o carro.' },
      { objecao: 'Meu nome está com restrição', resposta: 'Entendo, acontece bastante. Trabalhamos com vários bancos e alguns aprovam mesmo com restrição, com uma entrada um pouco maior. Vale a pena fazer a simulação sem compromisso. Se aprovar, você vem ver o carro já sabendo a parcela. Posso simular?' },
      { objecao: 'Vou pensar / falar com a família', resposta: 'Claro, decisão importante. O que ficou de dúvida pra você conversar com eles? (ouça) Que tal vir junto com quem decide com você? Assim todo mundo vê o carro e tira as dúvidas na hora. Sábado às 10h ou às 14h fica melhor?' },
      { objecao: 'Moro longe / não consigo ir à loja', resposta: 'Entendo. Posso te mandar um vídeo completo do carro agora e fazer uma chamada de vídeo mostrando os detalhes. Se gostar, a gente reserva e você vem uma vez só pra fechar e retirar. Qual o melhor horário pra chamada?' },
      { objecao: 'Me manda por mensagem, não posso falar', resposta: 'Claro! Vou te mandar no WhatsApp as fotos, o valor e uma simulação. Só me diz: é pra você mesmo e pretende usar o carro no dia a dia? Qual o melhor horário pra eu te ligar rapidinho, 2 minutos, depois que você olhar?' },
    ],
  },

  // sigla de cada grupo de origem no código do post (#DR1001). Vazio = automática pelo nome do grupo
  siglas: {},

  segundosParaJuntarFotos: 25,
  segundosEsperandoFotos: 120, // quando o texto chega antes das fotos
  // foto que chega mais longe que isso do texto não é usada (evita foto de um carro no texto de outro). 0 = sem limite
  segundosMaxFotoTexto: 20,
  // antes de postar, espera isso para ver se o vendedor manda outro anúncio logo em seguida (fotos ambíguas)
  segundosConferirFotos: 60,
  maxFotos: 10,
  intervaloEntrePostagens: [8, 20],

  modelo:
    '🚗 *{modelo}*\n{blindado}\n\n📅 Ano: {ano}\n🛣️ KM: {km}\n⛽ Combustível: {combustivel}\n⚙️ Câmbio: {cambio}\n🎨 Cor: {cor}\n\n{destaques}\n\n{afazer}\n\n📊 FIPE: {fipe}\n🌐 Preço Web: {web}\n💰 *Nosso preço: {preco}*\n🔥 *{abaixoFipe}*\n\n━━━━━━━━━━━━━━━\n🏁 *{loja}*\n📲 Interesse nesse carro? Chame no WhatsApp: {link}\n📸 Conheça nosso Instagram: {instagram}\n📍 {endereco}\n\n{aviso}\n\n{codigo}'
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
  '🚗 *{modelo}*\n{blindado}\n\n📅 Ano: {ano}\n🛣️ KM: {km}\n⛽ Combustível: {combustivel}\n⚙️ Câmbio: {cambio}\n🎨 Cor: {cor}\n\n{destaques}\n\n{afazer}\n\n📊 FIPE: {fipe}\n🌐 Preço Web: {web}\n💰 *Nosso preço: {preco}*\n🔥 *{abaixoFipe}*\n\n{aviso}\n\n━━━━━━━━━━━━━━━\n🏁 *{loja}*\n📲 Interesse nesse carro? Chame no WhatsApp: {link}\n📸 Conheça nosso Instagram: {instagram}\n📍 {endereco}\n\n{codigo}',
  '🚗 *{modelo}*\n{blindado}\n\n📅 Ano: {ano}\n🛣️ KM: {km}\n⛽ Combustível: {combustivel}\n⚙️ Câmbio: {cambio}\n🎨 Cor: {cor}\n\n{destaques}\n\n{afazer}\n\n📊 FIPE: {fipe}\n🌐 Preço Web: {web}\n💰 *Nosso preço: {preco}*\n🔥 *{abaixoFipe}*\n\n━━━━━━━━━━━━━━━\n🏁 *{loja}*\n📲 Interesse nesse carro? Chame no WhatsApp: {link}\n📸 Conheça nosso Instagram: {instagram}\n📍 {endereco}\n\n{codigo}',
  '🚗 *{modelo}*\n{blindado}\n\n📅 Ano: {ano}\n🛣️ KM: {km}\n⛽ Combustível: {combustivel}\n⚙️ Câmbio: {cambio}\n🎨 Cor: {cor}\n\n{destaques}\n\n{afazer}\n\n📊 FIPE: {fipe}\n🌐 Preço Web: {web}\n💰 *Nosso preço: {preco}*\n🔥 *{abaixoFipe}*\n\n━━━━━━━━━━━━━━━\n🏁 *{loja}*\n📲 Interesse nesse carro? Chame no WhatsApp: {link}\n📸 Conheça nossa loja: {instagram}\n📍 {endereco} {maps}',
  '🚗 *{modelo}*\n{blindado}\n\n📅 Ano: {ano}\n🛣️ KM: {km}\n🎨 Cor: {cor}\n⚙️ Câmbio: {cambio}\n\n{detalhes}\n\n📊 FIPE: {fipe}\n🌐 Preço Web: {web}\n💰 *Nosso preço: {preco}*\n🔥 *{abaixoFipe}*\n\n━━━━━━━━━━━━━━━\n🏁 *{loja}*\n📍 {cidade}\n📲 Chame agora: {link}',
  '🚗 *{modelo}*\n\n📅 Ano: {ano}\n🛣️ KM: {km}\n🎨 Cor: {cor}\n⚙️ Câmbio: {cambio}\n\n{detalhes}\n\n📊 FIPE: {fipe}\n💰 *Nosso preço: {preco}*\n🔥 *{abaixoFipe}*\n\n━━━━━━━━━━━━━━━\n🏁 *{loja}*\n📍 {cidade}\n📲 Chame agora: {link}',
  '🚗 *{modelo}*\n\n📅 Ano: {ano}\n🛣️ KM: {km}\n🎨 Cor: {cor}\n⚙️ Câmbio: {cambio}\n\n{detalhes}\n\n💰 *{preco}*\n📊 FIPE: {fipe}\n🔥 {abaixoFipe}\n\n━━━━━━━━━━━━━━━\n🏁 *{loja}*\n📍 {cidade}\n📲 Chame agora: {link}',
];
if (MODELOS_ANTIGOS.includes(atual.modelo)) atual.modelo = PADRAO.modelo;
// avisos padrão antigos (não editados) passam para o atual
const AVISOS_ANTIGOS = [
  '⚠️ _Anúncio sujeito a confirmação. Preço, fotos e informações podem conter erros de digitação e podem mudar sem aviso. Consulte disponibilidade e valores com nossa equipe antes de fechar negócio._',
  '⚠️ _Consulte disponibilidade com nossa equipe antes de fechar negócio._',
];
if (AVISOS_ANTIGOS.includes(atual.aviso)) atual.aviso = PADRAO.aviso;

module.exports = {
  DATA_DIR,
  get: () => atual,
  salvar(novo) {
    atual = mesclar(PADRAO, novo);
    fs.writeFileSync(ARQ, JSON.stringify(atual, null, 2));
    return atual;
  },
};
