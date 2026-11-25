// ============================================================
// WolfSource API — Cloudflare Workers (plano gratuito)
//   POST /api/auth/token   userId + familyId -> custom token do Firebase Auth
//   POST /api/fcm/send     push do chat (exige ID token do Firebase)
//   GET  /api/health
// Segredo obrigatório: FIREBASE_SERVICE_ACCOUNT (JSON da conta de serviço).
// ============================================================

import { getAccessToken, createCustomToken, verifyIdToken } from './google.js';

// Site, canais de preview, APK (Capacitor) e desenvolvimento local
const ALLOWED_ORIGIN = /^(https:\/\/financeiro-lopes(--[\w-]+)?\.(web\.app|firebaseapp\.com)|https?:\/\/localhost(:\d+)?|http:\/\/127\.0\.0\.1(:\d+)?|capacitor:\/\/localhost)$/;

function corsHeaders(origin) {
  if (!origin || !ALLOWED_ORIGIN.test(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '3600',
    Vary: 'Origin'
  };
}

const json = (status, body, headers) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

async function requireUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return [null, [401, { error: 'Faça login para usar este recurso.' }]];
  try {
    const claims = await verifyIdToken(header.slice(7), env.FIREBASE_PROJECT_ID);
    if (!claims.familyId) return [null, [403, { error: 'Usuário sem família vinculada.' }]];
    return [claims, null];
  } catch {
    return [null, [401, { error: 'Sessão inválida ou expirada. Entre novamente.' }]];
  }
}

// ───────────── Rotas ─────────────

async function authToken(request, env) {
  const { userId, familyId } = await readJson(request);
  if (!userId || !familyId) return [400, { error: 'userId e familyId são obrigatórios' }];

  const project = env.FIREBASE_PROJECT_ID;
  const access = await getAccessToken(env);
  const auth = { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' };

  // Usuário no Firestore (mesma checagem do backend antigo)
  const docRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${encodeURIComponent(userId)}`,
    { headers: auth });
  if (docRes.status === 404) return [404, { error: 'Usuário não encontrado' }];
  if (!docRes.ok) throw new Error(`Firestore ${docRes.status}`);
  const fields = (await docRes.json()).fields || {};
  if (fields.familyId?.stringValue !== familyId) return [403, { error: 'familyId não corresponde ao usuário' }];
  const role = fields.role?.stringValue || 'user';

  // Garante o usuário no Firebase Auth e grava as claims persistentes (Firestore Rules usam familyId/role)
  const base = `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts`;
  const created = await fetch(base, { method: 'POST', headers: auth, body: JSON.stringify({ localId: userId }) });
  if (!created.ok) {
    const err = await created.json().catch(() => ({}));
    if (!String(err.error?.message || '').includes('DUPLICATE_LOCAL_ID')) throw new Error(`Auth create ${created.status}`);
  }
  const updated = await fetch(`${base}:update`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ localId: userId, customAttributes: JSON.stringify({ familyId, role }) })
  });
  if (!updated.ok) throw new Error(`Auth update ${updated.status}`);

  return [200, { token: await createCustomToken(env, userId, { familyId, role }) }];
}

async function fcmSend(request, env) {
  const [, error] = await requireUser(request, env);
  if (error) return error;
  const data = await readJson(request);
  if (!data.token) return [400, { error: 'token é obrigatório' }];

  const access = await getAccessToken(env);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: data.token,
        notification: { title: String(data.title || ''), body: String(data.body || '') },
        data: Object.fromEntries(Object.entries(data.data || {}).map(([k, v]) => [String(k), String(v)])),
        android: {
          priority: 'HIGH',
          notification: {
            channel_id: 'chat_messages',
            notification_priority: 'PRIORITY_HIGH',
            default_sound: true,
            default_vibrate_timings: true,
            icon: 'ic_launcher',
            tag: 'chat-incoming'
          }
        }
      }
    })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log('[FCM] falha', res.status, JSON.stringify(out.error || out));
    return [502, { error: 'Falha ao enviar a notificação.' }];
  }
  return [200, { success: true, messageId: out.name }];
}

const ROUTES = {
  'POST /auth/token': authToken,
  'POST /fcm/send': fcmSend,
  'GET /health': async () => [200, { status: 'healthy' }]
};

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const path = new URL(request.url).pathname.replace(/\/+$/, '').replace(/^\/api(?=\/)/, '') || '/';
    const handler = ROUTES[`${request.method} ${path}`];
    if (!handler) return json(404, { error: 'Rota não encontrada' }, cors);
    try {
      const [status, body] = await handler(request, env);
      return json(status, body, cors);
    } catch (err) {
      console.log(`[API] ${request.method} ${path}:`, err.message);
      return json(500, { error: 'Erro interno do servidor' }, cors);
    }
  }
};
