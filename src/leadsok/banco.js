// Banco do LeadsOK (SQLite que já vem no Node 22, sem dependência nova): DATA_DIR/leadsok.db
const path = require('path');
const { DATA_DIR } = require('../config');

let db = null;
let erroBanco = null;

function abrir() {
  if (db || erroBanco) return db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path.join(DATA_DIR, 'leadsok.db'));
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS lk_leads (
        id TEXT PRIMARY KEY, conversa_id TEXT, nome TEXT, whatsapp TEXT, origem TEXT, vendedor TEXT,
        vendedor_is_ia INTEGER, aba_atual TEXT, agendado_alguma_vez INTEGER DEFAULT 0, archive_reason TEXT,
        tem_financiamento INTEGER, created_date TEXT, ultima_msg_owner TEXT, ultima_msg_at TEXT,
        is_resgate INTEGER, first_seen_at INTEGER, updated_at INTEGER,
        assinatura TEXT, detalhe_em INTEGER, detalhe_assinatura TEXT, chat_completo INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS lk_leads_criado ON lk_leads(created_date);
      CREATE TABLE IF NOT EXISTS lk_eventos (id TEXT PRIMARY KEY, lead_id TEXT, tipo TEXT, ts TEXT, actor TEXT, conteudo TEXT);
      CREATE INDEX IF NOT EXISTS lk_eventos_lead ON lk_eventos(lead_id);
      CREATE TABLE IF NOT EXISTS lk_mensagens (id TEXT PRIMARY KEY, lead_id TEXT, ts TEXT, owner TEXT, owner_name TEXT, tipo TEXT);
      CREATE INDEX IF NOT EXISTS lk_mensagens_lead ON lk_mensagens(lead_id, ts);
      CREATE TABLE IF NOT EXISTS lk_fichas (lead_id TEXT, banco TEXT, status TEXT, created_at TEXT, valor_financiado REAL, PRIMARY KEY (lead_id, banco, created_at));
      CREATE TABLE IF NOT EXISTS lk_agenda (id TEXT PRIMARY KEY, lead_id TEXT, data TEXT, modalidade TEXT, concluido INTEGER, pela_ia INTEGER, visto_em INTEGER);
      CREATE TABLE IF NOT EXISTS lk_estoque (placa TEXT PRIMARY KEY, marca TEXT, modelo TEXT, versao TEXT, ano TEXT, km REAL, preco REAL, imagem TEXT, primeira_vez INTEGER, ultima_vez INTEGER, ativo INTEGER);
      CREATE TABLE IF NOT EXISTS lk_vendedores (id TEXT PRIMARY KEY, nome TEXT, setor TEXT);
      CREATE TABLE IF NOT EXISTS lk_visitas (lead_id TEXT, data_agendada TEXT, compareceu INTEGER, marcado_por TEXT, marcado_em INTEGER, PRIMARY KEY (lead_id, data_agendada));
      CREATE TABLE IF NOT EXISTS lk_sync_log (inicio INTEGER, fim INTEGER, tipo TEXT, ok INTEGER, erro TEXT, contagens TEXT);
    `);
  } catch (e) {
    erroBanco = `Banco do LeadsOK indisponível (${e.message}). É preciso Node 22.13 ou mais novo.`;
  }
  return db;
}

// Várias gravações numa transação só (bem mais rápido no disco da Oracle)
function transacao(fn) {
  const d = abrir();
  d.exec('BEGIN');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { abrir, transacao, erro: () => erroBanco };
