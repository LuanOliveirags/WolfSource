// ============================================================
// GOOGLE.JS — Credenciais Google/Firebase sem SDK (WebCrypto puro)
// • access token OAuth da conta de serviço (Firestore, Auth, FCM)
// • custom token do Firebase Auth
// • verificação de ID token do Firebase
// Tudo em RS256 com crypto.subtle, compatível com Cloudflare Workers.
// ============================================================

const enc = new TextEncoder();

export function b64url(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

// ───────────── Conta de serviço ─────────────

let _saKey = null;        // { email, key: CryptoKey } — reaproveitado enquanto o isolate vive
let _accessToken = null;  // { token, exp }

async function serviceAccount(env) {
  if (_saKey) return _saKey;
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT não configurado');
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, RS256, false, ['sign']);
  _saKey = { email: sa.client_email, key };
  return _saKey;
}

async function signJwt(payload, key) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign(RS256, key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

/** Access token OAuth da conta de serviço (cache até 5 min antes de expirar). */
export async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_accessToken && _accessToken.exp - 300 > now) return _accessToken.token;
  const { email, key } = await serviceAccount(env);
  const assertion = await signJwt({
    iss: email,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }, key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OAuth falhou: ${data.error_description || data.error || res.status}`);
  _accessToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return _accessToken.token;
}

/** Custom token do Firebase Auth (equivalente ao create_custom_token do Admin SDK). */
export async function createCustomToken(env, uid, claims) {
  const { email, key } = await serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: email,
    sub: email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid,
    claims
  }, key);
}

// ───────────── ID token do Firebase ─────────────

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let _jwks = null; // { keys: Map<kid, CryptoKey>, exp }

async function signingKeys() {
  const now = Date.now();
  if (_jwks && _jwks.exp > now) return _jwks.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('Não foi possível obter as chaves públicas do Firebase');
  const maxAge = Number((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  const { keys } = await res.json();
  const map = new Map();
  for (const jwk of keys) map.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, RS256, false, ['verify']));
  _jwks = { keys: map, exp: now + maxAge * 1000 };
  return map;
}

/** Verifica o ID token (assinatura, emissor, público, validade). Retorna as claims ou lança erro. */
export async function verifyIdToken(token, projectId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('token malformado');
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  if (header.alg !== 'RS256') throw new Error('algoritmo inválido');
  const key = (await signingKeys()).get(header.kid);
  if (!key) throw new Error('chave desconhecida');
  const valid = await crypto.subtle.verify(RS256, key, b64urlDecode(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error('assinatura inválida');
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('emissor inválido');
  if (claims.aud !== projectId) throw new Error('público inválido');
  if (!claims.sub || claims.exp <= now || claims.iat > now + 300) throw new Error('token expirado');
  return { ...claims, uid: claims.sub };
}

/** Só para testes: limpa os caches de módulo. */
export function _resetCaches() { _saKey = null; _accessToken = null; _jwks = null; }
