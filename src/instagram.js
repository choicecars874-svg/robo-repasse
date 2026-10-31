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

async function chamar(caminho, params, token, tempo = 15000) {
  const url = new URL(caminho.startsWith('http') ? caminho : API + caminho);
  for (const [k, v] of Object.entries({ ...params, access_token: token })) url.searchParams.set(k, v);
  const r = await fetch(url, { signal: AbortSignal.timeout(tempo) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `Instagram respondeu ${r.status}`);
  return j;
}

const diaDe = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
// meia-noite de hoje em Brasília, em segundos
// janela do período em segundos: hoje, ontem, últimos 7 ou 30 dias (fuso de Brasília)
function janela(periodo = 'hoje') {
  const h = inicioDeHoje();
  const agora = Math.floor(Date.now() / 1000);
  if (periodo === 'ontem') return { since: h - 86400, until: h };
  if (periodo === '7') return { since: h - 6 * 86400, until: agora };
  if (periodo === '30') return { since: h - 29 * 86400, until: agora };
  return { since: h, until: agora };
}
const inicioDeHoje = () => Math.floor(new Date(`${diaDe()}T00:00:00-03:00`).getTime() / 1000);

async function guardarToken(token) {
  token = String(token || '').trim();
  if (!token) throw new Error('Cole o token');
  const perfil = await chamar('/me', { fields: 'user_id,username' }, token);
  const antes = dados.contas[perfil.username] || {};
  dados.contas[perfil.username] = { seguidoresPorDia: {}, ...antes, token, salvoEm: Date.now(), renovadoEm: Date.now() };
  salvar();
  for (const k of [...cache.keys()]) if (k.startsWith(perfil.username + '|')) cache.delete(k);
  delete erros[perfil.username];
  return { usuario: perfil.username };
}

function removerToken(usuario) {
  delete dados.contas[usuario];
  salvar();
  for (const k of [...cache.keys()]) if (k.startsWith(usuario + '|')) cache.delete(k);
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

// Direct: só LÊ as conversas para contar (não responde, não marca como lida, não usa webhook —
// o atendimento continua na ferramenta própria). Precisa da permissão de mensagens no token.
async function direct(token, perfil, { since, until }) {
  try {
    // 1) só a lista (rápido); 2) mensagens apenas das conversas que mexeram hoje, poucas por vez
    const hoje = since * 1000;
    const fim = until * 1000;
    const lista = await chamar('/me/conversations', { platform: 'instagram', fields: 'updated_time', limit: 50 }, token, 30000);
    const deHoje = (lista.data || []).filter((c) => new Date(c.updated_time).getTime() >= hoje).slice(0, 40);
    const j = { data: [] };
    for (let i = 0; i < deHoje.length; i += 4) {
      const parte = await Promise.all(deHoje.slice(i, i + 4).map((c) => chamar(`/${c.id}`, { fields: 'updated_time,participants,messages.limit(25){created_time,from}' }, token, 20000).catch(() => null)));
      j.data.push(...parte.filter(Boolean));
    }
    const daLoja = (m) => m.from && (m.from.id === perfil.user_id || m.from.id === perfil.id || m.from.username === perfil.username);
    let conversas = 0, novas = 0, aguardando = 0, respondidas = 0;
    const tempos = [];
    const esperando = []; // quem está esperando resposta agora (o @ do cliente e desde quando)
    for (const c of j.data || []) {
      if (new Date(c.updated_time).getTime() < hoje) continue;
      const msgs = (c.messages?.data || []).map((m) => ({ t: new Date(m.created_time).getTime(), loja: daLoja(m) })).sort((a, b) => a.t - b.t);
      const doCliente = msgs.filter((m) => !m.loja && m.t >= hoje && m.t < fim);
      if (!doCliente.length) continue;
      conversas++;
      if (msgs.length < 25 && msgs[0].t >= hoje) novas++; // conversa inteira cabe na página e começou hoje
      if (!msgs[msgs.length - 1].loja) {
        aguardando++;
        const cliente = (c.participants?.data || []).find((p) => p.username !== perfil.username && p.id !== perfil.user_id);
        // desde a 1ª mensagem do cliente ainda sem resposta
        let desde = msgs[msgs.length - 1].t;
        for (let k = msgs.length - 1; k >= 0 && !msgs[k].loja; k--) desde = msgs[k].t;
        esperando.push({ perfil: perfil.username, cliente: cliente?.username || null, desde });
      }
      const resposta = msgs.find((m) => m.loja && m.t > doCliente[0].t);
      if (resposta) {
        respondidas++;
        tempos.push((resposta.t - doCliente[0].t) / 60000);
      }
    }
    return { conversas, novas, aguardando, respondidas, esperando, minutos: tempos.length ? tempos.reduce((a, b) => a + b, 0) / tempos.length : null, amostra: (j.data || []).length };
  } catch (e) {
    return { erro: /permission|scope|\(#10\)|\(#200\)|\(#230\)/i.test(e.message) ? 'O token deste perfil não tem permissão de mensagens. Gere de novo marcando instagram_business_manage_messages.' : e.message };
  }
}

async function resumoConta(usuario, periodo = 'hoje') {
  const c = dados.contas[usuario];
  const guardado = cache.get(usuario + '|' + periodo);
  if (guardado && Date.now() - guardado.quando < 10 * 60 * 1000) return guardado.resumo;
  await renovarSePreciso(usuario, c);
  const t = c.token;
  try {
    const { since, until } = janela(periodo);
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
    const dm = await direct(t, perfil, { since, until });
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
      direct: dm,
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
    cache.set(usuario + '|' + periodo, { quando: Date.now(), resumo: r });
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

async function resumo(periodo = 'hoje') {
  if (!['hoje', 'ontem', '7', '30'].includes(periodo)) periodo = 'hoje';
  const usuarios = Object.keys(dados.contas);
  if (!usuarios.length) return { conectado: false, contas: [] };
  const contas = await Promise.all(usuarios.map((u) => resumoConta(u, periodo)));
  const ok = contas.filter((c) => !c.erro);
  const semana = (ok[0]?.semana || []).map((d, i) => ({ dia: d.dia, alcance: somar(ok, (c) => c.semana[i]?.alcance) }));
  return {
    conectado: true,
    periodo,
    contas,
    total: {
      seguidores: somar(ok, (c) => c.seguidores),
      seguidoresOntem: ok.every((c) => c.seguidoresOntem != null) ? somar(ok, (c) => c.seguidoresOntem) : null,
      alcance: somar(ok, (c) => c.hoje.alcance),
      interacoes: somar(ok, (c) => c.hoje.interacoes),
      visualizacoes: somar(ok, (c) => c.hoje.visualizacoes),
      toquesLink: somar(ok, (c) => c.hoje.toquesLink),
      direct: (() => {
        const d = ok.map((c) => c.direct).filter((x) => x && !x.erro);
        if (!d.length) return null;
        const resp = somar(d, (x) => x.respondidas);
        return {
          conversas: somar(d, (x) => x.conversas),
          novas: somar(d, (x) => x.novas),
          aguardando: somar(d, (x) => x.aguardando),
          respondidas: resp,
          minutos: resp ? d.filter((x) => x.minutos != null).reduce((a, x) => a + x.minutos * x.respondidas, 0) / resp : null,
          esperando: d.flatMap((x) => x.esperando || []).sort((a, b) => a.desde - b.desde),
        };
      })(),
    },
    semana,
    ultimos: ok.flatMap((c) => c.ultimos).sort((a, b) => String(b.quando).localeCompare(String(a.quando))).slice(0, 8),
    atualizadoEm: Date.now(),
  };
}

// Posts recentes de cada perfil com as métricas de cada post (alcance, salvos, compartilhamentos)
const cachePosts = { quando: 0, dados: null };
async function metricasDoPost(token, m) {
  for (const metricas of ['reach,saved,shares,total_interactions,views', 'reach,saved,shares,total_interactions', 'reach']) {
    try {
      const j = await chamar(`/${m.id}/insights`, { metric: metricas }, token, 20000);
      return Object.fromEntries((j.data || []).map((x) => [x.name, x.values?.[0]?.value ?? x.total_value?.value ?? null]));
    } catch {}
  }
  return {};
}
async function posts() {
  if (cachePosts.dados && Date.now() - cachePosts.quando < 30 * 60 * 1000) return cachePosts.dados;
  const lista = [];
  for (const [usuario, c] of Object.entries(dados.contas)) {
    try {
      const midia = await chamar('/me/media', { fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count', limit: 25 }, c.token, 20000);
      const itens = midia.data || [];
      for (let i = 0; i < itens.length; i += 4) {
        const ms = await Promise.all(itens.slice(i, i + 4).map((m) => metricasDoPost(c.token, m)));
        itens.slice(i, i + 4).forEach((m, k) => lista.push({
          id: m.id,
          usuario,
          tipo: m.media_product_type === 'REELS' ? 'Reels' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carrossel' : m.media_type === 'VIDEO' ? 'Vídeo' : 'Foto',
          legenda: (m.caption || '').slice(0, 160),
          link: m.permalink,
          imagem: m.thumbnail_url || m.media_url,
          quando: m.timestamp,
          curtidas: m.like_count ?? null,
          comentarios: m.comments_count ?? null,
          alcance: ms[k].reach ?? null,
          salvos: ms[k].saved ?? null,
          compartilhamentos: ms[k].shares ?? null,
          interacoes: ms[k].total_interactions ?? null,
          visualizacoes: ms[k].views ?? null,
        }));
      }
    } catch (e) {
      erros[usuario] = e.message;
    }
  }
  lista.sort((a, b) => String(b.quando).localeCompare(String(a.quando)));
  cachePosts.dados = { posts: lista, atualizadoEm: Date.now() };
  cachePosts.quando = Date.now();
  return cachePosts.dados;
}

const estado = () => ({
  contas: Object.entries(dados.contas).map(([usuario, c]) => ({ usuario, salvoEm: c.salvoEm, renovadoEm: c.renovadoEm, erro: erros[usuario] || null })),
});

module.exports = { guardarToken, removerToken, resumo, estado, posts };
