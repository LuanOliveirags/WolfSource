// ============================================================
// TRANSACTIONS.JS — Controller de UI de transações
// Responsabilidade: DOM, eventos e orquestração.
// Lógica de dados → packages/services/transactions/transactions.service.js
// ============================================================

import { CATEGORY_MAP } from '../../../../../packages/services/firebase/firebase.config.js';
import { state, getFamilyId } from '../../../../../packages/core/state/store.js';
import { esc, formatCurrency, formatDate, showAlert, emptyState, toDateStr } from '../../../../../packages/utils/helpers.js';
import { saveDataToStorage, saveToFirebase, deleteFromFirebase } from '../../../../../packages/services/firebase/firebase.service.js';
import { updateDashboard } from '../dashboard/dashboard.js';
import {
  buildTransactionObject,
  filterTransactions,
  groupByDate,
  matchSalaryDeposits
} from '../../../../../packages/services/transactions/transactions.service.js';

// ===== ADICIONAR TRANSAÇÃO =====
export function addTransaction(e) {
  e.preventDefault();
  const familyId = getFamilyId();
  if (!familyId) { showAlert('Erro: família não identificada.', 'danger'); return; }

  const transaction = buildTransactionObject({
    type:          document.getElementById('transType').value,
    amount:        parseFloat(document.getElementById('tranAmount').value),
    category:      document.getElementById('tranCategory').value,
    responsible:   document.getElementById('tranResponsible').value,
    date:          document.getElementById('tranDate').value,
    description:   document.getElementById('tranDescription').value,
    paymentMethod: document.getElementById('tranPaymentMethod')?.value || 'dinheiro',
    familyId
  });

  if (!transaction.type || !transaction.amount || !transaction.category || !transaction.responsible) {
    alert('Preencha todos os campos obrigatórios!');
    return;
  }

  state.transactions.push(transaction);
  saveDataToStorage();
  saveToFirebase('transactions', transaction);
  showAlert('Transação registrada!', 'success');

  e.target.reset();
  document.getElementById('tranDate').value = toDateStr(new Date());
  document.getElementById('transType').value = 'saida';
  document.querySelectorAll('.type-toggle-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('btnSaida')?.classList.add('active');

  document.getElementById('tranPaymentMethod').value = 'dinheiro';
  document.querySelectorAll('#tranPaymentMethods .shop-pay-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('#tranPaymentMethods .shop-pay-btn[data-method="dinheiro"]')?.classList.add('active');

  updateDashboard();
  updateTransactionHistory();
}

// ===== DELETAR TRANSAÇÃO =====
export function deleteTransaction(id) {
  if (!confirm('Deseja deletar esta transação?')) return;
  state.transactions = state.transactions.filter(t => t.id !== id);
  saveDataToStorage();
  deleteFromFirebase('transactions', id);
  updateDashboard();
  updateTransactionHistory();
  showAlert('Transação deletada!', 'success');
}

// ===== RENDER ITEM =====
export function renderTransactionItem(t, { selectable = false, selected = false, salaryLinked = false } = {}) {
  const cat      = CATEGORY_MAP[t.category] || { icon: '📁', label: t.category, css: 'cat-outros' };
  const isIn     = t.type === 'entrada';
  const iconCss  = isIn ? 'cat-entrada' : cat.css;
  const icon     = isIn ? '💰' : cat.icon;
  const sign     = isIn ? '+' : '−';
  const amtClass = isIn ? 'entrada' : 'saida';
  const catLabel = isIn ? 'Receita' : cat.label;
  const isVR     = t.paymentMethod === 'vr';
  const isVA     = t.paymentMethod === 'va';
  const payBadge = isVR ? ' <span class="vr-badge">VR</span>' : isVA ? ' <span class="va-badge">VA</span>' : '';
  const salBadge = salaryLinked ? ' <span class="vr-badge" title="Já contabilizado pelo seu holerite na aba Salário (não duplica o saldo)">Conciliado ao Salário</span>' : '';
  const wrapCss  = isVR ? 'cat-vr' : isVA ? 'cat-va' : iconCss;
  const wrapIcon = isVR ? '🍽️' : isVA ? '🛒' : icon;

  const check = selectable
    ? `<input type="checkbox" class="trans-check" aria-label="Selecionar" ${selected ? 'checked' : ''}>`
    : '';
  return `
    <div class="transaction-item${selectable ? ' is-selectable' : ''}${selected ? ' is-selected' : ''}" data-id="${esc(t.id)}">
      ${check}
      <div class="trans-icon-wrap ${wrapCss}">${wrapIcon}</div>
      <div class="trans-info">
        <div class="trans-name">${esc(t.description) || catLabel}${payBadge}${salBadge}</div>
        <div class="trans-meta">
          <span>${formatDate(t.date)}</span>
          <span>·</span>
          <span class="trans-cat-badge ${iconCss}">${catLabel}</span>
          <span>·</span>
          <span>${esc(t.responsible)}</span>
        </div>
      </div>
      <div class="trans-actions">
        <div class="trans-amount ${amtClass}">${sign}${formatCurrency(t.amount)}</div>
        <button onclick="deleteTransaction('${t.id}')" class="btn-delete" title="Excluir">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>`;
}

// ===== TRANSAÇÕES RECENTES (Dashboard) =====
export function updateRecentTransactions(transactions) {
  const container = document.getElementById('recentTransactionsList');
  if (!container) return;
  const visible = (transactions || []).filter(t => !t.isBalanceAdjustment);
  if (visible.length === 0) { container.innerHTML = emptyState('Nenhuma transação este mês'); return; }
  const { matchedTxIds } = matchSalaryDeposits(state.transactions, state.salaries);
  const sorted = visible.slice().sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '')
  );
  container.innerHTML = sorted.slice(0, 5).map(t => renderTransactionItem(t, { salaryLinked: matchedTxIds.has(t.id) })).join('');
}

// ===== HISTÓRICO DE TRANSAÇÕES =====
// Seleção em massa: modo seleção, ids marcados e filtro de período
const bulk = { active: false, ids: new Set(), from: '', to: '' };
let visibleTransactions = [];

function getVisibleTransactions() {
  const typeFilter = document.getElementById('historyFilter')?.value || 'all';
  if (bulk.active && (bulk.from || bulk.to)) {
    const from = bulk.from || '0000-00-00';
    const to = bulk.to || '9999-99-99';
    return filterTransactions(state.transactions, { typeFilter })
      .filter(t => t.date >= from && t.date <= to);
  }
  return filterTransactions(state.transactions, {
    monthVal: document.getElementById('historyMonth')?.value,
    selectedDay: state.selectedDay,
    typeFilter
  });
}

export function updateTransactionHistory() {
  const container = document.getElementById('transactionHistoryList');
  if (!container) return;

  const filtered = getVisibleTransactions();
  visibleTransactions = filtered;
  // Só fica selecionado o que está na tela: o que for excluído é sempre visível
  const visibleIds = new Set(filtered.map(t => t.id));
  bulk.ids.forEach(id => { if (!visibleIds.has(id)) bulk.ids.delete(id); });

  if (filtered.length === 0) {
    const msg = bulk.active && (bulk.from || bulk.to) ? 'Nenhuma transação neste período'
      : state.selectedDay ? 'Nenhuma transação neste dia' : 'Nenhuma transação encontrada';
    container.innerHTML = emptyState(msg);
    updateBulkBar();
    return;
  }

  const { matchedTxIds } = matchSalaryDeposits(state.transactions, state.salaries);
  const groups = groupByDate(filtered);
  container.innerHTML = groups.map(({ date, items, dayTotal }) => {
    const totalColor = dayTotal >= 0 ? 'var(--income-dark)' : 'var(--expense)';
    const allDay = bulk.active && items.every(t => bulk.ids.has(t.id));
    const dayCheck = bulk.active
      ? `<input type="checkbox" class="trans-day-check" data-date="${date}" aria-label="Selecionar o dia inteiro" ${allDay ? 'checked' : ''}>`
      : '';
    return `
      <div class="transaction-day-group">
        <div class="trans-day-header">
          <label class="trans-day-label">${dayCheck}${formatDate(date)}</label>
          <span class="trans-day-total" style="color:${totalColor}">${dayTotal >= 0 ? '+' : ''}${formatCurrency(dayTotal)}</span>
        </div>
        ${items.map(t => renderTransactionItem(t, { selectable: bulk.active, selected: bulk.ids.has(t.id), salaryLinked: matchedTxIds.has(t.id) })).join('')}
      </div>`;
  }).join('');
  updateBulkBar();
}

// ===== SELEÇÃO EM MASSA =====
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const $id = (id) => document.getElementById(id);

function updateBulkBar() {
  const bar = $id('txBulkBar');
  if (!bar) return;
  bar.hidden = !bulk.active;
  $id('txSelectToggle')?.classList.toggle('active', bulk.active);
  if (!bulk.active) return;

  const n = bulk.ids.size;
  const total = visibleTransactions.length;
  const all = $id('txSelectAll');
  all.checked = total > 0 && n === total;
  all.indeterminate = n > 0 && n < total;
  all.disabled = total === 0;
  $id('txSelectAllLabel').textContent = `Selecionar todas (${total})`;
  $id('txBulkCount').textContent = n ? plural(n, 'selecionada', 'selecionadas') : 'Nenhuma selecionada';
  $id('txBulkDelete').disabled = n === 0;
  $id('txBulkDeleteLabel').textContent = n ? `Excluir ${n}` : 'Excluir';
  $id('txPeriodClear').hidden = !(bulk.from || bulk.to);
}

function clearPeriodInputs() {
  bulk.from = bulk.to = '';
  $id('txPeriodFrom').value = '';
  $id('txPeriodTo').value = '';
}

function setBulkMode(on) {
  const hadPeriod = !!(bulk.from || bulk.to);
  bulk.active = on;
  bulk.ids.clear();
  if (!on && hadPeriod) {
    clearPeriodInputs();
    window.selectWeekDay?.(null); // volta para "Tudo" (e redesenha)
    return;
  }
  updateTransactionHistory();
}

function onPeriodChange() {
  bulk.from = $id('txPeriodFrom').value;
  bulk.to = $id('txPeriodTo').value;
  if (bulk.from && bulk.to && bulk.from > bulk.to) {
    [bulk.from, bulk.to] = [bulk.to, bulk.from];
    $id('txPeriodFrom').value = bulk.from;
    $id('txPeriodTo').value = bulk.to;
  }
  if (bulk.from || bulk.to) {
    // O período substitui o filtro de dia: nenhum chip da semana fica ativo
    state.selectedDay = null;
    document.querySelectorAll('.week-day-btn').forEach(b => b.classList.remove('active'));
    // Ao escolher um período, já seleciona tudo dele
    bulk.ids = new Set(getVisibleTransactions().map(t => t.id));
    updateTransactionHistory();
  } else {
    bulk.ids.clear();
    window.selectWeekDay?.(null);
  }
}

function toggleIds(ids, on) {
  ids.forEach(id => (on ? bulk.ids.add(id) : bulk.ids.delete(id)));
  updateTransactionHistory();
}

async function deleteSelected() {
  const ids = [...bulk.ids];
  if (!ids.length) return;
  const chosen = state.transactions.filter(t => bulk.ids.has(t.id));
  const income = chosen.filter(t => t.type === 'entrada').reduce((s, t) => s + t.amount, 0);
  const expense = chosen.filter(t => t.type !== 'entrada').reduce((s, t) => s + t.amount, 0);
  const detail = [income ? `entradas ${formatCurrency(income)}` : '', expense ? `saídas ${formatCurrency(expense)}` : '']
    .filter(Boolean).join(' · ');
  if (!confirm(`Excluir ${plural(ids.length, 'transação', 'transações')}?${detail ? `\n(${detail})` : ''}\n\nIsso não pode ser desfeito.`)) return;

  const btn = $id('txBulkDelete');
  btn.disabled = true;
  $id('txBulkDeleteLabel').textContent = 'Excluindo…';

  const idSet = new Set(ids);
  state.transactions = state.transactions.filter(t => !idSet.has(t.id));
  saveDataToStorage();
  await Promise.allSettled(ids.map(id => deleteFromFirebase('transactions', id)));

  updateDashboard();
  setBulkMode(false);
  showAlert(`${plural(ids.length, 'transação excluída', 'transações excluídas')}!`, 'success');
}

export function setupBulkSelect() {
  const list = $id('transactionHistoryList');
  if (!list || !$id('txBulkBar')) return;

  $id('txSelectToggle').addEventListener('click', () => setBulkMode(!bulk.active));
  $id('txBulkCancel').addEventListener('click', () => setBulkMode(false));
  $id('txBulkDelete').addEventListener('click', deleteSelected);
  $id('txSelectAll').addEventListener('change', (e) => {
    bulk.ids = e.target.checked ? new Set(visibleTransactions.map(t => t.id)) : new Set();
    updateTransactionHistory();
  });
  $id('txPeriodFrom').addEventListener('change', onPeriodChange);
  $id('txPeriodTo').addEventListener('change', onPeriodChange);
  $id('txPeriodClear').addEventListener('click', () => { clearPeriodInputs(); onPeriodChange(); });

  // Tocar na linha marca/desmarca; o checkbox do dia marca o dia inteiro
  list.addEventListener('click', (e) => {
    if (!bulk.active) return;
    const dayCheck = e.target.closest('.trans-day-check');
    if (dayCheck) {
      const ids = visibleTransactions.filter(t => t.date === dayCheck.dataset.date).map(t => t.id);
      toggleIds(ids, dayCheck.checked);
      return;
    }
    const item = e.target.closest('.transaction-item.is-selectable');
    if (!item) return;
    e.preventDefault(); // evita o clique duplo do checkbox dentro da linha
    const id = item.dataset.id;
    toggleIds([id], !bulk.ids.has(id));
  });

  // Escolher um dia na semana descarta o período
  $id('weekScroller')?.addEventListener('click', () => {
    if (bulk.from || bulk.to) clearPeriodInputs();
  }, true);
}

// Globals para inline handlers
window.deleteTransaction = deleteTransaction;
