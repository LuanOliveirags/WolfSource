// ============================================================
// FIREBASE.SERVICE.JS — Orquestração: sync, storage, listeners
//
// Responsabilidade: sincronização Firebase ↔ localStorage,
// listeners realtime, refresh callback e ações de UI (export/import).
//
// Módulos filhos (use-os diretamente em código novo):
//   firebase.init.js  → db, storage, firebaseReady, initFirebase
//   firebase.crud.js  → saveToFirebase, deleteFromFirebase, updateInFirebase
//
// Re-exporta tudo dos módulos filhos para manter compatibilidade
// com os 15+ arquivos que já importam daqui.
// ============================================================

import { db, firebaseReady } from './firebase.init.js';
import { state, getFamilyId, getFamilyStorageKey } from '../../core/state/store.js';
import { showAlert, formatCurrency } from '../../utils/helpers.js';
import {
  saveToFirebase as _saveToFirebase,
  deleteFromFirebase as _deleteFromFirebase,
  getPendingWrites, clearPending, SYNCED_COLLECTIONS
} from './firebase.crud.js';

// ===== RE-EXPORTS (backward compat — não remover) =====
export { db, storage, auth, firebaseReady, initFirebase } from './firebase.init.js';
export { saveToFirebase, deleteFromFirebase, updateInFirebase } from './firebase.crud.js';

// ===== ESTADO INTERNO =====
let _fbSyncTimer    = null;
let _fbListeners    = [];
let _loadingData    = false;
let _listenersActive = false;
let _allowRefresh   = false;
let _lastFetchTime  = 0;
let _reloadQueued   = false;

// ===== ARMAZENAMENTO LOCAL =====
export function saveDataToStorage() {
  const key = getFamilyStorageKey();
  if (!key) { console.warn('Sem familyId — dados não serão salvos no localStorage.'); return; }
  localStorage.setItem(key, JSON.stringify({
    transactions:  state.transactions,
    debts:         state.debts,
    salaries:      state.salaries,
    shoppingLists: state.shoppingLists,
    lastSaved:     new Date().toISOString()
  }));
}

export function loadDataFromStorage() {
  state.transactions  = [];
  state.debts         = [];
  state.salaries      = [];
  state.shoppingLists = [];

  const key = getFamilyStorageKey();
  if (!key) { _notifyRefresh(); return Promise.resolve(); }

  const raw = localStorage.getItem(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      state.transactions  = parsed.transactions  || [];
      state.debts         = parsed.debts         || [];
      state.salaries      = parsed.salaries      || [];
      // Migração: lê do storage antigo (shopping_lists_{fid}) se ainda não consolidado
      if (parsed.shoppingLists) {
        state.shoppingLists = parsed.shoppingLists;
      } else {
        const fid = getFamilyId();
        const oldRaw = fid ? localStorage.getItem(`shopping_lists_${fid}`) : null;
        try { state.shoppingLists = oldRaw ? JSON.parse(oldRaw) : []; }
        catch { state.shoppingLists = []; }
      }
    } catch (e) {
      console.error('Erro ao carregar dados locais:', e);
    }
  }

  _notifyRefresh();

  return new Promise(resolve => {
    if (firebaseReady && !_loadingData && !_listenersActive) {
      _loadingData = true;
      loadDataFromFirebase()
        .then(() => { _loadingData = false; _listenersActive = true; listenFirebaseChanges(); resolve(); })
        .catch(err => { _loadingData = false; console.error('Erro ao carregar do Firebase:', err); resolve(); });
    } else {
      resolve();
    }
  });
}

// ===== PENDÊNCIAS =====
// Reenvia o que não chegou ao servidor (gravações e exclusões feitas sem conexão/login).
async function flushPendingWrites() {
  const pending = getPendingWrites();
  for (const [key, op] of Object.entries(pending)) {
    const slash = key.indexOf('/');
    const col = key.slice(0, slash);
    const id = key.slice(slash + 1);
    if (op === 'delete') {
      await _deleteFromFirebase(col, id);
    } else {
      const item = (state[col] || []).find(x => x.id === id);
      if (item) await _saveToFirebase(col, item);
      else clearPending(col, id);
    }
  }
}

// Reconciliação única por aparelho: lançamentos que só existem aqui (de antes
// da fila de pendências) sobem para o servidor em vez de serem descartados.
const reconcileKey = (fid) => `wolfsource_reconciled_${fid}`;

// ===== CARREGAR DO FIREBASE =====
export async function loadDataFromFirebase() {
  if (!firebaseReady) return;
  const familyId = getFamilyId();
  if (!familyId) { console.warn('Sem familyId — dados do Firebase não serão carregados.'); return; }
  try {
    await flushPendingWrites();

    const remote = {};
    for (const col of SYNCED_COLLECTIONS) {
      const snap = await db.collection(col).where('familyId', '==', familyId).get();
      remote[col] = snap.docs.map(d => d.data());
    }

    // Mescla: servidor é a fonte da verdade, mas o que ainda está pendente neste
    // aparelho é preservado (senão seria apagado ao recarregar).
    const pending = getPendingWrites();
    const reconcile = !localStorage.getItem(reconcileKey(familyId));
    const toUpload = [];
    for (const col of SYNCED_COLLECTIONS) {
      const remoteIds = new Set(remote[col].map(x => x.id));
      let merged = remote[col].filter(x => pending[`${col}/${x.id}`] !== 'delete');
      for (const item of state[col] || []) {
        if (!item?.id || remoteIds.has(item.id)) continue;
        const isPending = pending[`${col}/${item.id}`] === 'save';
        if (isPending || reconcile) {
          merged.push(item);
          if (!isPending) toUpload.push([col, item]);
        }
      }
      state[col] = merged.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    }

    saveDataToStorage();
    if (reconcile) localStorage.setItem(reconcileKey(familyId), new Date().toISOString());
    if (toUpload.length) {
      console.info(`[Sync] Enviando ${toUpload.length} item(ns) que estavam só neste aparelho.`);
      toUpload.forEach(([col, item]) => _saveToFirebase(col, item));
    }
    _lastFetchTime = Date.now();
    _notifyRefresh();
  } catch (error) {
    console.error('Erro ao carregar do Firebase:', error);
    if (error.code !== 'permission-denied') {
      showAlert('Erro ao carregar dados do servidor. Usando dados locais.', 'warning');
    }
  }
}

// ===== LISTENERS REALTIME =====
export function listenFirebaseChanges() {
  if (!firebaseReady)      { console.warn('⚠️ Firebase não está pronto para listeners'); return; }
  if (_listenersActive)    { return; }

  _fbListeners.forEach(unsub => unsub());
  _fbListeners = [];

  const familyId = getFamilyId();
  if (!familyId) { console.warn('⚠️ Sem familyId — listeners não serão ativados'); return; }

  // Se chegar mudança durante um carregamento, recarrega de novo ao terminar
  // (antes ela era descartada e o aparelho ficava desatualizado).
  const runLoad = () => {
    if (_loadingData) { _reloadQueued = true; return; }
    _loadingData = true;
    loadDataFromFirebase().finally(() => {
      _loadingData = false;
      if (_reloadQueued) { _reloadQueued = false; runLoad(); }
    });
  };
  const debouncedLoad = () => {
    clearTimeout(_fbSyncTimer);
    _fbSyncTimer = setTimeout(runLoad, 500);
  };

  SYNCED_COLLECTIONS.forEach(col => {
    const unsub = db.collection(col)
      .where('familyId', '==', familyId)
      .onSnapshot(debouncedLoad, err => console.error(`❌ Erro no listener de ${col}:`, err));
    _fbListeners.push(unsub);
  });
}

export function cleanupFirebaseListeners() {
  _fbListeners.forEach(unsub => unsub());
  _fbListeners    = [];
  _listenersActive = false;
  _loadingData    = false;
  _reloadQueued   = false;
  clearTimeout(_fbSyncTimer);
}

export function refreshIfStale(maxAgeMs = 30_000) {
  if (!firebaseReady || !state.isLoggedIn || !_allowRefresh) return;
  if (_loadingData) return;
  if (Date.now() - _lastFetchTime < maxAgeMs) return;
  loadDataFromFirebase();
}

// Dispara refresh ao voltar ao foreground
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfStale(); });
window.addEventListener('focus', () => refreshIfStale());

// ===== SYNC COMPLETO =====
export async function syncAllToFirebase() {
  if (!firebaseReady) return;
  const familyId = getFamilyId();
  if (!familyId) { console.warn('Sem familyId — sincronização cancelada.'); return; }
  try {
    for (const t of state.transactions)  await _saveToFirebase('transactions', t);
    for (const d of state.debts)         await _saveToFirebase('debts', d);
    for (const s of state.salaries)      await _saveToFirebase('salaries', s);
    for (const sl of state.shoppingLists) await _saveToFirebase('shoppingLists', sl);
  } catch (error) {
    console.error('Erro na sincronização completa:', error);
  }
}

// ===== EXPORTAR / IMPORTAR =====
export function exportData() {
  const json = JSON.stringify({
    transactions: state.transactions,
    debts:        state.debts,
    salaries:     state.salaries,
    exportedAt:   new Date().toISOString()
  }, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `wolfsource-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showAlert('Dados exportados com sucesso!', 'success');
}

export function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(event) {
    try {
      const data = JSON.parse(event.target.result);
      if (confirm('Substituir todos os dados pelos do arquivo?')) {
        const familyId = getFamilyId();
        if (!familyId) { showAlert('Erro: família não identificada. Faça login novamente.', 'danger'); return; }
        state.transactions = (data.transactions || []).map(t => ({ ...t, familyId }));
        state.debts        = (data.debts        || []).map(d => ({ ...d, familyId }));
        state.salaries     = (data.salaries     || []).map(s => ({ ...s, familyId }));
        saveDataToStorage();
        syncAllToFirebase();
        _notifyRefresh();
        showAlert('Dados importados com sucesso!', 'success');
      }
    } catch {
      showAlert('Erro ao importar arquivo!', 'danger');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ===== AÇÕES DE UI =====
export function syncData() {
  if (state.syncStatus === 'offline') { showAlert('Sem conexão! Sincronização será feita quando voltar online.', 'warning'); return; }
  if (!firebaseReady)                 { showAlert('Firebase não configurado.', 'warning'); return; }
  showAlert('Sincronizando dados...', 'info');
  syncAllToFirebase()
    .then(() => showAlert('Dados sincronizados com Firebase!', 'success'))
    .catch(() => showAlert('Erro ao sincronizar.', 'danger'));
}

export function clearCache() {
  if (!confirm('Deseja limpar o cache da aplicação?')) return;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
  }
  localStorage.clear();
  sessionStorage.clear();
  showAlert('Cache limpo! Atualizando página...', 'success');
  setTimeout(() => location.reload(), 1500);
}

// ===== REFRESH CALLBACK =====
let _refreshCallback = null;

export function setRefreshCallback(fn) { _refreshCallback = fn; }
export function allowRefresh(allow = true) { _allowRefresh = allow; }
export function notifyRefresh() { _notifyRefresh(); }

function _notifyRefresh() {
  if (_refreshCallback && state.isLoggedIn && _allowRefresh) {
    try { _refreshCallback(); } catch (error) { console.error('❌ Erro no callback de refresh:', error); }
  }
}
