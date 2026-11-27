// ============================================================
// SALARIES.SERVICE.JS — Dados e lógica de negócio de salários
// Sem dependências de DOM. Importável por qualquer camada.
// ============================================================

import { generateId } from '../../utils/helpers.js';

const COMP_MONTHS = [
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
];

function normText(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Último dia útil (seg–sex) de um mês (month1Based: 1..12). */
export function lastBusinessDayOfMonth(year, month1Based) {
  const dt = new Date(year, month1Based, 0); // último dia do mês
  while (dt.getDay() === 0 || dt.getDay() === 6) {
    dt.setDate(dt.getDate() - 1);
  }
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/**
 * Determina a melhor data para registrar um holerite lido:
 * 1) Data de pagamento impressa no holerite (ex.: DATA PAGTO: 30/10/2026)
 * 2) Crédito equivalente já existente no extrato bancário próximo à competência
 * 3) Último dia útil do mês de competência (evita cair na data de hoje em outro mês)
 */
export function inferPayslipDate(payslipResult, transactions = []) {
  if (payslipResult?.payDate) return payslipResult.payDate;
  const comp = payslipResult?.competencia;
  if (!comp?.year || !comp?.month) return null;

  const net = Number(payslipResult.net ?? payslipResult.computedNet ?? 0);
  const mm = String(comp.month).padStart(2, '0');
  const nextDate = new Date(comp.year, comp.month, 10);
  const windowStart = `${comp.year}-${mm}-15`;
  const windowEnd = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-10`;

  if (net > 0 && Array.isArray(transactions)) {
    const match = transactions.find(t =>
      t &&
      !t.isBalanceAdjustment &&
      t.type === 'entrada' &&
      t.paymentMethod !== 'vr' &&
      t.paymentMethod !== 'va' &&
      t.date >= windowStart &&
      t.date <= windowEnd &&
      Math.abs(Number(t.amount || 0) - net) <= 0.02
    );
    if (match?.date) return match.date;
  }

  return lastBusinessDayOfMonth(comp.year, comp.month);
}

/**
 * Corrige automaticamente holerites que foram gravados com a data do dia da leitura
 * por falta de "DATA PAGTO" (ex.: "Salário Outubro/2026" gravado em 27/11/2026),
 * alinhando-os ao crédito real do extrato ou ao fim do mês de competência.
 */
export function reconcileMisdatedPayslips(salaries = [], transactions = []) {
  const repaired = [];
  for (const s of salaries || []) {
    if (!s || s.salaryType === 'vr' || s.salaryType === 'va' || !s.description || !s.date) continue;
    const norm = normText(s.description);
    const m = norm.match(/\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*\/\s*(20\d{2})\b/);
    if (!m) continue;

    const compMonth = COMP_MONTHS.indexOf(m[1]) + 1;
    const compYear = parseInt(m[2], 10);
    if (compMonth < 1) continue;

    // Até o dia 12 do mês seguinte pode ser pagamento legítimo no 5º dia útil; após isso foi fallback para hoje
    const nextMonthLimitDt = new Date(compYear, compMonth, 12);
    const latestReasonable = `${nextMonthLimitDt.getFullYear()}-${String(nextMonthLimitDt.getMonth() + 1).padStart(2, '0')}-12`;
    const earliestReasonable = `${compYear}-${String(compMonth).padStart(2, '0')}-01`;

    if (s.date >= earliestReasonable && s.date <= latestReasonable) continue;

    const windowStart = `${compYear}-${String(compMonth).padStart(2, '0')}-15`;
    const windowEnd = latestReasonable;
    const salAmt = Number(s.amount || 0);

    const bankMatch = (transactions || []).find(t =>
      t &&
      !t.isBalanceAdjustment &&
      t.type === 'entrada' &&
      t.paymentMethod !== 'vr' &&
      t.paymentMethod !== 'va' &&
      t.date >= windowStart &&
      t.date <= windowEnd &&
      Math.abs(Number(t.amount || 0) - salAmt) <= 0.02
    );

    const fixedDate = bankMatch?.date || lastBusinessDayOfMonth(compYear, compMonth);
    if (fixedDate && fixedDate !== s.date) {
      s.date = fixedDate;
      repaired.push(s);
    }
  }
  return repaired;
}

// ===== FACTORY =====

/**
 * Constrói o objeto de salário a partir dos dados do formulário.
 * Puro — sem efeitos colaterais, sem DOM, sem Firebase.
 */
export function buildSalaryObject({ person, grossAmount, salaryType, date, description, additions, deductions, familyId }) {
  const totalAdditions = additions.reduce((sum, a) => sum + a.value, 0);
  const totalDeductions = deductions.reduce((sum, d) => sum + d.value, 0);
  const netAmount = grossAmount + totalAdditions - totalDeductions;

  return {
    id: generateId(),
    person,
    amount: netAmount,
    grossAmount,
    salaryType: salaryType || 'salario',
    additions: additions.length > 0 ? [...additions] : [],
    totalAdditions,
    deductions: deductions.length > 0 ? [...deductions] : [],
    totalDeductions,
    date,
    description,
    familyId,
    createdAt: new Date().toISOString()
  };
}

// ===== FILTROS =====

export function filterByMonth(salaries, monthKey) {
  if (!monthKey) return salaries;
  return salaries.filter(s => s.date.startsWith(monthKey));
}

export function getSalaryMonths(salaries) {
  const set = new Set();
  salaries.forEach(s => {
    const d = new Date(s.date + 'T12:00:00');
    set.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  });
  return set;
}

// ===== ESTATÍSTICAS (função pura) =====

/**
 * Calcula totais mensais e anuais por pessoa e combinados, separando Salário, VR e VA.
 */
export function computeSalaryStats(salaries, members, curMonth, curYear) {
  let combinedMonth = 0, combinedAnnual = 0;
  let combinedVRMonth = 0, combinedVRAnnual = 0;
  let combinedVAMonth = 0, combinedVAAnnual = 0;

  const byMember = {};
  members.forEach(m => {
    const slug = m.name.replace(/\s+/g, '_');
    const regular = salaries.filter(s => s.person === m.name && s.salaryType !== 'vr' && s.salaryType !== 'va');
    const vr = salaries.filter(s => s.person === m.name && s.salaryType === 'vr');
    const va = salaries.filter(s => s.person === m.name && s.salaryType === 'va');

    const inMonth = s => {
      const d = new Date(s.date + 'T12:00:00');
      return d.getMonth() === curMonth && d.getFullYear() === curYear;
    };

    const inYear = s => {
      const d = new Date(s.date + 'T12:00:00');
      return d.getFullYear() === curYear;
    };

    const annual    = regular.filter(inYear).reduce((sum, s) => sum + s.amount, 0);
    const monthly   = regular.filter(inMonth).reduce((sum, s) => sum + s.amount, 0);
    const vrAnnual  = vr.filter(inYear).reduce((sum, s) => sum + s.amount, 0);
    const vrMonthly = vr.filter(inMonth).reduce((sum, s) => sum + s.amount, 0);
    const vaAnnual  = va.filter(inYear).reduce((sum, s) => sum + s.amount, 0);
    const vaMonthly = va.filter(inMonth).reduce((sum, s) => sum + s.amount, 0);

    byMember[slug] = { monthly, annual, vrMonthly, vrAnnual, vaMonthly, vaAnnual };
    combinedMonth    += monthly;
    combinedAnnual   += annual;
    combinedVRMonth  += vrMonthly;
    combinedVRAnnual += vrAnnual;
    combinedVAMonth  += vaMonthly;
    combinedVAAnnual += vaAnnual;
  });

  return {
    byMember,
    combinedMonth,
    combinedAnnual,
    combinedVRMonth,
    combinedVRAnnual,
    combinedVAMonth,
    combinedVAAnnual
  };
}
