// ============================================================
// SALARIES.SERVICE.JS — Dados e lógica de negócio de salários
// Sem dependências de DOM. Importável por qualquer camada.
// ============================================================

import { generateId } from '../../utils/helpers.js';
import {
  getCheckpointValue,
  isBenefitMode,
  matchesWalletMode,
  matchSalaryDeposits,
  sumNetBetween
} from '../transactions/transactions.service.js';

const round2 = (n) => Math.round(n * 100) / 100;

const COMP_MONTHS = [
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
];

const COMP_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

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

/** Extrai 'YYYY-MM' quando a descrição indica competência (ex.: "Salário Outubro/2026", "Out/2026"). */
export function extractCompetenciaKey(description) {
  const norm = normText(description);
  if (!norm) return null;
  const mFull = norm.match(/\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*(?:\/|de\s+)\s*(20\d{2})\b/);
  if (mFull) {
    const month = COMP_MONTHS.indexOf(mFull[1]) + 1;
    return `${mFull[2]}-${String(month).padStart(2, '0')}`;
  }
  const mShort = norm.match(/\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\s*\/\s*(20\d{2})\b/);
  if (mShort) {
    const month = COMP_SHORT.indexOf(mShort[1]) + 1;
    return `${mShort[2]}-${String(month).padStart(2, '0')}`;
  }
  return null;
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
 * 1) Se já existe depósito equivalente no extrato dentro de ±5 dias da DATA PAGTO, usa a data real do banco
 * 2) Data de pagamento impressa no holerite (ex.: DATA PAGTO: 30/10/2026)
 * 3) Crédito equivalente já existente no extrato bancário próximo à competência
 * 4) Último dia útil do mês de competência (evita cair na data de hoje em outro mês)
 */
export function inferPayslipDate(payslipResult, transactions = []) {
  const net = Number(payslipResult?.net ?? payslipResult?.computedNet ?? 0);
  if (payslipResult?.payDate) {
    if (net > 0 && Array.isArray(transactions)) {
      const nearDeposit = transactions.find(t =>
        t &&
        !t.isBalanceAdjustment &&
        t.type === 'entrada' &&
        !isBenefitMode(t.paymentMethod) &&
        Math.abs(Number(t.amount || 0) - net) <= 0.02 &&
        daysBetweenIso(t.date, payslipResult.payDate) <= 5
      );
      if (nearDeposit?.date) return nearDeposit.date;
    }
    return payslipResult.payDate;
  }

  const comp = payslipResult?.competencia;
  if (!comp?.year || !comp?.month) return null;

  const mm = String(comp.month).padStart(2, '0');
  const nextDate = new Date(comp.year, comp.month, 10);
  const windowStart = `${comp.year}-${mm}-15`;
  const windowEnd = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-10`;

  if (net > 0 && Array.isArray(transactions)) {
    const match = transactions.find(t =>
      t &&
      !t.isBalanceAdjustment &&
      t.type === 'entrada' &&
      !isBenefitMode(t.paymentMethod) &&
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
    if (!s || isBenefitMode(s.salaryType) || !s.description || !s.date) continue;
    const compKey = extractCompetenciaKey(s.description);
    if (!compKey) continue;

    const [compYear, compMonth] = compKey.split('-').map(Number);
    if (!compYear || compMonth < 1) continue;

    const nextMonthLimitDt = new Date(compYear, compMonth, 12);
    const latestReasonable = `${nextMonthLimitDt.getFullYear()}-${String(nextMonthLimitDt.getMonth() + 1).padStart(2, '0')}-12`;
    const earliestReasonable = `${compYear}-${String(compMonth).padStart(2, '0')}-01`;
    const windowStart = `${compYear}-${String(compMonth).padStart(2, '0')}-15`;
    const salAmt = Number(s.amount || 0);

    const bankMatch = (transactions || []).find(t =>
      t &&
      !t.isBalanceAdjustment &&
      t.type === 'entrada' &&
      !isBenefitMode(t.paymentMethod) &&
      t.date >= windowStart &&
      t.date <= latestReasonable &&
      Math.abs(Number(t.amount || 0) - salAmt) <= 0.02
    );

    // Se a data está fora da janela da competência, ou se o depósito caiu até 5 dias antes/depois (ex.: 29/10 vs 30/10)
    const outOfWindow = s.date < earliestReasonable || s.date > latestReasonable;
    const shouldSnapToBank = Boolean(bankMatch?.date && daysBetweenIso(s.date, bankMatch.date) <= 5 && s.date !== bankMatch.date);

    if (!outOfWindow && !shouldSnapToBank) continue;

    const fixedDate = bankMatch?.date || lastBusinessDayOfMonth(compYear, compMonth);
    if (fixedDate && fixedDate !== s.date) {
      s.date = fixedDate;
      repaired.push(s);
    }
  }
  return repaired;
}

function salaryRichnessScore(s) {
  return ((s.additions?.length || 0) + (s.deductions?.length || 0)) * 100 + (s.grossAmount ? 10 : 0);
}

/**
 * Remove duplicatas de salários regulares da mesma pessoa e mesmo valor líquido (±R$ 0,02)
 * quando pertencem à mesma competência ("Salário Outubro/2026") ou estão dentro de ±15 dias,
 * preservando sempre o registro mais completo (com acréscimos/descontos do holerite).
 */
export function deduplicateSalaries(salaries = []) {
  const keptSalaries = [];
  const removedSalaries = [];

  // Ordena para que o registro mais rico (e mais recente em empate) venha primeiro
  const ordered = (salaries || []).slice().sort((a, b) => {
    const scoreDiff = salaryRichnessScore(b) - salaryRichnessScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });

  for (const s of ordered) {
    if (!s || isBenefitMode(s.salaryType)) {
      if (s) keptSalaries.push(s);
      continue;
    }
    const sComp = extractCompetenciaKey(s.description);
    const sAmt = Number(s.amount || 0);

    const dupOf = keptSalaries.find(k => {
      if (isBenefitMode(k.salaryType)) return false;
      if ((k.person || '') !== (s.person || '')) return false;
      if (Math.abs(Number(k.amount || 0) - sAmt) > 0.02) return false;

      const kComp = extractCompetenciaKey(k.description);
      if (kComp && sComp) return kComp === sComp;
      return daysBetweenIso(k.date, s.date) <= 15;
    });

    if (dupOf) {
      removedSalaries.push(s);
    } else {
      keptSalaries.push(s);
    }
  }

  // Restaura ordem cronológica original de criação (mais recente primeiro)
  keptSalaries.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return { keptSalaries, removedSalaries };
}

/**
 * Conciliação completa e idempotente ao carregar/atualizar dados:
 * 1) Corrige datas de holerites fora da competência e alinha ao depósito bancário
 * 2) Remove holerites/salários duplicados no mesmo ciclo de pagamento
 * 3) Recalibra marcos de saldo de extrato quando necessário
 */
export function reconcileSalariesAndStatements(salaries = [], transactions = []) {
  const repairedSalaries = reconcileMisdatedPayslips(salaries, transactions);
  const { keptSalaries, removedSalaries } = deduplicateSalaries(salaries);
  const removedIds = new Set(removedSalaries.map(s => s.id));
  const survivingRepaired = repairedSalaries.filter(s => !removedIds.has(s.id));

  const updatedCheckpoints = [];
  const checkpoints = (transactions || []).filter(t => t?.isBalanceAdjustment && t.checkpointSource !== 'manual' && t.date);

  for (const cp of checkpoints) {
    const mode = cp.paymentMethod === 'vr' ? 'vr' : cp.paymentMethod === 'va' ? 'va' : 'geral';
    const currentBal = getCheckpointValue(cp);
    let nextBal = currentBal;

    if (typeof cp.statementClosingBalance === 'number' && Number.isFinite(cp.statementClosingBalance) && cp.statementEndDate) {
      const periodNet = sumNetBetween(transactions, keptSalaries, cp.date, cp.statementEndDate, mode);
      nextBal = round2(cp.statementClosingBalance - periodNet);
    } else if (mode === 'geral') {
      const generalDates = (transactions || [])
        .filter(t => t && !t.isBalanceAdjustment && t.date && matchesWalletMode(t.paymentMethod, 'geral'))
        .map(t => t.date)
        .sort();
      const maxTxDate = generalDates.length ? generalDates[generalDates.length - 1] : cp.date;
      const removedInRange = removedSalaries.filter(s => s.date >= cp.date && s.date <= maxTxDate);

      if (removedInRange.length >= 2 && nextBal < -100) {
        const sampleAmt = Number(removedInRange[0].amount || 0);
        if (sampleAmt > 0 && nextBal + sampleAmt >= -10) {
          nextBal = round2(nextBal + sampleAmt);
        }
      } else if (removedInRange.length === 0 && !cp.reconciledLegacyV38) {
        const { salaryEffectiveDate } = matchSalaryDeposits(transactions, keptSalaries);
        const unmatchedCompSal = keptSalaries.find(s =>
          !isBenefitMode(s.salaryType) &&
          extractCompetenciaKey(s.description) &&
          s.date >= cp.date &&
          s.date <= maxTxDate &&
          !salaryEffectiveDate.has(s.id) &&
          Number(s.amount || 0) >= 500
        );
        if (unmatchedCompSal && nextBal >= Number(unmatchedCompSal.amount)) {
          nextBal = round2(nextBal - Number(unmatchedCompSal.amount));
          cp.reconciledLegacyV38 = true;
        }
      }
    }

    if (Math.abs(nextBal - currentBal) >= 0.01) {
      cp.checkpointBalance = nextBal;
      cp.type = nextBal >= 0 ? 'entrada' : 'saida';
      cp.amount = Math.abs(nextBal);
      updatedCheckpoints.push(cp);
    }
  }

  return {
    keptSalaries,
    repairedSalaries: survivingRepaired,
    removedSalaries,
    updatedCheckpoints
  };
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
