// Cliente do LeadsOK (crm.atendeleads.app.br). Não há API: usa a sessão de um usuário,
// as listas em RSC (/atendimentos?tab=...) e server actions do Next.js, só de leitura.
const BASE = process.env.LEADSOK_URL || 'https://crm.atendeleads.app.br';

// Ações que alteram dados no LeadsOK: nunca chamar, nem por engano
const PROIBIDAS = /send|mark|archive|transfer|schedule(?!d)|registrar|bulk|update|delete|create|save|set[A-Z]|toggle|assign|remove|edit/i;
const PERMITIDAS = new Set(['getCustomerJourneyLog', 'getChatMessages', 'getCustomerFinancing', 'listStoreInventory', 'listStoreSalesmen', 'getPendingSchedule']);

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
  async function descobrirAcoes() {
    const mapa = {};
    const scripts = new Set();
    for (const pag of ['/login', '/atendimentos']) {
      const r = await req(pag, { seguir: true });
      const html = await r.text();
      for (const m of html.matchAll(/<script[^>]+src="([^"]*\/_next\/static\/chunks\/[^"]+\.js)"/g)) scripts.add(m[1]);
    }
    const res = [/createServerReference\)\("([0-9a-f]{40,42})"[^)]*?"(\w+)"/g, /createServerReference\("([0-9a-f]{40,42})",[^)]*?"(\w+)"\)/g];
    for (const src of scripts) {
      const r = await req(src.startsWith('http') ? new URL(src).pathname : src, { seguir: true });
      const js = await r.text();
      for (const re of res) for (const m of js.matchAll(re)) mapa[m[2]] = m[1];
      await esperar(80);
    }
    if (!mapa.loginAction && !Object.keys(mapa).length) throw new Error('Não achei as ações do LeadsOK (o site pode ter mudado)');
    acoes = mapa;
    return mapa;
  }

  // ---------- Login ----------
  // A tela /login chama a server action "loginAction". O formato do corpo depende de como o
  // formulário foi escrito; tenta os formatos do Next.js e fica com o que devolver sessão.
  async function login() {
    if (!email || !senha) throw new Error('E-mail e senha do LeadsOK não configurados');
    cookies.clear();
    if (!acoes?.loginAction) await descobrirAcoes();
    const id = acoes.loginAction;
    if (!id) throw new Error('Ação de login do LeadsOK não encontrada');
    const html = await (await req('/login', { seguir: true })).text();
    const campos = [...html.matchAll(/<input[^>]+name="([^"$]+)"/g)].map((m) => m[1]);
    const cEmail = campos.find((n) => /mail|user|login/i.test(n)) || 'email';
    const cSenha = campos.find((n) => /pass|senha/i.test(n)) || 'password';
    const formulario = (raiz) => {
      const f = new FormData();
      f.set('0', raiz);
      f.set(`1_${cEmail}`, email);
      f.set(`1_${cSenha}`, senha);
      return f;
    };
    const tentativas = [
      () => ({ corpo: formulario('["$undefined","$K1"]') }), // useActionState(prev, formData)
      () => ({ corpo: formulario('["$K1"]') }), // action(formData)
      () => ({ corpo: JSON.stringify([{ [cEmail]: email, [cSenha]: senha }]), tipo: 'text/plain;charset=UTF-8' }),
      () => ({ corpo: JSON.stringify([email, senha]), tipo: 'text/plain;charset=UTF-8' }),
    ];
    let ultimaResposta = '';
    for (const t of tentativas) {
      const { corpo, tipo } = t();
      const r = await req('/login', { metodo: 'POST', corpo, headers: { 'Next-Action': id, Accept: 'text/x-component', ...(tipo ? { 'Content-Type': tipo } : {}) } });
      ultimaResposta = (await r.text()).slice(0, 300);
      if (await sessaoValida()) return true;
      cookies.clear();
    }
    const erro = ultimaResposta.match(/"(?:error|erro|message)":"([^"]+)"/i)?.[1];
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
    return { leads: extrairLeads(texto), total: +total[1], pageSize: +total[2], page: +total[3] };
  }

  // ---------- Server actions (só leitura) ----------
  async function acao(nome, args = [], tentativa = 0) {
    if (!PERMITIDAS.has(nome) || PROIBIDAS.test(nome.replace(/^get|^list/, ''))) throw new Error(`Ação ${nome} não é permitida (só leitura)`);
    if (!acoes) await descobrirAcoes();
    const id = acoes[nome];
    if (!id) {
      if (tentativa) throw new Error(`Ação ${nome} não existe mais no LeadsOK`);
      await descobrirAcoes();
      return acao(nome, args, 1);
    }
    const r = await req('/atendimentos', {
      metodo: 'POST',
      corpo: JSON.stringify(args),
      headers: { 'Next-Action': id, Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8' },
    });
    const texto = foiParaLogin(r) ? '' : await r.text();
    const linha = texto.split('\n').find((l) => l.startsWith('1:'));
    if (!linha || r.status >= 400) {
      if (tentativa) throw new Error(`Ação ${nome} falhou (${r.status})`);
      // sessão caiu ou o ID mudou com um deploy novo: redescobre e loga de novo
      await descobrirAcoes();
      if (foiParaLogin(r) || !texto) await login();
      return acao(nome, args, 1);
    }
    return JSON.parse(linha.slice(2));
  }

  return { login, descobrirAcoes, pagina, acao, get acoes() { return acoes; } };
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

module.exports = { criarCliente, extrairLeads, SessaoExpirada };
