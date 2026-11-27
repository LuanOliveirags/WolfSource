// ============================================================
// SHOPPING.JS — Controller de UI da Lista de Compras
// Responsabilidade: DOM, eventos e orquestração.
// Lógica de dados e catálogos → packages/services/shopping/shopping.service.js
// ============================================================

import { state, getFamilyId } from '../../../../../packages/core/state/store.js';
import { esc, formatCurrency, showAlert } from '../../../../../packages/utils/helpers.js';
import { saveDataToStorage, saveToFirebase, deleteFromFirebase } from '../../../../../packages/services/firebase/firebase.service.js';
import { updateDashboard } from '../dashboard/dashboard.js';
import { updateTransactionHistory } from '../transactions/transactions.js';
import {
  STORES,
  SHOPPING_CATEGORIES,
  MONTHS_PT_FULL,
  normalizeItemName,
  buildQuickCatalog,
  loadLists,
  saveLists,
  createList,
  createListFromTemplate,
  togglePrincipal,
  addItem,
  toggleItem,
  removeItem,
  editItem,
  buildCheckoutTransaction,
  finalizeList
} from '../../../../../packages/services/shopping/shopping.service.js';

// ===== ESTADO DO CONTROLLER =====
let shoppingLists = [];
let activeListId = null;
let shoppingView = 'lists'; // 'lists' | 'detail'
let editingItemId = null;
let quickAddCollapsed = localStorage.getItem('shop_quick_collapsed') === 'true';
let quickFilter = localStorage.getItem('shop_quick_filter') || 'all'; // 'all' | 'user' | 'store' | 'default'
let quickSearchQuery = '';
let _panelOpen = false;
let _usePrincipalCandidates = [];
let _selectedTargetMonth = 0;
let _customTargetNameTouched = false;

const MONTHS_SHORT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// ===== ABERTURA / FECHAMENTO =====
export function openShoppingPanel() {
  _panelOpen = true;
  shoppingLists = loadLists();
  shoppingView = 'lists';
  activeListId = null;
  renderShoppingView();
}

export function closeShoppingPanel() {
  _panelOpen = false;
  shoppingView = 'lists';
  activeListId = null;
  editingItemId = null;
}

// Chamado pelo refresh callback do Firebase para sincronizar em tempo real
export function refreshShoppingIfOpen() {
  if (!_panelOpen) return;
  shoppingLists = loadLists();
  renderShoppingView();
}

// ===== PERSISTÊNCIA =====
function persistLists(changed = null) {
  saveLists(shoppingLists);
  saveDataToStorage();
  if (Array.isArray(changed)) {
    changed.forEach(l => saveToFirebase('shoppingLists', l));
  } else if (changed) {
    saveToFirebase('shoppingLists', changed);
  }
}

// ===== RENDER PRINCIPAL =====
function renderShoppingView() {
  const listsView = document.getElementById('shoppingListsView');
  const detailView = document.getElementById('shoppingDetailView');
  if (shoppingView === 'lists') {
    listsView.style.display = '';
    detailView.style.display = 'none';
    renderShoppingLists();
  } else {
    listsView.style.display = 'none';
    detailView.style.display = '';
    renderListDetail();
  }
}

// ===== LISTAS =====
function renderShoppingLists() {
  const body = document.getElementById('shoppingListsBody');
  if (!body) return;

  const principals = shoppingLists.filter(l => l.isPrincipal);
  const topBtn = document.getElementById('shopUsePrincipalsTopBtn');
  if (topBtn) topBtn.style.display = principals.length > 0 ? '' : 'none';

  const active = shoppingLists.filter(l => l.status === 'active');
  const completed = shoppingLists
    .filter(l => l.status === 'completed')
    .sort((a, b) => new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt));

  if (active.length === 0 && completed.length === 0) {
    body.innerHTML = `
      <div class="shop-empty">
        <div class="shop-empty-icon"><i class="fa-solid fa-cart-shopping"></i></div>
        <h3>Nenhuma lista ainda</h3>
        <p>Onde vamos fazer compras hoje?</p>
        <div class="shop-store-picker-inline">
          ${Object.entries(STORES).map(([key, s]) => `
            <button class="shop-store-pick" data-store="${key}">
              ${s.img
                ? `<img src="${s.img}" alt="${esc(s.name)}" class="shop-store-logo-pick">`
                : `<div class="shop-store-icon-pick"><i class="fa-solid fa-store"></i></div>`}
              <span>${esc(s.name)}</span>
            </button>`).join('')}
        </div>
      </div>`;
    body.querySelectorAll('.shop-store-pick').forEach(btn =>
      btn.addEventListener('click', () => openNewListModal(btn.dataset.store))
    );
    return;
  }

  let html = '';

  if (principals.length > 0) {
    html += `
      <div class="shop-principals-panel">
        <div class="shop-principals-head">
          <div class="shop-principals-title-wrap">
            <span class="shop-principals-title">
              <i class="fa-solid fa-star"></i> Listas principais (${principals.length})
            </span>
            <span class="shop-principals-sub">Modelos salvos para reutilizar em qualquer mês</span>
          </div>
          <button type="button" class="shop-principals-use-btn" id="shopOpenUseMonthBtn">
            <i class="fa-regular fa-calendar-plus"></i> Usar em outro mês
          </button>
        </div>
        <div class="shop-principals-chips">
          ${principals.map(p => {
            const store = STORES[p.store] || STORES.outro;
            const est = p.items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 1), 0);
            const icon = store.img
              ? `<img src="${store.img}" alt="${esc(store.name)}">`
              : '<i class="fa-solid fa-store"></i>';
            return `
              <button type="button" class="shop-principal-pill" data-id="${esc(p.id)}" title="Abrir lista principal">
                ${icon}
                <span><strong>${esc(store.name)}</strong> · ${esc(p.name)}</span>
                <span class="shop-principal-pill-meta">${p.items.length} iten${p.items.length === 1 ? '' : 's'}${est > 0 ? ` · ${formatCurrency(est)}` : ''}</span>
              </button>`;
          }).join('')}
        </div>
      </div>`;
  }

  if (active.length > 0) {
    html += '<p class="shop-section-label">Listas ativas</p>';
    html += active.map(list => renderListCard(list)).join('');
  }
  if (completed.length > 0) {
    html += '<p class="shop-section-label">Concluídas</p>';
    html += completed.slice(0, 10).map(list => renderListCard(list)).join('');
  }

  body.innerHTML = html;

  document.getElementById('shopOpenUseMonthBtn')?.addEventListener('click', () => openUsePrincipalModal());

  body.querySelectorAll('.shop-principal-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      activeListId = pill.dataset.id;
      shoppingView = 'detail';
      renderShoppingView();
    });
  });

  body.querySelectorAll('.shop-list-card').forEach(card => {
    card.addEventListener('click', () => {
      activeListId = card.dataset.id;
      shoppingView = 'detail';
      renderShoppingView();
    });
  });

  body.querySelectorAll('.shop-card-principal-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleTogglePrincipal(btn.dataset.id);
    });
  });

  body.querySelectorAll('.shop-card-reuse').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openUsePrincipalModal(btn.dataset.id);
    });
  });
}

function renderListCard(list) {
  const total = list.items.length;
  const checked = list.items.filter(i => i.checked).length;
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
  const isCompleted = list.status === 'completed';
  const isPrincipal = Boolean(list.isPrincipal);
  const date = new Date(list.createdAt);
  const dateStr = date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  const store = STORES[list.store] || STORES.outro;

  const categories = [...new Set(list.items.map(i => i.category))];
  const catIcons = categories.slice(0, 4).map(cat => {
    const c = SHOPPING_CATEGORIES[cat] || SHOPPING_CATEGORIES.outros;
    return `<span class="shop-card-cat" style="background:${c.color}20;color:${c.color}"><i class="fa-solid ${c.icon}"></i></span>`;
  }).join('');

  const estimatedTotal = list.items.reduce((sum, i) => sum + (i.price || 0) * (i.quantity || 1), 0);
  const displayTotal = isCompleted && list.totalSpent ? list.totalSpent : estimatedTotal;

  const storeBadge = store.img
    ? `<img src="${store.img}" alt="${esc(store.name)}" class="shop-card-store-logo">`
    : `<span class="shop-card-store-icon"><i class="fa-solid fa-store"></i></span>`;

  return `
    <div class="shop-list-card ${isCompleted ? 'completed' : ''} ${isPrincipal ? 'is-principal' : ''}" data-id="${list.id}">
      <div class="shop-card-top">
        <div class="shop-card-store-badge">${storeBadge}</div>
        <div class="shop-card-info">
          <h4 class="shop-card-name">${esc(list.name)}</h4>
          <div class="shop-card-meta">
            <span class="shop-card-date"><i class="fa-regular fa-calendar"></i> ${dateStr}</span>
            <span class="shop-card-count"><i class="fa-solid fa-basket-shopping"></i> ${checked}/${total}</span>
            ${displayTotal > 0 ? `<span class="shop-card-price">${isCompleted ? '<i class="fa-solid fa-receipt"></i> ' : ''}${formatCurrency(displayTotal)}</span>` : ''}
          </div>
        </div>
        <div class="shop-card-progress-ring">
          <svg viewBox="0 0 36 36">
            <circle class="shop-ring-bg" cx="18" cy="18" r="15.5"/>
            <circle class="shop-ring-fill" cx="18" cy="18" r="15.5" style="stroke-dashoffset:${97.4 - (pct / 100) * 97.4};stroke:${isCompleted ? 'var(--success)' : 'var(--primary)'}"/>
          </svg>
          <span class="shop-ring-text">${pct}%</span>
        </div>
      </div>
      <div class="shop-card-bottom">
        <div class="shop-card-cats">${catIcons}</div>
        <div class="shop-card-actions">
          <button type="button" class="shop-card-principal-btn ${isPrincipal ? 'active' : ''}" data-id="${list.id}" title="${isPrincipal ? 'Remover das listas principais' : 'Salvar como lista principal para outros meses'}">
            <i class="fa-${isPrincipal ? 'solid' : 'regular'} fa-star"></i> ${isPrincipal ? 'Principal' : 'Principal'}
          </button>
          ${(isCompleted || isPrincipal) ? `<button type="button" class="shop-card-reuse" data-id="${list.id}" title="Usar esta lista em outro mês"><i class="fa-regular fa-calendar-plus"></i> Usar no mês</button>` : ''}
        </div>
      </div>
    </div>`;
}

// ===== FAVORITAR / DEFINIR LISTA PRINCIPAL =====
function handleTogglePrincipal(listId) {
  const list = shoppingLists.find(l => l.id === listId);
  if (!list) return;
  const nowPrincipal = togglePrincipal(list);
  persistLists(list);
  renderShoppingView();
  showAlert(
    nowPrincipal
      ? `"${list.name}" salva como lista principal! Agora você pode usá-la nos outros meses.`
      : `"${list.name}" removida das listas principais.`,
    nowPrincipal ? 'success' : 'info'
  );
}

// ===== USAR LISTA(S) PRINCIPAL(IS) EM OUTRO MÊS =====
function suggestNextAvailableMonthIndex() {
  const activeNames = new Set(
    shoppingLists
      .filter(l => l.status === 'active')
      .map(l => normalizeItemName(l.name))
  );
  const start = (new Date().getMonth() + 1) % 12;
  for (let offset = 0; offset < 12; offset++) {
    const idx = (start + offset) % 12;
    const monthLower = normalizeItemName(MONTHS_PT_FULL[idx]);
    if (!activeNames.has(monthLower)) return idx;
  }
  return start;
}

function getPrincipalForStore(storeKey) {
  if (!storeKey) return null;
  return shoppingLists.find(l => l.isPrincipal && l.store === storeKey && l.items?.length > 0) || null;
}

function updateNewListPrincipalOption(storeKey) {
  const wrap = document.getElementById('shopNewListFromPrincipalWrap');
  const check = document.getElementById('shopNewListFromPrincipal');
  const text = document.getElementById('shopNewListFromPrincipalText');
  if (!wrap || !check || !text) return;

  const principal = getPrincipalForStore(storeKey);
  if (principal) {
    const storeName = STORES[storeKey]?.name || 'mercado';
    const est = principal.items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 1), 0);
    text.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Puxar ${principal.items.length} iten${principal.items.length === 1 ? '' : 's'} da principal de ${esc(storeName)}${est > 0 ? ` (${formatCurrency(est)})` : ''}`;
    check.checked = true;
    wrap.style.display = '';
  } else {
    check.checked = false;
    wrap.style.display = 'none';
  }
}

function openUsePrincipalModal(singleListId = null) {
  const modal = document.getElementById('shoppingUsePrincipalModal');
  if (!modal) return;

  const principals = shoppingLists.filter(l => l.isPrincipal);
  const single = singleListId ? shoppingLists.find(l => l.id === singleListId) : null;

  if (single && !principals.some(p => p.id === single.id)) {
    _usePrincipalCandidates = [single, ...principals];
  } else {
    _usePrincipalCandidates = principals.length ? principals : (single ? [single] : []);
  }

  if (_usePrincipalCandidates.length === 0) {
    showAlert('Marque pelo menos uma lista com a estrela "Principal" primeiro.', 'info');
    return;
  }

  _selectedTargetMonth = suggestNextAvailableMonthIndex();
  _customTargetNameTouched = false;

  const nameInput = document.getElementById('shopPrincipalTargetName');
  if (nameInput) nameInput.value = MONTHS_PT_FULL[_selectedTargetMonth];

  renderUsePrincipalMonthChips();

  const checklist = document.getElementById('shopPrincipalChecklist');
  if (checklist) {
    checklist.innerHTML = _usePrincipalCandidates.map(c => {
      const store = STORES[c.store] || STORES.outro;
      const est = c.items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 1), 0);
      const checked = singleListId ? c.id === singleListId : true;
      const logo = store.img
        ? `<img src="${store.img}" alt="${esc(store.name)}">`
        : '<i class="fa-solid fa-store"></i>';
      return `
        <label class="shop-principal-check-item">
          <input type="checkbox" class="shop-principal-source-check" value="${esc(c.id)}" ${checked ? 'checked' : ''}>
          ${logo}
          <div class="shop-principal-check-info">
            <span class="shop-principal-check-title">${esc(store.name)} — ${esc(c.name)}</span>
            <span class="shop-principal-check-meta">${c.items.length} iten${c.items.length === 1 ? '' : 's'}${est > 0 ? ` · Estimado ${formatCurrency(est)}` : ''}</span>
          </div>
        </label>`;
    }).join('');

    checklist.querySelectorAll('.shop-principal-source-check').forEach(ch => {
      ch.addEventListener('change', updateUsePrincipalConfirmBtn);
    });
  }

  updateUsePrincipalConfirmBtn();
  modal.classList.add('active');
}

function renderUsePrincipalMonthChips() {
  const wrap = document.getElementById('shopPrincipalMonthChips');
  if (!wrap) return;
  wrap.innerHTML = MONTHS_SHORT.map((m, idx) => `
    <button type="button" class="shop-month-chip ${idx === _selectedTargetMonth ? 'active' : ''}" data-month="${idx}">${m}</button>
  `).join('');

  wrap.querySelectorAll('.shop-month-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      _selectedTargetMonth = parseInt(btn.dataset.month, 10);
      wrap.querySelectorAll('.shop-month-chip').forEach(b => b.classList.toggle('active', b === btn));
      const nameInput = document.getElementById('shopPrincipalTargetName');
      if (nameInput && !_customTargetNameTouched) {
        nameInput.value = MONTHS_PT_FULL[_selectedTargetMonth];
      }
      updateUsePrincipalConfirmBtn();
    });
  });
}

function updateUsePrincipalConfirmBtn() {
  const btn = document.getElementById('shopConfirmUsePrincipalBtn');
  if (!btn) return;
  const checkedIds = [...document.querySelectorAll('#shopPrincipalChecklist .shop-principal-source-check:checked')];
  const count = checkedIds.length;
  const targetName = document.getElementById('shopPrincipalTargetName')?.value.trim() || MONTHS_PT_FULL[_selectedTargetMonth];
  btn.disabled = count === 0;
  btn.innerHTML = count > 1
    ? `<i class="fa-solid fa-copy"></i> Criar ${count} listas para ${esc(targetName)}`
    : `<i class="fa-solid fa-copy"></i> Criar lista para ${esc(targetName)}`;
}

function confirmUsePrincipal() {
  const checkedEls = [...document.querySelectorAll('#shopPrincipalChecklist .shop-principal-source-check:checked')];
  if (!checkedEls.length) {
    showAlert('Selecione pelo menos uma lista.', 'warning');
    return;
  }
  const targetName = document.getElementById('shopPrincipalTargetName')?.value.trim() || MONTHS_PT_FULL[_selectedTargetMonth];
  const created = [];

  // Percorre de trás para frente ao usar unshift para manter a ordem original dos mercados
  for (let i = checkedEls.length - 1; i >= 0; i--) {
    const src = shoppingLists.find(l => l.id === checkedEls[i].value);
    if (!src) continue;
    const copy = createListFromTemplate(src, targetName);
    shoppingLists.unshift(copy);
    created.unshift(copy);
  }

  if (!created.length) return;
  persistLists(created);

  document.getElementById('shoppingUsePrincipalModal')?.classList.remove('active');

  if (created.length === 1) {
    activeListId = created[0].id;
    shoppingView = 'detail';
  } else {
    activeListId = null;
    shoppingView = 'lists';
  }
  renderShoppingView();
  showAlert(
    created.length === 1
      ? `Lista "${targetName}" criada com ${created[0].items.length} itens!`
      : `${created.length} listas criadas para ${targetName}!`,
    'success'
  );
}

// ===== CRIAÇÃO DE LISTA =====
function openNewListModal(preselectedStore) {
  const modal = document.getElementById('shoppingNewListModal');
  const input = document.getElementById('shoppingNewListName');
  if (!modal || !input) return;

  input.value = '';
  const principalCheck = document.getElementById('shoppingNewListPrincipal');
  if (principalCheck) principalCheck.checked = false;

  const storeGrid = document.getElementById('shopStoreSelector');
  if (storeGrid) {
    storeGrid.innerHTML = Object.entries(STORES).map(([key, s]) => `
      <button type="button" class="shop-store-option ${key === (preselectedStore || '') ? 'active' : ''}" data-store="${key}">
        ${s.img
          ? `<img src="${s.img}" alt="${esc(s.name)}" class="shop-store-opt-img">`
          : `<div class="shop-store-opt-icon"><i class="fa-solid fa-store"></i></div>`}
        <span class="shop-store-opt-name">${esc(s.name)}</span>
      </button>
    `).join('');
    storeGrid.querySelectorAll('.shop-store-option').forEach(btn => {
      btn.addEventListener('click', () => {
        storeGrid.querySelectorAll('.shop-store-option').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateNewListPrincipalOption(btn.dataset.store);
      });
    });
  }

  if (preselectedStore && STORES[preselectedStore]) {
    const today = new Date();
    input.value = `${MONTHS_PT_FULL[today.getMonth()]}`;
  }
  updateNewListPrincipalOption(preselectedStore || null);

  modal.classList.add('active');
  setTimeout(() => input.focus(), 200);
}

function confirmNewList() {
  const input = document.getElementById('shoppingNewListName');
  const name = input?.value.trim();
  if (!name) { showAlert('Digite um nome para a lista.', 'warning'); return; }

  const selectedStore = document.querySelector('#shopStoreSelector .shop-store-option.active');
  const storeKey = selectedStore?.dataset.store || 'outro';
  const isPrincipal = Boolean(document.getElementById('shoppingNewListPrincipal')?.checked);
  const pullFromPrincipal = Boolean(document.getElementById('shopNewListFromPrincipal')?.checked);
  const principalSource = pullFromPrincipal ? getPrincipalForStore(storeKey) : null;

  const newList = createList(name, storeKey, {
    isPrincipal,
    templateItems: principalSource ? principalSource.items : null
  });
  shoppingLists.unshift(newList);
  persistLists(newList);

  document.getElementById('shoppingNewListModal').classList.remove('active');
  activeListId = newList.id;
  shoppingView = 'detail';
  renderShoppingView();
  showAlert(
    principalSource
      ? `Lista criada com ${newList.items.length} itens da lista principal!`
      : 'Lista criada!',
    'success'
  );
}

// ===== DETALHE DA LISTA =====
function getActiveList() {
  return shoppingLists.find(l => l.id === activeListId);
}

function getAvailableQuickItems(list) {
  const existingKeys = new Set((list?.items || []).map(i => normalizeItemName(i.name)));
  const catalog = buildQuickCatalog(shoppingLists, list?.store || null);
  return catalog.filter(item => !existingKeys.has(normalizeItemName(item.name)));
}

function filterQuickSuggestions(available, list) {
  let base = available;
  if (quickFilter === 'user') base = available.filter(i => i.fromUser);
  else if (quickFilter === 'store') base = available.filter(i => i.fromUser && i.sameStore);
  else if (quickFilter === 'default') base = available.filter(i => !i.fromUser);

  // Fallback automático se o filtro salvo estiver vazio para esta lista
  if (base.length === 0 && quickFilter !== 'all') {
    base = available;
  }

  const q = normalizeItemName(quickSearchQuery);
  if (q) {
    base = base.filter(i => normalizeItemName(i.name).includes(q));
  }
  return base;
}

function renderQuickChipHtml(s) {
  const cat = SHOPPING_CATEGORIES[s.category] || SHOPPING_CATEGORIES.outros;
  let sub = '';
  if (s.fromUser) {
    const qtyPart = (s.quantity && s.quantity !== 1) || (s.unit && s.unit !== 'un')
      ? `${s.quantity || 1} ${s.unit || 'un'}`
      : '';
    const totalEst = s.price ? s.price * (s.quantity || 1) : null;
    const parts = [qtyPart, totalEst ? formatCurrency(totalEst) : ''].filter(Boolean);
    if (parts.length) sub = `<span class="shop-quick-chip-sub">· ${esc(parts.join(' · '))}</span>`;
  }
  return `<button type="button" class="shop-quick-chip ${s.fromUser ? 'is-user-item' : ''}" data-name="${esc(s.name)}" data-cat="${esc(s.category)}" data-unit="${esc(s.unit)}" data-qty="${s.quantity || 1}" data-price="${s.price ?? ''}">
    <i class="fa-solid ${cat.icon}" style="color:${cat.color}"></i>
    <span>${esc(s.name)}</span>${sub}
  </button>`;
}

function bindQuickChipClicks(container) {
  if (!container) return;
  container.querySelectorAll('.shop-quick-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.add('adding');
      const qty = parseFloat(chip.dataset.qty) || 1;
      const price = chip.dataset.price !== '' ? parseFloat(chip.dataset.price) : null;
      setTimeout(() => handleAddItem(chip.dataset.name, chip.dataset.cat, chip.dataset.unit, { quantity: qty, price }), 120);
    });
  });
}

function renderListDetail() {
  const list = getActiveList();
  if (!list) { shoppingView = 'lists'; renderShoppingView(); return; }

  const titleEl = document.getElementById('shoppingDetailTitle');
  if (titleEl) titleEl.textContent = list.name;

  const principalBtn = document.getElementById('shoppingPrincipalBtn');
  if (principalBtn) {
    const isP = Boolean(list.isPrincipal);
    principalBtn.classList.toggle('active', isP);
    principalBtn.title = isP ? 'Remover das listas principais' : 'Salvar como lista principal para outros meses';
    principalBtn.innerHTML = `<i class="fa-${isP ? 'solid' : 'regular'} fa-star"></i>`;
  }

  const store = STORES[list.store] || STORES.outro;
  const storeHeader = document.getElementById('shoppingDetailStoreBar');
  if (storeHeader) {
    storeHeader.style.display = 'flex';
    const leftHtml = store.img
      ? `<div class="shop-detail-store-left"><img src="${store.img}" alt="${esc(store.name)}" class="shop-detail-store-logo"><span class="shop-detail-store-name">${esc(store.label)}</span></div>`
      : `<div class="shop-detail-store-left"><i class="fa-solid fa-store shop-detail-store-icon"></i><span class="shop-detail-store-name">${esc(store.label)}</span></div>`;
    const badgeHtml = list.isPrincipal
      ? `<span class="shop-detail-principal-tag"><i class="fa-solid fa-star"></i> Lista principal</span>`
      : '';
    storeHeader.innerHTML = `${leftHtml}${badgeHtml}`;
    storeHeader.style.setProperty('--store-accent', store.color);
  }

  const body = document.getElementById('shoppingDetailBody');
  if (!body) return;

  const total = list.items.length;
  const checked = list.items.filter(i => i.checked).length;
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
  const estimatedTotal = list.items.reduce((sum, i) => sum + (i.price || 0) * (i.quantity || 1), 0);
  const isCompleted = list.status === 'completed';

  let html = `
    <div class="shop-detail-stats">
      <div class="shop-progress-bar-wrap">
        <div class="shop-progress-bar">
          <div class="shop-progress-fill ${pct === 100 ? 'complete' : ''}" style="width:${pct}%"></div>
        </div>
        <span class="shop-progress-label">${checked}/${total}</span>
      </div>
      <div class="shop-stats-row">
        <div class="shop-stat">
          <div class="shop-stat-icon" style="background:rgba(var(--primary-rgb),0.12)"><i class="fa-solid fa-list" style="color:var(--primary)"></i></div>
          <span class="shop-stat-val">${total}</span>
          <span class="shop-stat-label">Total</span>
        </div>
        <div class="shop-stat">
          <div class="shop-stat-icon" style="background:rgba(6,214,160,0.12)"><i class="fa-solid fa-check" style="color:var(--success)"></i></div>
          <span class="shop-stat-val shop-stat-success">${checked}</span>
          <span class="shop-stat-label">Pegos</span>
        </div>
        <div class="shop-stat">
          <div class="shop-stat-icon" style="background:rgba(248,150,30,0.12)"><i class="fa-solid fa-clock" style="color:var(--warning)"></i></div>
          <span class="shop-stat-val shop-stat-warning">${total - checked}</span>
          <span class="shop-stat-label">Faltam</span>
        </div>
        <div class="shop-stat">
          <div class="shop-stat-icon" style="background:rgba(var(--primary-rgb),0.12)"><i class="fa-solid fa-tag" style="color:var(--primary)"></i></div>
          <span class="shop-stat-val shop-stat-price">${estimatedTotal > 0 ? formatCurrency(estimatedTotal) : '—'}</span>
          <span class="shop-stat-label">Estimado</span>
        </div>
      </div>
    </div>`;

  if (!isCompleted) {
    const available = getAvailableQuickItems(list);
    const userCount = available.filter(i => i.fromUser).length;
    const storeCount = available.filter(i => i.fromUser && i.sameStore).length;
    const defaultCount = available.filter(i => !i.fromUser).length;

    // Garante que o filtro ativo tenha itens (senão volta para 'all')
    if (
      (quickFilter === 'user' && userCount === 0) ||
      (quickFilter === 'store' && storeCount === 0) ||
      (quickFilter === 'default' && defaultCount === 0)
    ) {
      quickFilter = 'all';
    }

    const suggestions = filterQuickSuggestions(available, list);

    if (available.length > 0) {
      const showFilters = userCount > 0;
      html += `<div class="shop-quick-wrap">
        <button type="button" class="shop-quick-toggle" id="shopQuickToggle">
          <div class="shop-quick-toggle-left">
            <i class="fa-solid fa-bolt"></i>
            <span>Adicionar rápido</span>
            <span class="shop-quick-badge" id="shopQuickCountBadge">${suggestions.length}</span>
          </div>
          <i class="fa-solid fa-chevron-down shop-quick-chevron ${quickAddCollapsed ? '' : 'open'}"></i>
        </button>
        ${showFilters ? `
        <div class="shop-quick-toolbar ${quickAddCollapsed ? 'collapsed' : ''}" id="shopQuickToolbar">
          <div class="shop-quick-filters">
            <button type="button" class="shop-quick-filter-btn ${quickFilter === 'all' ? 'active' : ''}" data-qfilter="all">Todos (${available.length})</button>
            <button type="button" class="shop-quick-filter-btn ${quickFilter === 'user' ? 'active' : ''}" data-qfilter="user"><i class="fa-solid fa-store"></i> Cadastrados (${userCount})</button>
            ${storeCount > 0 && list.store && list.store !== 'outro' ? `<button type="button" class="shop-quick-filter-btn ${quickFilter === 'store' ? 'active' : ''}" data-qfilter="store">${esc(store.name)} (${storeCount})</button>` : ''}
            ${defaultCount > 0 ? `<button type="button" class="shop-quick-filter-btn ${quickFilter === 'default' ? 'active' : ''}" data-qfilter="default">Básicos (${defaultCount})</button>` : ''}
          </div>
          <input type="search" class="shop-quick-search" id="shopQuickSearch" placeholder="Filtrar rápido..." value="${esc(quickSearchQuery)}" autocomplete="off">
        </div>` : ''}
        <div class="shop-quick-chips ${quickAddCollapsed ? 'collapsed' : ''}" id="shopQuickChips">${suggestions.map(renderQuickChipHtml).join('')}</div>
      </div>`;
    }
  }

  const grouped = {};
  list.items.forEach(item => {
    const cat = item.category || 'outros';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  });

  const catOrder = Object.keys(grouped).sort((a, b) => {
    const aAllChecked = grouped[a].every(i => i.checked);
    const bAllChecked = grouped[b].every(i => i.checked);
    if (aAllChecked !== bAllChecked) return aAllChecked ? 1 : -1;
    return (SHOPPING_CATEGORIES[a]?.label || a).localeCompare(SHOPPING_CATEGORIES[b]?.label || b);
  });

  if (catOrder.length > 0) {
    html += '<div class="shop-items-groups">';
    catOrder.forEach(cat => {
      const catInfo = SHOPPING_CATEGORIES[cat] || SHOPPING_CATEGORIES.outros;
      const items = grouped[cat];
      const catChecked = items.filter(i => i.checked).length;
      const allDone = catChecked === items.length;

      html += `
        <div class="shop-category-group ${allDone ? 'all-done' : ''}">
          <div class="shop-cat-header">
            <div class="shop-cat-left">
              <span class="shop-cat-icon" style="background:${catInfo.color}20;color:${catInfo.color}">
                <i class="fa-solid ${catInfo.icon}"></i>
              </span>
              <span class="shop-cat-name">${catInfo.label}</span>
            </div>
            <span class="shop-cat-count">${catChecked}/${items.length}</span>
          </div>
          <ul class="shop-items-list">
            ${items.map(item => renderShopItem(item, isCompleted)).join('')}
          </ul>
        </div>`;
    });
    html += '</div>';
  } else {
    html += `<div class="shop-empty-items">
      <i class="fa-solid fa-basket-shopping"></i>
      <p>Lista vazia — adicione itens acima ou abaixo!</p>
    </div>`;
  }

  if (!isCompleted && total > 0) {
    html += `<div class="shop-complete-wrap">
      <button class="shop-complete-btn" id="shopCompleteListBtn">
        <i class="fa-solid fa-check-double"></i> Finalizar Compras
      </button>
    </div>`;
  }

  body.innerHTML = html;

  const addBar = document.getElementById('shoppingAddBar');
  if (addBar) addBar.style.display = isCompleted ? 'none' : '';

  document.getElementById('shopQuickToggle')?.addEventListener('click', () => {
    quickAddCollapsed = !quickAddCollapsed;
    localStorage.setItem('shop_quick_collapsed', quickAddCollapsed);
    document.getElementById('shopQuickChips')?.classList.toggle('collapsed', quickAddCollapsed);
    document.getElementById('shopQuickToolbar')?.classList.toggle('collapsed', quickAddCollapsed);
    document.querySelector('.shop-quick-chevron')?.classList.toggle('open', !quickAddCollapsed);
  });

  body.querySelectorAll('.shop-quick-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      quickFilter = btn.dataset.qfilter || 'all';
      localStorage.setItem('shop_quick_filter', quickFilter);
      renderListDetail();
    });
  });

  const quickSearchInput = document.getElementById('shopQuickSearch');
  if (quickSearchInput) {
    quickSearchInput.addEventListener('input', () => {
      quickSearchQuery = quickSearchInput.value;
      const available = getAvailableQuickItems(list);
      const filtered = filterQuickSuggestions(available, list);
      const chipsEl = document.getElementById('shopQuickChips');
      const badgeEl = document.getElementById('shopQuickCountBadge');
      if (badgeEl) badgeEl.textContent = String(filtered.length);
      if (chipsEl) {
        chipsEl.innerHTML = filtered.map(renderQuickChipHtml).join('');
        bindQuickChipClicks(chipsEl);
      }
    });
  }

  bindQuickChipClicks(document.getElementById('shopQuickChips'));

  body.querySelectorAll('.shop-item').forEach(el => {
    const itemId = el.dataset.id;
    el.querySelector('.shop-item-check')?.addEventListener('click', (e) => {
      e.stopPropagation();
      handleToggleItem(itemId);
    });
    el.querySelector('.shop-item-delete')?.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteItem(itemId);
    });
    el.addEventListener('click', () => {
      if (!isCompleted) openEditItemModal(itemId);
    });
  });

  document.getElementById('shopCompleteListBtn')?.addEventListener('click', openCheckoutModal);
}

function renderShopItem(item, isCompleted) {
  const cat = SHOPPING_CATEGORIES[item.category] || SHOPPING_CATEGORIES.outros;
  const qty = item.quantity || 1;
  const unitLabel = item.unit || 'un';
  const totalPrice = item.price ? item.price * qty : null;

  return `
    <li class="shop-item ${item.checked ? 'checked' : ''}" data-id="${item.id}">
      <button class="shop-item-check" ${isCompleted ? 'disabled' : ''}>
        <i class="fa-solid ${item.checked ? 'fa-circle-check' : 'fa-circle'}"></i>
      </button>
      <span class="shop-item-dot" style="background:${cat.color}"></span>
      <div class="shop-item-info">
        <span class="shop-item-name">${esc(item.name)}</span>
        <span class="shop-item-meta">
          <span class="shop-item-qty">${qty} ${unitLabel}</span>
          ${totalPrice ? `<span class="shop-item-sep">·</span><span class="shop-item-price">${formatCurrency(totalPrice)}</span>` : ''}
        </span>
      </div>
      ${!isCompleted ? `<button class="shop-item-delete" title="Remover"><i class="fa-solid fa-trash-can"></i></button>` : ''}
    </li>`;
}

// ===== AUTOCOMPLETE (registrado uma única vez) =====
function setupAutocomplete() {
  const input = document.getElementById('shoppingItemInput');
  if (!input) return;

  input.addEventListener('input', () => {
    const val = normalizeItemName(input.value);
    const dropdown = document.getElementById('shoppingAutocomplete');
    if (!dropdown) return;

    if (val.length < 2) { dropdown.classList.remove('active'); return; }

    const list = getActiveList();
    const available = getAvailableQuickItems(list);
    const matches = available
      .filter(q => normalizeItemName(q.name).includes(val))
      .slice(0, 6);

    if (matches.length === 0) { dropdown.classList.remove('active'); return; }

    dropdown.innerHTML = matches.map(m => {
      const cat = SHOPPING_CATEGORIES[m.category] || SHOPPING_CATEGORIES.outros;
      const totalEst = m.price ? m.price * (m.quantity || 1) : null;
      const detail = m.fromUser
        ? [ `${m.quantity || 1} ${m.unit || 'un'}`, totalEst ? formatCurrency(totalEst) : '' ].filter(Boolean).join(' · ')
        : cat.label;
      return `<button type="button" class="shop-ac-item" data-name="${esc(m.name)}" data-cat="${esc(m.category)}" data-unit="${esc(m.unit)}" data-qty="${m.quantity || 1}" data-price="${m.price ?? ''}">
        <i class="fa-solid ${cat.icon}" style="color:${cat.color}"></i>
        <span>${esc(m.name)}</span>
        <span class="shop-ac-cat">${esc(detail)}</span>
      </button>`;
    }).join('');
    dropdown.classList.add('active');

    dropdown.querySelectorAll('.shop-ac-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const qty = parseFloat(btn.dataset.qty) || 1;
        const price = btn.dataset.price !== '' ? parseFloat(btn.dataset.price) : null;
        handleAddItem(btn.dataset.name, btn.dataset.cat, btn.dataset.unit, { quantity: qty, price });
        input.value = '';
        dropdown.classList.remove('active');
      });
    });
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitManualItemInput();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.shopping-add-bar')) {
      document.getElementById('shoppingAutocomplete')?.classList.remove('active');
    }
  });
}

function submitManualItemInput() {
  const input = document.getElementById('shoppingItemInput');
  const val = input?.value.trim();
  if (!val) return;
  const list = getActiveList();
  const catalog = buildQuickCatalog(shoppingLists, list?.store || null);
  const match = catalog.find(q => normalizeItemName(q.name) === normalizeItemName(val));
  handleAddItem(
    match?.name || val,
    match?.category || 'outros',
    match?.unit || 'un',
    match ? { quantity: match.quantity, price: match.price } : {}
  );
  input.value = '';
  document.getElementById('shoppingAutocomplete')?.classList.remove('active');
}

// ===== HANDLERS DE ITEM =====
function handleAddItem(name, category, unit, extra = {}) {
  const list = getActiveList();
  if (!list) return;
  addItem(list, name, category, unit, extra);
  persistLists(list);
  renderListDetail();
}

function handleToggleItem(itemId) {
  const list = getActiveList();
  if (!list) return;
  toggleItem(list, itemId);
  persistLists(list);
  renderListDetail();
}

function handleDeleteItem(itemId) {
  const list = getActiveList();
  if (!list) return;
  removeItem(list, itemId);
  persistLists(list);
  renderListDetail();
}

function handleDeleteList() {
  const list = getActiveList();
  if (!list) return;
  if (!confirm(`Excluir a lista "${list.name}"?`)) return;
  shoppingLists = shoppingLists.filter(l => l.id !== list.id);
  saveLists(shoppingLists);
  saveDataToStorage();
  deleteFromFirebase('shoppingLists', list.id);
  showAlert('Lista excluída.', 'info');
  shoppingView = 'lists';
  renderShoppingView();
}

// ===== CHECKOUT =====
function openCheckoutModal() {
  const list = getActiveList();
  if (!list) return;

  const total = list.items.length;
  const checked = list.items.filter(i => i.checked).length;
  const estimatedTotal = list.items.reduce((sum, i) => sum + (i.price || 0) * (i.quantity || 1), 0);
  const store = STORES[list.store] || STORES.outro;

  const storeBrand = store.img
    ? `<div class="shop-checkout-store"><img src="${store.img}" alt="${esc(store.name)}" class="shop-checkout-store-logo"><span>${esc(store.label)}</span></div>`
    : `<div class="shop-checkout-store"><i class="fa-solid fa-store"></i><span>${esc(store.label)}</span></div>`;

  const summaryEl = document.getElementById('shopCheckoutSummary');
  if (summaryEl) {
    summaryEl.innerHTML = `
      ${storeBrand}
      <div class="shop-checkout-info">
        <div class="shop-checkout-info-row">
          <span><i class="fa-solid fa-basket-shopping"></i> ${esc(list.name)}</span>
          <span class="shop-checkout-items">${checked}/${total} pegos</span>
        </div>
        ${estimatedTotal > 0 ? `<div class="shop-checkout-info-row">
          <span>Estimado</span>
          <span class="shop-checkout-estimated">${formatCurrency(estimatedTotal)}</span>
        </div>` : ''}
      </div>`;
  }

  const totalInput = document.getElementById('shopCheckoutTotal');
  if (totalInput) totalInput.value = estimatedTotal > 0 ? estimatedTotal.toFixed(2) : '';

  const descInput = document.getElementById('shopCheckoutDesc');
  if (descInput) descInput.value = list.name;

  const responsibleSelect = document.getElementById('shopCheckoutResponsible');
  if (responsibleSelect) {
    const members = state.familyMembers || [];
    const currentUser = state.currentUser;
    if (members.length > 0) {
      responsibleSelect.innerHTML = members.map(m =>
        `<option value="${esc(m.name || m.login)}" ${m.login === currentUser?.login ? 'selected' : ''}>${esc(m.name || m.login)}</option>`
      ).join('');
    } else if (currentUser) {
      responsibleSelect.innerHTML = `<option value="${esc(currentUser.fullName || currentUser.login)}" selected>${esc(currentUser.fullName || currentUser.login)}</option>`;
    }
  }

  document.getElementById('shopPaymentMethod').value = 'dinheiro';
  document.querySelectorAll('#shopPaymentMethods .shop-pay-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('#shopPaymentMethods .shop-pay-btn[data-method="dinheiro"]')?.classList.add('active');
  const vrHint = document.getElementById('shopPayVrHint');
  if (vrHint) vrHint.style.display = 'none';
  const regToggle = document.getElementById('shopCheckoutRegister');
  if (regToggle) {
    regToggle.checked = true;
    const toggleWrap = regToggle.closest('.shop-checkout-toggle');
    if (toggleWrap) toggleWrap.style.display = '';
  }

  document.getElementById('shoppingCheckoutModal').classList.add('active');
}

function confirmCheckout() {
  const list = getActiveList();
  if (!list) return;

  const registerAsExpense = document.getElementById('shopCheckoutRegister')?.checked;
  const totalValue = parseFloat(document.getElementById('shopCheckoutTotal')?.value);

  if (registerAsExpense && totalValue > 0) {
    const familyId = getFamilyId();
    if (!familyId) { showAlert('Erro: família não identificada.', 'danger'); return; }

    const transaction = buildCheckoutTransaction({
      list,
      totalValue,
      responsible: document.getElementById('shopCheckoutResponsible')?.value,
      category: document.getElementById('shopCheckoutCategory')?.value || 'alimentacao',
      description: document.getElementById('shopCheckoutDesc')?.value?.trim() || list.name,
      paymentMethod: document.getElementById('shopPaymentMethod')?.value || 'dinheiro',
      familyId
    });

    state.transactions.push(transaction);
    saveDataToStorage();
    saveToFirebase('transactions', transaction);
    updateDashboard();
    updateTransactionHistory();
  }

  finalizeList(list, totalValue || 0);
  persistLists(list);

  document.getElementById('shoppingCheckoutModal').classList.remove('active');
  showAlert(
    registerAsExpense && totalValue > 0
      ? `Compras finalizadas! Despesa de ${formatCurrency(totalValue)} registrada.`
      : 'Compras finalizadas!',
    'success'
  );
  shoppingView = 'lists';
  renderShoppingView();
}

// ===== EDITAR ITEM =====
function openEditItemModal(itemId) {
  const list = getActiveList();
  if (!list) return;
  const item = list.items.find(i => i.id === itemId);
  if (!item) return;

  editingItemId = itemId;
  document.getElementById('editShopItemName').value = item.name;
  document.getElementById('editShopItemQty').value = item.quantity || 1;
  document.getElementById('editShopItemUnit').value = item.unit || 'un';
  document.getElementById('editShopItemPrice').value = item.price || '';
  document.getElementById('editShopItemCategory').value = item.category || 'outros';
  document.getElementById('shoppingEditItemModal').classList.add('active');
}

function saveEditItem() {
  const list = getActiveList();
  if (!list || !editingItemId) return;

  const price = parseFloat(document.getElementById('editShopItemPrice').value);
  editItem(list, editingItemId, {
    name: document.getElementById('editShopItemName').value.trim() || undefined,
    quantity: parseFloat(document.getElementById('editShopItemQty').value) || 1,
    unit: document.getElementById('editShopItemUnit').value || 'un',
    price: isNaN(price) ? null : price,
    category: document.getElementById('editShopItemCategory').value || 'outros'
  });

  persistLists(list);
  editingItemId = null;
  document.getElementById('shoppingEditItemModal').classList.remove('active');
  renderListDetail();
}

// ===== SETUP DE EVENTOS =====
export function setupShoppingListeners() {
  document.getElementById('shoppingBackBtn')?.addEventListener('click', () => {
    quickSearchQuery = '';
    shoppingView = 'lists';
    renderShoppingView();
  });

  document.getElementById('shopNewListBtn')?.addEventListener('click', () => openNewListModal());
  document.getElementById('shopUsePrincipalsTopBtn')?.addEventListener('click', () => openUsePrincipalModal());

  document.getElementById('shoppingPrincipalBtn')?.addEventListener('click', () => {
    if (activeListId) handleTogglePrincipal(activeListId);
  });
  document.getElementById('shoppingUseInMonthBtn')?.addEventListener('click', () => {
    if (activeListId) openUsePrincipalModal(activeListId);
  });

  document.getElementById('shopConfirmNewListBtn')?.addEventListener('click', confirmNewList);
  document.getElementById('shoppingNewListName')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmNewList(); }
  });

  document.getElementById('shopPrincipalTargetName')?.addEventListener('input', (e) => {
    const typed = e.target.value.trim();
    _customTargetNameTouched = Boolean(typed && !MONTHS_PT_FULL.some(m => normalizeItemName(m) === normalizeItemName(typed)));
    updateUsePrincipalConfirmBtn();
  });
  document.getElementById('shopConfirmUsePrincipalBtn')?.addEventListener('click', confirmUsePrincipal);

  document.getElementById('shoppingDeleteListBtn')?.addEventListener('click', handleDeleteList);

  document.getElementById('shoppingAddItemBtn')?.addEventListener('click', submitManualItemInput);

  document.getElementById('editShopItemForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    saveEditItem();
  });

  document.getElementById('shopCheckoutForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    confirmCheckout();
  });

  document.querySelectorAll('#shopPaymentMethods .shop-pay-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#shopPaymentMethods .shop-pay-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const method = btn.dataset.method;
      document.getElementById('shopPaymentMethod').value = method;
      const hint = document.getElementById('shopPayVrHint');
      if (hint) hint.style.display = method === 'vr' ? '' : 'none';
      const regToggle = document.getElementById('shopCheckoutRegister');
      if (regToggle) {
        const toggleWrap = regToggle.closest('.shop-checkout-toggle');
        if (toggleWrap) toggleWrap.style.display = method === 'vr' ? 'none' : '';
        if (method === 'vr') regToggle.checked = true;
      }
    });
  });

  document.querySelectorAll('#shoppingPanel .modal .close, #shoppingPanel .modal .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      this.closest('.modal').classList.remove('active');
    });
  });

  document.querySelectorAll('#shoppingPanel .modal').forEach(modal => {
    modal.addEventListener('click', function (e) {
      if (e.target === this) this.classList.remove('active');
    });
  });

  setupAutocomplete();
  setupSwipeBack();
}

// ===== SWIPE BACK (MOBILE) =====
function setupSwipeBack() {
  const panel = document.getElementById('shoppingPanel');
  if (!panel) return;

  let startX = 0, startY = 0, tracking = false;
  const THRESHOLD = 80;

  panel.addEventListener('touchstart', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (panel.querySelector('.modal.active')) return;
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    tracking = true;
  }, { passive: true });

  panel.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    if (Math.abs(dy) > Math.abs(dx)) { tracking = false; }
  }, { passive: true });

  panel.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    if (dx > THRESHOLD && shoppingView === 'detail') {
      quickSearchQuery = '';
      shoppingView = 'lists';
      renderShoppingView();
    }
  }, { passive: true });

  panel.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
}
