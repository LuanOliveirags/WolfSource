// ============================================================
// SALARIES.SERVICE.JS — Dados e lógica de negócio de salários
// Sem dependências de DOM. Importável por qualquer camada.
// ============================================================

import { generateId } from '../../utils/helpers.js';

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
 * Retorna { byMember, combinedMonth, combinedAnnual, combinedVRMonth, combinedVRAnnual, combinedVAMonth, combinedVAAnnual }.
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
