// Card do carro para o WhatsApp (estilo story): foto do carro, frase grande em branco, dia e hora em dourado
// e a logo da Choice embaixo. Montado em SVG e convertido em PNG (resvg, leve, sem navegador).
const fs = require('fs');
const path = require('path');

const FONTE = path.join(__dirname, '..', 'assets', 'fontes', 'BebasNeue_400Regular.ttf');
const LOGO = path.join(__dirname, '..', 'logo.png');
const L = 1080;
const A = 1350;

const escXml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function tipoImagem(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}
// quebra a frase em linhas pela largura aproximada da fonte (Bebas Neue é estreita: ~0,42 da altura por letra)
function quebrar(texto, tamanho, largura) {
  const max = Math.max(6, Math.floor(largura / (tamanho * 0.42)));
  const linhas = [];
  let atual = '';
  for (const p of String(texto).toUpperCase().split(/\s+/).filter(Boolean)) {
    if ((atual + ' ' + p).trim().length > max && atual) {
      linhas.push(atual);
      atual = p;
    } else atual = (atual + ' ' + p).trim();
  }
  if (atual) linhas.push(atual);
  return linhas;
}

async function baixar(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`foto do carro não baixou (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

// foto: Buffer ou URL. titulo: frase principal. subtitulo: linha dourada (ex.: "HOJE · 15H").
async function gerarCard({ foto, titulo, subtitulo = '', pb = false }) {
  const { Resvg } = require('@resvg/resvg-js');
  const buf = Buffer.isBuffer(foto) ? foto : await baixar(foto);
  const img = `data:${tipoImagem(buf)};base64,${buf.toString('base64')}`;
  const logo = fs.existsSync(LOGO) ? `data:image/png;base64,${fs.readFileSync(LOGO).toString('base64')}` : null;
  // tamanho da frase: diminui até caber em no máximo 4 linhas
  let tam = 128;
  let linhas = quebrar(titulo, tam, L - 140);
  while (linhas.length > 4 && tam > 70) linhas = quebrar(titulo, (tam -= 8), L - 140);
  const alturaLinha = tam * 0.98;
  const topo = 150;
  const textoSvg = linhas.map((l, i) => `<text x="${L / 2}" y="${topo + tam + i * alturaLinha}" text-anchor="middle" font-family="Bebas Neue" font-size="${tam}" fill="#ffffff" letter-spacing="2" filter="url(#sombra)">${escXml(l)}</text>`).join('');
  const ySub = topo + tam + linhas.length * alturaLinha + 34;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${L}" height="${A}" viewBox="0 0 ${L} ${A}">
  <defs>
    <linearGradient id="cima" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.82"/><stop offset="0.55" stop-color="#000" stop-opacity="0.15"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
    <linearGradient id="baixo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.9"/></linearGradient>
    <filter id="sombra" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000" flood-opacity="0.6"/></filter>
    ${pb ? '<filter id="pb"><feColorMatrix type="saturate" values="0"/></filter>' : ''}
  </defs>
  <rect width="${L}" height="${A}" fill="#0b0b0b"/>
  <image xlink:href="${img}" x="0" y="0" width="${L}" height="${A}" preserveAspectRatio="xMidYMax slice" ${pb ? 'filter="url(#pb)"' : ''}/>
  <rect width="${L}" height="${A * 0.62}" fill="url(#cima)"/>
  <rect y="${A * 0.72}" width="${L}" height="${A * 0.28}" fill="url(#baixo)"/>
  ${textoSvg}
  ${subtitulo ? `<text x="${L / 2}" y="${ySub + 56}" text-anchor="middle" font-family="Bebas Neue" font-size="60" fill="#E2B350" letter-spacing="6" filter="url(#sombra)">${escXml(String(subtitulo).toUpperCase())}</text>` : ''}
  ${logo ? `<image xlink:href="${logo}" x="${(L - 330) / 2}" y="${A - 190}" width="330" height="134" preserveAspectRatio="xMidYMid meet"/>` : ''}
</svg>`;
  const r = new Resvg(svg, { font: { fontFiles: [FONTE], loadSystemFonts: false, defaultFontFamily: 'Bebas Neue' }, fitTo: { mode: 'width', value: L } });
  return r.render().asPng();
}

module.exports = { gerarCard };
