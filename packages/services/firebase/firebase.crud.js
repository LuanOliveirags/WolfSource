// ============================================================
// FIREBASE.CRUD.JS — Operações atômicas no Firestore
// Responsabilidade única: CRUD de documentos individuais.
// Escritas que falham (sem rede, sem login no Firebase) entram numa
// fila de pendências e são reenviadas na próxima sincronização
// (ver flushPendingWrites em firebase.service.js).
// ============================================================

import { db, firebaseReady } from './firebase.init.js';
import { getFamilyId } from '../../core/state/store.js';
import { showAlert } from '../../utils/helpers.js';

// Coleções sincronizadas com o estado local (state.<coleção>)
export const SYNCED_COLLECTIONS = ['transactions', 'debts', 'salaries', 'shoppingLists'];

// ===== FILA DE PENDÊNCIAS =====
// { "transactions/<id>": "save" | "delete" } por família, no localStorage.
function pendingKey() {
  const fid = getFamilyId();
  return fid ? `wolfsource_pending_${fid}` : null;
}

export function getPendingWrites() {
  const key = pendingKey();
  if (!key) return {};
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}

function setPending(collection, id, op) {
  if (!SYNCED_COLLECTIONS.includes(collection) || !id) return;
  const key = pendingKey();
  if (!key) return;
  const pending = getPendingWrites();
  const k = `${collection}/${id}`;
  if (op) pending[k] = op; else delete pending[k];
  localStorage.setItem(key, JSON.stringify(pending));
}

export const clearPending = (collection, id) => setPending(collection, id, null);

// Só limpa se a pendência ainda for a mesma operação (evita apagar um delete posterior)
function settlePending(collection, id, op) {
  if (getPendingWrites()[`${collection}/${id}`] === op) clearPending(collection, id);
}

// Avisa uma vez por sessão que os dados ficaram só no aparelho
let _warned = false;
function warnNotSynced(error) {
  if (_warned) return;
  _warned = true;
  const auth = error?.code === 'permission-denied' || error?.code === 'unauthenticated';
  showAlert(auth
    ? 'Sem conexão com o servidor: o que você lançar fica salvo neste aparelho e será enviado quando a conexão voltar.'
    : 'Não consegui salvar no servidor agora. Vou tentar de novo automaticamente.', 'warning');
}

// ===== CRUD =====
export async function saveToFirebase(collection, item) {
  if (!firebaseReady) return;
  const familyId = getFamilyId();
  if (!familyId) { console.warn(`Sem familyId — item ${item.id} não será salvo no Firebase.`); return; }
  setPending(collection, item.id, 'save');
  try {
    await db.collection(collection).doc(item.id).set({ ...item, familyId });
    settlePending(collection, item.id, 'save');
  } catch (error) {
    console.error(`Erro ao salvar no Firebase (${collection}):`, error);
    warnNotSynced(error);
  }
}

export async function deleteFromFirebase(collection, id) {
  if (!firebaseReady) return;
  setPending(collection, id, 'delete');
  try {
    await db.collection(collection).doc(id).delete();
    settlePending(collection, id, 'delete');
  } catch (error) {
    console.error(`Erro ao deletar do Firebase (${collection}):`, error);
    warnNotSynced(error);
  }
}

export async function updateInFirebase(collection, id, data) {
  if (!firebaseReady) return;
  try {
    await db.collection(collection).doc(id).update(data);
  } catch (error) {
    console.error(`Erro ao atualizar no Firebase (${collection}):`, error);
    // Na próxima sincronização o item inteiro (já atualizado no estado local) é reenviado
    setPending(collection, id, 'save');
    warnNotSynced(error);
  }
}
