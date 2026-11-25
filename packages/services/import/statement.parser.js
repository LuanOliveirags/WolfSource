// ============================================================
// STATEMENT.PARSER.JS — Leitura de extratos bancários no navegador
// OFX/QFX, CSV/TXT e planilhas (linhas já extraídas pelo SheetJS).
// Sem DOM e sem rede: recebe texto/linhas, devolve lançamentos
// normalizados { date: 'YYYY-MM-DD', description, amount (>0), type, ref }.
// PDF e imagens são lidos pelo backend (statement.ai.js).
// ============================================================

// ───────────────────────── Texto / encoding ─────────────────────────

/** Decodifica bytes de arquivo: UTF-8 quando válido, senão Windows-1252 (padrão de OFX/CSV de bancos BR). */
export function decodeBytes(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

/** Minúsculas, sem acentos e com espaços simples — base para comparar textos. */
export function normalizeText(str) {
  return String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// ───────────────────────── Valores ─────────────────────────

/**
 * Converte "R$ 1.234,56", "-1.234,56", "1,234.56", "(123,45)", "123,45 D", "123,45-"
 * em número com sinal. Retorna null quando não é um valor.
 */
export function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw ?? '').trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  const suffix = s.match(/\s*([CD])$/i);
  if (suffix) { negative = suffix[1].toUpperCase() === 'D'; s = s.slice(0, -suffix[0].length); }
  s = s.replace(/r\$|brl|\s/gi, '');
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1); }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    // Os dois aparecem: o último é o separador decimal
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // Só vírgula: decimal se houver 1–2 dígitos depois, senão milhar
    s = /,\d{1,2}$/.test(s) ? s.replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot !== -1) {
    // Só ponto: "1.234" / "1.234.567" é milhar (padrão BR); "12.5" / "1234.56" é decimal
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// ───────────────────────── Datas ─────────────────────────

const MONTHS_PT = { jan: 1, fev: 2, feb: 2, mar: 3, abr: 4, apr: 4, mai: 5, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, set: 9, sep: 9, out: 10, oct: 10, nov: 11, dez: 12, dec: 12 };

function iso(y, m, d) {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const date = new Date(y, m - 1, d);
  if (date.getMonth() !== m - 1) return null; // 31/02 e afins
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Aceita dd/mm/aaaa, dd/mm/aa, dd-mm-aaaa, aaaa-mm-dd, aaaammdd, "05 nov 2026", "05/nov". Sem ano → usa fallbackYear. */
export function parseDate(raw, fallbackYear = new Date().getFullYear()) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{6})?/)) && s.replace(/\D/g, '').length >= 8 && !s.includes('/')) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/))) return iso(+m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})$/))) return iso(fallbackYear, +m[2], +m[1]);
  const n = normalizeText(s);
  if ((m = n.match(/^(\d{1,2})[\s/.-]*([a-z]{3})[a-z]*\.?[\s/.-]*(\d{2,4})?$/)) && MONTHS_PT[m[2]]) {
    return iso(m[3] ? +m[3] : fallbackYear, MONTHS_PT[m[2]], +m[1]);
  }
  return null;
}

// ───────────────────────── OFX / QFX ─────────────────────────

function ofxTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : '';
}

/** Lê OFX (SGML 1.x ou XML 2.x), conta corrente ou cartão. */
export function parseOFX(text) {
  const blocks = text.match(/<STMTTRN>[\s\S]*?(<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi) || [];
  const bankName = ofxTag(text, 'ORG') || ofxTag(text, 'BANKID') || '';
  const items = [];
  for (const block of blocks) {
    const amount = parseAmount(ofxTag(block, 'TRNAMT'));
    const date = parseDate(ofxTag(block, 'DTPOSTED').slice(0, 8));
    if (amount === null || amount === 0 || !date) continue;
    const memo = ofxTag(block, 'MEMO');
    const name = ofxTag(block, 'NAME');
    const description = (memo && name && !normalizeText(memo).includes(normalizeText(name)) ? `${name} — ${memo}` : (memo || name || ofxTag(block, 'TRNTYPE')))
      .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const fitid = ofxTag(block, 'FITID');
    items.push({ date, description, amount: Math.abs(amount), type: amount > 0 ? 'entrada' : 'saida', ref: fitid ? `ofx:${fitid}` : null });
  }
  return { items, source: 'OFX', bank: bankName, warnings: blocks.length === 0 ? ['Nenhum lançamento encontrado no OFX.'] : [] };
}

// ───────────────────────── CSV / planilhas ─────────────────────────

/** Divide CSV respeitando aspas; detecta ; , TAB ou | pelo conteúdo. */
export function parseCSVRows(text) {
  const sample = text.split(/\r?\n/).slice(0, 20).join('\n');
  const delimiter = [';', ',', '\t', '|']
    .map(d => ({ d, n: sample.split(d).length }))
    .sort((a, b) => b.n - a.n)[0].d;
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
}

const HEADER_PATTERNS = {
  date:        /^(data|date|dt)\b|data (do )?(lancamento|movimento|transacao|compra)/,
  description: /descri|historico|lancamento|estabelecimento|^title$|memo|detalhe|^nome|favorecido|^titulo/,
  amount:      /^(valor|amount|quantia|montante)\b|valor \(?r\$|^vlr/,
  credit:      /credito|^entradas?$|recebido|^c$/,
  debit:       /debito|^saidas?$|^d$/,
  dc:          /^(tipo|d\/c|c\/d|natureza|sinal)$/,
  balance:     /saldo/
};

const DESCRIPTION_PRIORITY = [/descri/, /historico/, /^title$|^titulo/, /estabelecimento/, /lancamento/, /memo|detalhe/, /favorecido|^nome/];

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = rows[i].map(normalizeText);
    const map = {};
    cells.forEach((c, idx) => {
      if (!c) return;
      if (HEADER_PATTERNS.balance.test(c)) return;
      for (const key of ['date', 'amount', 'credit', 'debit', 'dc', 'description']) {
        if (map[key] === undefined && HEADER_PATTERNS[key].test(c)) { map[key] = idx; break; }
      }
    });
    // Descrição: prefere o nome mais explícito quando várias colunas servem
    for (const re of DESCRIPTION_PRIORITY) {
      const idx = cells.findIndex((c, i) => re.test(c) && i !== map.date && i !== map.amount);
      if (idx !== -1) { map.description = idx; break; }
    }
    const hasValue = map.amount !== undefined || map.credit !== undefined || map.debit !== undefined;
    if (map.date !== undefined && hasValue) return { headerRow: i, map };
  }
  return null;
}

/** Sem cabeçalho reconhecível: escolhe colunas pelo conteúdo (mais datas, mais valores, texto mais longo). */
function inferColumns(rows) {
  const width = Math.max(...rows.map(r => r.length));
  const score = Array.from({ length: width }, () => ({ date: 0, amount: 0, text: 0 }));
  rows.slice(0, 60).forEach(r => r.forEach((c, i) => {
    if (parseDate(c)) score[i].date++;
    else if (parseAmount(c) !== null) score[i].amount++;
    else score[i].text += c.length;
  }));
  const pick = (key, exclude = []) => score
    .map((s, i) => ({ i, v: s[key] }))
    .filter(x => !exclude.includes(x.i))
    .sort((a, b) => b.v - a.v)[0];
  const date = pick('date');
  const amount = pick('amount', [date?.i]);
  const description = pick('text', [date?.i, amount?.i]);
  if (!date?.v || !amount?.v) return null;
  return { headerRow: -1, map: { date: date.i, amount: amount.i, description: description?.i } };
}

/**
 * Converte linhas (CSV ou planilha) em lançamentos.
 * Quando há uma única coluna de valor e quase tudo é positivo, o arquivo
 * provavelmente é fatura de cartão (positivo = gasto) — inverte e avisa.
 */
export function parseTableRows(rows, sourceLabel = 'CSV') {
  const warnings = [];
  const layout = findHeader(rows) || inferColumns(rows);
  if (!layout) return { items: [], source: sourceLabel, warnings: ['Não reconheci as colunas de data e valor deste arquivo.'] };

  const { headerRow, map } = layout;
  const dataRows = rows.slice(headerRow + 1);
  const raw = [];
  for (const r of dataRows) {
    const date = parseDate(r[map.date]);
    if (!date) continue;
    let amount = null;
    if (map.amount !== undefined) {
      amount = parseAmount(r[map.amount]);
      if (amount !== null && map.dc !== undefined) {
        const dc = normalizeText(r[map.dc]);
        if (/^(d|debito|saida|-)/.test(dc)) amount = -Math.abs(amount);
        else if (/^(c|credito|entrada|\+)/.test(dc)) amount = Math.abs(amount);
      }
    } else {
      const credit = parseAmount(r[map.credit]);
      const debit = parseAmount(r[map.debit]);
      if (credit) amount = Math.abs(credit);
      else if (debit) amount = -Math.abs(debit);
    }
    if (amount === null || amount === 0) continue;
    const description = (map.description !== undefined ? r[map.description] : '') ||
      r.filter((c, i) => i !== map.date && i !== map.amount && parseAmount(c) === null && !parseDate(c)).join(' ');
    if (/^saldo\b/.test(normalizeText(description))) continue;
    raw.push({ date, description: description.replace(/\s+/g, ' ').trim() || 'Lançamento', amount });
  }

  const singleAmountColumn = map.amount !== undefined && map.dc === undefined;
  const positives = raw.filter(t => t.amount > 0).length;
  const looksLikeCardBill = singleAmountColumn && raw.length >= 3 && positives / raw.length >= 0.65;
  if (looksLikeCardBill) warnings.push('Parece uma fatura de cartão: valores positivos foram lidos como saídas. Use "Inverter entradas/saídas" se estiver errado.');

  const items = raw.map(t => {
    const signed = looksLikeCardBill ? -t.amount : t.amount;
    return { date: t.date, description: t.description, amount: Math.abs(signed), type: signed > 0 ? 'entrada' : 'saida', ref: null };
  });
  if (!items.length) warnings.push('Nenhum lançamento com data e valor foi encontrado.');
  return { items, source: sourceLabel, warnings };
}

// ───────────────────────── Categoria e forma de pagamento ─────────────────────────

const CATEGORY_RULES = [
  ['assinaturas',   /netflix|spotify|prime video|amazon prime|disney|hbo|\bmax\b|youtube|apple\.com|icloud|deezer|globoplay|paramount|google (one|storage|play)|chatgpt|openai|claude/],
  ['academia',      /academia|smart ?fit|bluefit|gympass|wellhub|crossfit|bodytech/],
  ['alimentacao',   /mercado|supermerc|padaria|ifood|restaurante|lanchonete|acougue|hortifruti|assai|atacad|carrefour|pao de acucar|\bextra\b|burger|pizza|mcdonald|subway|rappi|ze delivery|cafe|sorvete|doceria|feira|emporio|bar e |churrasc|ayumi|westboi/],
  ['transporte',    /\buber\b|\b99\b|99app|posto|combust|ipiranga|shell|petrobras|\bbr mania|estaciona|pedagio|sem parar|conectcar|metro|cptm|onibus|bilhete unico|top transporte|cabify/],
  ['saude',         /farmacia|drogaria|droga ?raia|pacheco|drogasil|pague menos|hospital|clinica|laborat|medic|odonto|unimed|amil|hapvida|bradesco saude|sulamerica/],
  ['educacao',      /escola|faculdade|universidade|curso|udemy|alura|livraria|colegio|mensalidade escolar|perua escolar/],
  ['moradia',       /aluguel|condominio|iptu|imobiliaria|quinto andar|financiamento habitacional/],
  ['utilidades',    /enel|sabesp|copasa|cemig|light|cpfl|energia|\bluz\b|agua|comgas|\bgas\b|vivo|claro|\btim\b|\boi\b|internet|telefon|net servicos/],
  ['beleza',        /salao|cabelei|barbearia|estetica|boticario|natura|sephora|manicure/],
  ['pets',          /\bpet|petz|cobasi|veterin|racao/],
  ['lazer',         /cinema|ingresso|steam|playstation|xbox|nintendo|teatro|show|viagem|hotel|airbnb|decolar|booking|parque/],
  ['investimentos', /aplicacao|resgate|\bcdb\b|tesouro|invest|poupanca|corretora|\bxp\b|rico|nuinvest/]
];

/** Sugere a categoria do app pelo texto do lançamento. */
export function suggestCategory(description, type) {
  const n = normalizeText(description);
  if (type === 'entrada' && /resgate|rendimento/.test(n)) return 'investimentos';
  for (const [category, re] of CATEGORY_RULES) if (re.test(n)) return category;
  return 'outros';
}

/** Forma de pagamento provável: Pix quando o texto diz, senão cartão. */
export function suggestPaymentMethod(description) {
  const n = normalizeText(description);
  if (/\bpix\b/.test(n)) return 'pix';
  if (/saque|dinheiro/.test(n)) return 'dinheiro';
  return 'cartao';
}

// ───────────────────────── Duplicados ─────────────────────────

/**
 * Marca cada item novo como duplicado quando já existe lançamento com a mesma
 * referência de importação, ou com mesma data, valor e tipo.
 * Repetições legítimas dentro do próprio extrato (dois cafés iguais no mesmo dia)
 * só contam como duplicadas até o número de iguais já gravados.
 */
export function markDuplicates(items, existing) {
  const refs = new Set(existing.map(t => t.importRef).filter(Boolean));
  const counts = new Map();
  const key = t => `${t.date}|${t.type}|${Number(t.amount).toFixed(2)}`;
  existing.forEach(t => counts.set(key(t), (counts.get(key(t)) || 0) + 1));
  return items.map(item => {
    if (item.ref && refs.has(item.ref)) return { ...item, duplicate: true };
    const k = key(item);
    const left = counts.get(k) || 0;
    if (left > 0) { counts.set(k, left - 1); return { ...item, duplicate: true }; }
    return { ...item, duplicate: false };
  });
}

/** Referência estável para lançamentos sem ID do banco (CSV, planilha, IA). */
export function buildImportRef(item, occurrence) {
  return `imp:${item.date}|${item.type}|${Number(item.amount).toFixed(2)}|${normalizeText(item.description).slice(0, 40)}|${occurrence}`;
}

/** Detecta o tipo do arquivo pela extensão e pelo MIME. */
export function detectFileKind(file) {
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  if (/\.(ofx|qfx)$/.test(name)) return 'ofx';
  if (/\.(xlsx|xls|ods)$/.test(name) || /spreadsheet|excel/.test(type)) return 'sheet';
  if (/\.(csv|txt|tsv)$/.test(name) || type === 'text/csv' || type === 'text/plain') return 'csv';
  if (/\.pdf$/.test(name) || type === 'application/pdf') return 'pdf';
  if (/\.(jpe?g|png|webp|gif)$/.test(name) || /^image\/(jpeg|png|webp|gif)$/.test(type)) return 'image';
  if (/\.(heic|heif)$/.test(name) || /heic|heif/.test(type)) return 'heic';
  return 'unknown';
}
