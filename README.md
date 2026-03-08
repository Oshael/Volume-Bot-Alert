# Volume Alert Server — Etapa 1

Backend server para o Volume Alert Bot com autenticação, sistema de convites e segurança.

## Requisitos

- **Node.js** 18+
- **PostgreSQL** 14+

## Setup rápido

### 1. Instalar dependências
```bash
cd volume-alert-server
npm install
```

### 2. Criar banco de dados
```sql
-- No psql ou pgAdmin:
CREATE DATABASE volume_alert;
```

### 3. Configurar .env
```bash
cp .env.example .env
# Edite .env com suas credenciais
# IMPORTANTE: gere um JWT_SECRET único:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 4. Inicializar tabelas
```bash
npm run db:init
```

### 5. Criar primeiro convite (bootstrap)
```bash
npm run invite:create
# Anote o código gerado — expire em 24h
```

### 6. Iniciar o servidor
```bash
npm start        # produção
npm run dev      # desenvolvimento (auto-reload)
```

### 7. Registrar primeiro usuário
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","email":"admin@example.com","password":"senhasegura123","inviteCode":"CÓDIGO_DO_PASSO_5"}'
```

### 8. Promover a admin
```sql
UPDATE users SET role = 'admin' WHERE username = 'admin';
```

## Endpoints

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| GET | /api/health | ❌ | Status do servidor |
| POST | /api/auth/register | ❌ | Registro (requer invite) |
| POST | /api/auth/login | ❌ | Login |
| POST | /api/auth/logout | ✅ | Logout (sessão atual) |
| POST | /api/auth/logout-all | ✅ | Logout de todas sessões |
| GET | /api/auth/me | ✅ | Dados do usuário |
| POST | /api/auth/change-password | ✅ | Trocar senha |
| POST | /api/invites | ✅ | Criar convite |
| GET | /api/invites | ✅ | Listar meus convites |
| GET | /api/invites/all | 🔒 Admin | Listar todos convites |
| GET | /api/invites/validate/:code | ❌ | Validar convite |
| DELETE | /api/invites/:id | ✅ | Revogar convite |

## Segurança implementada

- **bcrypt** — hash de senhas com 12 rounds
- **JWT** — tokens com expiração configurável (padrão: 7 dias)
- **Sessions** — tracking de sessões ativas, revogáveis individualmente ou em massa
- **Rate limiting** — geral (100 req/15min) + auth endpoints (10 req/15min)
- **Lockout** — 5 tentativas falhas por email ou 10 por IP = bloqueio de 15 min
- **Helmet** — headers de segurança HTTP
- **CORS** — origins configuráveis
- **Auditoria** — todas tentativas de login registradas (IP, user-agent, sucesso/falha)
- **Invite-only** — registro só com código de convite válido
- **Session cleanup** — sessões expiradas e login attempts antigos limpos a cada hora

## Rodar testes

```bash
# Criar banco de teste
# psql: CREATE DATABASE volume_alert_test;

# Configurar .env com DB_NAME=volume_alert_test
# Depois:
npm run db:init
npm test
```

## Estrutura

```
volume-alert-server/
├── config/
│   └── index.js           # Configuração centralizada
├── src/
│   ├── server.js           # Express app principal
│   ├── middleware/
│   │   ├── auth.js         # JWT + session validation
│   │   └── rate-limit.js   # Rate limiting
│   ├── models/
│   │   ├── db.js           # Pool PostgreSQL
│   │   ├── user.js         # User CRUD + bcrypt
│   │   ├── invite.js       # Invite CRUD
│   │   ├── session.js      # Session tracking
│   │   └── login-attempt.js # Login audit
│   ├── routes/
│   │   ├── auth.js         # Register, login, logout
│   │   ├── invites.js      # Invite management
│   │   └── health.js       # Health check
│   └── utils/
│       ├── db-init.js      # Create tables
│       └── create-invite.js # Bootstrap invite
├── tests/
│   └── auth.test.js        # Test suite completa
├── .env.example
├── .gitignore
├── package.json
└── README.md
```
