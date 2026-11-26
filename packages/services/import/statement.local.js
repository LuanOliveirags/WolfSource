// ============================================================
// STATEMENT.LOCAL.JS — Leitura de PDF e foto no próprio aparelho
// • PDF com texto: pdf.js extrai as palavras e remontamos as linhas
// • PDF escaneado e foto: OCR com Tesseract (português)
// Nada sai do aparelho; as bibliotecas são baixadas sob demanda (CDN)
// e ficam no cache do navegador/WebView do APK.
// ============================================================
/* global Tesseract */

import { parseStatementLines, PAGE_BREAK } from './statement.parser.js';

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

const MAX_OCR_PAGES = 12;     // PDF escaneado: limite para não travar o celular
const MIN_TEXT_PER_PAGE = 40; // abaixo disso o PDF não tem camada de texto

let _pdfjs = null;

async function loadPdfJs() {
  if (_pdfjs) return _pdfjs;
  try {
    _pdfjs = await import(/* @vite-ignore */ PDFJS_URL);
  } catch {
    throw new Error('Não consegui carregar o leitor de PDF. Verifique a internet e tente de novo.');
  }
  _pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  return _pdfjs;
}

function loadTesseract() {
  if (typeof Tesseract !== 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Não consegui carregar o reconhecimento de texto. Verifique a internet e tente de novo.'));
    document.head.appendChild(s);
  });
}

/** Agrupa as palavras de uma página em linhas pela coordenada vertical. */
export function pageItemsToLines(items) {
  return pageItemsToRows(items).map(r => r.text);
}

/** Como pageItemsToLines, mas guarda a posição de cada trecho ({ text, parts }). */
export function pageItemsToRows(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.abs(it.transform[3]) || 8;
    let row = rows.find(r => Math.abs(r.y - y) <= Math.max(2, h * 0.4));
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, str: it.str, end: x + (it.width || 0) });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map(r => {
      const parts = r.parts.sort((a, b) => a.x - b.x);
      const text = parts
        .reduce((acc, p, i, arr) => acc + (i && p.x - arr[i - 1].end > 1 ? ' ' : '') + p.str, '')
        .replace(/\s+/g, ' ').trim();
      return { text, parts };
    })
    .filter(r => r.text);
}

const OCR_TARGET_SIDE = 2600; // px no lado maior: texto de extrato fica com ~25-35px de altura

/**
 * Prepara a imagem para o OCR: redimensiona, passa para tons de cinza e binariza com
 * limiar adaptativo (Bradley). Remove faixas cinzas de tabelas e sombras de foto,
 * que fazem o Tesseract pular linhas inteiras.
 */
export async function prepareForOcr(source) {
  const bitmap = source instanceof HTMLCanvasElement ? source : await createImageBitmap(source);
  const scale = OCR_TARGET_SIDE / Math.max(bitmap.width, bitmap.height);
  const w = Math.round(bitmap.width * Math.min(scale, 2));
  const h = Math.round(bitmap.height * Math.min(scale, 2));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  // Luminância + imagem integral para a média local em O(1)
  const lum = new Uint8ClampedArray(w * h);
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
      lum[i] = l;
      rowSum += l;
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum;
    }
  }
  const half = Math.max(8, Math.round(w / 40));
  const T = 0.15; // pixel vira preto se for 15% mais escuro que a vizinhança
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[(y2 + 1) * (w + 1) + x2 + 1] - integral[y1 * (w + 1) + x2 + 1]
        - integral[(y2 + 1) * (w + 1) + x1] + integral[y1 * (w + 1) + x1];
      const i = y * w + x;
      const v = lum[i] * area < sum * (1 - T) ? 0 : 255;
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** OCR de uma lista de imagens/canvas, com progresso. */
async function ocrImages(images, onProgress, { withPositions = false } = {}) {
  await loadTesseract();
  onProgress?.('Preparando o reconhecimento de texto…', 'Na primeira vez baixa o dicionário de português (alguns MB).');
  const worker = await Tesseract.createWorker('por', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.('Reconhecendo o texto…', `${Math.round((m.progress || 0) * 100)}%`);
    }
  });
  try {
    // PSM 6: bloco uniforme — preserva as linhas de tabelas de extrato
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    const lines = [];
    for (let i = 0; i < images.length; i++) {
      onProgress?.(images.length > 1 ? `Reconhecendo página ${i + 1} de ${images.length}…` : 'Reconhecendo o texto…', 'Ajustando contraste da imagem…');
      const { data } = await worker.recognize(await prepareForOcr(images[i]));
      if (i) lines.push(PAGE_BREAK);
      if (withPositions) {
        // Linhas com a posição de cada palavra (para separar colunas, ex.: holerite)
        lines.push(...(data.lines || []).map(l => ({
          text: l.text.trim(),
          parts: (l.words || []).map(w => ({ str: w.text, x: w.bbox.x0, end: w.bbox.x1 }))
        })));
      } else {
        lines.push(...data.text.split('\n'));
      }
    }
    return lines;
  } finally {
    await worker.terminate();
  }
}

/** Lê um PDF: texto direto quando houver; senão OCR das páginas. */
export async function readPdfLocally(file, onProgress) {
  const pdfjs = await loadPdfJs();
  onProgress?.('Lendo o PDF…', file.name);
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') throw new Error('Este PDF tem senha. Abra no app do banco, salve sem senha (ou exporte em OFX) e tente de novo.');
    throw new Error('Não consegui abrir este PDF.');
  }

  const lines = [];
  let chars = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const pageLines = pageItemsToLines(content.items);
    chars += pageLines.join('').length;
    if (p > 1) lines.push(PAGE_BREAK);
    lines.push(...pageLines);
  }

  if (chars >= MIN_TEXT_PER_PAGE * pdf.numPages) return parseStatementLines(lines, 'PDF');

  // PDF escaneado (imagem): renderiza as páginas e faz OCR
  const pages = Math.min(pdf.numPages, MAX_OCR_PAGES);
  const canvases = [];
  for (let p = 1; p <= pages; p++) {
    onProgress?.(`Preparando página ${p} de ${pages}…`, 'PDF escaneado: vou reconhecer o texto da imagem.');
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    canvases.push(canvas);
  }
  const result = parseStatementLines(await ocrImages(canvases, onProgress), 'PDF escaneado', { ocr: true });
  result.warnings.unshift('PDF escaneado lido por reconhecimento de texto: confira datas e valores.');
  if (pdf.numPages > MAX_OCR_PAGES) result.warnings.push(`Só as ${MAX_OCR_PAGES} primeiras páginas foram lidas.`);
  return result;
}

/**
 * Lê um PDF ou foto e devolve as linhas com a posição das palavras, sem
 * interpretar o conteúdo (usado pelo leitor de holerite).
 * @returns {{ rows: Array<{ text, parts }>, ocr: boolean }}
 */
export async function readDocumentRows(file, onProgress) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  if (!isPdf) {
    if (/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '')) {
      throw new Error('Fotos HEIC não são suportadas. Tire a foto pelo botão da câmera ou envie em JPG.');
    }
    return { rows: await ocrImages([file], onProgress, { withPositions: true }), ocr: true };
  }

  const pdfjs = await loadPdfJs();
  onProgress?.('Lendo o PDF…', file.name);
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') throw new Error('Este PDF tem senha. Salve uma cópia sem senha e tente de novo.');
    throw new Error('Não consegui abrir este PDF.');
  }
  const rows = [];
  let chars = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const pageRows = pageItemsToRows((await page.getTextContent()).items);
    chars += pageRows.reduce((n, r) => n + r.text.length, 0);
    if (p > 1) rows.push(PAGE_BREAK);
    rows.push(...pageRows);
  }
  if (chars >= MIN_TEXT_PER_PAGE * pdf.numPages) return { rows, ocr: false };

  // PDF escaneado: renderiza as páginas e faz OCR
  const pages = Math.min(pdf.numPages, MAX_OCR_PAGES);
  const canvases = [];
  for (let p = 1; p <= pages; p++) {
    onProgress?.(`Preparando página ${p} de ${pages}…`, 'PDF escaneado: vou reconhecer o texto da imagem.');
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    canvases.push(canvas);
  }
  return { rows: await ocrImages(canvases, onProgress, { withPositions: true }), ocr: true };
}

/** Lê a foto de um extrato por OCR. */
export async function readImageLocally(file, onProgress) {
  const result = parseStatementLines(await ocrImages([file], onProgress), 'Foto', { ocr: true });
  result.warnings.unshift('Foto lida por reconhecimento de texto: confira datas e valores.');
  return result;
}
