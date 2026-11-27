// ============================================================
// IMPORT.JS — Controller do modal "Importar extrato"
// Arquivo → leitura no aparelho → revisão editável → gravação.
// Lógica de leitura: packages/services/import/statement.parser.js
// (OFX/CSV/planilha/texto) e statement.local.js (PDF e foto).
// ============================================================
/* global XLSX */

import { CATEGORY_MAP } from '../../../../../packages/services/firebase/firebase.config.js';
import { state, getFamilyId } from '../../../../../packages/core/state/store.js';
import { esc, formatCurrency, formatDate, showAlert, generateId } from '../../../../../packages/utils/helpers.js';
import { saveDataToStorage, saveToFirebase, deleteFromFirebase } from '../../../../../packages/services/firebase/firebase.service.js';
import {
  buildTransactionObject,
  buildBalanceCheckpointObject,
  computeBalanceAtDate,
  matchesWalletMode,
  sumNetBetween
} from '../../../../../packages/services/transactions/transactions.service.js';
import {
  decodeBytes, parseOFX, parseCSVRows, parseTableRows, detectFileKind,
  suggestCategory, suggestPaymentMethod, markDuplicates, buildImportRef, isInternalTransfer
} from '../../../../../packages/services/import/statement.parser.js';
import { readPdfLocally, readImageLocally } from '../../../../../packages/services/import/statement.local.js';
import { updateDashboard } from '../dashboard/dashboard.js';
import { updateTransactionHistory } from '../transactions/transactions.js';

const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
const round2 = (n) => Math.round(n * 100) / 100;

let rows = [];          // lançamentos em revisão
let sourceInfo = null;  // { source, bank, fileName, openingBalance, closingBalance }
let syncBalance = true; // conciliar saldo final da conta com o extrato
let busy = false;

const $ = (id) => document.getElementById(id);

// ───────────────────────── Abertura / passos ─────────────────────────

export function openImportModal() {
  resetImport();
  $('importModal')?.classList.add('active');
}

function closeImportModal() {
  $('importModal')?.classList.remove('active');
  resetImport();
}

function resetImport() {
  rows = [];
  sourceInfo = null;
  syncBalance = true;
  busy = false;
  const input = $('importFileInput'); if (input) input.value = '';
  const cam = $('importCameraInput'); if (cam) cam.value = '';
  showStep('upload');
  renderImportHistory();
}

// ───────────────────────── Importações anteriores ─────────────────────────

// Chave do lote: importações novas têm importBatch; as antigas são agrupadas
// pela origem + minuto em que foram gravadas (todas do mesmo lote juntas).
function batchKey(t) {
  if (t.importBatch) return t.importBatch;
  return `legacy|${t.importSource || ''}|${(t.createdAt || '').slice(0, 16)}`;
}

function getImportBatches() {
  const batches = new Map();
  for (const t of state.transactions) {
    if (!t.importRef && !t.importBatch) continue;
    const key = batchKey(t);
    if (!batches.has(key)) {
      batches.set(key, {
        key,
        fileName: t.importFile || '',
        source: t.importSource || '',
        bank: t.importBank || '',
        createdAt: t.createdAt || '',
        items: []
      });
    }
    const b = batches.get(key);
    if (!b.fileName && t.importFile) b.fileName = t.importFile;
    if (!b.bank && t.importBank) b.bank = t.importBank;
    if (!b.source && t.importSource) b.source = t.importSource;
    b.items.push(t);
  }
  return [...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const fmtShort = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().slice(0, 2).join('/') : '');
const fmtFull = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '');

function renderImportHistory() {
  const box = $('importHistory');
  if (!box) return;
  const batches = getImportBatches();
  box.hidden = batches.length === 0;
  if (!batches.length) { box.innerHTML = ''; return; }

  box.innerHTML = `
    <p class="import-history-title">Importações anteriores</p>
    ${batches.map(b => {
      const realItems = b.items.filter(t => !t.isBalanceAdjustment);
      const dates = (realItems.length ? realItems : b.items).map(t => t.date).filter(Boolean).sort();
      const period = dates.length
        ? (dates[0] === dates[dates.length - 1] ? fmtShort(dates[0]) : `${fmtShort(dates[0])} a ${fmtShort(dates[dates.length - 1])}`)
        : '';
      const name = b.fileName || `Extrato ${[b.source, b.bank].filter(Boolean).join(' · ') || 'importado'}`;
      const count = realItems.length;
      const hasCheckpoint = b.items.some(t => t.isBalanceAdjustment);
      const countLabel = count > 0
        ? `${count} lançamento${count === 1 ? '' : 's'}${hasCheckpoint ? ' + saldo' : ''}`
        : 'Conciliação de saldo';
      const meta = [
        countLabel,
        period,
        b.createdAt ? `importado em ${fmtFull(b.createdAt)}` : ''
      ].filter(Boolean).join(' · ');
      return `
        <div class="import-history-item">
          <span class="import-history-icon"><i class="fa-regular fa-file-lines"></i></span>
          <div class="import-history-info">
            <span class="import-history-name">${esc(name)}</span>
            <span class="import-history-meta">${esc(meta)}</span>
          </div>
          <button type="button" class="import-history-remove" data-batch="${esc(b.key)}" title="Remover os lançamentos desta importação">
            <i class="fa-solid fa-trash"></i> <span class="hide-sm">Remover</span>
          </button>
        </div>`;
    }).join('')}`;
}

async function removeImportBatch(key, btn) {
  const batch = getImportBatches().find(b => b.key === key);
  if (!batch) return;
  const realCount = batch.items.filter(t => !t.isBalanceAdjustment).length;
  const name = batch.fileName || 'esta importação';
  const msg = realCount > 0
    ? `Remover ${realCount} lançamento${realCount === 1 ? '' : 's'} importado${realCount === 1 ? '' : 's'} de "${name}"?\n\nIsso não pode ser desfeito.`
    : `Remover a conciliação de saldo de "${name}"?`;
  if (!confirm(msg)) return;

  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="loading-spinner"></span>'; }
  const ids = new Set(batch.items.map(t => t.id));
  state.transactions = state.transactions.filter(t => !ids.has(t.id));
  saveDataToStorage();
  await Promise.allSettled([...ids].map(id => deleteFromFirebase('transactions', id)));

  updateDashboard();
  updateTransactionHistory();
  renderImportHistory();
  showAlert('Importação removida com sucesso.', 'success');
}

function showStep(step) {
  $('importStepUpload').hidden = step !== 'upload';
  $('importStepLoading').hidden = step !== 'loading';
  $('importStepReview').hidden = step !== 'review';
  $('importModal')?.classList.toggle('is-review', step === 'review');
}

// ───────────────────────── Leitura ─────────────────────────

function loadSheetJS() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SHEETJS_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Não consegui carregar o leitor de planilhas. Verifique a internet ou exporte em CSV.'));
    document.head.appendChild(s);
  });
}

async function readSpreadsheet(file) {
  await loadSheetJS();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  // Usa a aba com mais linhas preenchidas
  let best = [];
  for (const name of wb.SheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' })
      .map(r => r.map(c => String(c).trim()))
      .filter(r => r.some(c => c));
    if (sheetRows.length > best.length) best = sheetRows;
  }
  return parseTableRows(best, 'Planilha');
}

async function readFile(file) {
  const kind = detectFileKind(file);
  if (kind === 'ofx') return parseOFX(decodeBytes(await file.arrayBuffer()));
  if (kind === 'csv') {
    const text = decodeBytes(await file.arrayBuffer());
    if (/OFXHEADER|<OFX>/i.test(text.slice(0, 500))) return parseOFX(text);
    return parseTableRows(parseCSVRows(text), 'CSV');
  }
  if (kind === 'sheet') return readSpreadsheet(file);
  if (kind === 'pdf') return readPdfLocally(file, setLoading);
  if (kind === 'image') return readImageLocally(file, setLoading);
  if (kind === 'heic') throw new Error('Fotos HEIC não são suportadas. Tire a foto pelo botão "Fotografar extrato" ou envie em JPG.');
  throw new Error('Formato não reconhecido. Use OFX, CSV, Excel, PDF ou uma foto.');
}

function setLoading(title, sub = '') {
  $('importLoadingText').textContent = title;
  $('importLoadingSub').textContent = sub;
}

async function handleFile(file) {
  if (!file || busy) return;
  busy = true;
  const kind = detectFileKind(file);
  setLoading(kind === 'image' ? 'Reconhecendo o texto da foto…' : 'Lendo extrato…', file.name);
  showStep('loading');

  try {
    const result = await readFile(file);
    sourceInfo = {
      source: result.source,
      bank: result.bank || '',
      fileName: file.name,
      openingBalance: typeof result.openingBalance === 'number' ? result.openingBalance : null,
      closingBalance: typeof result.closingBalance === 'number' ? result.closingBalance : null,
      warnings: result.warnings || []
    };
    syncBalance = sourceInfo.closingBalance !== null;
    const enriched = result.items.map(item => ({
      ...item,
      category: suggestCategory(item.description, item.type),
      payment: suggestPaymentMethod(item.description),
      internal: isInternalTransfer(item.description)
    }));
    // Duplicados vêm desmarcados; resgates/aplicações de poupança permanecem marcados
    // no extrato da conta corrente pois compõem o saldo final da conta.
    rows = markDuplicates(enriched, state.transactions, state.salaries).map(item => ({
      ...item,
      selected: !item.duplicate
    }));
    if (!rows.length) {
      showStep('upload');
      showAlert(sourceInfo.warnings[0] || 'Nenhum lançamento encontrado neste arquivo.', 'warning');
      return;
    }
    populateResponsible();
    renderReview();
    showStep('review');
  } catch (err) {
    console.error('[Import] Falha ao ler extrato:', err);
    showStep('upload');
    showAlert(err.message || 'Não foi possível ler o arquivo.', 'danger');
  } finally {
    busy = false;
    $('importFileInput').value = '';
    $('importCameraInput').value = '';
  }
}

// ───────────────────────── Conciliação de saldo do extrato ─────────────────────────

function getStatementReconciliation() {
  if (!sourceInfo || sourceInfo.closingBalance === null) return null;
  const dates = rows.map(r => r.date).filter(Boolean).sort();
  if (!dates.length) return null;

  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const paymentChoice = $('importPayment')?.value || 'auto';
  const mode = (paymentChoice === 'vr' || paymentChoice === 'va') ? paymentChoice : 'geral';

  const selected = rows.filter(r => r.selected);
  const netSelected = round2(selected.reduce((s, r) => s + (r.type === 'entrada' ? r.amount : -r.amount), 0));
  const existingInPeriod = sumNetBetween(state.transactions, state.salaries, firstDate, lastDate, mode);
  const openingCheckpoint = round2(sourceInfo.closingBalance - existingInPeriod - netSelected);

  const currentAtEnd = computeBalanceAtDate(state.transactions, state.salaries, lastDate, mode);
  const projectedWithoutSync = currentAtEnd !== null
    ? round2(currentAtEnd + netSelected)
    : round2(existingInPeriod + netSelected);
  const needsSync = currentAtEnd === null || Math.abs(projectedWithoutSync - sourceInfo.closingBalance) >= 0.01;

  return {
    mode,
    firstDate,
    lastDate,
    closingBalance: sourceInfo.closingBalance,
    openingStatement: sourceInfo.openingBalance,
    openingCheckpoint,
    needsSync
  };
}

// ───────────────────────── Revisão ─────────────────────────

function populateResponsible() {
  const select = $('importResponsible');
  const members = state.familyMembers || [];
  const me = state.currentUser?.fullName;
  select.innerHTML = members.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('') +
    '<option value="Ambos">Ambos</option>';
  if (me && members.some(m => m.name === me)) select.value = me;
}

const CATEGORY_OPTIONS = Object.entries(CATEGORY_MAP)
  .map(([key, c]) => `<option value="${key}">${c.icon} ${c.label}</option>`).join('');

function rowHtml(r, i) {
  const dupText = r.duplicateSalary ? 'Já registrado em Salário' : 'Já existe um lançamento igual';
  return `
    <div class="import-row ${r.type} ${r.duplicate ? 'is-dup' : ''} ${r.selected ? '' : 'is-off'}" data-i="${i}">
      <input type="checkbox" class="import-row-check" aria-label="Importar este lançamento" ${r.selected ? 'checked' : ''}>
      <input type="date" class="import-row-date" value="${r.date}" aria-label="Data">
      <div class="import-row-main">
        <input type="text" class="import-row-desc" value="${esc(r.description)}" aria-label="Descrição">
        ${r.duplicate ? `<span class="import-dup-badge"><i class="fa-solid fa-clone"></i> ${dupText}</span>` : ''}
        ${r.internal ? '<span class="import-dup-badge is-internal"><i class="fa-solid fa-piggy-bank"></i> Poupança / entre contas</span>' : ''}
      </div>
      <select class="import-row-cat" aria-label="Categoria">${CATEGORY_OPTIONS}</select>
      <button type="button" class="import-row-type" title="Trocar entrada/saída">
        ${r.type === 'entrada' ? '<i class="fa-solid fa-arrow-down"></i> Entrada' : '<i class="fa-solid fa-arrow-up"></i> Saída'}
      </button>
      <input type="number" class="import-row-amount" value="${r.amount.toFixed(2)}" step="0.01" min="0.01" inputmode="decimal" aria-label="Valor">
    </div>`;
}

function renderReview() {
  $('importList').innerHTML = rows.map(rowHtml).join('');
  $('importList').querySelectorAll('.import-row').forEach(el => {
    el.querySelector('.import-row-cat').value = rows[+el.dataset.i].category;
  });
  const warnings = sourceInfo.warnings || [];
  $('importWarnings').innerHTML = warnings.map(w => `<p class="import-warning"><i class="fa-solid fa-circle-info"></i> ${esc(w)}</p>`).join('');
  updateSummary();
}

function updateSummary() {
  const selected = rows.filter(r => r.selected);
  const income = selected.filter(r => r.type === 'entrada').reduce((s, r) => s + r.amount, 0);
  const expense = selected.filter(r => r.type === 'saida').reduce((s, r) => s + r.amount, 0);
  const dups = rows.filter(r => r.duplicate).length;
  const origin = [sourceInfo.source, sourceInfo.bank].filter(Boolean).join(' · ');
  const recon = getStatementReconciliation();

  const fourthStat = recon
    ? `<div><span class="import-stat-label">Saldo final no extrato</span><span class="import-stat-val is-bal">${formatCurrency(recon.closingBalance)}</span></div>`
    : `<div><span class="import-stat-label">Possíveis duplicados</span><span class="import-stat-val">${dups}</span></div>`;

  $('importSummary').innerHTML = `
    <div class="import-summary-head">
      <span class="import-summary-file"><i class="fa-regular fa-file-lines"></i> ${esc(sourceInfo.fileName)}</span>
      <span class="import-summary-origin">${esc(origin)}${recon && dups ? ` · ${dups} duplicado${dups === 1 ? '' : 's'}` : ''}</span>
    </div>
    <div class="import-summary-stats">
      <div><span class="import-stat-label">Lançamentos</span><span class="import-stat-val">${selected.length}<small> de ${rows.length}</small></span></div>
      <div><span class="import-stat-label">Entradas</span><span class="import-stat-val is-in">${formatCurrency(income)}</span></div>
      <div><span class="import-stat-label">Saídas</span><span class="import-stat-val is-out">${formatCurrency(expense)}</span></div>
      ${fourthStat}
    </div>`;

  const syncBox = $('importBalanceSync');
  if (syncBox) {
    if (recon) {
      syncBox.hidden = false;
      const openInfo = recon.openingStatement !== null
        ? `saldo inicial de ${formatCurrency(recon.openingStatement)} em ${formatDate(recon.firstDate)}`
        : `em ${formatDate(recon.lastDate)}`;
      syncBox.innerHTML = `
        <label class="import-sync-label">
          <input type="checkbox" id="importSyncBalanceCheck" ${syncBalance ? 'checked' : ''}>
          <span>
            <strong>Conciliar saldo em conta para ${formatCurrency(recon.closingBalance)}</strong>
            <small>Considera o ${openInfo} e mantém o saldo acumulado entre os meses.</small>
          </span>
        </label>`;
    } else {
      syncBox.hidden = true;
      syncBox.innerHTML = '';
    }
  }

  $('importSelectAll').checked = rows.length > 0 && selected.length === rows.length;
  $('importSelectAll').indeterminate = selected.length > 0 && selected.length < rows.length;

  const canSyncOnly = Boolean(recon && syncBalance && recon.needsSync);
  const btn = $('importConfirmBtn');
  btn.disabled = selected.length === 0 && !canSyncOnly;
  if (selected.length > 0) {
    btn.innerHTML = `<i class="fa-solid fa-check"></i> Importar ${selected.length} lançamento${selected.length === 1 ? '' : 's'}`;
  } else if (canSyncOnly) {
    btn.innerHTML = `<i class="fa-solid fa-scale-balanced"></i> Ajustar saldo para ${formatCurrency(recon.closingBalance)}`;
  } else {
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Nenhum lançamento novo';
  }
}

function rowFromEvent(e) {
  const el = e.target.closest('.import-row');
  return el ? { el, row: rows[+el.dataset.i] } : {};
}

function onListChange(e) {
  const { el, row } = rowFromEvent(e);
  if (!row) return;
  const t = e.target;
  if (t.classList.contains('import-row-check')) { row.selected = t.checked; el.classList.toggle('is-off', !t.checked); }
  else if (t.classList.contains('import-row-date')) row.date = t.value || row.date;
  else if (t.classList.contains('import-row-desc')) row.description = t.value.trim() || row.description;
  else if (t.classList.contains('import-row-cat')) row.category = t.value;
  else if (t.classList.contains('import-row-amount')) {
    const v = parseFloat(t.value);
    if (Number.isFinite(v) && v > 0) row.amount = v; else t.value = row.amount.toFixed(2);
  }
  updateSummary();
}

function onListClick(e) {
  const btn = e.target.closest('.import-row-type');
  if (!btn) return;
  const { el, row } = rowFromEvent(e);
  row.type = row.type === 'entrada' ? 'saida' : 'entrada';
  el.outerHTML = rowHtml(row, rows.indexOf(row));
  $('importList').querySelector(`.import-row[data-i="${rows.indexOf(row)}"] .import-row-cat`).value = row.category;
  updateSummary();
}

function invertAll() {
  rows.forEach(r => { r.type = r.type === 'entrada' ? 'saida' : 'entrada'; });
  rows = markDuplicates(rows.map(({ duplicate, duplicateSalary, ...r }) => r), state.transactions, state.salaries)
    .map((r, i) => ({ ...r, selected: rows[i].selected }));
  renderReview();
}

// ───────────────────────── Gravação ─────────────────────────

async function confirmImport() {
  const familyId = getFamilyId();
  if (!familyId) { showAlert('Erro: família não identificada.', 'danger'); return; }
  const selected = rows.filter(r => r.selected);
  const recon = getStatementReconciliation();
  const shouldWriteCheckpoint = Boolean(recon && syncBalance && (selected.length > 0 || recon.needsSync));
  if (!selected.length && !shouldWriteCheckpoint) return;

  const responsible = $('importResponsible').value || state.currentUser?.fullName || 'Família';
  const paymentChoice = $('importPayment').value;
  const occurrences = new Map();
  const batchId = `imp-${generateId()}`;
  const baseMs = Date.now();

  const oldestFirst = selected.length >= 2 && selected[0].date < selected[selected.length - 1].date;

  // Ordena os createdAt para manter a ordem intradia original (mais recente primeiro)
  const transactions = selected.map((r, idx) => {
    const baseKey = `${r.date}|${r.type}|${r.amount.toFixed(2)}|${r.description}`;
    const n = (occurrences.get(baseKey) || 0) + 1;
    occurrences.set(baseKey, n);
    return {
      ...buildTransactionObject({
        type: r.type,
        amount: round2(r.amount),
        category: r.category,
        responsible,
        date: r.date,
        description: r.description,
        paymentMethod: paymentChoice === 'auto' ? r.payment : paymentChoice,
        familyId
      }),
      createdAt: new Date(oldestFirst ? baseMs + idx : baseMs - idx).toISOString(),
      importRef: r.ref || buildImportRef(r, n),
      importSource: sourceInfo.source,
      importBatch: batchId,
      importFile: sourceInfo.fileName,
      importBank: sourceInfo.bank || ''
    };
  });

  if (shouldWriteCheckpoint) {
    const cpPayment = (recon.mode === 'vr' || recon.mode === 'va') ? recon.mode : 'conta';
    // Remove marcos antigos dentro do mesmo período para não empilhar ajustes conflitantes
    const staleIds = state.transactions
      .filter(t =>
        t.isBalanceAdjustment &&
        t.date >= recon.firstDate &&
        t.date <= recon.lastDate &&
        matchesWalletMode(t.paymentMethod, recon.mode)
      )
      .map(t => t.id);
    if (staleIds.length) {
      const staleSet = new Set(staleIds);
      state.transactions = state.transactions.filter(t => !staleSet.has(t.id));
      await Promise.allSettled(staleIds.map(id => deleteFromFirebase('transactions', id)));
    }

    const cp = buildBalanceCheckpointObject({
      checkpointBalance: recon.openingCheckpoint,
      date: recon.firstDate,
      responsible,
      description: `Saldo inicial do extrato (${sourceInfo.fileName})`,
      paymentMethod: cpPayment,
      familyId,
      source: sourceInfo.source,
      importBatch: batchId,
      importFile: sourceInfo.fileName,
      importBank: sourceInfo.bank || '',
      statementOpeningBalance: recon.openingStatement,
      statementClosingBalance: recon.closingBalance,
      statementEndDate: recon.lastDate
    });
    transactions.push(cp);
  }

  const btn = $('importConfirmBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> Salvando…';

  state.transactions.push(...transactions);
  saveDataToStorage();
  await Promise.allSettled(transactions.map(t => saveToFirebase('transactions', t)));

  updateDashboard();
  updateTransactionHistory();
  closeImportModal();

  if (selected.length > 0 && shouldWriteCheckpoint) {
    showAlert(`${selected.length} lançamento${selected.length === 1 ? '' : 's'} importado${selected.length === 1 ? '' : 's'} · Saldo conciliado em ${formatCurrency(recon.closingBalance)}!`, 'success');
  } else if (shouldWriteCheckpoint) {
    showAlert(`Saldo em conta ajustado para ${formatCurrency(recon.closingBalance)}!`, 'success');
  } else {
    showAlert(`${selected.length} lançamento${selected.length === 1 ? '' : 's'} importado${selected.length === 1 ? '' : 's'}!`, 'success');
  }
}

// ───────────────────────── Eventos ─────────────────────────

export function setupImportListeners() {
  const modal = $('importModal');
  if (!modal) return;

  $('importCloseBtn').addEventListener('click', () => {
    if (!$('importStepReview').hidden && !confirm('Descartar os lançamentos lidos?')) return;
    closeImportModal();
  });
  // Clique fora: na revisão, confirma antes (captura roda antes do fechamento genérico de .modal)
  modal.addEventListener('click', (e) => {
    if (e.target !== modal) return;
    if (busy || (!$('importStepReview').hidden && !confirm('Descartar os lançamentos lidos?'))) {
      e.stopImmediatePropagation();
      return;
    }
    resetImport();
  }, true);

  $('importFileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
  $('importCameraInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
  $('importCameraBtn').addEventListener('click', () => $('importCameraInput').click());

  const drop = $('importDrop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

  const list = $('importList');
  list.addEventListener('change', onListChange);
  list.addEventListener('click', onListClick);

  $('importBalanceSync')?.addEventListener('change', (e) => {
    if (e.target.id === 'importSyncBalanceCheck') {
      syncBalance = e.target.checked;
      updateSummary();
    }
  });
  $('importPayment')?.addEventListener('change', updateSummary);

  $('importSelectAll').addEventListener('change', (e) => {
    rows.forEach(r => { r.selected = e.target.checked; });
    renderReview();
  });
  $('importInvertBtn').addEventListener('click', invertAll);
  $('importBackBtn').addEventListener('click', resetImport);
  $('importConfirmBtn').addEventListener('click', confirmImport);

  $('importHistory')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.import-history-remove');
    if (btn && !btn.disabled) removeImportBatch(btn.dataset.batch, btn);
  });
}

window.openImportModal = openImportModal;
