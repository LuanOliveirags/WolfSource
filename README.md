# WolfSource — Sistema de Gestão Financeira

Aplicação web e Android para gestão financeira familiar. Desenvolvida como PWA com arquitetura modular vanilla JS, suporte offline, sincronização em tempo real com Firestore e empacotamento Android via Capacitor — web e APK compartilham o mesmo código e backend.

**Produção:** https://financeiro-lopes.web.app

## Características Principais

- **Autenticação Customizada**: Login com hash SHA-256, roles (superadmin / admin / user) e Firebase Auth via custom token
- **Isolamento Multiusuário**: Dados isolados por família via Firestore Security Rules + claim `familyId` no JWT
- **Dashboard Interativo**: KPIs, gráficos Chart.js e análise financeira mensal
- **Controle de Transações**: Registro completo de entradas e saídas com categorias
- **Importação de Extratos**: OFX, CSV e Excel lidos no próprio aparelho; PDF e fotos lidos por IA (Claude) no backend — com revisão editável, categoria sugerida e detecção de duplicados antes de gravar
- **Gestão de Dívidas**: Controle de vencimentos, status automático e alertas
- **Gestão de Salários**: Acompanhamento de rendas por membro da família
- **Lista de Compras**: Colaborativa e sincronizada em tempo real
- **Tarefas Domésticas**: Sistema compartilhado com responsáveis
- **Chat em Tempo Real**: Mensagens com notificações push via FCM
- **PWA + APK Android**: Instalável no browser ou como app nativo via Capacitor
- **Modo Offline**: Cache-first com sincronização automática ao reconectar
- **Notificações Push**: FCM web (Service Worker) + FCM nativo (Android)

## Início Rápido

### Pré-requisitos

- Navegador moderno (Chrome, Firefox, Edge, Safari)
- Node.js 18+

### Rodar no Browser (dev)

```bash
git clone https://github.com/LuanOliveirags/WolfSource.git
cd WolfSource
npm install
npm run dev
```

Acesse `http://localhost:3000` e instale como PWA pelo ícone na barra de endereços.

### Configurar Firebase

1. Crie um projeto no [Firebase Console](https://console.firebase.google.com)
2. Habilite **Cloud Firestore**, **Firebase Storage** e **Firebase Authentication**
3. Adicione o domínio de produção em Authentication → Settings → Authorized domains
4. Atualize as credenciais em `packages/services/firebase/firebase.config.js`:

```js
export const firebaseConfig = {
  apiKey:            'sua-api-key',
  authDomain:        'seu-projeto.firebaseapp.com',
  projectId:         'seu-projeto-id',
  storageBucket:     'seu-projeto.appspot.com',
  messagingSenderId: 'seu-messaging-id',
  appId:             'seu-app-id'
};
```

5. Configure o backend Flask com a variável `FIREBASE_SERVICE_ACCOUNT_JSON` (JSON da service account do Firebase)

## Build Android (APK)

O frontend é empacotado com **Capacitor 6** — zero mudança no código, mesma lógica, mesmo Firebase.

### Pré-requisitos

- [Android Studio](https://developer.android.com/studio) (SDK Android 34)
- `google-services.json` do Firebase Console → coloque em `android/app/`

### Gerar APK de Debug

```bash
npm install
npm run sync   # monta www/ + sincroniza com Android (cwd: apps/mobile/)

JAVA_HOME="C:/Program Files/Android/Android Studio/jbr" \
  ./apps/mobile/android/gradlew -p apps/mobile/android assembleDebug
```

APK em: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`

### APK de Release

```bash
npm run open:android
# Android Studio → Build → Generate Signed App Bundle / APK → APK
```

## Arquitetura

```
WolfSource/
├── apps/
│   ├── web/
│   │   ├── public/                    # Assets estáticos (index.html, SW, manifest)
│   │   └── src/
│   │       ├── app/
│   │       │   ├── bootstrap.js       # Entry point — init Firebase, auth, UI
│   │       │   └── router.js          # Carrega fragmentos HTML dos módulos
│   │       └── features/
│   │           ├── dashboard/         # KPIs, gráficos, resumo mensal
│   │           ├── transactions/      # Controller CRUD de transações
│   │           ├── salaries/          # Controller de salários
│   │           ├── debts/             # Controller de dívidas
│   │           ├── shopping/          # Controller lista de compras
│   │           ├── chores/            # Controller tarefas domésticas
│   │           └── chat/              # Chat realtime
│   └── mobile/
│       ├── capacitor.config.json
│       └── android/
│
├── packages/
│   ├── core/state/
│   │   └── store.js                   # Estado global (isLoggedIn, currentUser, etc.)
│   ├── services/
│   │   ├── firebase/
│   │   │   ├── firebase.config.js     # Config pública + BACKEND_URL + constantes
│   │   │   ├── firebase.init.js       # Live-bindings: db, storage, auth, firebaseReady
│   │   │   ├── firebase.crud.js       # saveToFirebase, deleteFromFirebase, updateInFirebase
│   │   │   ├── firebase.service.js    # Orquestração + sync + re-exports (compat)
│   │   │   └── fcm.service.js         # Firebase Cloud Messaging
│   │   ├── auth/
│   │   │   └── auth.service.js        # Login SHA-256, signInWithFirebase, roles, família
│   │   ├── transactions/
│   │   │   └── transactions.service.js  # buildTransactionObject, filterTransactions, groupByDate
│   │   ├── salaries/
│   │   │   └── salaries.service.js    # buildSalaryObject, computeSalaryStats
│   │   ├── debts/
│   │   │   └── debts.service.js       # buildDebtObject, computeDebtStats, computeAlerts
│   │   ├── shopping/
│   │   │   └── shopping.service.js    # createList, addItem, toggleItem, finalizeList
│   │   ├── chores/
│   │   │   └── chores.service.js      # loadChores, saveChores, computeStats
│   │   └── notifications/
│   │       └── notification.service.js
│   ├── ui/navigation/
│   │   └── navigation.js              # Header, bottom nav, login form, FAB
│   └── utils/
│       ├── helpers.js
│       └── capacitor.bridge.js
│
├── functions/                         # Backend — Cloud Functions (Python)
├── backend/                           # (desativado) antiga API Flask do Railway
│   ├── app.py                         # Rotas Flask + endpoint /api/auth/token
│   └── requirements.txt
│
├── firestore.rules                    # Regras de segurança do Firestore
├── firestore.indexes.json
└── firebase.json                      # Hosting + Firestore config
```

### Padrão Service / Controller

Toda feature segue separação estrita:

| Camada | Local | Responsabilidade |
|---|---|---|
| **Service** | `packages/services/{mod}/{mod}.service.js` | Lógica pura — sem DOM, sem Firebase |
| **Controller** | `apps/web/src/features/{mod}/{mod}.js` | DOM, eventos, Firebase, orquestração |

## Stack

### Frontend
| Tecnologia | Uso |
|---|---|
| HTML5 / CSS3 / JS ES2022 | Vanilla — sem framework |
| ES Modules nativos | Módulos do browser sem bundler |
| Chart.js 4 | Gráficos do dashboard |
| Firebase SDK 10 (compat) | Firestore, Storage, Auth, FCM |
| Capacitor 6 | Empacotamento Android |
| Service Worker v23 | Cache-first offline PWA |

### Backend
| Tecnologia | Uso |
|---|---|
| Python 3.8+ / Flask | API REST + emissão de custom tokens |
| firebase-admin 6 | Firestore Admin + Firebase Auth Admin |
| Flask-CORS | Suporte a preflight CORS |
| Cloud Functions | Backend (token de login, push, leitura de extratos por IA) |

### Banco de Dados
- **Cloud Firestore** — dados em tempo real (transações, dívidas, salários, chat, usuários, famílias)
- **Firebase Storage** — fotos de perfil
- **localStorage** — cache offline por família (`familyId`)

## Segurança

### Fluxo de Autenticação

```
Login SHA-256 (browser)
  → POST /api/auth/token (Cloud Function)
      → Valida users/{userId}.familyId no Firestore Admin
      → set_custom_user_claims(uid, { familyId })
      → create_custom_token(uid)
  → signInWithCustomToken(token) (Firebase Auth SDK)
  → request.auth.token.familyId ativo nas Firestore Rules
```

### Firestore Security Rules

```
transactions / debts / salaries / shoppingLists
  → read/write somente se request.auth.token.familyId == doc.familyId

users
  → read: público (necessário para login e select de família)
  → create/update/delete: superadmin (qualquer usuário) ou admin (mesma família)

families
  → read: público
  → write: superadmin ou membro da família

conversations / messages
  → read/write: somente participantes da conversa (participantIds[])

passwordResets
  → read/write: público (fluxo sem auth)
```

### Resumo de Segurança

| Área | Abordagem |
|---|---|
| Autenticação | SHA-256 + Firebase Auth custom token com claim `familyId` |
| Isolamento de dados | Firestore Security Rules — nenhuma família acessa dados de outra |
| Claims JWT | `set_custom_user_claims` — persistentes em todos os refreshes |
| Credenciais Firebase | Config de cliente é pública por design (Firebase SDK) |
| Service Account | Conta padrão do Cloud Functions (papel Criador de token da conta de serviço) |
| Domínios autorizados | Firebase Console → Authentication → Authorized domains |

## Backend (Cloud Functions do Firebase)

O backend é uma Cloud Function Python (2ª geração) chamada `api`, em `functions/main.py`.
URL base: `https://us-central1-financeiro-lopes.cloudfunctions.net` (constante `BACKEND_URL` em
`packages/services/firebase/firebase.config.js`). A mesma URL atende site, previews, APK e dev local;
as origens permitidas estão no CORS da função.

```
POST /api/auth/token         userId + familyId → custom token do Firebase Auth (claims familyId e role)
POST /api/fcm/send           push do chat            (exige Authorization: Bearer <ID token>)
POST /api/statements/parse   PDF ≤ 20 MB / foto ≤ 5 MB (multipart "file") → lançamentos via Claude
                             { bank, transactions: [{ date, description, amount, type }], warnings }
                                                     (exige Authorization: Bearer <ID token com familyId>)
GET  /api/health
```

> A pasta `backend/` (Flask no Railway) está **desativada** e não é usada pelo app.

### Deploy das Functions (manual)

Pré-requisitos, uma única vez:

1. Projeto no plano **Blaze** (Firebase Console → Uso e faturamento). Cloud Functions e chamadas
   externas (API da Anthropic) não rodam no plano gratuito.
2. Chave da Anthropic como secret (o deploy falha sem ela):
   ```bash
   firebase functions:secrets:set ANTHROPIC_API_KEY
   ```
3. Permissão para a função emitir o token de login (`create_custom_token` assina com a conta de serviço
   padrão). No Google Cloud Console → IAM, dê à conta
   `621443570583-compute@developer.gserviceaccount.com` o papel **Criador de token da conta de serviço**
   (`roles/iam.serviceAccountTokenCreator`), e ative a **IAM Service Account Credentials API**.

A cada mudança em `functions/`:

```bash
cd functions
python -m venv venv
venv\Scripts\pip install -r requirements.txt      # Linux/macOS: venv/bin/pip
cd ..
firebase deploy --only functions
```

Teste rápido: `https://us-central1-financeiro-lopes.cloudfunctions.net/api/health` deve responder `{"status": "healthy"}`.

## Infra e Deploy

| Ambiente | URL | Trigger |
|---|---|---|
| Produção | https://financeiro-lopes.web.app | Push em `main` via `deploy.yml` (Firebase Hosting, canal `live`) |
| Staging | https://financeiro-lopes--staging-9u9590k6.web.app | Push em `dev` via `deploy-staging.yml` |
| Backend | https://us-central1-financeiro-lopes.cloudfunctions.net/api | Manual: `firebase deploy --only functions` |

### Workflow de Desenvolvimento

```
feature branch → dev → validar staging → PR → merge main → produção automática
```

Nunca commitar direto em `main` — o merge para produção sempre passa pelo staging.

### Deploy das Firestore Rules

As rules **não** fazem parte do CI — deploy manual:

```bash
firebase deploy --only firestore:rules
```

## PWA

| Recurso | Status |
|---|---|
| Instalável (Add to Home Screen) | Sim |
| Offline-first (cache-first SW) | Sim |
| Notificações push background | Sim — FCM Service Worker |
| Ícones maskable | Sim — 48px → 512px |
| Service Worker | v23 |

## Roadmap

### Concluído
- [x] Autenticação customizada com roles e família
- [x] Dashboard com gráficos (Chart.js)
- [x] CRUD de transações, dívidas e salários
- [x] Lista de compras e tarefas domésticas
- [x] Chat em tempo real com FCM
- [x] PWA com modo offline
- [x] APK Android via Capacitor
- [x] Notificações push nativas Android
- [x] Arquitetura service/controller — 6 módulos refatorados
- [x] Firebase split — firebase.init / firebase.crud / firebase.service
- [x] Infra de staging (Firebase Hosting Preview Channel)
- [x] Segurança multiusuário — Firebase Auth custom token + Firestore rules
- [x] Isolamento por família via claim `familyId` no JWT

### Em Desenvolvimento
- [ ] Relatórios PDF exportáveis
- [ ] Metas e orçamentos mensais
- [ ] Alertas personalizados por categoria

### Planejado
- [ ] Integração Open Banking
- [ ] Categorização automática com ML
- [ ] Reconhecimento de recibos via OCR
- [ ] Exportação Excel / CSV
- [ ] Multi-idioma (i18n)

## Autor

Desenvolvido por **Luan Gs**
