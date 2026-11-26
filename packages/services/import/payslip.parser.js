// ============================================================
// PAYSLIP.PARSER.JS — Leitura de holerite (contracheque)
// Recebe as linhas do documento (PDF com texto ou OCR) e devolve
// salário base, acréscimos (proventos), descontos, totais, líquido,
// competência e data de pagamento. Sem DOM: testável em Node.
//
// Cada linha pode vir com a posição horizontal das palavras
// ({ text, parts: [{ x, end, str }] }). Com ela, o valor é classificado
// pela coluna (Vencimentos × Descontos); sem ela, pelo nome da verba.
// No fim, os totais do holerite servem de prova real.
// ============================================================

import { normalizeText } from './statement.parser.js';

// "3.500,00" · "315,00" · OCR: "3.500.00"
const MONEY = /(?<![\d.,/])(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2}|\d{1,3}(?:\.\d{3})+\.\d{2})(?![\d,]|\/)(\s?%)?/g;

export function toAmount(raw) {
  const m = String(raw).match(/^(.*)[.,](\d{2})$/);
  return m ? parseFloat(`${m[1].replace(/[.,]/g, '')}.${m[2]}`) : NaN;
}

const round2 = (n) => Math.round(n * 100) / 100;
const near = (a, b) => Math.abs(a - b) < 0.05;

// ───────────────────────── Linhas ─────────────────────────

/** Normaliza a entrada: strings ou { text, parts } → { text, spans } com x por trecho. */
function normalizeRows(rows) {
  return rows.map(r => {
    if (typeof r === 'string') return { text: r, spans: null };
    if (!r.parts?.length) return { text: r.text || '', spans: null };
    let text = '';
    const spans = [];
    r.parts.forEach((p, i) => {
      if (i && p.x - r.parts[i - 1].end > 1) text += ' ';
      spans.push({ start: text.length, end: text.length + p.str.length, x: (p.x + p.end) / 2 });
      text += p.str;
    });
    return { text, spans };
  });
}

/** Posição horizontal do caractere `index` da linha (centro do trecho). */
function xAt(row, index) {
  if (!row.spans) return null;
  const span = row.spans.find(s => index >= s.start && index < s.end) || row.spans.find(s => s.start >= index);
  return span ? span.x : null;
}

// ───────────────────────── Verbas ─────────────────────────

const HEADER_PROV = /\b(proventos?|vencimentos?|creditos?|rendimentos?)\b/;
const HEADER_DESC = /\b(descontos?|debitos?|deducoes)\b/;

const TOTAL_PROV = /total\s*(?:de\s*|dos\s*)?(?:vencimentos|proventos|creditos|rendimentos)|total\s+bruto/;
const TOTAL_DESC = /total\s*(?:de\s*|dos\s*)?(?:descontos|debitos|deducoes)/;
const TOTAL_NET = /(?:valor\s+|total\s+|salario\s+)?liquido(?:\s+a\s+receber)?/;

// Linhas informativas (rodapé de bases, dados bancários e cadastrais) — não são verbas
const NOT_ITEM = /fgts|base\s*(?:de\s*)?calc|bases?\s+(?:inss|irrf|fgts)|sal\.?\s*contr|salario\s+contribui|faixa|banco|agencia|\bconta\b|cpf|cnpj|admiss|\bcbo\b|cargo|depend|pis\b|matricula|^\s*total|liquido/;

const KW_BENEFIT = /aux[ií]lio|ajuda\s+de\s+custo|reembolso|salario\s+familia/;
const KW_DESC = /inss|irrf|\bir\b|i\.r\.|imposto|contrib|sindic|vale[\s.-]*transp|\bv\.?t\.?\b|desc|adiant|falta|atraso|pensao|emprest|consign|plano|saude|medic|odonto|dent|convenio|seguro|copart|farmacia|mensalidade|refeic|alimentac|\bv\.?r\.?\b|\bv\.?a\.?\b|cesta|previd|associa|parcela|debito|estorno/;
const KW_PROV = /salario|hora|\bh\.?\s?e\b|extra|adicion|noturn|insalub|periculos|comiss|gratif|\bdsr\b|d\.s\.r|repouso|premio|bonus|ferias|13|abono|ajuda|auxilio|reembolso|\bplr\b|particip|quinquen|anuenio|bienio|trienio|sobreaviso|arredond|diferenca|retroativ/;

const BASE_SALARY = /^(?:\d+\s+)?(?:salario|sal\.?|ordenado|vencimento\s+base|pro[\s-]*labore|horas?\s+normais|dias?\s+(?:normais|trabalhados))\b/;
const NOT_BASE = /familia|maternidade|ferias|13|abono|substitui/;

function keywordKind(label) {
  const n = normalizeText(label);
  if (KW_BENEFIT.test(n) && !/desc/.test(n)) return 'prov';
  if (KW_DESC.test(n)) return 'desc';
  if (KW_PROV.test(n)) return 'prov';
  return null;
}

const SMALL_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 's/', 'c/', 'a', 'o']);
/** "SALARIO BASE" → "Salario Base"; mantém siglas curtas (INSS, IRRF, DSR, VT). */
export function prettyLabel(label) {
  const clean = label.replace(/\s+/g, ' ').trim();
  if (clean !== clean.toUpperCase()) return clean;
  return clean.toLowerCase().split(' ').map((w, i) => {
    if (i && SMALL_WORDS.has(w)) return w;
    if (/^(inss|irrf|dsr|fgts|vt|vr|va|ir|plr|he|hr|13o?|13º)$/.test(w)) return w.toUpperCase();
    if (/^([a-z]\.){2,}[a-z]?\.?$/.test(w)) return w.toUpperCase(); // I.N.S.S. · D.S.R.
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

/** Limpa o rótulo de uma verba: tira código no início e referência (30, 220:00, 9%) no fim. */
function cleanLabel(raw) {
  return raw
    .replace(/^[\s|:;.\-–]*\d{1,5}\s+(?=\D)/, '')     // código da verba
    .replace(/[\s|:;\-–]*(?:\d[\d.,:]*\s*(?:%|h|hs|d|dias)?\s*)+$/i, '') // referência no fim (30 · 220:00 · 7,5%)
    .replace(/^[\s|:;.\-–]+|[\s|:;.\-–]+$/g, '')
    .trim();
}

/** Extrai as verbas de uma linha: pode haver uma ou duas (layout em duas colunas). */
function rowItems(row) {
  const items = [];
  let cursor = 0;
  for (const m of row.text.matchAll(MONEY)) {
    if (m[2]) continue; // "9,00%" é referência, não valor: fica no rótulo e é limpa depois
    const between = row.text.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    const value = toAmount(m[1]);
    const label = cleanLabel(between);
    if (/[a-zà-ú]/i.test(label)) {
      items.push({ label, value, x: xAt(row, m.index) });
    } else if (items.length) {
      // Sem texto entre dois números: o anterior era a referência (ex.: "30,00 3.500,00")
      const last = items[items.length - 1];
      last.value = value;
      last.x = xAt(row, m.index);
    }
  }
  return items;
}

// ───────────────────────── Totais ─────────────────────────

function findTotals(rows) {
  const totals = { proventos: null, descontos: null, liquido: null };
  const kinds = [['proventos', TOTAL_PROV], ['descontos', TOTAL_DESC], ['liquido', TOTAL_NET]];
  for (let i = 0; i < rows.length; i++) {
    const n = normalizeText(rows[i].text);
    const labels = kinds
      .filter(([key]) => totals[key] === null)
      .map(([key, re]) => { const m = n.match(re); return m ? { key, index: m.index } : null; })
      .filter(Boolean)
      // "liquido" dentro de "total liquido" não conta duas vezes
      .sort((a, b) => a.index - b.index);
    if (!labels.length) continue;

    let moneys = [...n.matchAll(MONEY)].filter(m => !m[2]).map(m => ({ index: m.index, value: toAmount(m[1]) }));
    if (moneys.length) {
      const used = new Set();
      for (const l of labels) {
        const pick = moneys.find(m => m.index > l.index && !used.has(m));
        if (pick) { used.add(pick); totals[l.key] = pick.value; }
      }
    } else if (rows[i + 1]) {
      // Rótulos numa linha, valores na seguinte, na mesma ordem
      moneys = [...normalizeText(rows[i + 1].text).matchAll(MONEY)].filter(m => !m[2]).map(m => toAmount(m[1]));
      labels.forEach((l, k) => { if (moneys[k] != null) totals[l.key] = moneys[k]; });
    }
  }
  return totals;
}

// ───────────────────────── Competência, pagamento, pessoa ─────────────────────────

const MONTH_NAMES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTH_RE = new RegExp(`\\b(${MONTH_NAMES.join('|')}|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\\.?\\s*(?:de\\s*|\\/\\s*|-\\s*)?(20\\d{2})\\b`);
const NUM_MONTH_RE = /(?<![\d/])(0?[1-9]|1[0-2])\s*\/\s*(20\d{2})\b/;
const PERIOD_HINT = /compet|refer|mes\s*\/?\s*ano|periodo|folha|mensal|holerite|demonstrativo|recibo|contracheque/;

function monthFrom(text) {
  const m = text.match(MONTH_RE);
  if (m) {
    const idx = MONTH_NAMES.findIndex(name => name.startsWith(m[1].slice(0, 3)));
    if (idx >= 0) return { month: idx + 1, year: +m[2] };
  }
  const k = text.match(NUM_MONTH_RE);
  return k ? { month: +k[1], year: +k[2] } : null;
}

function findCompetencia(rows) {
  const norm = rows.map(r => normalizeText(r.text));
  for (let i = 0; i < norm.length; i++) {
    if (!PERIOD_HINT.test(norm[i])) continue;
    const found = monthFrom(norm[i]) || (norm[i + 1] ? monthFrom(norm[i + 1]) : null);
    if (found) return found;
  }
  // Sem rótulo: mês por extenso em qualquer lugar (evita datas dd/mm/aaaa)
  for (const n of norm) {
    const m = n.match(MONTH_RE);
    if (m) return monthFrom(n);
  }
  return null;
}

function findPayDate(rows) {
  for (const r of rows) {
    const n = normalizeText(r.text);
    const m = n.match(/(?:pagamento|credito|creditado|pago\s+em|data\s+pgto)\D{0,25}(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  }
  return null;
}

/** Acha o membro da família cujo nome aparece no holerite. */
export function findPerson(text, names = []) {
  const n = ` ${normalizeText(text).replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ')} `;
  let best = null;
  let bestScore = 0;
  for (const name of names) {
    const tokens = normalizeText(name).split(' ').filter(t => t.length > 2);
    if (!tokens.length) continue;
    const full = n.includes(` ${tokens.join(' ')} `);
    const hits = tokens.filter(t => n.includes(` ${t} `)).length;
    const score = full ? 100 : hits;
    if (score > bestScore && (full || hits >= Math.min(2, tokens.length))) { best = name; bestScore = score; }
  }
  return best;
}

// ───────────────────────── Principal ─────────────────────────

/**
 * @param rows   linhas (string) ou { text, parts: [{ x, end, str }] }
 * @param opts   { memberNames: string[] }
 */
export function parsePayslip(rawRows, { memberNames = [] } = {}) {
  const rows = normalizeRows(rawRows).filter(r => r.text.trim() && r.text !== '\f');
  const warnings = [];

  // Cabeçalho da tabela de verbas e posição das colunas
  let start = 0;
  let colProv = null;
  let colDesc = null;
  let hasHeader = false;
  for (let i = 0; i < rows.length; i++) {
    const n = normalizeText(rows[i].text);
    if (HEADER_PROV.test(n) && HEADER_DESC.test(n) && !/total/.test(n)) {
      hasHeader = true;
      start = i + 1;
      if (rows[i].spans) {
        const lower = rows[i].text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const p = lower.search(HEADER_PROV);
        const d = lower.search(HEADER_DESC);
        colProv = p >= 0 ? xAt(rows[i], p) : null;
        colDesc = d >= 0 ? xAt(rows[i], d) : null;
      }
      break;
    }
  }

  // Fim da tabela: primeira linha de totais/líquido depois do cabeçalho
  let end = rows.length;
  for (let i = start; i < rows.length; i++) {
    const n = normalizeText(rows[i].text);
    if (TOTAL_PROV.test(n) || TOTAL_DESC.test(n) || /\bliquido\b/.test(n)) { end = i; break; }
  }

  const items = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    const n = normalizeText(row.text);
    if (!hasHeader && !/^\s*\d{1,5}\s+[a-z]/.test(n)) continue; // sem cabeçalho: só linhas com código
    for (const it of rowItems(row)) {
      if (NOT_ITEM.test(normalizeText(it.label)) || !(it.value > 0)) continue;
      let kind = null;
      if (colProv != null && colDesc != null && it.x != null) {
        kind = Math.abs(it.x - colProv) <= Math.abs(it.x - colDesc) ? 'prov' : 'desc';
      }
      items.push({ name: prettyLabel(it.label), value: round2(it.value), kind: kind || keywordKind(it.label), byColumn: !!kind });
    }
  }

  const totals = findTotals(rows);

  // Verbas sem classificação: usa os totais como prova real
  const unknown = items.filter(i => !i.kind);
  if (unknown.length) {
    const sumOf = (k) => items.filter(i => i.kind === k).reduce((s, i) => s + i.value, 0);
    let solved = false;
    if (totals.proventos != null && totals.descontos != null && unknown.length <= 12) {
      const baseP = sumOf('prov');
      const baseD = sumOf('desc');
      for (let mask = 0; mask < 1 << unknown.length && !solved; mask++) {
        let p = baseP;
        let d = baseD;
        unknown.forEach((u, k) => { if (mask & (1 << k)) d += u.value; else p += u.value; });
        if (near(p, totals.proventos) && near(d, totals.descontos)) {
          unknown.forEach((u, k) => { u.kind = mask & (1 << k) ? 'desc' : 'prov'; });
          solved = true;
        }
      }
    }
    if (!solved) {
      unknown.forEach(u => { u.kind = 'prov'; });
      warnings.push(`Não reconheci se ${unknown.length === 1 ? `"${unknown[0].name}" é acréscimo ou desconto` : `${unknown.length} verbas são acréscimos ou descontos`}: confira.`);
    }
  }

  const proventos = items.filter(i => i.kind === 'prov');
  const descontos = items.filter(i => i.kind === 'desc');

  // Salário base = verba "Salário..." (ou a maior), o resto vira acréscimo
  let base = proventos.find(p => BASE_SALARY.test(normalizeText(p.name)) && !NOT_BASE.test(normalizeText(p.name)));
  if (!base && proventos.length) base = proventos.reduce((a, b) => (b.value > a.value ? b : a));

  const sumP = round2(proventos.reduce((s, i) => s + i.value, 0));
  const sumD = round2(descontos.reduce((s, i) => s + i.value, 0));
  const computedNet = round2(sumP - sumD);

  if (!items.length) warnings.push('Não encontrei as verbas do holerite. Confira se o arquivo é um holerite/contracheque.');
  if (totals.proventos != null && items.length && !near(sumP, totals.proventos)) {
    warnings.push(`A soma dos acréscimos (${sumP.toFixed(2).replace('.', ',')}) difere do total de vencimentos do holerite (${totals.proventos.toFixed(2).replace('.', ',')}).`);
  }
  if (totals.descontos != null && items.length && !near(sumD, totals.descontos)) {
    warnings.push(`A soma dos descontos (${sumD.toFixed(2).replace('.', ',')}) difere do total de descontos do holerite (${totals.descontos.toFixed(2).replace('.', ',')}).`);
  }

  const fullText = rows.map(r => r.text).join('\n');
  return {
    gross: base ? base.value : 0,
    grossLabel: base ? base.name : '',
    additions: proventos.filter(p => p !== base).map(({ name, value }) => ({ name, value })),
    deductions: descontos.map(({ name, value }) => ({ name, value })),
    totals,
    computedNet,
    net: totals.liquido ?? computedNet,
    netMatches: totals.liquido != null && items.length ? near(computedNet, totals.liquido) : null,
    competencia: findCompetencia(rows),
    payDate: findPayDate(rows),
    person: findPerson(fullText, memberNames),
    warnings
  };
}
