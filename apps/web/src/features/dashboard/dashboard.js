// ============================================================
// DASHBOARD.JS — Dashboard KPIs e gráficos (Chart.js)
// ============================================================
/* global Chart */

import { CATEGORY_MAP } from '../../../../../packages/services/firebase/firebase.config.js';
import { state, getFamilyId } from '../../../../../packages/core/state/store.js';
import { formatCurrency, showAlert } from '../../../../../packages/utils/helpers.js';
import { saveDataToStorage, saveToFirebase, deleteFromFirebase } from '../../../../../packages/services/firebase/firebase.service.js';
import {
  buildBalanceCheckpointObject,
  computeMonthAccountBalance,
  getCheckpointValue,
  isBenefitMode,
  matchesWalletMode,
  matchSalaryDeposits
} from '../../../../../packages/services/transactions/transactions.service.js';
import { updateRecentTransactions } from '../transactions/transactions.js';

// ===== DASHBOARD MODE STATE =====
let dashboardMode = 'geral'; // 'geral' | 'vr' | 'va'
const round2 = (n) => Math.round(n * 100) / 100;

function getSelectedYearMonth() {
  const monthVal = document.getElementById('monthFilter')?.value;
  if (monthVal) {
    const parts = monthVal.split('-');
    return { year: parseInt(parts[0]), month: parseInt(parts[1]) - 1 };
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

function formatSignedCurrency(val) {
  if (val > 0.004) return `+${formatCurrency(val)}`;
  if (val < -0.004) return `−${formatCurrency(Math.abs(val))}`;
  return formatCurrency(0);
}

// ===== KPI CARD CLICK → NAVIGATE + FILTER =====
export function setupKpiClickListeners() {
  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-kpi-action]');
    if (!card) return;
    const action = card.dataset.kpiAction;
    const filter = card.dataset.kpiFilter;

    // Navigate to the target tab
    if (typeof window.switchTab === 'function') {
      window.switchTab(action);
    }

    // If there's a debt filter, simulate clicking the matching filter card in debts tab
    if (action === 'debts' && filter) {
      setTimeout(() => {
        // Clear any existing filter first
        if (typeof window.clearDebtFilter === 'function') {
          window.clearDebtFilter();
        }
        // Find and click the matching debt overview card or summary-mini
        const targetCard = document.querySelector(`.debt-overview-card[data-filter="${filter}"], .summary-mini[data-filter="${filter}"]`);
        if (targetCard) {
          targetCard.click();
          targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 150);
    }
  });
}

export function setDashboardMode(mode) {
  if (!['geral', 'vr', 'va'].includes(mode)) return;
  dashboardMode = mode;

  const btnGeral = document.getElementById('btnModeGeral');
  const btnVR = document.getElementById('btnModeVR');
  const btnVA = document.getElementById('btnModeVA');
  const slider = document.getElementById('dashModeSlider');
  const dashboard = document.getElementById('dashboard');
  const isBenefit = isBenefitMode(mode);

  btnGeral?.classList.toggle('active', mode === 'geral');
  btnVR?.classList.toggle('active', mode === 'vr');
  btnVA?.classList.toggle('active', mode === 'va');

  if (slider) {
    slider.classList.toggle('vr-active', mode === 'vr');
    slider.classList.toggle('va-active', mode === 'va');
  }

  dashboard?.classList.toggle('dashboard-vr-mode', isBenefit);

  const balanceCard = document.querySelector('.balance-card');
  balanceCard?.classList.toggle('vr-mode', mode === 'vr');
  balanceCard?.classList.toggle('va-mode', mode === 'va');
  document.querySelectorAll('.ie-card').forEach(c => {
    c.classList.toggle('vr-mode', mode === 'vr');
    c.classList.toggle('va-mode', mode === 'va');
  });
  document.getElementById('vrKpiSummary')?.classList.toggle('va-mode', mode === 'va');

  updateDashboard();
}

export function setupDashboardToggle() {
  const btnGeral = document.getElementById('btnModeGeral');
  const btnVR = document.getElementById('btnModeVR');
  const btnVA = document.getElementById('btnModeVA');
  if (!btnGeral || !btnVR) return;

  btnGeral.addEventListener('click', () => setDashboardMode('geral'));
  btnVR.addEventListener('click', () => setDashboardMode('vr'));
  btnVA?.addEventListener('click', () => setDashboardMode('va'));

  document.querySelectorAll('[data-switch-mode]').forEach(card => {
    card.addEventListener('click', () => setDashboardMode(card.dataset.switchMode));
  });
}

// ===== HIDE/SHOW VALUES TOGGLE =====
export function setupValuesToggle() {
  const btn = document.getElementById('toggleValuesBtn');
  const icon = document.getElementById('toggleValuesIcon');
  if (!btn || !icon) return;

  const hidden = localStorage.getItem('valuesHidden') === 'true';
  const dashboard = document.getElementById('dashboard');
  if (hidden) {
    dashboard.classList.add('values-hidden');
    icon.classList.replace('fa-eye', 'fa-eye-slash');
  }

  btn.addEventListener('click', () => {
    const isHidden = dashboard.classList.toggle('values-hidden');
    icon.classList.replace(
      isHidden ? 'fa-eye' : 'fa-eye-slash',
      isHidden ? 'fa-eye-slash' : 'fa-eye'
    );
    localStorage.setItem('valuesHidden', isHidden);
  });
}

// ===== SUMMARY PANEL TOGGLE =====
export function setupSummaryToggle() {
  const btn = document.getElementById('dashSummaryToggleBtn');
  const label = document.getElementById('dashSummaryToggleLabel');
  const panel = document.getElementById('dashSummaryPanel');
  if (!btn || !panel) return;

  const setCollapsed = (collapsed) => {
    panel.classList.toggle('collapsed', collapsed);
    btn.classList.toggle('is-collapsed', collapsed);
    if (label) label.textContent = collapsed ? 'Mostrar' : 'Ocultar';
    btn.title = collapsed ? 'Mostrar resumo' : 'Ocultar resumo';
    localStorage.setItem('summaryCollapsed', collapsed);
  };

  setCollapsed(localStorage.getItem('summaryCollapsed') === 'true');
  btn.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
}

// ===== AJUSTAR SALDO EM CONTA / VR / VA =====
export function setupBalanceAdjustment() {
  const openBtn = document.getElementById('adjustBalanceBtn');
  const modal = document.getElementById('adjustBalanceModal');
  const closeBtn = document.getElementById('adjustBalanceCloseBtn');
  const form = document.getElementById('adjustBalanceForm');
  const input = document.getElementById('adjustBalanceInput');
  const resetBtn = document.getElementById('removeBalanceAdjustBtn');
  if (!openBtn || !modal || !form || !input) return;

  const close = () => modal.classList.remove('active');
  closeBtn?.addEventListener('click', close);

  openBtn.addEventListener('click', () => {
    const { year, month } = getSelectedYearMonth();
    const mode = dashboardMode;
    const info = computeMonthAccountBalance(state.transactions, state.salaries, year, month, mode);
    const monthName = new Date(year, month, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    const titleEl = document.getElementById('adjustBalanceModalTitle');
    if (titleEl) {
      if (mode === 'vr') titleEl.innerHTML = '<i class="fa-solid fa-utensils"></i> Ajustar saldo de VR';
      else if (mode === 'va') titleEl.innerHTML = '<i class="fa-solid fa-basket-shopping"></i> Ajustar saldo de VA';
      else titleEl.innerHTML = '<i class="fa-solid fa-scale-balanced"></i> Ajustar saldo em conta';
    }
    const labelEl = document.getElementById('adjustBalanceLabel');
    const walletName = mode === 'vr' ? 'VR' : mode === 'va' ? 'VA' : 'conta';
    if (labelEl) labelEl.textContent = `Saldo de ${walletName} em ${monthName} (R$)`;

    input.value = info.closingBalance.toFixed(2);
    if (resetBtn) resetBtn.hidden = !info.hasCheckpoint;
    modal.classList.add('active');
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const familyId = getFamilyId();
    if (!familyId) { showAlert('Erro: família não identificada.', 'danger'); return; }
    const target = parseFloat(input.value);
    if (!Number.isFinite(target)) { showAlert('Informe um valor válido.', 'warning'); return; }

    const { year, month } = getSelectedYearMonth();
    const mm = String(month + 1).padStart(2, '0');
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthStart = `${year}-${mm}-01`;
    const monthEnd = `${year}-${mm}-${String(daysInMonth).padStart(2, '0')}`;
    const mode = dashboardMode;

    const info = computeMonthAccountBalance(state.transactions, state.salaries, year, month, mode);
    const neededOpening = round2(target - info.monthNet);

    // Substitui qualquer marco de saldo dentro deste mesmo mês para a carteira atual (geral, vr ou va)
    const staleIds = state.transactions
      .filter(t =>
        t.isBalanceAdjustment &&
        t.date >= monthStart &&
        t.date <= monthEnd &&
        matchesWalletMode(t.paymentMethod, mode)
      )
      .map(t => t.id);

    if (staleIds.length) {
      const idSet = new Set(staleIds);
      state.transactions = state.transactions.filter(t => !idSet.has(t.id));
      await Promise.allSettled(staleIds.map(id => deleteFromFirebase('transactions', id)));
    }

    const walletLabel = mode === 'vr' ? 'VR' : mode === 'va' ? 'VA' : 'conta';
    const cp = buildBalanceCheckpointObject({
      checkpointBalance: neededOpening,
      date: monthStart,
      responsible: state.currentUser?.fullName || 'Família',
      description: `Ajuste manual de saldo (${walletLabel})`,
      paymentMethod: mode === 'geral' ? 'conta' : mode,
      familyId,
      source: 'manual'
    });

    state.transactions.push(cp);
    saveDataToStorage();
    await saveToFirebase('transactions', cp);

    close();
    updateDashboard();
    showAlert(`Saldo de ${walletLabel} ajustado para ${formatCurrency(round2(target))}!`, 'success');
  });

  resetBtn?.addEventListener('click', async () => {
    const { year, month } = getSelectedYearMonth();
    const mm = String(month + 1).padStart(2, '0');
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthEnd = `${year}-${mm}-${String(daysInMonth).padStart(2, '0')}`;
    const mode = dashboardMode;
    if (!confirm('Remover os ajustes/saldos iniciais anteriores e mostrar apenas Receita − Despesa do mês?')) return;

    const removeIds = state.transactions
      .filter(t =>
        t.isBalanceAdjustment &&
        t.date <= monthEnd &&
        matchesWalletMode(t.paymentMethod, mode)
      )
      .map(t => t.id);

    if (removeIds.length) {
      const idSet = new Set(removeIds);
      state.transactions = state.transactions.filter(t => !idSet.has(t.id));
      saveDataToStorage();
      await Promise.allSettled(removeIds.map(id => deleteFromFirebase('transactions', id)));
    }

    close();
    updateDashboard();
    showAlert('Cálculo voltou a usar apenas as movimentações do mês.', 'info');
  });
}

// ===== ATUALIZAR DASHBOARD =====
export function updateDashboard() {
  const { year, month } = getSelectedYearMonth();

  const realTransactions = state.transactions.filter(t => !t.isBalanceAdjustment);
  const { matchedTxIds, salaryEffectiveDate } = matchSalaryDeposits(realTransactions, state.salaries);

  const monthTransactions = realTransactions.filter(t => {
    const tDate = new Date(t.date + 'T12:00:00');
    return tDate.getMonth() === month && tDate.getFullYear() === year;
  });

  const effectiveSalaries = state.salaries.map(s => {
    const effDate = salaryEffectiveDate.get(s.id);
    return effDate && effDate !== s.date ? { ...s, date: effDate } : s;
  });

  const monthSalaries = effectiveSalaries.filter(s => {
    const sDate = new Date(s.date + 'T12:00:00');
    return sDate.getMonth() === month && sDate.getFullYear() === year;
  });

  const monthDebts = state.debts.filter(d => d.status === 'active');

  // Separa Geral, VR e VA de forma independente; em Geral, ignora o depósito do extrato já coberto pelo holerite
  const generalAllMonthTx = monthTransactions.filter(t => !isBenefitMode(t.paymentMethod));
  const generalTransactions = generalAllMonthTx.filter(t => !matchedTxIds.has(t.id));
  const vrTransactions = monthTransactions.filter(t => t.paymentMethod === 'vr');
  const vaTransactions = monthTransactions.filter(t => t.paymentMethod === 'va');

  const generalSalaries = monthSalaries.filter(s => !isBenefitMode(s.salaryType));
  const vrSalaries = monthSalaries.filter(s => s.salaryType === 'vr');
  const vaSalaries = monthSalaries.filter(s => s.salaryType === 'va');

  const totalExpenses = generalTransactions.filter(t => t.type === 'saida').reduce((sum, t) => sum + t.amount, 0);
  const totalTransactionIncome = generalTransactions.filter(t => t.type === 'entrada').reduce((sum, t) => sum + t.amount, 0);
  const totalSalaryIncome = generalSalaries.reduce((sum, s) => sum + s.amount, 0);
  const totalIncome = totalTransactionIncome + totalSalaryIncome;

  const generalBalanceInfo = computeMonthAccountBalance(state.transactions, state.salaries, year, month, 'geral');
  const vrBalanceInfo = computeMonthAccountBalance(state.transactions, state.salaries, year, month, 'vr');
  const vaBalanceInfo = computeMonthAccountBalance(state.transactions, state.salaries, year, month, 'va');

  const totalBalance = generalBalanceInfo.closingBalance;
  const totalDebt = monthDebts.reduce((sum, d) => sum + d.amount, 0);
  const responsibleCount = new Set(generalTransactions.map(t => t.responsible)).size;

  const isInstallmentType = d => (d.debtType === 'financiamento' || d.debtType === 'parcelada' || d.debtType === 'emprestimo') || (d.debtType === 'cartao' && d.cartaoMode === 'parcelado');
  const monthlyDebtsActive = monthDebts.filter(d => !isInstallmentType(d));
  const financingDebtsOnly = monthDebts.filter(d => (d.debtType === 'financiamento' || d.debtType === 'parcelada') || (d.debtType === 'cartao' && d.cartaoMode === 'parcelado'));
  const loanDebtsOnly = monthDebts.filter(d => d.debtType === 'emprestimo');
  const totalMonthlyDebts = monthlyDebtsActive.reduce((sum, d) => sum + d.amount, 0);
  const totalFinancingInstallment = financingDebtsOnly.reduce((sum, d) => sum + (d.installmentValue || d.amount), 0);
  const totalFinancingRemaining = financingDebtsOnly.reduce((sum, d) => {
    const instVal = d.installmentValue || (d.amount / (d.installments || 1));
    return sum + (d.amount - (instVal * (d.paidInstallments || 0)));
  }, 0);
  const totalLoanInstallment = loanDebtsOnly.reduce((sum, d) => sum + (d.installmentValue || d.amount), 0);
  const totalLoanRemaining = loanDebtsOnly.reduce((sum, d) => {
    const instVal = d.installmentValue || (d.amount / (d.installments || 1));
    return sum + (d.amount - (instVal * (d.paidInstallments || 0)));
  }, 0);

  const paidDebtsThisMonth = realTransactions.filter(t => {
    if (!t.fromDebt) return false;
    const tDate = new Date(t.date + 'T12:00:00');
    return tDate.getMonth() === month && tDate.getFullYear() === year;
  });
  const totalPaidDebts = paidDebtsThisMonth.reduce((sum, t) => sum + t.amount, 0);
  const totalMonthDeductions = generalSalaries.reduce((sum, s) => sum + (s.totalDeductions || 0), 0);

  // Totais isolados de VR e de VA
  const vrIncomeTotal = vrSalaries.reduce((sum, s) => sum + s.amount, 0) +
    vrTransactions.filter(t => t.type === 'entrada').reduce((sum, t) => sum + t.amount, 0);
  const vrExpenseTotal = vrTransactions.filter(t => t.type === 'saida').reduce((sum, t) => sum + t.amount, 0);
  const vrBalanceVal = vrBalanceInfo.closingBalance;

  const vaIncomeTotal = vaSalaries.reduce((sum, s) => sum + s.amount, 0) +
    vaTransactions.filter(t => t.type === 'entrada').reduce((sum, t) => sum + t.amount, 0);
  const vaExpenseTotal = vaTransactions.filter(t => t.type === 'saida').reduce((sum, t) => sum + t.amount, 0);
  const vaBalanceVal = vaBalanceInfo.closingBalance;

  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };

  let activeIncomeForMeter = totalIncome;
  let activeExpenseForMeter = totalExpenses;
  let activeBalanceForPulse = totalBalance;

  if (dashboardMode === 'vr' || dashboardMode === 'va') {
    const isVA = dashboardMode === 'va';
    const bLabel = isVA ? 'VA' : 'VR';
    const bTx = isVA ? vaTransactions : vrTransactions;
    const bSal = isVA ? vaSalaries : vrSalaries;
    const bIncome = isVA ? vaIncomeTotal : vrIncomeTotal;
    const bExpense = isVA ? vaExpenseTotal : vrExpenseTotal;
    const bBal = isVA ? vaBalanceVal : vrBalanceVal;
    const bInfo = isVA ? vaBalanceInfo : vrBalanceInfo;

    activeIncomeForMeter = bIncome;
    activeExpenseForMeter = bExpense;
    activeBalanceForPulse = bBal;

    document.getElementById('totalBalance').textContent = formatCurrency(bBal);
    document.getElementById('totalExpenses').textContent = formatCurrency(bExpense);
    el('totalIncomeDash', formatCurrency(bIncome));

    const summaryTitle = document.getElementById('benefitSummaryTitle');
    if (summaryTitle) {
      summaryTitle.innerHTML = `<i class="fa-solid fa-chart-simple"></i> Resumo ${bLabel}`;
    }
    el('benefitUsageLabel', `% do ${bLabel} usado`);

    const bExpenses = bTx.filter(t => t.type === 'saida');
    const bCount = bExpenses.length;
    const bAvg = bCount > 0 ? bExpense / bCount : 0;
    const bMax = bCount > 0 ? Math.max(...bExpenses.map(t => t.amount)) : 0;
    const bPct = bIncome > 0 ? Math.min(100, (bExpense / bIncome) * 100) : 0;

    el('vrPurchaseCount', String(bCount));
    el('vrAvgTicket', formatCurrency(bAvg));
    el('vrMaxExpense', formatCurrency(bMax));
    el('vrUsagePercent', `${bPct.toFixed(0)}%`);

    updateCarryInfo(bInfo);
    updateCharts(bTx, [], bSal, bInfo);
    updateRecentTransactions(bTx);

  } else {
    // === MODO GERAL (sem misturar VR nem VA) ===
    document.getElementById('totalExpenses').textContent = formatCurrency(totalExpenses);
    document.getElementById('totalBalance').textContent = formatCurrency(totalBalance);
    document.getElementById('totalSpent').textContent = formatCurrency(totalDebt);
    document.getElementById('totalResponsible').textContent = responsibleCount;

    el('dashMonthlyDebts', formatCurrency(totalMonthlyDebts));
    el('dashMonthlyCount', `${monthlyDebtsActive.length} ativa${monthlyDebtsActive.length !== 1 ? 's' : ''}`);
    el('dashFinancingDebts', formatCurrency(totalFinancingInstallment));
    el('dashFinancingRemaining', `Restante: ${formatCurrency(totalFinancingRemaining)}`);
    el('dashLoanDebts', formatCurrency(totalLoanInstallment));
    el('dashLoanRemaining', `Restante: ${formatCurrency(totalLoanRemaining)}`);
    el('totalPaidDebts', formatCurrency(totalPaidDebts));
    el('totalDeductionsDash', formatCurrency(totalMonthDeductions));
    el('totalIncomeDash', formatCurrency(totalIncome));

    // Mini cards separados de VR e VA (apenas no modo geral)
    el('vrIncome', formatCurrency(vrIncomeTotal));
    el('vrExpense', formatCurrency(vrExpenseTotal));
    el('vrBalance', formatCurrency(vrBalanceVal));
    const showVR = vrIncomeTotal > 0 || vrExpenseTotal > 0 || vrBalanceInfo.hasCheckpoint;
    const vrCard = document.getElementById('vrDashboardCard');
    if (vrCard) vrCard.style.display = showVR ? '' : 'none';

    el('vaIncome', formatCurrency(vaIncomeTotal));
    el('vaExpense', formatCurrency(vaExpenseTotal));
    el('vaBalance', formatCurrency(vaBalanceVal));
    const showVA = vaIncomeTotal > 0 || vaExpenseTotal > 0 || vaBalanceInfo.hasCheckpoint;
    const vaCard = document.getElementById('vaDashboardCard');
    if (vaCard) vaCard.style.display = showVA ? '' : 'none';

    const benefitsGrid = document.getElementById('benefitsDashboardGrid');
    if (benefitsGrid) benefitsGrid.style.display = (showVR || showVA) ? '' : 'none';

    updateCarryInfo(generalBalanceInfo);
    updateCharts(generalTransactions, monthDebts, generalSalaries, generalBalanceInfo);
    updateRecentTransactions(generalAllMonthTx);
  }

  // Medidor do hero + pulso inteligente + mês por extenso no cabeçalho
  updateBalanceMeter(activeIncomeForMeter, activeExpenseForMeter, dashboardMode);
  const activeInfoForPulse = dashboardMode === 'vr'
    ? vrBalanceInfo
    : dashboardMode === 'va'
      ? vaBalanceInfo
      : generalBalanceInfo;
  const activeTxForPulse = dashboardMode === 'vr'
    ? vrTransactions
    : dashboardMode === 'va'
      ? vaTransactions
      : generalTransactions;
  updatePulseStrip(activeInfoForPulse, activeTxForPulse, monthDebts, activeIncomeForMeter);

  const monthLabel = document.getElementById('dashMonthLabel');
  if (monthLabel) monthLabel.textContent = new Date(year, month, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  // Rótulo do saldo principal
  const balanceLabel = document.querySelector('.balance-label');
  if (balanceLabel) {
    if (dashboardMode === 'vr') balanceLabel.textContent = 'Saldo VR (Vale Refeição)';
    else if (dashboardMode === 'va') balanceLabel.textContent = 'Saldo VA (Vale Alimentação)';
    else balanceLabel.textContent = generalBalanceInfo.hasCheckpoint ? 'Saldo em conta' : 'Saldo líquido';
  }

  // Pulso dinâmico de saúde financeira
  const balanceCard = document.querySelector('.balance-card');
  if (balanceCard) {
    balanceCard.classList.remove('positive-pulse', 'negative-pulse');
    if (activeBalanceForPulse > 0) balanceCard.classList.add('positive-pulse');
    else if (activeBalanceForPulse < 0) balanceCard.classList.add('negative-pulse');
  }

  // Flash de atualização
  const balanceEl = document.getElementById('totalBalance');
  if (balanceEl) {
    balanceEl.classList.remove('value-updated');
    void balanceEl.offsetWidth;
    balanceEl.classList.add('value-updated');
  }
}

function updateCarryInfo(balanceInfo) {
  const carryEl = document.getElementById('balanceCarryInfo');
  if (!carryEl) return;
  if (!balanceInfo?.hasCheckpoint) {
    carryEl.hidden = true;
    carryEl.innerHTML = '';
    return;
  }
  const prevLabel = balanceInfo.intraMonthCheckpoint ? 'Saldo inicial' : 'Saldo anterior';
  const prevVal = balanceInfo.intraMonthCheckpoint
    ? getCheckpointValue(balanceInfo.intraMonthCheckpoint)
    : balanceInfo.carryOver;
  carryEl.innerHTML = `${prevLabel}: <strong>${formatCurrency(prevVal)}</strong> · No mês: <strong>${formatSignedCurrency(balanceInfo.monthNet)}</strong>`;
  carryEl.hidden = false;
}

function updatePulseStrip(balanceInfo, monthTxs, activeDebts, monthIncome) {
  const flowVal = document.getElementById('pulseFlowVal');
  const flowDot = document.getElementById('pulseFlowDot');
  if (flowVal && balanceInfo) {
    const net = round2(balanceInfo.monthNet || 0);
    flowVal.textContent = formatSignedCurrency(net);
    if (flowDot) {
      flowDot.className = 'dpc-dot ' + (net > 0.004 ? 'is-pos' : net < -0.004 ? 'is-neg' : 'is-neutral');
    }
  }

  const topCatVal = document.getElementById('pulseTopCatVal');
  const topCatIcon = document.getElementById('pulseTopCatIcon');
  if (topCatVal) {
    const catTotals = {};
    let totalOut = 0;
    (monthTxs || []).filter(t => t.type === 'saida').forEach(t => {
      catTotals[t.category] = (catTotals[t.category] || 0) + t.amount;
      totalOut += t.amount;
    });
    const sortedCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
    if (sortedCats.length > 0 && totalOut > 0) {
      const [topKey, topAmt] = sortedCats[0];
      const meta = CATEGORY_MAP[topKey] || { label: topKey, icon: '📁' };
      const pct = Math.round((topAmt / totalOut) * 100);
      topCatVal.textContent = `${meta.label} · ${pct}%`;
      if (topCatIcon) topCatIcon.textContent = meta.icon;
    } else {
      topCatVal.textContent = monthIncome > 0 ? 'Nenhum gasto' : 'Sem movimentos';
      if (topCatIcon) topCatIcon.innerHTML = '<i class="fa-solid fa-sparkles"></i>';
    }
  }

  const nextDebtLabel = document.getElementById('pulseNextDebtLabel');
  const nextDebtVal = document.getElementById('pulseNextDebtVal');
  const nextDebtChip = document.getElementById('pulseNextDebtChip');
  if (nextDebtVal) {
    const withDue = (activeDebts || []).filter(d => d.dueDate).slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    if (withDue.length > 0) {
      const todayIso = new Date().toISOString().slice(0, 10);
      const overdue = withDue.find(d => d.dueDate < todayIso);
      const target = overdue || withDue.find(d => d.dueDate >= todayIso) || withDue[0];
      const [, mm, dd] = target.dueDate.split('-');
      const amt = target.installmentValue || target.amount || 0;
      if (nextDebtLabel) nextDebtLabel.textContent = overdue ? 'Dívida em atraso' : `Vence ${dd}/${mm}`;
      nextDebtVal.textContent = `${target.creditor} · ${formatCurrency(amt)}`;
      nextDebtChip?.classList.toggle('is-alert', Boolean(overdue));
    } else {
      if (nextDebtLabel) nextDebtLabel.textContent = 'Compromissos';
      nextDebtVal.textContent = 'Tudo em dia';
      nextDebtChip?.classList.remove('is-alert');
    }
  }
}

function toggleChartEmpty(canvasEl, isEmpty, message = 'Sem dados neste período') {
  const wrap = canvasEl?.parentElement;
  if (!wrap) return;
  let emptyEl = wrap.querySelector('.chart-empty-placeholder');
  if (isEmpty) {
    canvasEl.style.display = 'none';
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.className = 'chart-empty-placeholder';
      wrap.appendChild(emptyEl);
    }
    emptyEl.innerHTML = `<i class="fa-regular fa-chart-bar"></i><span>${message}</span>`;
    emptyEl.hidden = false;
  } else {
    canvasEl.style.display = '';
    if (emptyEl) emptyEl.hidden = true;
  }
}

// ===== MEDIDOR DO HERO =====
function updateBalanceMeter(income, expense, mode) {
  const fill = document.getElementById('balanceMeterFill');
  const caption = document.getElementById('balanceMeterCaption');
  if (!fill || !caption) return;
  const pct = income > 0 ? (expense / income) * 100 : (expense > 0 ? 100 : 0);
  fill.style.setProperty('--meter', `${Math.min(100, pct)}%`);
  fill.classList.toggle('is-warn', pct >= 75 && pct < 100);
  fill.classList.toggle('is-danger', pct >= 100);
  const scopeLabel = mode === 'vr' ? 'do VR' : mode === 'va' ? 'do VA' : 'da receita';
  if (income <= 0 && expense <= 0) caption.textContent = 'Sem movimentações no mês';
  else if (income <= 0) caption.innerHTML = `<strong>${formatCurrency(expense)}</strong> em saídas, sem entrada registrada`;
  else caption.innerHTML = `<strong>${pct.toFixed(0)}%</strong> ${scopeLabel} já comprometido`;
}

// ===== TEMA DOS GRÁFICOS =====
function chartTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    text: v('--text-secondary'), muted: v('--text-muted'), grid: v('--border'), card: v('--bg-card'),
    palette: [v('--c-navy'), v('--c-gold'), v('--c-green'), v('--c-coral'), v('--c-sky'), v('--c-plum'), v('--c-amber'), v('--c-teal'), v('--c-slate'), '#F472B6', '#84CC16', '#A16207', '#6366F1'],
    income: v('--income'), expense: v('--expense')
  };
}

function applyChartDefaults(theme) {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = theme.text;
}

const isWide = () => window.matchMedia('(min-width: 640px)').matches;
const compactBRL = (n) => n >= 1000 ? `R$ ${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : `R$ ${n.toLocaleString('pt-BR')}`;

function legendOptions(position) {
  return { position, labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 12, font: { size: 11, weight: 500 } } };
}

function tooltipOptions(theme) {
  return {
    backgroundColor: '#0E1624', titleColor: '#F3F1EC', bodyColor: '#F3F1EC', padding: 10, cornerRadius: 10,
    titleFont: { weight: 600 }, bodyFont: { weight: 500 }, displayColors: true, boxPadding: 4, usePointStyle: true,
    borderColor: theme.grid, borderWidth: 0
  };
}

// ===== ATUALIZAR GRÁFICOS =====
export function updateCharts(transactions, debts, salaries = [], balanceInfo = null) {
  Object.values(state.charts).forEach(chart => { if (chart) chart.destroy(); });
  state.charts = {};
  const cleanTx = (transactions || []).filter(t => !t.isBalanceAdjustment);
  const theme = chartTheme();
  applyChartDefaults(theme);
  state.charts.sparkline = createBalanceSparkline(cleanTx, salaries, balanceInfo);
  state.charts.category = createCategoryChart(cleanTx, theme);
  state.charts.responsible = createResponsibleChart(cleanTx, theme);
  state.charts.debtType = createDebtTypeChart(debts, theme);
}

// ===== SPARKLINE =====
function createBalanceSparkline(transactions, salaries = [], balanceInfo = null) {
  const ctx = document.getElementById('monthlyChart');
  if (!ctx) return null;

  const { year, month } = getSelectedYearMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const dailyNet = Array(daysInMonth).fill(0);
  transactions.forEach(t => {
    const d = new Date(t.date + 'T12:00:00');
    if (d.getMonth() === month && d.getFullYear() === year) {
      dailyNet[d.getDate() - 1] += t.type === 'entrada' ? t.amount : -t.amount;
    }
  });
  salaries.forEach(s => {
    const d = new Date(s.date + 'T12:00:00');
    if (d.getMonth() === month && d.getFullYear() === year) dailyNet[d.getDate() - 1] += s.amount;
  });

  const intraCp = balanceInfo?.intraMonthCheckpoint;
  const intraDay = intraCp ? parseInt(intraCp.date.slice(8, 10), 10) : null;
  const intraBase = intraCp ? getCheckpointValue(intraCp) : 0;

  let cum = balanceInfo?.carryOver || 0;
  const cumData = dailyNet.map((v, idx) => {
    if (intraDay && idx + 1 === intraDay) cum = intraBase;
    cum = round2(cum + v);
    return cum;
  });
  const labels = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  if (!cumData.some(v => v !== 0) && !dailyNet.some(v => v !== 0)) { ctx.style.display = 'none'; return null; }
  ctx.style.display = '';

  const rgb = dashboardMode === 'vr'
    ? '110,231,183'
    : dashboardMode === 'va'
      ? '125,211,252'
      : '233,196,119';

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: cumData,
        borderColor: `rgb(${rgb})`,
        backgroundColor: (c) => {
          const { ctx: g, chartArea } = c.chart;
          if (!chartArea) return 'transparent';
          const grad = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          grad.addColorStop(0, `rgba(${rgb},0.32)`);
          grad.addColorStop(1, `rgba(${rgb},0)`);
          return grad;
        },
        tension: 0.35, fill: true, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5,
        pointHoverBackgroundColor: `rgb(${rgb})`, pointHoverBorderColor: '#0E1624', pointHoverBorderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#F3F1EC', titleColor: '#0E1624', bodyColor: '#0E1624', padding: 8, cornerRadius: 8, displayColors: false,
          callbacks: { title: (items) => `Dia ${items[0].label}`, label: (item) => formatCurrency(item.raw) }
        }
      },
      scales: { x: { display: false }, y: { display: false, grace: '8%' } },
      animation: { duration: 700, easing: 'easeOutQuart' }
    }
  });
}

// ===== GRÁFICO POR CATEGORIA =====
function createCategoryChart(transactions, theme) {
  const ctx = document.getElementById('categoryChart');
  if (!ctx) return null;
  const categories = {};
  transactions.filter(t => t.type === 'saida').forEach(t => { categories[t.category] = (categories[t.category] || 0) + t.amount; });
  if (Object.keys(categories).length === 0) {
    toggleChartEmpty(ctx, true, 'Nenhuma despesa registrada neste mês');
    return null;
  }
  toggleChartEmpty(ctx, false);
  let entries = Object.entries(categories).sort((a, b) => b[1] - a[1]);
  if (entries.length > 7) {
    const rest = entries.slice(6).reduce((sum, [, v]) => sum + v, 0);
    entries = [...entries.slice(0, 6), [null, rest]];
  }
  return new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([k]) => k === null ? 'Outras' : (CATEGORY_MAP[k]?.label || k)),
      datasets: [{ data: entries.map(([, v]) => v), backgroundColor: theme.palette, borderColor: theme.card, borderWidth: 3, hoverOffset: 6 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '68%',
      plugins: {
        legend: legendOptions(isWide() ? 'right' : 'bottom'),
        tooltip: { ...tooltipOptions(theme), callbacks: { label: (c) => ` ${c.label}: ${formatCurrency(c.raw)}` } }
      },
      animation: { duration: 700 }
    }
  });
}

// ===== GRÁFICO POR RESPONSÁVEL =====
function createResponsibleChart(transactions, theme) {
  const ctx = document.getElementById('responsibleChart');
  if (!ctx) return null;
  const responsible = {};
  transactions.forEach(t => {
    if (!responsible[t.responsible]) responsible[t.responsible] = { entrada: 0, saida: 0 };
    responsible[t.responsible][t.type] += t.amount;
  });
  if (Object.keys(responsible).length === 0) {
    toggleChartEmpty(ctx, true, 'Sem movimentações por responsável');
    return null;
  }
  toggleChartEmpty(ctx, false);
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(responsible),
      datasets: [
        { label: 'Receitas', data: Object.values(responsible).map(r => r.entrada), backgroundColor: theme.income, borderRadius: 6, borderSkipped: false, barPercentage: 0.7, categoryPercentage: 0.6 },
        { label: 'Despesas', data: Object.values(responsible).map(r => r.saida), backgroundColor: theme.expense, borderRadius: 6, borderSkipped: false, barPercentage: 0.7, categoryPercentage: 0.6 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: legendOptions('bottom'),
        tooltip: { ...tooltipOptions(theme), callbacks: { label: (c) => ` ${c.dataset.label}: ${formatCurrency(c.raw)}` } }
      },
      scales: {
        y: { beginAtZero: true, border: { display: false }, grid: { color: theme.grid }, ticks: { color: theme.muted, maxTicksLimit: 5, callback: (v) => compactBRL(v) } },
        x: { border: { display: false }, grid: { display: false }, ticks: { color: theme.text, font: { weight: 600 } } }
      },
      animation: { duration: 700 }
    }
  });
}

// ===== GRÁFICO POR TIPO DE DÍVIDA =====
function createDebtTypeChart(debts, theme) {
  const ctx = document.getElementById('debtTypeChart');
  if (!ctx) return null;
  const css = getComputedStyle(document.documentElement);
  const c = (name) => css.getPropertyValue(name).trim();
  const typeMap = {
    unica: { label: 'Únicas', color: c('--c-slate') }, fixa: { label: 'Fixas', color: c('--c-amber') },
    cartao: { label: 'Cartão', color: c('--c-plum') }, emprestimo: { label: 'Empréstimos', color: c('--c-coral') },
    financiamento: { label: 'Financiamento', color: c('--c-navy') }, parcelada: { label: 'Financiamento', color: c('--c-navy') }
  };
  const totals = {};
  debts.forEach(d => {
    const key = (d.debtType === 'parcelada') ? 'financiamento' : (d.debtType || 'unica');
    const val = (key === 'financiamento' || key === 'emprestimo' || (key === 'cartao' && d.cartaoMode === 'parcelado')) ? (d.installmentValue || d.amount) : d.amount;
    totals[key] = (totals[key] || 0) + val;
  });
  const keys = Object.keys(totals);
  if (keys.length === 0) {
    toggleChartEmpty(ctx, true, 'Nenhuma dívida ativa cadastrada');
    return null;
  }
  toggleChartEmpty(ctx, false);
  return new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: keys.map(k => typeMap[k]?.label || k),
      datasets: [{ data: keys.map(k => totals[k]), backgroundColor: keys.map(k => typeMap[k]?.color || '#9CA3AF'), borderColor: theme.card, borderWidth: 3, hoverOffset: 6 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: legendOptions(isWide() ? 'right' : 'bottom'),
        tooltip: { ...tooltipOptions(theme), callbacks: { label: function(ctx) { const total = ctx.dataset.data.reduce((a, b) => a + b, 0); const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0; return ` ${ctx.label}: ${formatCurrency(ctx.raw)} (${pct}%)`; } } }
      },
      cutout: '68%', animation: { duration: 700 }
    }
  });
}
