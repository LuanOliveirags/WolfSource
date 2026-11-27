// ============================================================
// TRANSACTIONS.SERVICE.JS — Dados e lógica de negócio de transações
// Sem dependências de DOM. Importável por qualquer camada.
// ============================================================

import { generateId } from '../../utils/helpers.js';

const round2 = (n) => Math.round(n * 100) / 100;

function normText(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function daysBetweenIso(a, b) {
  if (!a || !b) return Infinity;
  const da = new Date(a + 'T12:00:00');
  const db = new Date(b + 'T12:00:00');
  return Math.abs(Math.round((da - db) / 86400000));
}

// ===== FACTORY =====

export function buildTransactionObject({ type, amount, category, responsible, date, description, paymentMethod, familyId }) {
  return {
    id: generateId(),
    type,
    amount,
    category,
    responsible,
    date,
    description,
    paymentMethod: paymentMethod || 'dinheiro',
    familyId,
    createdAt: new Date().toISOString()
  };
}

/** Cria um marco de saldo em conta (saldo inicial / conciliação), sincronizado na coleção transactions. */
export function buildBalanceCheckpointObject({
  checkpointBalance,
  date,
  responsible,
  description,
  paymentMethod = 'conta',
  familyId,
  source = 'manual',
  importBatch = null,
  importFile = '',
  importBank = '',
  statementOpeningBalance = null,
  statementClosingBalance = null,
  statementEndDate = ''
}) {
  const bal = round2(Number(checkpointBalance) || 0);
  const obj = {
    id: generateId(),
    type: bal >= 0 ? 'entrada' : 'saida',
    amount: Math.abs(bal),
    category: 'outros',
    responsible: responsible || 'Família',
    date,
    description: description || 'Ajuste de saldo em conta',
    paymentMethod,
    familyId,
    isBalanceAdjustment: true,
    checkpointMode: 'opening',
    checkpointBalance: bal,
    checkpointSource: source,
    createdAt: new Date().toISOString()
  };
  if (importBatch) obj.importBatch = importBatch;
  if (importFile) obj.importFile = importFile;
  if (importBank) obj.importBank = importBank;
  if (typeof statementOpeningBalance === 'number' && Number.isFinite(statementOpeningBalance)) {
    obj.statementOpeningBalance = round2(statementOpeningBalance);
  }
  if (typeof statementClosingBalance === 'number' && Number.isFinite(statementClosingBalance)) {
    obj.statementClosingBalance = round2(statementClosingBalance);
  }
  if (statementEndDate) obj.statementEndDate = statementEndDate;
  return obj;
}

// ===== FILTROS =====

export function filterTransactions(transactions, { monthVal, selectedDay, typeFilter }) {
  let filtered = transactions.filter(t => !t.isBalanceAdjustment);
  if (selectedDay) {
    filtered = filtered.filter(t => t.date === selectedDay);
  } else if (monthVal) {
    filtered = filtered.filter(t => t.date.startsWith(monthVal));
  }
  if (typeFilter && typeFilter !== 'all') {
    filtered = filtered.filter(t => t.type === typeFilter);
  }
  return filtered;
}

// ===== AGRUPAMENTO =====

export function groupByDate(transactions) {
  const grouped = {};
  transactions.filter(t => !t.isBalanceAdjustment).forEach(t => {
    if (!grouped[t.date]) grouped[t.date] = [];
    grouped[t.date].push(t);
  });
  return Object.entries(grouped)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, items]) => ({
      date,
      items,
      dayTotal: items.reduce((s, t) => s + (t.type === 'entrada' ? t.amount : -t.amount), 0)
    }));
}

// ===== CONCILIAÇÃO DE SALÁRIO × EXTRATO E SALDO ACUMULADO =====

export function isBenefitMode(val) {
  return val === 'vr' || val === 'va';
}

export function matchesWalletMode(paymentOrSalaryType, mode = 'geral') {
  if (mode === 'vr') return paymentOrSalaryType === 'vr';
  if (mode === 'va') return paymentOrSalaryType === 'va';
  return !isBenefitMode(paymentOrSalaryType);
}

const SALARY_TX_RE = /\b(salario|vencimento|provento|folha|remunera|holerite|contracheque)\b/;

/**
 * Pareia 1-para-1 salários cadastrados na aba Salário com entradas equivalentes do extrato
 * (ex.: "Ted conta salario R$ 4.240,06" no dia 29/10 e holerite líquido de R$ 4.240,06 em 30/10),
 * evitando que o mesmo salário seja somado duas vezes na Receita e no Saldo em conta.
 */
export function matchSalaryDeposits(transactions = [], salaries = []) {
  const matchedTxIds = new Set();
  const salaryEffectiveDate = new Map();

  const regularSalaries = (salaries || []).filter(s => s && s.date && !isBenefitMode(s.salaryType));
  if (!regularSalaries.length) return { matchedTxIds, salaryEffectiveDate };

  const candidateTxs = (transactions || []).filter(t =>
    t &&
    !t.isBalanceAdjustment &&
    t.type === 'entrada' &&
    t.date &&
    !isBenefitMode(t.paymentMethod)
  );

  for (const sal of regularSalaries) {
    const salAmt = Number(sal.amount || 0);
    if (!(salAmt > 0)) continue;

    let bestTx = null;
    let bestDiff = Infinity;

    for (const tx of candidateTxs) {
      if (matchedTxIds.has(tx.id)) continue;
      const txAmt = Number(tx.amount || 0);
      if (Math.abs(txAmt - salAmt) > 0.02) continue;

      const dayDiff = daysBetweenIso(tx.date, sal.date);
      if (dayDiff > 10) continue;

      const descNorm = normText(tx.description);
      const hasSalaryHint = SALARY_TX_RE.test(descNorm);
      const hasExactCents = txAmt >= 500 && Math.round(txAmt * 100) % 100 !== 0 && dayDiff <= 5;
      if (!hasSalaryHint && !hasExactCents) continue;

      if (dayDiff < bestDiff) {
        bestDiff = dayDiff;
        bestTx = tx;
      }
    }

    if (bestTx) {
      matchedTxIds.add(bestTx.id);
      // Usa a data real em que o dinheiro caiu na conta bancária para manter o saldo diário exato
      salaryEffectiveDate.set(sal.id, bestTx.date);
    }
  }

  return { matchedTxIds, salaryEffectiveDate };
}

export function getCheckpointValue(cp) {
  if (!cp) return 0;
  if (typeof cp.checkpointBalance === 'number' && Number.isFinite(cp.checkpointBalance)) {
    return round2(cp.checkpointBalance);
  }
  return round2(cp.type === 'saida' ? -Number(cp.amount || 0) : Number(cp.amount || 0));
}

/** Último marco de saldo (checkpoint) com data <= upToDate para o modo ('geral' | 'vr' | 'va'). */
export function getLatestCheckpoint(transactions, upToDate, mode = 'geral') {
  const candidates = (transactions || []).filter(t =>
    t?.isBalanceAdjustment &&
    t.date &&
    t.date <= upToDate &&
    matchesWalletMode(t.paymentMethod, mode)
  );
  if (!candidates.length) return null;
  return candidates.sort((a, b) =>
    b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '')
  )[0];
}

/** Soma líquida (entradas + salários − saídas) no intervalo [fromDate, toDate] inclusivo, sem duplicar salário × extrato. */
export function sumNetBetween(transactions, salaries = [], fromDate = '0000-00-00', toDate = '9999-99-99', mode = 'geral') {
  const { matchedTxIds, salaryEffectiveDate } = mode === 'geral'
    ? matchSalaryDeposits(transactions, salaries)
    : { matchedTxIds: new Set(), salaryEffectiveDate: new Map() };

  let sum = 0;
  for (const t of transactions || []) {
    if (!t || t.isBalanceAdjustment || !t.date) continue;
    if (matchedTxIds.has(t.id)) continue;
    if (!matchesWalletMode(t.paymentMethod, mode)) continue;
    if (t.date >= fromDate && t.date <= toDate) {
      sum += t.type === 'entrada' ? Number(t.amount || 0) : -Number(t.amount || 0);
    }
  }
  for (const s of salaries || []) {
    if (!s || !s.date) continue;
    if (!matchesWalletMode(s.salaryType, mode)) continue;
    const effDate = salaryEffectiveDate.get(s.id) || s.date;
    if (effDate >= fromDate && effDate <= toDate) {
      sum += Number(s.amount || 0);
    }
  }
  return round2(sum);
}

/** Saldo conciliado ao fim de targetDate, ou null se não houver marco de saldo até essa data. */
export function computeBalanceAtDate(transactions, salaries = [], targetDate, mode = 'geral') {
  const cp = getLatestCheckpoint(transactions, targetDate, mode);
  if (!cp) return null;
  return round2(getCheckpointValue(cp) + sumNetBetween(transactions, salaries, cp.date, targetDate, mode));
}

/**
 * Calcula o saldo do mês (year, month 0-based) levando em conta o saldo anterior
 * conciliado (quando houver marco de saldo de extrato ou ajuste manual).
 */
export function computeMonthAccountBalance(transactions, salaries = [], year, month, mode = 'geral') {
  const mm = String(month + 1).padStart(2, '0');
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthStart = `${year}-${mm}-01`;
  const monthEnd = `${year}-${mm}-${String(daysInMonth).padStart(2, '0')}`;

  const monthNet = sumNetBetween(transactions, salaries, monthStart, monthEnd, mode);
  const cp = getLatestCheckpoint(transactions, monthEnd, mode);

  if (!cp) {
    return {
      hasCheckpoint: false,
      carryOver: 0,
      monthNet,
      closingBalance: monthNet,
      checkpoint: null,
      intraMonthCheckpoint: null
    };
  }

  const cpBase = getCheckpointValue(cp);

  if (cp.date <= monthStart) {
    let beforeMonthSum = 0;
    if (cp.date < monthStart) {
      const prevMonthEnd = toPrevDay(monthStart);
      beforeMonthSum = sumNetBetween(transactions, salaries, cp.date, prevMonthEnd, mode);
    }
    const carryOver = round2(cpBase + beforeMonthSum);
    const closingBalance = round2(carryOver + monthNet);
    return {
      hasCheckpoint: true,
      carryOver,
      monthNet,
      closingBalance,
      checkpoint: cp,
      intraMonthCheckpoint: null
    };
  }

  const afterCpNet = sumNetBetween(transactions, salaries, cp.date, monthEnd, mode);
  const closingBalance = round2(cpBase + afterCpNet);
  const effectiveCarryOver = round2(closingBalance - monthNet);
  return {
    hasCheckpoint: true,
    carryOver: effectiveCarryOver,
    monthNet,
    closingBalance,
    checkpoint: cp,
    intraMonthCheckpoint: cp
  };
}

function toPrevDay(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
