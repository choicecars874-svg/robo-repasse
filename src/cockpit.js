// Integração com o Cockpit (Webmotors), só leitura e sem dados pessoais de clientes.
// Não há API pública: usa a API do próprio site com o login da loja (JSON, senha em Base64, token JWT).
// O site tem proteção anti-robô (PerimeterX); se ela bloquear o servidor, o painel mostra o aviso.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const BASE = process.env.COCKPIT_URL || 'https://www.cockpit.com.br';
const ARQ = path.join(DATA_DIR, 'cockpit.json');
const ARQ_DADOS = path.join(DATA_DIR, 'cockpit-dados.json');
const ARQ_CHAVE = path.join(DATA_DIR, 'cockpit.chave');
const MIN = 60 * 1000;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let cfg = { email: '', senha: null, ativo: false };
try {
  cfg = { ...cfg, ...JSON.parse(fs.readFileSync(ARQ, 'utf8')) };
} catch {}
const salvarCfg = () => fs.writeFileSync(ARQ, JSON.stringify(cfg), { mode: 0o600 });
let dados = {};
try {
  dados = JSON.parse(fs.readFileSync(ARQ_DADOS, 'utf8'));
} catch {}
const salvarDados = () => fs.writeFileSync(ARQ_DADOS, JSON.stringify(dados));

// senha guardada criptografada (AES-256-GCM), chave só neste servidor
function chave() {
  if (!fs.existsSync(ARQ_CHAVE)) fs.writeFileSync(ARQ_CHAVE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(ARQ_CHAVE, 'utf8').trim(), 'hex');
}
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const dado = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), dado: dado.toString('hex') };
}
function decifrar(s) {
  if (!s) return '';
  const d = crypto.createDecipheriv('aes-256-gcm', chave(), Buffer.from(s.iv, 'hex'));
  d.setAuthTag(Buffer.from(s.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(s.dado, 'hex')), d.final()]).toString('utf8');
}

const estado = { rodando: false, ultimoOk: null, ultimoErro: null, falhasSeguidas: 0, avisos: [] };
let sessao = { jwt: null, exp: 0 };

const CABECALHOS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Origin: BASE,
  Referer: BASE + '/',
};
function bloqueado(status, texto) {
  return (status === 403 || status === 429) && /perimeterx|px-captcha|_pxAppId|captcha|blocked/i.test(texto || '');
}
const expDoJwt = (jwt) => {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).exp * 1000;
  } catch {
    return Date.now() + 30 * MIN;
  }
};

async function login(email = cfg.email, senha = decifrar(cfg.senha)) {
  if (!email || !senha) throw new Error('E-mail e senha do Cockpit não configurados');
  const r = await fetch(BASE + '/api/login/access/sso/login', {
    method: 'POST',
    headers: { ...CABECALHOS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Email: email, Senha: Buffer.from(senha, 'utf8').toString('base64'), Encrypted: true, Environment: 'production', ManterConectado: true }),
    signal: AbortSignal.timeout(30000),
  });
  const texto = await r.text();
  if (bloqueado(r.status, texto)) throw new Error('O Cockpit bloqueou o acesso do servidor (proteção anti-robô PerimeterX). Precisamos da integração oficial da Webmotors.');
  let j = {};
  try {
    j = JSON.parse(texto);
  } catch {}
  const jwt = j?.Result?.jwt || j?.result?.jwt;
  if (!r.ok || !jwt) throw new Error(`Login no Cockpit recusado${j?.Message || j?.message ? `: ${j.Message || j.message}` : ` (${r.status})`}`);
  sessao = { jwt, exp: expDoJwt(jwt) };
  return true;
}

async function chamar(caminho, { metodo = 'GET', corpo, tentativa = 0 } = {}) {
  if (!sessao.jwt || Date.now() > sessao.exp - 5 * MIN) await login();
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: { ...CABECALHOS, Authorization: `Bearer ${sessao.jwt}`, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const texto = await r.text();
  if (bloqueado(r.status, texto)) throw new Error('O Cockpit bloqueou o acesso do servidor (proteção anti-robô PerimeterX).');
  if (r.status === 401 && !tentativa) {
    sessao.jwt = null;
    return chamar(caminho, { metodo, corpo, tentativa: 1 });
  }
  // o relatório de anúncios às vezes demora e dá 504: tenta de novo
  if ((r.status === 504 || r.status === 502) && tentativa < 2) {
    await esperar(5000);
    return chamar(caminho, { metodo, corpo, tentativa: tentativa + 1 });
  }
  if (!r.ok) throw new Error(`${caminho.split('?')[0]} respondeu ${r.status}`);
  return JSON.parse(texto);
}

const dataSP = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const inicioDoMes = () => dataSP().slice(0, 8) + '01';

// Cada parte é independente: se uma falhar, as outras continuam
async function sincronizar(forcar = false) {
  if (estado.rodando || (!cfg.ativo && !forcar)) return;
  estado.rodando = true;
  const avisos = [];
  const agora = Date.now();
  const parte = async (nome, aCada, fn) => {
    if (!forcar && dados[nome]?.quando && agora - dados[nome].quando < aCada) return;
    try {
      dados[nome] = { quando: Date.now(), valor: await fn() };
    } catch (e) {
      avisos.push(`${nome}: ${e.message}`);
      if (/bloqueou|recusado/.test(e.message)) throw e;
    }
  };
  try {
    const de = inicioDoMes();
    const ate = dataSP();
    const periodo = `startDate=${de}T00:00:00-03:00&endDate=${ate}T23:59:59-03:00`;
    await parte('painel', 25 * MIN, async () => (await chamar('/api/cockpit/panel/new')).data || []);
    await parte('canais', 25 * MIN, async () => (await chamar(`/api/cockpit/crm/report/mychannels?${periodo}`)).data || []);
    await parte('loja', 25 * MIN, async () => (await chamar(`/api/cockpit/crm/report/mystore?${periodo}`)).data || []);
    await parte('faturas', 6 * 60 * MIN, async () => {
      const r = await chamar('/api/cockpit/statement/invoice?searchForExpiration=true&totalItemsPerPage=6&page=1');
      const meses = (r.data || []).map((m) => (m.listInvoices || []).map((f) => ({ id: f.billingId, emissao: f.issueDate, vencimento: f.dueDate, valor: f.value, pago: f.amountPaid, status: f.billingStatus, forma: f.paymentMethod }))).flat();
      // detalhamento da fatura mais recente (plano, destaques, turbo...)
      let detalhe = null;
      if (meses[0]?.id) {
        try {
          const d = await chamar(`/api/cockpit/statement/charge-details?chargeId=${meses[0].id}`);
          const x = d.data || d;
          detalhe = { mes: x.month_payment, total: x.total_value, comDesconto: x.total_value_with_discount, itens: (x.billing_data || []).map((b) => ({ produto: b.product_name, valor: b.price_charge ?? b.price_invoice ?? b.price_total, quantidade: b.quantity })) };
        } catch {}
      }
      return { faturas: meses, detalhe };
    });
    await parte('estoque', 2 * 60 * MIN, async () => {
      const carros = [];
      for (let page = 1; page <= 20; page++) {
        const r = await chamar(`/api/cockpit/stock/vehicle?status=1&type=1&order=1&qtyItems=50&page=${page}`);
        const itens = r.data?.items || [];
        for (const v of itens) carros.push({ placa: v.plate, marca: v.brand?.description, modelo: v.model?.description, versao: v.version?.description, ano: v.modelYear, km: v.mileage, preco: v.price, dias: v.stockDays, fotos: v.qntyPhotos, publicado: v.published, canais: (v.channelsPublished || []).map((c) => c.modality?.description || c.status?.description).filter(Boolean) });
        if (!itens.length || carros.length >= (r.data?.totalItems || 0)) break;
        await esperar(800);
      }
      return carros;
    });
    await parte('anuncios', 6 * 60 * MIN, async () => {
      const r = await chamar('/api/cockpit/stock/vehicle/report', { metodo: 'POST', corpo: { reportType: 1, vehicleType: 1, startDate: de, endDate: ate, activeOnly: true, export: false, page: 1 } });
      return (r.Retorno || r.retorno || []).map((a) => ({ carro: a.DescricaoVeiculo, placa: a.Placa, ano: a.AnoModelo, preco: a.VlVeiculo, produto: a.Produto, dias: a.QuantidadeDiasAnuncio, visualizacoes: a.QuantidadeVisualizacoes, cliquesTelefone: a.QuantidadeClicksTelefone, emails: a.QuantidadeEmailsRecebidos, propostas: a.QuantidadePropostaFinanciamento }));
    });
    salvarDados();
    estado.ultimoOk = Date.now();
    estado.falhasSeguidas = 0;
  } catch (e) {
    estado.falhasSeguidas++;
    avisos.push(e.message);
  } finally {
    estado.avisos = avisos;
    estado.ultimoErro = avisos[0] || null;
    estado.rodando = false;
  }
}

function iniciar() {
  setTimeout(() => sincronizar().catch(() => {}), 3 * MIN);
  setInterval(() => sincronizar().catch(() => {}), 30 * MIN);
}

async function salvarCredenciais({ email, senha }) {
  email = String(email || '').trim();
  if (!email) throw new Error('Informe o e-mail do Cockpit');
  await login(email, senha || decifrar(cfg.senha)); // testa antes de salvar
  cfg.email = email;
  if (senha) cfg.senha = cifrar(senha);
  cfg.ativo = true;
  salvarCfg();
  sincronizar(true).catch(() => {});
  return { ok: true };
}
function desligar() {
  cfg.ativo = false;
  salvarCfg();
}

// Resumo pronto para a tela (números do Dashboard do Cockpit pelo nome do "item")
function resumo() {
  const itens = Object.fromEntries((dados.painel?.valor || []).map((x) => [String(x.item || '').replace(/^INDEX#/, ''), x.value]));
  const n = (k) => (itens[k] == null ? null : Number(itens[k]));
  return {
    configurado: !!(cfg.email && cfg.senha),
    email: cfg.email || null,
    ativo: !!cfg.ativo,
    ...estado,
    problema: estado.falhasSeguidas >= 2 ? `Integração Cockpit com problema: ${estado.ultimoErro}` : null,
    numeros: {
      leads: n('TOTAL_LEADS_RECEIVED'),
      leadsWebmotors: n('TOTAL_LEADS_RECEIVED_WEBMOTORS'),
      leadsParceria: n('TOTAL_LEADS_RECEIVED_RIGHT_PARTNERSHIP'),
      leadsOutros: n('TOTAL_LEADS_RECEIVED_OTHER_CHANNELS'),
      semResposta: n('UNANSWERED_LEADS'),
      estoque: n('VEHICLES_IN_STOCK'),
      publicadosWebmotors: n('QTY_OF_ADS_PUBLISHED_WEBMOTORS'),
      publicadosOutros: n('QTY_OF_ADS_PUBLISHED_OTHER_CHANNELS'),
      naoPublicados: n('QTY_OF_ADS_UNPUBLISHED'),
      anunciosComErro: n('ADS_ERROR'),
    },
    canais: dados.canais?.valor || [],
    loja: dados.loja?.valor || [],
    faturas: dados.faturas?.valor || null,
    estoque: dados.estoque?.valor || [],
    anuncios: dados.anuncios?.valor || [],
    atualizado: Object.fromEntries(Object.entries(dados).map(([k, v]) => [k, v?.quando || null])),
  };
}

module.exports = { iniciar, sincronizar, salvarCredenciais, desligar, resumo };
