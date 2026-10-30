// Números do Instagram da loja pela API oficial (login do Instagram, app da Meta).
// Só lê: perfil, seguidores, alcance/interações do dia e os últimos posts. Não mexe no direct
// nem em webhooks (isso fica com a ferramenta de atendimento).
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const ARQ = path.join(DATA_DIR, 'instagram.json');
const API = 'https://graph.instagram.com/v22.0';
const DIA = 24 * 3600 * 1000;

// contas: { [usuario]: { token, salvoEm, renovadoEm, seguidoresPorDia } } — choicecarsbr, reservachoice1, elyaspereira...
let dados = { contas: {} };
try {
  dados = { contas: {}, ...JSON.parse(fs.readFileSync(ARQ, 'utf8')) };
} catch {}
const salvar = () => fs.writeFileSync(ARQ, JSON.stringify(dados), { mode: 0o600 });

const cache = new Map(); // usuario -> { quando, resumo }
const erros = {};

async function chamar(caminho, params, token) {
  const url = new URL(caminho.startsWith('http') ? caminho : API + caminho);
  for (const [k, v] of Object.entries({ ...params, access_token: token })) url.searchParams.set(k, v);
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `Instagram respondeu ${r.status}`);
  return j;
}

const diaDe = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
// meia-noite de hoje em Brasília, em segundos
const inicioDeHoje = () => Math.floor(new Date(`${diaDe()}T00:00:00-03:00`).getTime() / 1000);

async function guardarToken(token) {
  token = String(token || '').trim();
  if (!token) throw new Error('Cole o token');
  const perfil = await chamar('/me', { fields: 'user_id,username' }, token);
  const antes = dados.contas[perfil.username] || {};
  dados.contas[perfil.username] = { seguidoresPorDia: {}, ...antes, token, salvoEm: Date.now(), renovadoEm: Date.now() };
  salvar();
  cache.delete(perfil.username);
  delete erros[perfil.username];
  return { usuario: perfil.username };
}

function removerToken(usuario) {
  delete dados.contas[usuario];
  salvar();
  cache.delete(usuario);
}

// O token vale 60 dias; renova sozinho a cada ~20 dias para nunca vencer
async function renovarSePreciso(usuario, c) {
  if (Date.now() - c.renovadoEm < 20 * DIA) return;
  try {
    const j = await chamar('https://graph.instagram.com/refresh_access_token', { grant_type: 'ig_refresh_token' }, c.token);
    if (j.access_token) {
      c.token = j.access_token;
      c.renovadoEm = Date.now();
      salvar();
    }
  } catch (e) {
    erros[usuario] = `Não renovou o token: ${e.message}`;
  }
}

// Uma métrica por chamada: se a Meta recusar uma, as outras continuam aparecendo
async function metrica(token, nome, since, until) {
  try {
    const j = await chamar('/me/insights', { metric: nome, period: 'day', metric_type: 'total_value', since, until }, token);
    return j.data?.[0]?.total_value?.value ?? null;
  } catch {
    return null;
  }
}

async function alcanceDaSemana(token) {
  const hoje = inicioDeHoje();
  const dias = [];
  for (let i = 6; i >= 0; i--) {
    const since = hoje - i * 86400;
    dias.push({ dia: diaDe(since * 1000 + 12 * 3600 * 1000), since, until: since + 86400 });
  }
  return Promise.all(dias.map(async (d) => ({ dia: d.dia, alcance: await metrica(token, 'reach', d.since, d.until) })));
}

async function resumoConta(usuario) {
  const c = dados.contas[usuario];
  const guardado = cache.get(usuario);
  if (guardado && Date.now() - guardado.quando < 10 * 60 * 1000) return guardado.resumo;
  await renovarSePreciso(usuario, c);
  const t = c.token;
  try {
    const since = inicioDeHoje();
    const until = Math.floor(Date.now() / 1000);
    const [perfil, midia, alcance, interacoes, visualizacoes, engajadas, toquesLink, semana] = await Promise.all([
      chamar('/me', { fields: 'user_id,username,name,profile_picture_url,followers_count,follows_count,media_count' }, t),
      chamar('/me/media', { fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count', limit: 8 }, t).catch(() => ({ data: [] })),
      metrica(t, 'reach', since, until),
      metrica(t, 'total_interactions', since, until),
      metrica(t, 'views', since, until),
      metrica(t, 'accounts_engaged', since, until),
      metrica(t, 'profile_links_taps', since, until),
      alcanceDaSemana(t),
    ]);
    // seguidores do dia (para mostrar quanto cresceu)
    c.seguidoresPorDia ||= {};
    c.seguidoresPorDia[diaDe()] = perfil.followers_count;
    const dias = Object.keys(c.seguidoresPorDia).sort();
    for (const d of dias.slice(0, Math.max(0, dias.length - 120))) delete c.seguidoresPorDia[d];
    salvar();
    const r = {
      usuario: perfil.username,
      nome: perfil.name,
      foto: perfil.profile_picture_url,
      seguidores: perfil.followers_count,
      seguindo: perfil.follows_count,
      posts: perfil.media_count,
      seguidoresOntem: c.seguidoresPorDia[diaDe(Date.now() - DIA)] ?? null,
      hoje: { alcance, interacoes, visualizacoes, engajadas, toquesLink },
      semana,
      ultimos: (midia.data || []).map((m) => ({
        id: m.id,
        usuario: perfil.username,
        tipo: m.media_product_type === 'REELS' ? 'Reels' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carrossel' : m.media_type === 'VIDEO' ? 'Vídeo' : 'Foto',
        legenda: (m.caption || '').slice(0, 140),
        link: m.permalink,
        imagem: m.thumbnail_url || m.media_url,
        quando: m.timestamp,
        curtidas: m.like_count ?? null,
        comentarios: m.comments_count ?? null,
      })),
    };
    cache.set(usuario, { quando: Date.now(), resumo: r });
    delete erros[usuario];
    return r;
  } catch (e) {
    erros[usuario] = e.message;
    return { usuario, erro: e.message };
  }
}

const somar = (lista, f) => {
  const v = lista.map(f).filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

async function resumo() {
  const usuarios = Object.keys(dados.contas);
  if (!usuarios.length) return { conectado: false, contas: [] };
  const contas = await Promise.all(usuarios.map(resumoConta));
  const ok = contas.filter((c) => !c.erro);
  const semana = (ok[0]?.semana || []).map((d, i) => ({ dia: d.dia, alcance: somar(ok, (c) => c.semana[i]?.alcance) }));
  return {
    conectado: true,
    contas,
    total: {
      seguidores: somar(ok, (c) => c.seguidores),
      seguidoresOntem: ok.every((c) => c.seguidoresOntem != null) ? somar(ok, (c) => c.seguidoresOntem) : null,
      alcance: somar(ok, (c) => c.hoje.alcance),
      interacoes: somar(ok, (c) => c.hoje.interacoes),
      visualizacoes: somar(ok, (c) => c.hoje.visualizacoes),
      toquesLink: somar(ok, (c) => c.hoje.toquesLink),
    },
    semana,
    ultimos: ok.flatMap((c) => c.ultimos).sort((a, b) => String(b.quando).localeCompare(String(a.quando))).slice(0, 8),
    atualizadoEm: Date.now(),
  };
}

const estado = () => ({
  contas: Object.entries(dados.contas).map(([usuario, c]) => ({ usuario, salvoEm: c.salvoEm, renovadoEm: c.renovadoEm, erro: erros[usuario] || null })),
});

module.exports = { guardarToken, removerToken, resumo, estado };
