// ============================================================
// STATEMENT.PARSER.JS — Leitura de extratos bancários no navegador
// OFX/QFX, CSV/TXT e planilhas (linhas já extraídas pelo SheetJS).
// Sem DOM e sem rede: recebe texto/linhas, devolve lançamentos
// normalizados { date: 'YYYY-MM-DD', description, amount (>0), type, ref }
// e, em extratos de conta, { openingBalance, closingBalance, bank }.
// PDF e imagens: statement.local.js extrai o texto e usa parseStatementLines.
// ============================================================

const round2 = (n) => Math.round(n * 100) / 100;

// ───────────────────────── Texto / encoding ─────────────────────────

/** Decodifica bytes de arquivo: UTF-8 quando válido, senão Windows-1252 (padrão de OFX/CSV de bancos BR). */
export function decodeBytes(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

/** Minúsculas, sem acentos e com espaços simples — base para comparar textos. */
export function normalizeText(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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
  s = s.replace(/r\$|brl|\s/gi, '').replace(/−/g, '-');
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

/** Aceita dd/mm/aaaa, dd/mm/aa, dd-mm-aaaa, aaaa-mm-dd, aaaammdd, "05 nov 2026", "25 de novembro de 2026", "05/11". */
export function parseDate(raw, fallbackYear = new Date().getFullYear()) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{6})?/)) && s.replace(/\D/g, '').length >= 8 && !s.includes('/')) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/))) return iso(+m[3], +m[2], +m[1]);
  // Sem ano: exige 2 dígitos no mês (evita confundir paginação "1/5" com 01/maio)
  if ((m = s.match(/^(\d{1,2})[/.-](\d{2})$/))) return iso(fallbackYear, +m[2], +m[1]);
  const n = normalizeText(s);
  if ((m = n.match(/^(\d{1,2})[\s/.-]*(?:de\s+)?([a-z]{3})[a-zç]*\.?[\s/.-]*(?:de\s+)?(\d{2,4})?$/)) && MONTHS_PT[m[2]]) {
    return iso(m[3] ? +m[3] : fallbackYear, MONTHS_PT[m[2]], +m[1]);
  }
  return null;
}

// ───────────────────────── Bancos e saldos ─────────────────────────

const BANK_PATTERNS = [
  ['Santander',       /\bsantander\b/i],
  ['Nubank',          /\bnubank\b|\bnu pagamentos\b/i],
  ['Itaú',            /\bita[uú]\b/i],
  ['Bradesco',        /\bbradesco\b/i],
  ['Banco do Brasil', /\bbanco do brasil\b/i],
  ['Caixa',           /\bcaixa econ[oô]mica\b/i],
  ['Inter',           /\bbanco inter\b/i],
  ['C6 Bank',         /\bc6 bank\b/i],
  ['Mercado Pago',    /\bmercado pago\b/i],
  ['Porto Seguro',    /\bporto seguro\b/i],
  ['Sicredi',         /\bsicredi\b/i],
  ['Sicoob',          /\bsicoob\b/i],
  ['BTG Pactual',     /\bbtg pactual\b/i]
];

function detectBankFromHeader(headerText) {
  for (const [name, re] of BANK_PATTERNS) {
    if (re.test(headerText)) return name;
  }
  return '';
}

/**
 * Completa saldo inicial e saldo final a partir da coluna Saldo das linhas (quando houver)
 * ou da relação saldoFinal = saldoInicial + entradas − saídas.
 */
function inferBalancesFromRows(rawItems, openingBalance, closingBalance) {
  let open = openingBalance;
  let close = closingBalance;
  if (!rawItems.length) return { openingBalance: open, closingBalance: close };

  const signed = (it) => (it.type === 'entrada' ? it.amount : -it.amount);
  const withBal = rawItems.filter(it => typeof it.rowBalance === 'number' && Number.isFinite(it.rowBalance));

  if ((open === null || close === null) && withBal.length >= Math.max(1, Math.ceil(rawItems.length * 0.6))) {
    let newestFirst = false;
    if (rawItems.length >= 2) {
      if (rawItems[0].date > rawItems[rawItems.length - 1].date) newestFirst = true;
      else if (rawItems[0].date < rawItems[rawItems.length - 1].date) newestFirst = false;
      else if (rawItems[0].rowBalance !== null && rawItems[1].rowBalance !== null) {
        if (Math.abs(round2(rawItems[1].rowBalance + signed(rawItems[0])) - rawItems[0].rowBalance) <= 0.02) {
          newestFirst = true;
        }
      }
    }
    const newest = newestFirst ? rawItems[0] : rawItems[rawItems.length - 1];
    const oldest = newestFirst ? rawItems[rawItems.length - 1] : rawItems[0];
    if (close === null && newest.rowBalance !== null && newest.rowBalance !== undefined) close = round2(newest.rowBalance);
    if (open === null && oldest.rowBalance !== null && oldest.rowBalance !== undefined) open = round2(oldest.rowBalance - signed(oldest));
  }

  const net = round2(rawItems.reduce((s, t) => s + signed(t), 0));
  if (close !== null && open === null) open = round2(close - net);
  else if (open !== null && close === null) close = round2(open + net);

  return { openingBalance: open, closingBalance: close };
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
  const isCardBill = /<CCSTMTRS|<CCACCTFROM/i.test(text);
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

  let openingBalance = null;
  let closingBalance = null;
  if (!isCardBill) {
    const ledgerMatch = text.match(/<LEDGERBAL>[\s\S]*?(?:<\/LEDGERBAL>|(?=<AVAILBAL>|<\/STMTRS>))/i);
    const bal = parseAmount(ofxTag(ledgerMatch ? ledgerMatch[0] : text, 'BALAMT'));
    if (bal !== null) {
      closingBalance = round2(bal);
      const net = round2(items.reduce((s, t) => s + (t.type === 'entrada' ? t.amount : -t.amount), 0));
      openingBalance = round2(closingBalance - net);
    }
  }

  return {
    items,
    source: 'OFX',
    bank: bankName,
    openingBalance,
    closingBalance,
    warnings: blocks.length === 0 ? ['Nenhum lançamento encontrado no OFX.'] : []
  };
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
      if (HEADER_PATTERNS.balance.test(c)) { if (map.balance === undefined) map.balance = idx; return; }
      for (const key of ['date', 'amount', 'credit', 'debit', 'dc', 'description']) {
        if (map[key] === undefined && HEADER_PATTERNS[key].test(c)) { map[key] = idx; break; }
      }
    });
    // Descrição: prefere o nome mais explícito quando várias colunas servem
    for (const re of DESCRIPTION_PRIORITY) {
      const idx = cells.findIndex((c, i) => re.test(c) && i !== map.date && i !== map.amount && i !== map.balance);
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
  if (!layout) return { items: [], source: sourceLabel, openingBalance: null, closingBalance: null, warnings: ['Não reconheci as colunas de data e valor deste arquivo.'] };

  const { headerRow, map } = layout;
  const headerText = headerRow > 0 ? rows.slice(0, headerRow).map(r => r.join(' ')).join('\n') : '';
  const bank = detectBankFromHeader(headerText);

  let openingBalance = null;
  let closingBalance = null;
  // Procura saldos no cabeçalho acima da tabela (ex.: CSV Santander/Bradesco/Inter)
  for (let i = 0; i < Math.max(0, headerRow); i++) {
    const joined = rows[i].join(' ');
    const norm = normalizeText(joined);
    const nums = rows[i].map(parseAmount).filter(v => v !== null);
    if (!nums.length) continue;
    if (openingBalance === null && /\bsaldo (inicial|anterior)\b/.test(norm)) openingBalance = round2(nums[0]);
    if (closingBalance === null && /\bsaldo (final|atual|do periodo|em conta)\b/.test(norm)) closingBalance = round2(nums[nums.length - 1]);
  }

  const dataRows = rows.slice(headerRow + 1);
  const raw = [];
  for (const r of dataRows) {
    const rawDesc = (map.description !== undefined ? r[map.description] : '') ||
      r.filter((c, i) => i !== map.date && i !== map.amount && i !== map.balance && parseAmount(c) === null && !parseDate(c)).join(' ');
    const normDesc = normalizeText(rawDesc);
    const rowBal = map.balance !== undefined ? parseAmount(r[map.balance]) : null;

    if (/^saldo\b/.test(normDesc)) {
      const candidate = rowBal ?? (map.amount !== undefined ? parseAmount(r[map.amount]) : null);
      if (candidate !== null) {
        if (openingBalance === null && /\b(anterior|inicial)\b/.test(normDesc)) openingBalance = round2(candidate);
        else if (closingBalance === null && /\b(final|atual|do periodo|em conta|total)\b/.test(normDesc)) closingBalance = round2(candidate);
      }
      continue;
    }

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
    raw.push({ date, description: rawDesc.replace(/\s+/g, ' ').trim() || 'Lançamento', amount, rowBalance: rowBal });
  }

  const singleAmountColumn = map.amount !== undefined && map.dc === undefined && map.balance === undefined;
  const positives = raw.filter(t => t.amount > 0).length;
  const looksLikeCardBill = singleAmountColumn && raw.length >= 3 && positives / raw.length >= 0.65;
  if (looksLikeCardBill) warnings.push('Parece uma fatura de cartão: valores positivos foram lidos como saídas. Use "Inverter entradas/saídas" se estiver errado.');

  const typed = raw.map(t => {
    const signed = looksLikeCardBill ? -t.amount : t.amount;
    return { date: t.date, description: t.description, amount: Math.abs(signed), type: signed > 0 ? 'entrada' : 'saida', rowBalance: t.rowBalance, ref: null };
  });

  const balances = looksLikeCardBill
    ? { openingBalance: null, closingBalance: null }
    : inferBalancesFromRows(typed, openingBalance, closingBalance);

  const items = typed.map(({ rowBalance, ...rest }) => rest);
  if (!items.length) warnings.push('Nenhum lançamento com data e valor foi encontrado.');
  return { items, source: sourceLabel, bank, ...balances, warnings };
}

// ───────────────────────── Categoria e forma de pagamento ─────────────────────────

const CATEGORY_RULES = [
  ['assinaturas',   /netflix|spotify|prime video|amazon prime|disney|hbo|\bmax\b|youtube|apple\.com|icloud|deezer|globoplay|paramount|google (one|storage|play)|chatgpt|openai|claude/],
  ['academia',      /academia|smart ?fit|bluefit|gympass|wellhub|crossfit|bodytech/],
  ['alimentacao',   /mercado|supermerc|padaria|ifood|99 ?food|uber ?eats|restaurante|lanchonete|acougue|hortifruti|assai|atacad|carrefour|pao de acucar|\bextra\b|burger|pizza|mcdonald|subway|rappi|ze delivery|cafe|sorvete|doceria|feira|emporio|bar e |churrasc|ayumi|westboi|\bpaes\b|confeitaria|salgados|\bbanan|sacolao|mercearia|sendas|sancream|bebidas|lanches|marmit|quitanda/],
  ['transporte',    /\buber\b|\b99\b|99app|posto|combust|ipiranga|shell|petrobras|\bbr mania|estaciona|pedagio|sem parar|conectcar|metro|cptm|onibus|bilhete unico|top transporte|cabify/],
  ['saude',         /farmacia|drogaria|droga ?raia|pacheco|drogasil|pague menos|hospital|clinica|laborat|medic|odonto|unimed|amil|hapvida|bradesco saude|sulamerica/],
  ['educacao',      /escola|faculdade|universidade|curso|udemy|alura|livraria|colegio|mensalidade escolar|perua escolar/],
  ['moradia',       /aluguel|condominio|iptu|imobiliaria|quinto andar|habitac/],
  ['utilidades',    /enel|sabesp|copasa|cemig|light|cpfl|energia|\bluz\b|agua|comgas|\bgas\b|vivo|claro|\btim\b|\boi\b|(?<!\/)internet(?!\/)|telefon|net servicos/],
  ['beleza',        /salao|cabelei|barbearia|estetica|boticario|natura|sephora|manicure/],
  ['pets',          /\bpet\b|petz|petlove|cobasi|veterin|\bracao\b/],
  ['lazer',         /cinema|ingresso|steam|playstation|xbox|nintendo|teatro|show|viagem|hotel|airbnb|decolar|booking|parque/],
  ['investimentos', /aplicacao|resgate|\bcdb\b|tesouro|invest|poupanca|corretora|\bxp\b|rico|nuinvest/]
];

/** Sugere a categoria do app pelo texto do lançamento. */
export function suggestCategory(description, type) {
  const n = normalizeText(description);
  if (type === 'entrada' && /resgate|\bresg\b|rendimento|remunera/.test(n)) return 'investimentos';
  for (const [category, re] of CATEGORY_RULES) if (re.test(n)) return category;
  return 'outros';
}

/**
 * Movimentação entre conta corrente e poupança/aplicação do próprio titular.
 * Continua selecionada no extrato de conta corrente (pois compõe o saldo da conta),
 * mas recebe um selo informativo na revisão.
 */
export function isInternalTransfer(description) {
  const n = normalizeText(description);
  if (/remunera|rendimento|juros/.test(n)) return false;
  return /conta poupanca|resg(ate)? poup|resgate (de )?aplic|aplicacao (em|cdb|poup|automatica)|entre contas|mesma titularidade|transf(erencia)? (para|de) (conta )?poup/.test(n);
}

/** Forma de pagamento provável: Pix quando o texto diz, senão cartão. */
export function suggestPaymentMethod(description) {
  const n = normalizeText(description);
  if (/\bpix\b/.test(n)) return 'pix';
  if (/saque|dinheiro/.test(n)) return 'dinheiro';
  return 'cartao';
}

// ───────────────────────── Duplicados ─────────────────────────

function daysBetweenIso(a, b) {
  if (!a || !b) return Infinity;
  const da = new Date(a + 'T12:00:00');
  const db = new Date(b + 'T12:00:00');
  return Math.abs(Math.round((da - db) / 86400000));
}

/**
 * Marca cada item novo como duplicado quando já existe lançamento com a mesma
 * referência de importação, ou com mesma data, valor e tipo (ignorando marcos de saldo),
 * ou quando uma entrada de salário já está cadastrada na aba Salário.
 */
export function markDuplicates(items, existing, salaries = []) {
  const realExisting = (existing || []).filter(t => !t?.isBalanceAdjustment);
  const refs = new Set(realExisting.map(t => t.importRef).filter(Boolean));
  const counts = new Map();
  const key = t => `${t.date}|${t.type}|${Number(t.amount).toFixed(2)}`;
  realExisting.forEach(t => counts.set(key(t), (counts.get(key(t)) || 0) + 1));

  const availSalaries = (salaries || []).filter(s => s && s.salaryType !== 'vr').map(s => ({ ...s, _used: false }));

  return items.map(item => {
    if (item.ref && refs.has(item.ref)) return { ...item, duplicate: true };
    const k = key(item);
    const left = counts.get(k) || 0;
    if (left > 0) { counts.set(k, left - 1); return { ...item, duplicate: true }; }
    if (item.type === 'entrada') {
      const salMatch = availSalaries.find(s =>
        !s._used &&
        Math.abs(Number(s.amount) - Number(item.amount)) < 0.01 &&
        daysBetweenIso(s.date, item.date) <= 5
      );
      if (salMatch) {
        salMatch._used = true;
        return { ...item, duplicate: true, duplicateSalary: true };
      }
    }
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

// ───────────────────────── Texto livre (PDF / OCR) ─────────────────────────

const MONTH_WORD = String.raw`(?:jan|fev|feb|mar|abr|apr|mai|may|jun|jul|ago|aug|set|sep|out|oct|nov|dez|dec)[a-zç]*\.?`;
const LINE_DATE = new RegExp(String.raw`^\s*(\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{1,2}\s*(?:de\s+)?${MONTH_WORD}(?:\s*(?:de\s+)?\d{2,4})?)(?![\d,])`, 'i');
// Valor em formato BR (vírgula decimal). Sinal só conta colado no número ("-318,40",
// "-R$ 30,00"): um "-" solto antes é coluna vazia (ex.: "Nº Documento" do Santander).
const LINE_AMOUNT = /(?<![\d/,.])([-+−])?(?:R\$\s?)?(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2})(?!\d)(\s?[CD](?![a-zà-ú])|-(?!\d))?/gi;
const SKIP_LINE = /\bsaldo\b|^total|\btotal (da fatura|geral|de|do)\b|limite (total|dispon)|^resumo|p[aá]gina:? ?\d|^data\b.*\b(hist|descri|lan[cç])|^detalhe\s*dos\s*movimentos\b/i;
// Cabeçalho de dia da semana (ex.: "Quarta, 25 de novembro de 2026" no Santander)
const DAY_HEADER = /^(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)(-feira)?[\s,]+\d{1,2}\b/i;
// Rodapé de paginação ("1/5", "2 / 5")
const PAGE_COUNTER = /^\d{1,3}\s*\/\s*\d{1,3}$/;
// Cabeçalho da tabela de movimentação: a leitura começa aqui (pula resumos do topo)
const MOVEMENT_HEADER = /^data\b.*\b(descri|hist|lan[cç])[\s\S]*\b(movimento|valor|cr[eé]dito|d[eé]bito)/i;
// Títulos de seções que só repetem ou detalham o que já foi lido: a leitura para aqui
const END_SECTION = /^(saldos? por per[ií]odo|compras com cart[aã]o de d[eé]bito|comprovantes? de pagamento|transfer[eê]ncias entre contas|poupan[cç]a|investimentos|renda fixa|pacote de servi[cç]os|[ií]ndices econ[oô]micos|lan[cç]amentos futuros|agendamentos)\b/i;
const INCOME_HINT = /receb|cr[eé]dito|dep[oó]sito|sal[aá]rio|estorno|rendimento|remunera|resgate|\bresg\b|devolu|reembolso|cashback/i;
const CARD_PAYMENT = /pagamento (recebido|efetuado|da fatura|fatura)|pgto\.? ?fatura|pag fatura/i;
const MONTH_YEAR = /\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-zç]*\.?\s*(?:\/|de)?\s*(20\d{2})\b/gi;

/** Marcador de quebra de página entre as linhas de um PDF/OCR de várias páginas. */
export const PAGE_BREAK = '\f';

function signedLineAmount(m) {
  const v = parseAmount(m[2]);
  if (v === null) return null;
  const prefix = (m[1] || '').replace('−', '-');
  const suffix = (m[3] || '').trim().toUpperCase();
  const neg = prefix === '-' || suffix === 'D' || suffix === '-';
  return round2(neg ? -Math.abs(v) : Math.abs(v));
}

/** Verifica se uma linha tem data/valor mas nenhum texto de descrição (padrão Santander: data+valor no meio, tipo acima e favorecido abaixo). */
function isBareAmountLine(line, year) {
  if (!line || line === PAGE_BREAK || SKIP_LINE.test(line)) return false;
  const amts = [...line.matchAll(LINE_AMOUNT)];
  if (!amts.length) return false;
  let rest = line;
  const dm = rest.match(LINE_DATE);
  if (dm && parseDate(dm[1], year)) rest = rest.slice(dm[0].length);
  for (const a of amts) rest = rest.replace(a[0], ' ');
  rest = rest.replace(/R\$/gi, ' ').replace(/\s\d{5,}(?=\s|$)/g, ' ');
  return !/[a-zà-ú]/i.test(rest);
}

/** Extrai Saldo inicial e Saldo final do quadro-resumo no topo do extrato. */
function extractSummaryBalances(clean, headerAt) {
  let openingBalance = null;
  let closingBalance = null;
  const limit = headerAt >= 0 ? headerAt : Math.min(clean.length, 25);

  for (let k = 0; k < limit; k++) {
    const line = clean[k];
    if (!line || line === PAGE_BREAK) continue;
    const norm = normalizeText(line);

    // Quadro horizontal (ex.: Santander PDF: "Saldo inicial Entradas Saídas Saldo final" + linha de valores)
    if (/\bsaldo (inicial|anterior)\b.*\bsaldo (final|atual)\b/.test(norm)) {
      const next = clean[k + 1];
      if (next && next !== PAGE_BREAK) {
        const amts = [...next.matchAll(LINE_AMOUNT)].map(signedLineAmount).filter(v => v !== null);
        if (amts.length >= 2) {
          if (openingBalance === null) openingBalance = amts[0];
          if (closingBalance === null) closingBalance = amts[amts.length - 1];
          k++;
          continue;
        }
      }
    }

    if (openingBalance === null && /^saldo (inicial|anterior)\b/.test(norm)) {
      const amts = [...line.matchAll(LINE_AMOUNT)].map(signedLineAmount).filter(v => v !== null);
      if (amts.length) {
        openingBalance = amts[0];
      } else if (clean[k + 1] && clean[k + 1] !== PAGE_BREAK && !clean[k + 1].match(LINE_DATE)) {
        const nextAmts = [...clean[k + 1].matchAll(LINE_AMOUNT)].map(signedLineAmount).filter(v => v !== null);
        if (nextAmts.length === 1) { openingBalance = nextAmts[0]; k++; continue; }
      }
    }

    if (closingBalance === null && /^saldo (final|atual|do periodo|em conta|disponivel em conta)\b/.test(norm)) {
      const amts = [...line.matchAll(LINE_AMOUNT)].map(signedLineAmount).filter(v => v !== null);
      if (amts.length) {
        closingBalance = amts[amts.length - 1];
      } else if (clean[k + 1] && clean[k + 1] !== PAGE_BREAK && !clean[k + 1].match(LINE_DATE)) {
        const nextAmts = [...clean[k + 1].matchAll(LINE_AMOUNT)].map(signedLineAmount).filter(v => v !== null);
        if (nextAmts.length === 1) { closingBalance = nextAmts[0]; k++; continue; }
      }
    }
  }

  return { openingBalance, closingBalance };
}

const TX_TYPE_PREFIX = /^(pix|ted|doc|compra|pagamento|pgto|transf|resg|saque|tarifa|d[eé]bito|cr[eé]dito|estorno|aplica[cç][aã]o|boleto|dep[oó]sito)\b/i;

/**
 * Cabeçalhos e rodapés: linhas sem valor que se repetem no topo (antes do cabeçalho
 * da tabela) ou no rodapé das páginas, sem capturar descrições ou favorecidos.
 */
function pageBoilerplate(lines) {
  const pages = [[]];
  for (const l of lines) (l === PAGE_BREAK ? pages.push([]) : pages[pages.length - 1].push(l));
  const found = new Set();
  if (pages.length < 2) return found;
  const count = new Map();
  for (const p of pages) {
    const hdrIdx = p.findIndex(l => MOVEMENT_HEADER.test(l));
    const topSlice = hdrIdx >= 0 ? p.slice(0, hdrIdx + 1) : p.slice(0, 3);
    const bottomSlice = [];
    for (let k = Math.max(0, p.length - 2); k < p.length; k++) {
      // Não trata favorecido logo abaixo de uma linha com valor como rodapé
      if (k > 0 && /\d,\d{2}/.test(p[k - 1])) continue;
      bottomSlice.push(p[k]);
    }
    new Set([...topSlice, ...bottomSlice]).forEach(l => count.set(l, (count.get(l) || 0) + 1));
  }
  const min = Math.max(2, Math.ceil(pages.length * 0.4));
  for (const [line, n] of count) {
    if (n >= min && !/\d,\d{2}/.test(line) && !TX_TYPE_PREFIX.test(line)) found.add(line);
  }
  return found;
}

/** Ano mais provável do documento: "outubro/2026" pesa mais que datas soltas de rodapé. */
function documentYear(text) {
  const score = new Map();
  for (const m of text.matchAll(MONTH_YEAR)) score.set(m[2], (score.get(m[2]) || 0) + 5);
  for (const m of text.matchAll(/\b\d{1,2}\/\d{1,2}\/(20\d{2})\b/g)) score.set(m[1], (score.get(m[1]) || 0) + 1);
  if (!score.size) return new Date().getFullYear();
  return +[...score.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Lê lançamentos de linhas de texto (PDF com texto ou OCR de foto).
 * - Começa no cabeçalho da tabela de movimentação (quando houver) e para nas
 *   seções que repetem lançamentos (comprovantes, poupança, saldos por período…).
 * - Suporta linhas em 1, 2 ou 3 níveis (ex.: Santander com tipo acima da data/valor
 *   e favorecido abaixo).
 * - Extrai também saldo inicial e saldo final da conta quando presentes.
 */
export function parseStatementLines(lines, sourceLabel = 'PDF', { ocr = false } = {}) {
  const clean = lines
    .map(l => (l === PAGE_BREAK ? l : String(l).replace(/\s+/g, ' ').trim()))
    // OCR costuma perder a barra da data: "1310 PIX ENVIADO" → "13/10 PIX ENVIADO"
    .map(l => (ocr ? l.replace(/^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])\s+(?=\D)/, '$1/$2 ') : l))
    .filter(Boolean);
  const boilerplate = pageBoilerplate(clean);
  const text = clean.filter(l => l !== PAGE_BREAK).join('\n');

  const cardSignals = [/fatura/i, /vencimento/i, /pagamento m[ií]nimo/i, /limite (de cr[eé]dito|total|dispon)/i, /cart[aã]o de cr[eé]dito/i]
    .filter(re => re.test(text)).length;
  const isCardBill = cardSignals >= 2;
  const year = documentYear(text);
  // O extrato marca débitos? ("65,59-", "318,40 D" ou "-318,40" colado no número)
  const marksDebits = (text.match(/\d,\d{2}(-|\s?D\b)(?!\d)/g) || []).length >= 2 ||
    (text.match(/(?:^|\s)[-−](R\$\s?)?\d[\d.]*,\d{2}/gm) || []).length >= 2;

  const headerAt = clean.findIndex(l => MOVEMENT_HEADER.test(l));
  const start = headerAt >= 0 ? headerAt + 1 : 0;
  const headerSlice = clean.slice(0, headerAt > 0 ? headerAt : Math.min(clean.length, 15)).filter(l => l !== PAGE_BREAK).join('\n');
  const bank = detectBankFromHeader(headerSlice);

  let { openingBalance, closingBalance } = isCardBill
    ? { openingBalance: null, closingBalance: null }
    : extractSummaryBalances(clean, headerAt);

  const rawItems = [];
  let lastDate = null;
  let lastWasItem = false;
  let pendingDesc = '';
  let inferredSigns = 0;
  let skippedPayments = 0;

  for (let i = start; i < clean.length; i++) {
    const line = clean[i];
    if (line === PAGE_BREAK || boilerplate.has(line) || PAGE_COUNTER.test(line)) {
      lastWasItem = false;
      pendingDesc = '';
      continue;
    }
    if (DAY_HEADER.test(line)) {
      const dm = line.match(new RegExp(String.raw`\b(\d{1,2}\s+(?:de\s+)?${MONTH_WORD}(?:\s+(?:de\s+)?\d{2,4})?)\b`, 'i'));
      if (dm) lastDate = parseDate(dm[1], year) || lastDate;
      lastWasItem = false;
      pendingDesc = '';
      continue;
    }

    const amounts = [...line.matchAll(LINE_AMOUNT)];
    if (!amounts.length && END_SECTION.test(line)) break;

    const dateMatch = line.match(LINE_DATE);
    const date = dateMatch ? parseDate(dateMatch[1], year) : null;
    if (date) lastDate = date;

    if (SKIP_LINE.test(line)) {
      if (!isCardBill && amounts.length) {
        const norm = normalizeText(line);
        const val = signedLineAmount(amounts[amounts.length - 1]);
        if (val !== null) {
          if (openingBalance === null && /\bsaldo (anterior|inicial)\b/.test(norm)) openingBalance = val;
          else if (closingBalance === null && /\bsaldo (final|atual|do periodo|em conta|total)\b/.test(norm)) closingBalance = val;
        }
      }
      lastWasItem = false;
      pendingDesc = '';
      continue;
    }

    if (!amounts.length) {
      if (!date && line.length <= 60 && isBareAmountLine(clean[i + 1], year)) {
        // Linha de tipo imediatamente acima de uma linha só com data + valores (ex.: Santander)
        pendingDesc = line;
        lastWasItem = false;
      } else if (lastWasItem && !date && line.length <= 60) {
        // Continuação da descrição (ex.: favorecido do Pix na linha de baixo)
        const prev = rawItems[rawItems.length - 1];
        prev.description = (prev.description === 'Lançamento' ? line : `${prev.description} ${line}`).trim();
        lastWasItem = false;
        pendingDesc = '';
      } else if (!date && line.length <= 60) {
        pendingDesc = line;
      } else {
        pendingDesc = '';
      }
      continue;
    }
    if (!(date || lastDate)) { pendingDesc = ''; continue; }

    // Com 2+ valores, o primeiro é o lançamento e o último costuma ser o saldo
    const m = amounts[0];
    const value = parseAmount(m[2]);
    const rowBalance = !isCardBill && amounts.length >= 2 ? signedLineAmount(amounts[amounts.length - 1]) : null;
    if (!value) { pendingDesc = ''; continue; }
    const prefix = (m[1] || '').replace('−', '-');
    const suffix = (m[3] || '').trim().toUpperCase();

    let description = line;
    if (dateMatch && date) description = description.slice(dateMatch[0].length);
    for (const a of amounts) description = description.replace(a[0], ' ');
    description = description
      .replace(/R\$/gi, ' ')
      .replace(/\s\d{5,}(?=\s|$)/g, ' ')          // nº de documento
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–|:]+|[\s\-–|:]+$/g, '')
      .trim();

    if (!description && pendingDesc) description = pendingDesc;
    pendingDesc = '';

    if (isCardBill && CARD_PAYMENT.test(description)) { skippedPayments++; lastWasItem = false; continue; }

    let type;
    if (prefix === '-' || suffix === 'D' || suffix === '-') type = isCardBill ? 'entrada' : 'saida';
    else if (prefix === '+' || suffix === 'C') type = 'entrada';
    else if (isCardBill) type = 'saida';
    // No OCR o "-" final dos débitos some com frequência: a convenção do documento não é confiável
    else if (marksDebits && !ocr) type = 'entrada';
    else {
      inferredSigns++;
      type = INCOME_HINT.test(description) ? 'entrada' : 'saida';
    }
    rawItems.push({ date: date || lastDate, description: description || 'Lançamento', amount: value, type, rowBalance, ref: null });
    lastWasItem = true;
  }

  const balances = isCardBill
    ? { openingBalance: null, closingBalance: null }
    : inferBalancesFromRows(rawItems, openingBalance, closingBalance);

  const items = rawItems.map(({ rowBalance, ...rest }) => rest);

  const warnings = [];
  if (isCardBill) warnings.push('Lido como fatura de cartão: compras entram como saídas.');
  if (skippedPayments) warnings.push(`${skippedPayments} pagamento(s) da fatura anterior foram ignorados (não são receita).`);
  if (inferredSigns) warnings.push(`O arquivo não indica entrada/saída em ${inferredSigns} linha(s); deduzi pelo texto. Confira na lista.`);
  if (!items.length) warnings.push('Não encontrei linhas com data e valor neste arquivo.');
  return { items, source: sourceLabel, bank, ...balances, warnings };
}
