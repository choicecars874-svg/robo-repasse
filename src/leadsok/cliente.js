// Cliente do LeadsOK (crm.atendeleads.app.br). Não há API: usa a sessão de um usuário,
// as listas em RSC (/atendimentos?tab=...) e server actions do Next.js, só de leitura.
const BASE = process.env.LEADSOK_URL || 'https://crm.atendeleads.app.br';

// Ações que alteram dados no LeadsOK: nunca chamar, nem por engano
const PROIBIDAS = /send|mark|archive|transfer|schedule(?!d)|registrar|bulk|update|delete|create|save|set[A-Z]|toggle|assign|remove|edit/i;
const PERMITIDAS = new Set(['getCustomerJourneyLog', 'getChatMessages', 'getCustomerFinancing', 'listStoreInventory', 'listStoreSalesmen', 'getPendingSchedule', 'getCustomerNotes']);
// A ÚNICA escrita permitida: as Notas internas do lead (o cliente não vê). Nada que envie, arquive ou transfira.
const ESCRITAS = new Set(['updateCustomerNotes']);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

class SessaoExpirada extends Error {}

function criarCliente({ email, senha }) {
  const cookies = new Map();
  let acoes = null; // nome -> id

  const cabecalhoCookie = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  function guardarCookies(r) {
    const lista = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
    for (const c of lista) {
      const [par] = c.split(';');
      const i = par.indexOf('=');
      if (i > 0) {
        const nome = par.slice(0, i).trim();
        const valor = par.slice(i + 1).trim();
        if (valor && !/max-age=0|expires=thu, 01 jan 1970/i.test(c)) cookies.set(nome, valor);
        else cookies.delete(nome);
      }
    }
  }

  async function req(caminho, { metodo = 'GET', headers = {}, corpo, seguir = false } = {}) {
    const r = await fetch(BASE + caminho, {
      method: metodo,
      headers: { 'User-Agent': 'GestaoChoice/1.0', ...(cookies.size ? { Cookie: cabecalhoCookie() } : {}), ...headers },
      body: corpo,
      redirect: seguir ? 'follow' : 'manual',
      signal: AbortSignal.timeout(30000),
    });
    guardarCookies(r);
    return r;
  }
  const foiParaLogin = (r) => r.status === 401 || ((r.status === 307 || r.status === 303 || r.status === 302) && /\/login/.test(r.headers.get('location') || ''));

  // ---------- Descoberta dos IDs das server actions (mudam a cada deploy do LeadsOK) ----------
  // Lê as páginas do menu do LeadsOK (links internos) e guarda nome -> id de cada ação
  // e em qual página ela apareceu (a ação é chamada nessa página)
  let paginaDaAcao = {};
  let ultimaResposta = null;
  async function descobrirAcoes() {
    const mapa = {};
    const ondeEsta = {};
    const vistos = new Set();
    const fila = ['/atendimentos', '/login'];
    const res = [/createServerReference\)\("([0-9a-f]{40,42})"[^)]*?"(\w+)"/g, /createServerReference\("([0-9a-f]{40,42})",[^)]*?"(\w+)"\)/g];
    for (let k = 0; k < fila.length && k < 16; k++) {
      const pag = fila[k];
      const r = await req(pag, { seguir: true });
      const html = await r.text();
      // links do menu (só caminhos internos simples, sem sair, sem arquivos)
      for (const m of html.matchAll(/href="(\/[a-z][\w-]*)"/g)) if (!fila.includes(m[1]) && !/sair|logout|_next|api/i.test(m[1])) fila.push(m[1]);
      for (const m of html.matchAll(/<script[^>]+src="([^"]*\/_next\/static\/chunks\/[^"]+\.js)"/g)) {
        const src = m[1].startsWith('http') ? new URL(m[1]).pathname : m[1];
        if (vistos.has(src)) continue;
        vistos.add(src);
        const js = await (await req(src, { seguir: true })).text();
        for (const re of res) for (const a of js.matchAll(re)) {
          mapa[a[2]] = a[1];
          ondeEsta[a[2]] ||= pag === '/login' ? '/atendimentos' : pag;
        }
        await esperar(80);
      }
    }
    if (!Object.keys(mapa).length) throw new Error('Não achei as ações do LeadsOK (o site pode ter mudado)');
    acoes = mapa;
    paginaDaAcao = ondeEsta;
    return mapa;
  }

  // ---------- Login ----------
  // O formulário de /login funciona sem JavaScript: os campos ocultos ($ACTION_REF_1, $ACTION_1:0,
  // $ACTION_1:1, $ACTION_KEY) já trazem o id da loginAction do deploy atual. Basta reenviar o
  // formulário (multipart) com e-mail e senha, como um navegador faria.
  async function login() {
    if (!email || !senha) throw new Error('E-mail e senha do LeadsOK não configurados');
    cookies.clear();
    const html = await (await req('/login', { seguir: true })).text();
    const campos = camposDoFormulario(html);
    const nomes = Object.keys(campos);
    const cEmail = nomes.find((n) => /mail/i.test(n)) || 'email';
    const cSenha = nomes.find((n) => /pass|senha/i.test(n)) || 'password';
    const f = new FormData();
    for (const [k, v] of Object.entries(campos)) if (k !== cEmail && k !== cSenha) f.set(k, v);
    f.set(cEmail, email);
    f.set(cSenha, senha);
    const r = await req('/login', { metodo: 'POST', corpo: f, headers: { Accept: 'text/html,application/xhtml+xml', Origin: BASE, Referer: BASE + '/login' } });
    const resposta = r.status < 300 ? (await r.text()).slice(0, 4000) : '';
    if (await sessaoValida()) return true;
    const erro = resposta.match(/"error":"([^"]+)"/)?.[1] || resposta.match(/role="alert"[^>]*>([^<]+)</)?.[1];
    cookies.clear();
    throw new Error(`Login no LeadsOK recusado${erro ? `: ${erro}` : ' (confira e-mail e senha)'}`);
  }

  async function sessaoValida() {
    if (!cookies.size) return false;
    const r = await req('/atendimentos?tab=leads_novos&page=1', { headers: { RSC: '1' } });
    if (foiParaLogin(r)) return false;
    return /"total":\d+/.test(await r.text());
  }

  // ---------- Listas ----------
  async function pagina(aba, n, tentativa = 0) {
    const r = await req(`/atendimentos?tab=${aba}&page=${n}`, { headers: { RSC: '1' } });
    const texto = foiParaLogin(r) ? '' : await r.text();
    const total = texto.match(/"total":(\d+),"pageSize":(\d+),"page":(\d+)/);
    if (!total) {
      if (tentativa) throw new Error(`Lista ${aba} página ${n} veio sem dados`);
      await login();
      return pagina(aba, n, 1);
    }
    return { leads: extrairLeads(texto), agenda: aba === 'agendados' ? resolverRefs(texto, extrairArray(texto, 'agenda')) : null, total: +total[1], pageSize: +total[2], page: +total[3] };
  }

  // ---------- Server actions (só leitura) ----------
  async function acao(nome, args = [], tentativa = 0) {
    if (!ESCRITAS.has(nome) && (!PERMITIDAS.has(nome) || PROIBIDAS.test(nome.replace(/^get|^list/, '')))) throw new Error(`Ação ${nome} não é permitida (só leitura)`);
    if (!acoes) await descobrirAcoes();
    const id = acoes[nome];
    if (!id) {
      if (tentativa) throw new Error(`Ação ${nome} não existe mais no LeadsOK`);
      await descobrirAcoes();
      return acao(nome, args, 1);
    }
    const r = await req(paginaDaAcao[nome] || '/atendimentos', {
      metodo: 'POST',
      corpo: JSON.stringify(args),
      headers: { 'Next-Action': id, Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8' },
    });
    const texto = foiParaLogin(r) ? '' : await r.text();
    // só a forma da resposta (sem conteúdo, para não expor dados de cliente)
    ultimaResposta = { nome, pagina: paginaDaAcao[nome] || '/atendimentos', status: r.status, tipo: r.headers.get('content-type') || '', tamanho: texto.length, html: /^\s*<(!doctype|html)/i.test(texto), linhas: texto.split('\n').slice(0, 8).map((l) => l.slice(0, 6).replace(/[^0-9a-zA-Z:$@\[{"]/g, '')).filter(Boolean) };
    // a linha 0 diz onde está o resultado ({"a":"$@1"} ou ["$@1", ...]); o resultado pode ter referências "$n"
    const mapa = linhasRsc(texto);
    const raiz = JSON.stringify(mapa['0'] || '').match(/"\$@([0-9a-f]+)"/)?.[1] || '1';
    const linha = mapa[raiz] !== undefined ? 'ok' : null;
    if (!linha || r.status >= 400) {
      if (tentativa) throw new Error(`Ação ${nome} falhou (${r.status})`);
      // sessão caiu ou o ID mudou com um deploy novo: redescobre e loga de novo
      await descobrirAcoes();
      if (foiParaLogin(r) || !texto) await login();
      return acao(nome, args, 1);
    }
    return resolverRefs(texto, mapa[raiz]);
  }

  return { login, descobrirAcoes, pagina, acao, get acoes() { return acoes; }, get paginaDaAcao() { return paginaDaAcao; }, get ultimaResposta() { return ultimaResposta; } };
}

// Acha cada objeto de lead no texto RSC: {"id":"..." com "conversa_id" logo depois.
// Casa as chaves respeitando strings e escapes e faz JSON.parse.
function extrairLeads(texto) {
  const vistos = new Map();
  let i = 0;
  while ((i = texto.indexOf('{"id":"', i)) !== -1) {
    if (texto.slice(i, i + 120).includes('"conversa_id"')) {
      let nivel = 0;
      let emString = false;
      let j = i;
      for (; j < texto.length; j++) {
        const c = texto[j];
        if (emString) {
          if (c === '\\') j++;
          else if (c === '"') emString = false;
        } else if (c === '"') emString = true;
        else if (c === '{') nivel++;
        else if (c === '}' && --nivel === 0) break;
      }
      try {
        const o = JSON.parse(texto.slice(i, j + 1));
        if (o.id && !vistos.has(o.id)) vistos.set(o.id, o);
      } catch {}
      i = j + 1;
    } else i += 7;
  }
  return [...vistos.values()];
}

// Campos <input> de um formulário HTML (com os valores desescapados)
function camposDoFormulario(html) {
  const ent = (v) => v.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const campos = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const nome = m[0].match(/\bname="([^"]*)"/)?.[1];
    if (!nome) continue;
    campos[ent(nome)] = ent(m[0].match(/\bvalue="([^"]*)"/)?.[1] || '');
  }
  return campos;
}

// O RSC não repete objetos: no lugar põe uma referência "$<linha>" ou "$<linha>:caminho:até:o:campo",
// apontando para outra linha da resposta ("<linha>:<json>"). Troca cada referência pelo objeto real.
function linhasRsc(texto) {
  const mapa = {};
  for (const linha of texto.split('\n')) {
    const m = linha.match(/^([0-9a-f]+):(.+)$/);
    if (!m) continue;
    try {
      mapa[m[1]] = JSON.parse(m[2]);
    } catch {}
  }
  return mapa;
}
function resolverRefs(texto, valor) {
  if (valor == null) return valor;
  let mapa = null;
  const seguir = (v, prof) => {
    if (prof > 8) return v;
    if (typeof v === 'string' && /^\$[0-9a-f]+(:|$)/.test(v)) {
      mapa ||= linhasRsc(texto);
      const [id, ...caminho] = v.slice(1).split(':');
      let alvo = mapa[id];
      for (const k of caminho) alvo = alvo == null ? undefined : alvo[k];
      return alvo === undefined ? v : seguir(alvo, prof + 1);
    }
    if (Array.isArray(v)) return v.map((x) => seguir(x, prof + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, seguir(x, prof + 1)]));
    return v;
  };
  return seguir(valor, 0);
}

// Primeiro array "chave":[...] do texto RSC, casando colchetes fora de strings
function extrairArray(texto, chave) {
  const i = texto.indexOf(`"${chave}":[`);
  if (i < 0) return null;
  const ini = i + chave.length + 3;
  let nivel = 0;
  let emString = false;
  for (let j = ini; j < texto.length; j++) {
    const c = texto[j];
    if (emString) {
      if (c === '\\') j++;
      else if (c === '"') emString = false;
    } else if (c === '"') emString = true;
    else if (c === '[' || c === '{') nivel++;
    else if ((c === ']' || c === '}') && --nivel === 0) {
      try {
        return JSON.parse(texto.slice(ini, j + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

module.exports = { criarCliente, extrairLeads, extrairArray, resolverRefs, camposDoFormulario, SessaoExpirada };
