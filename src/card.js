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

// ---------- Modelos de card ----------
// "reservado": a foto do carro limpa em cima (nada escrito sobre o carro) e um rodapé preto com
// "RESERVADO PARA", o nome grande, o carro, o dia e a hora em dourado e a logo da Choice
function svgReservado({ img, logo, nome, carro, quando, pb }) {
  const hFoto = 830;
  const nomeT = String(nome || 'Você').toUpperCase();
  let tamNome = 150;
  while (nomeT.length * tamNome * 0.42 > L - 160 && tamNome > 80) tamNome -= 10;
  const carroL = quebrar(carro || '', 56, L - 160).slice(0, 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${L}" height="${A}" viewBox="0 0 ${L} ${A}">
  <defs>
    <linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0.75" stop-color="#0b0b0b" stop-opacity="0"/><stop offset="1" stop-color="#0b0b0b" stop-opacity="1"/></linearGradient>
    <linearGradient id="ouro" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#B8862B"/><stop offset="0.5" stop-color="#F3D27A"/><stop offset="1" stop-color="#B8862B"/></linearGradient>
    <clipPath id="c"><rect width="${L}" height="${hFoto}"/></clipPath>
    ${pb ? '<filter id="pb"><feColorMatrix type="saturate" values="0"/></filter>' : ''}
  </defs>
  <rect width="${L}" height="${A}" fill="#0b0b0b"/>
  <g clip-path="url(#c)"><image xlink:href="${img}" width="${L}" height="${hFoto}" preserveAspectRatio="xMidYMid slice" ${pb ? 'filter="url(#pb)"' : ''}/></g>
  <rect width="${L}" height="${hFoto}" fill="url(#f)"/>
  <text x="${L / 2}" y="${hFoto + 70}" text-anchor="middle" font-family="Bebas Neue" font-size="46" fill="url(#ouro)" letter-spacing="14">RESERVADO PARA</text>
  <text x="${L / 2}" y="${hFoto + 70 + tamNome * 0.98}" text-anchor="middle" font-family="Bebas Neue" font-size="${tamNome}" fill="#fff" letter-spacing="4">${escXml(nomeT)}</text>
  ${carroL.map((l) => `<text x="${L / 2}" y="${hFoto + 70 + tamNome * 0.98 + 66}" text-anchor="middle" font-family="Bebas Neue" font-size="56" fill="#cfcfcf" letter-spacing="3">${escXml(l)}</text>`).join('')}
  <rect x="0" y="${A - 150}" width="${L}" height="2" fill="url(#ouro)" opacity="0.6"/>
  <text x="70" y="${A - 55}" font-family="Bebas Neue" font-size="62" fill="url(#ouro)" letter-spacing="6">${escXml(String(quando || '').toUpperCase())}</text>
  ${logo ? `<image xlink:href="${logo}" x="${L - 70 - 230}" y="${A - 130}" width="230" height="94" preserveAspectRatio="xMaxYMid meet"/>` : ''}
</svg>`;
}
// "premium": foto em cima (70%), painel preto embaixo com linha dourada, logo pequena, frase e data
function svgPremium({ img, logo, nome, carro, quando, pb }) {
  const hFoto = 900;
  const titulo = quebrar(`${nome ? nome + ', ' : ''}seu ${carro || 'carro'} está pronto`, 92, L - 160).slice(0, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${L}" height="${A}" viewBox="0 0 ${L} ${A}">
  <defs>
    <linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0.6" stop-color="#0b0b0b" stop-opacity="0"/><stop offset="1" stop-color="#0b0b0b" stop-opacity="1"/></linearGradient>
    <linearGradient id="ouro" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#B8862B"/><stop offset="0.5" stop-color="#F3D27A"/><stop offset="1" stop-color="#B8862B"/></linearGradient>
    <clipPath id="c"><rect width="${L}" height="${hFoto}"/></clipPath>
    ${pb ? '<filter id="pb"><feColorMatrix type="saturate" values="0"/></filter>' : ''}
  </defs>
  <rect width="${L}" height="${A}" fill="#0b0b0b"/>
  <g clip-path="url(#c)"><image xlink:href="${img}" width="${L}" height="${hFoto}" preserveAspectRatio="xMidYMid slice" ${pb ? 'filter="url(#pb)"' : ''}/></g>
  <rect width="${L}" height="${hFoto}" fill="url(#f)"/>
  ${logo ? `<image xlink:href="${logo}" x="48" y="40" width="210" height="86" preserveAspectRatio="xMinYMid meet"/>` : ''}
  <rect x="80" y="${hFoto + 10}" width="120" height="6" fill="url(#ouro)"/>
  <text x="80" y="${hFoto + 80}" font-family="Bebas Neue" font-size="44" fill="url(#ouro)" letter-spacing="10">SUA VISITA NA CHOICE</text>
  ${titulo.map((l, i) => `<text x="80" y="${hFoto + 175 + i * 88}" font-family="Bebas Neue" font-size="92" fill="#fff" letter-spacing="2">${escXml(l)}</text>`).join('')}
  <text x="80" y="${A - 50}" font-family="Bebas Neue" font-size="54" fill="#bdbdbd" letter-spacing="6">${escXml(String(quando || '').toUpperCase())}</text>
</svg>`;
}

// foto: Buffer ou URL. titulo: frase principal. subtitulo: linha dourada (ex.: "HOJE · 15H").
// modelo: "story" (frase grande em cima), "reservado" ou "premium". nome/carro/quando: usados pelos dois últimos.
async function gerarCard({ foto, titulo, subtitulo = '', pb = false, modelo = 'story', nome = '', carro = '', quando = '' }) {
  const { Resvg } = require('@resvg/resvg-js');
  const buf = Buffer.isBuffer(foto) ? foto : await baixar(foto);
  const img = `data:${tipoImagem(buf)};base64,${buf.toString('base64')}`;
  const logo = fs.existsSync(LOGO) ? `data:image/png;base64,${fs.readFileSync(LOGO).toString('base64')}` : null;
  const render = (svg) => new Resvg(svg, { font: { fontFiles: [FONTE], loadSystemFonts: false, defaultFontFamily: 'Bebas Neue' }, fitTo: { mode: 'width', value: L } }).render().asPng();
  if (modelo === 'reservado') return render(svgReservado({ img, logo, nome, carro, quando: quando || subtitulo, pb }));
  if (modelo === 'premium') return render(svgPremium({ img, logo, nome, carro, quando: quando || subtitulo, pb }));
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
