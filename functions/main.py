"""
main.py - Backend do WolfSource em Cloud Functions (Firebase, 2ª geração).

Uma única função HTTP `api` atende as rotas usadas pelo app (web e APK):
  POST /api/auth/token         userId + familyId -> custom token do Firebase Auth
  POST /api/fcm/send           envia push do chat (exige login)
  POST /api/statements/parse   PDF/foto de extrato -> lançamentos via Claude (exige login)
  GET  /api/health

URL: https://us-central1-financeiro-lopes.cloudfunctions.net/api/<rota>
(o prefixo /api é opcional, para funcionar também atrás de rewrite do Hosting).
"""

import json
import os
import re

import firebase_admin
from firebase_admin import auth as fb_auth, firestore, messaging
from firebase_functions import https_fn, options

firebase_admin.initialize_app()  # credenciais padrão do ambiente do Cloud Functions

# Origens que podem chamar a API: site, canais de preview, APK (Capacitor) e dev local
_ALLOWED_ORIGIN = re.compile(
    r"^(https://financeiro-lopes(--[\w-]+)?\.(web\.app|firebaseapp\.com)"
    r"|https?://localhost(:\d+)?"
    r"|http://127\.0\.0\.1(:\d+)?"
    r"|capacitor://localhost)$"
)


def _cors_headers(origin: str) -> dict:
    if origin and _ALLOWED_ORIGIN.match(origin):
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "3600",
            "Vary": "Origin",
        }
    return {"Vary": "Origin"}


def _require_user(req: https_fn.Request):
    """Valida o ID token do Firebase. Retorna (claims, None) ou (None, (status, corpo))."""
    header = req.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None, (401, {"error": "Faça login para usar este recurso."})
    try:
        claims = fb_auth.verify_id_token(header[7:])
    except Exception:
        return None, (401, {"error": "Sessão inválida ou expirada. Entre novamente."})
    if not claims.get("familyId"):
        return None, (403, {"error": "Usuário sem família vinculada."})
    return claims, None


# ───────────────────────── Rotas ─────────────────────────

def _auth_token(req):
    """Confere userId + familyId no Firestore e emite o custom token com as claims."""
    data = req.get_json(silent=True) or {}
    user_id, family_id = data.get("userId"), data.get("familyId")
    if not user_id or not family_id:
        return 400, {"error": "userId e familyId são obrigatórios"}

    user_doc = firestore.client().collection("users").document(user_id).get()
    if not user_doc.exists:
        return 404, {"error": "Usuário não encontrado"}
    user_data = user_doc.to_dict()
    if user_data.get("familyId") != family_id:
        return 403, {"error": "familyId não corresponde ao usuário"}

    try:
        fb_auth.get_user(user_id)
    except fb_auth.UserNotFoundError:
        fb_auth.create_user(uid=user_id)

    # Claims persistentes: as Firestore Rules usam familyId e role
    fb_auth.set_custom_user_claims(user_id, {"familyId": family_id, "role": user_data.get("role", "user")})
    token = fb_auth.create_custom_token(user_id)
    return 200, {"token": token.decode("utf-8") if isinstance(token, bytes) else token}


def _fcm_send(req):
    _, error = _require_user(req)
    if error:
        return error
    data = req.get_json(silent=True) or {}
    token = data.get("token")
    if not token:
        return 400, {"error": "token é obrigatório"}
    message = messaging.Message(
        token=token,
        notification=messaging.Notification(title=data.get("title", ""), body=data.get("body", "")),
        data={str(k): str(v) for k, v in (data.get("data") or {}).items()},
        android=messaging.AndroidConfig(
            priority="high",
            notification=messaging.AndroidNotification(
                channel_id="chat_messages",
                priority="high",
                default_sound=True,
                default_vibrate_timings=True,
                icon="ic_launcher",
                tag="chat-incoming",
            ),
        ),
    )
    try:
        return 200, {"success": True, "messageId": messaging.send(message)}
    except Exception as exc:  # token do aparelho expirado, etc.
        print(f"[FCM] Falha ao enviar: {exc}")
        return 502, {"error": "Falha ao enviar a notificação."}


def _parse_statement(req):
    import anthropic
    from statement_parser import (parse_statement, StatementParseError,
                                  SUPPORTED_MEDIA, MAX_FILE_BYTES, MAX_IMAGE_BYTES)

    claims, error = _require_user(req)
    if error:
        return error
    if not os.getenv("ANTHROPIC_API_KEY"):
        return 503, {"error": "Leitura de PDF e fotos ainda não configurada no servidor."}

    upload = req.files.get("file")
    if not upload:
        return 400, {"error": "Nenhum arquivo enviado."}
    media_type = (upload.mimetype or "").lower()
    if media_type == "image/jpg":
        media_type = "image/jpeg"
    if media_type not in SUPPORTED_MEDIA:
        return 415, {"error": "Envie um PDF ou uma foto (JPG, PNG ou WEBP)."}

    data = upload.read(MAX_FILE_BYTES + 1)
    limit = MAX_IMAGE_BYTES if media_type.startswith("image/") else MAX_FILE_BYTES
    if len(data) > limit:
        return 413, {"error": f"Arquivo maior que {limit // (1024 * 1024)} MB."}

    try:
        result = parse_statement(data, media_type)
    except StatementParseError as exc:
        return 422, {"error": str(exc)}
    except anthropic.RateLimitError:
        return 429, {"error": "Muitas leituras seguidas. Aguarde um minuto e tente de novo."}
    except anthropic.APIStatusError as exc:
        print(f"[STATEMENTS] Erro da API ({exc.status_code}): {exc.message}")
        return 502, {"error": "O serviço de leitura falhou. Tente novamente em instantes."}
    except anthropic.APIConnectionError:
        return 502, {"error": "Sem conexão com o serviço de leitura. Tente novamente."}

    print(f"[STATEMENTS] uid={claims.get('uid')} tipo={media_type} lançamentos={len(result.get('transactions', []))}")
    return 200, result


_ROUTES = {
    ("/auth/token", "POST"): _auth_token,
    ("/fcm/send", "POST"): _fcm_send,
    ("/statements/parse", "POST"): _parse_statement,
    ("/health", "GET"): lambda req: (200, {"status": "healthy"}),
}


@https_fn.on_request(
    region="us-central1",
    timeout_sec=300,                      # PDFs longos levam até ~1-2 min na IA
    memory=options.MemoryOption.MB_512,
    max_instances=5,                      # teto de custo: uso familiar
    secrets=["ANTHROPIC_API_KEY"],
)
def api(req: https_fn.Request) -> https_fn.Response:
    cors = _cors_headers(req.headers.get("Origin", ""))
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204, headers=cors)

    path = re.sub(r"^/api(?=/)", "", req.path.rstrip("/")) or "/"
    handler = _ROUTES.get((path, req.method))
    if handler is None:
        status, body = 404, {"error": "Rota não encontrada"}
    else:
        try:
            status, body = handler(req)
        except Exception as exc:
            print(f"[API] Erro em {req.method} {path}: {exc}")
            status, body = 500, {"error": "Erro interno do servidor"}

    return https_fn.Response(
        json.dumps(body, ensure_ascii=False),
        status=status,
        headers={**cors, "Content-Type": "application/json; charset=utf-8"},
    )
