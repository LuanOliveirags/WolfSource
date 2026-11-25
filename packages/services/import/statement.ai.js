// ============================================================
// STATEMENT.AI.JS — Envia PDF/foto de extrato ao backend, que usa
// o Claude para extrair os lançamentos. Funciona igual no navegador
// e no APK (Capacitor): o backend é sempre o Railway em produção.
// ============================================================

import { BACKEND_URL } from '../firebase/firebase.config.js';
import { auth } from '../firebase/firebase.init.js';
import { parseDate } from './statement.parser.js';

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_SIDE = 2400;   // px — legível para a IA e leve para enviar
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Reduz a foto para no máximo IMAGE_MAX_SIDE e reexporta como JPEG. */
async function downscaleImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // formato que o navegador não decodifica: envia como está
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 3.5 * 1024 * 1024 && file.type === 'image/jpeg') return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  return blob ? new File([blob], (file.name || 'extrato').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
}

/**
 * Lê um extrato em PDF ou imagem pela IA.
 * @returns {Promise<{items: Array, source: string, bank: string, warnings: string[]}>}
 */
export async function parseStatementWithAI(file, kind) {
  const user = auth?.currentUser;
  if (!user) throw new Error('Sua sessão no servidor expirou. Saia e entre de novo para usar a leitura de PDF e fotos.');
  if (kind === 'pdf' && file.size > MAX_PDF_BYTES) throw new Error('PDF maior que 20 MB. Exporte um período menor do extrato.');

  const upload = kind === 'image' ? await downscaleImage(file) : file;
  const token = await user.getIdToken();
  const body = new FormData();
  body.append('file', upload, upload.name || (kind === 'pdf' ? 'extrato.pdf' : 'extrato.jpg'));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BACKEND_URL}/api/statements/parse`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body,
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('A leitura demorou demais. Tente um arquivo menor ou um período mais curto.');
    throw new Error('Sem conexão com o servidor. A leitura de PDF e fotos precisa de internet.');
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `O servidor não conseguiu ler o extrato (erro ${res.status}).`);

  const fallbackYear = new Date().getFullYear();
  const items = (data.transactions || [])
    .map(t => ({
      date: parseDate(t.date, fallbackYear),
      description: String(t.description || '').replace(/\s+/g, ' ').trim() || 'Lançamento',
      amount: Math.abs(Number(t.amount)),
      type: t.type === 'entrada' ? 'entrada' : 'saida',
      ref: null
    }))
    .filter(t => t.date && Number.isFinite(t.amount) && t.amount > 0);

  return {
    items,
    source: kind === 'pdf' ? 'PDF' : 'Foto',
    bank: data.bank || '',
    warnings: [...(data.warnings || []), ...(items.length === 0 ? ['A IA não encontrou lançamentos neste arquivo.'] : [])]
  };
}
