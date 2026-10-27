// Coloca a logo da loja em cima de cada foto.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { DATA_DIR } = require('./config');

const ARQ_LOGO = path.join(DATA_DIR, 'logo.png'); // enviada pelo painel
const LOGO_PADRAO = path.join(__dirname, '..', 'logo.png'); // vem junto com o projeto
const logoAtual = () => [ARQ_LOGO, LOGO_PADRAO].find((a) => fs.existsSync(a));

async function aplicarLogo(foto, opcoes) {
  const arqLogo = logoAtual();
  if (!opcoes.ativo || !arqLogo) return foto;
  const img = sharp(foto).rotate();
  const { width, height } = await img.metadata();

  const larguraLogo = Math.round((width * opcoes.tamanho) / 100);
  let logo = await sharp(arqLogo).resize({ width: larguraLogo }).ensureAlpha().toBuffer();
  if (opcoes.opacidade < 100) {
    logo = await sharp(logo)
      .composite([{ input: Buffer.from([255, 255, 255, Math.round((opcoes.opacidade / 100) * 255)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
      .toBuffer();
  }
  const { height: alturaLogo } = await sharp(logo).metadata();

  const m = Math.round(width * 0.03);
  const pos = {
    'inferior-direito': [width - larguraLogo - m, height - alturaLogo - m],
    'inferior-esquerdo': [m, height - alturaLogo - m],
    'superior-direito': [width - larguraLogo - m, m],
    'superior-esquerdo': [m, m],
    centro: [Math.round((width - larguraLogo) / 2), Math.round((height - alturaLogo) / 2)],
  }[opcoes.posicao] || [m, m];

  return img
    .composite([{ input: logo, left: Math.max(0, pos[0]), top: Math.max(0, pos[1]) }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = { aplicarLogo, ARQ_LOGO };
