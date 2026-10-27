// Testa a leitura sem conectar no WhatsApp:
//   npm run testar            -> roda os exemplos abaixo
//   npm run testar "texto"    -> testa um anúncio colado
const { parseAnuncio } = require('./parser');
const { montarTexto } = require('./modelo');
const config = require('./config').get();

const exemplos = process.argv[2]
  ? [process.argv[2]]
  : [
      `🔥 REPASSE 🔥
ONIX LT 1.0 2019/2020
Branco, manual
68.000 km
Completo, multimídia, pneus novos
Fipe 62.500
Repasse R$ 51.900
Chama no zap 11 98765-4321`,
      `HB20 Comfort 1.6 Aut 2018
45 mil km - prata
único dono, manual e chave reserva
valor 49 mil
falar com Zé (21) 99999-1234`,
      `Corolla XEi 2.0 2021
Câmbio CVT, preto
32.000km
Por 112k
FIPE R$ 124.300,00`,
    ];

for (const t of exemplos) {
  const carro = parseAnuncio(t);
  console.log('──────── ORIGINAL ────────\n' + t);
  console.log('──────── DADOS LIDOS ────────');
  console.log({ ...carro, textoOriginal: undefined });
  console.log('──────── ANÚNCIO DA LOJA ────────\n' + montarTexto(carro, config) + '\n\n');
}
