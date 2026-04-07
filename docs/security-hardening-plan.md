# Security Hardening Plan

## Purpose

Este documento organiza os 5 pontos de seguranca levantados no review em blocos bem divididos, com foco no codigo real atual do bot.

O objetivo nao e "fazer uma limpeza generica de seguranca".

O objetivo e:

- fechar riscos concretos que existem hoje
- evitar bypass backend-side, nao so cosmetica de UI
- reduzir superficie de vazamento de dados
- endurecer integracoes sensiveis sem quebrar o fluxo atual do bot

Este plano e intencionalmente baseado no estado atual do repositorio.

## Current Code Reality

Os pontos abaixo nao vieram de teoria. Eles vieram destas areas:

- CORS / origin trust:
  - `src/utils/request-security.js`
  - `src/middleware/auth.js`
- cookies / sessao:
  - `config/index.js`
  - `src/services/auth-session.js`
  - `src/services/pre-access-session.js`
- billing / webhook:
  - `src/routes/billing.js`
  - `src/services/billing-service.js`
  - `src/services/moonpay-commerce.js`
- websocket / rate limit:
  - `src/services/socket-hub.js`
  - `src/middleware/rate-limit.js`
- health:
  - `src/routes/health.js`

## Risk Summary

### 1. Preview Vercel pode ler dados autenticados

Risco atual:

- `src/utils/request-security.js` aceita `volume-bot-alert-frontend.vercel.app`
- tambem aceita `volume-bot-alert-frontend-*.vercel.app`
- cookies em producao usam `SameSite=None`
- requests `GET` nao passam pelo `requireTrustedOrigin`

Consequencia:

- um preview deployment confiado em excesso pode conseguir ler dados autenticados via browser se o usuario estiver logado

### 2. Rate limit e limites de socket dependem de `X-Forwarded-For`

Risco atual:

- IP e resolvido a partir de `x-forwarded-for`
- esse IP alimenta rate limit e limites por socket

Consequencia:

- se o proxy estiver errado, ou se o app receber trafego direto, um atacante pode spoofar IP e enfraquecer limites

### 3. Webhook de billing confia demais no payload

Risco atual:

- o webhook exige bearer token
- mas o processamento ainda depende demais de campos recebidos no body
- falta reconciliacao mais forte entre order local, charge e dados do provider

Consequencia:

- se o token do webhook vazar, o caminho de concessao de acesso fica exposto demais

### 4. `/api/health` devolve mensagem interna crua

Risco atual:

- em falha de DB, a resposta publica inclui `err.message`

Consequencia:

- isso vaza detalhe tecnico desnecessario para endpoint publico

### 5. Mock checkout e publico quando mock mode esta ligado

Risco atual:

- as rotas de mock checkout sao publicas
- mock mode so e barrado em `production`, nao em qualquer ambiente sensivel

Consequencia:

- staging / ambiente intermediario mal configurado pode liberar credito de acesso sem controle

## Recommended Order

Ordem recomendada de execucao:

1. bloco 4: sanitizar `/api/health`
2. bloco 5: endurecer mock checkout
3. bloco 1: restringir origins de preview
4. bloco 2: corrigir trust de IP/proxy
5. bloco 3: endurecer webhook MoonPay

Motivo:

- `4` e `5` sao baratos e reduzem risco rapido
- `1` fecha exposicao cross-origin sem reescrever arquitetura
- `2` depende de alinhamento com infra
- `3` e o bloco mais sensivel e merece execucao dedicada

## Block 1: Restrict Preview-Origin Access

### Goal

Remover confianca excessiva em previews Vercel e deixar CORS/origin trust explicito e auditavel.

### Current Code

Arquivos principais:

- `src/utils/request-security.js`
- `config/index.js`
- `src/server.js`
- `frontend/vercel.json`

### Desired End State

- apenas origins explicitamente aprovadas podem ler respostas autenticadas cross-origin
- previews Vercel nao entram automaticamente por padrao
- qualquer excecao de preview passa por env/config explicita

### Implementation Blocks

#### Block 1A. Tirar wildcard de preview do codigo

Mudancas:

- remover:
  - `volume-bot-alert-frontend.vercel.app`
  - `volume-bot-alert-frontend-*.vercel.app`
  de `src/utils/request-security.js`
- depender de `CORS_ORIGINS` como allowlist primaria

Validacao:

- o frontend oficial continua funcionando
- preview nao consegue ler `GET /api/config` com credenciais por padrao

#### Block 1B. Revisar CSP / connect-src legados

Mudancas:

- alinhar `frontend/vercel.json`
- alinhar CSP do backend em `src/server.js`
- manter so os hosts realmente necessarios

Validacao:

- frontend oficial continua conectando em API e websocket
- remover host legado nao quebra producao

#### Block 1C. Decidir politica de preview

Opcoes:

- opcao preferida:
  - preview sem acesso a dados autenticados
- opcao alternativa:
  - preview liberado so por env explicita e temporaria

### Testing / Validation

- teste manual com origin oficial
- teste manual com origin preview
- revisar `Set-Cookie`, CORS e requests `credentials: include`

### Difficulty

Facil a medio

### Main Risk

Quebrar preview que hoje depende de acesso autenticado

## Block 2: Harden IP / Proxy Trust

### Goal

Garantir que rate limit, logs e limites por socket usem IP confiavel, nao header cru controlado pelo cliente.

### Current Code

Arquivos principais:

- `src/utils/request-security.js`
- `src/middleware/rate-limit.js`
- `src/services/socket-hub.js`
- `src/server.js`

### Desired End State

- o app confia no IP resolvido pelo proxy de forma consistente
- `X-Forwarded-For` nao e tratado como verdade absoluta
- rate limit e socket caps continuam funcionando atras de nginx

### Implementation Blocks

#### Block 2A. Centralizar estrategia de IP confiavel

Mudancas:

- revisar `getRequestIp()` e `getSocketClientIp()`
- parar de preferir `x-forwarded-for` cru sem validacao
- usar uma estrategia consistente com `trust proxy`

Direcao sugerida:

- HTTP:
  - priorizar `req.ip` corretamente normalizado pelo Express
- socket:
  - usar valor resolvido pela camada confiavel de proxy, nao header solto

#### Block 2B. Documentar requisito de nginx

Mudancas:

- adicionar nota operacional no doc certo ou runbook
- deixar explicito que nginx deve sobrescrever `X-Forwarded-For`

#### Block 2C. Validar impacto em rate limit

Mudancas:

- revisar geradores de key em `src/middleware/rate-limit.js`
- revisar caps de socket por IP em `src/services/socket-hub.js`

### Testing / Validation

- requests repetidos com e sem proxy
- tentativa com `X-Forwarded-For` forjado
- validar que `req.ip` permanece estavel em producao-like

### Difficulty

Media

### Main Risk

Quebrar leitura de IP real em producao se a correcao for feita sem alinhar proxy

## Block 3: Harden Billing Webhook

### Goal

Garantir que concessao de acesso por pagamento dependa de validacao forte do evento, nao so de um payload plausivel.

### Current Code

Arquivos principais:

- `src/routes/billing.js`
- `src/services/billing-service.js`
- `src/services/moonpay-commerce.js`
- `src/models/billing-order.js`
- `src/models/billing-event.js`

### Desired End State

- o webhook nao concede acesso so porque recebeu um body bem formado
- order local, charge do provider, amount e status sao reconciliados
- se o webhook token vazar, ainda existe uma segunda camada forte de defesa

### Implementation Blocks

#### Block 3A. Validar consistencia local minima

Mudancas:

- antes de marcar `paid`, validar contra o pedido salvo:
  - `orderId`
  - `providerChargeId`
  - `planKey`
  - `currency`
  - `amount`
  - `userId` quando houver equivalente confiavel no metadata

Resultado esperado:

- payload inconsistente nao credita acesso

#### Block 3B. Reconciliar com MoonPay

Mudancas:

- quando houver `providerChargeId`, consultar o provider
- comparar resposta do provider com o pedido local
- so marcar `paid` quando a charge consultada bater com:
  - charge id
  - status
  - valor
  - paylink / metadata esperados

Observacao:

- este e o nucleo real da correcao

#### Block 3C. Endurecer politica de webhook token

Mudancas:

- manter token bearer
- validar presenca obrigatoria
- considerar rotacao / multiplos tokens ativos como politica operacional

#### Block 3D. Melhorar auditoria

Mudancas:

- registrar com clareza:
  - motivo de rejeicao
  - divergencia entre payload e order
  - divergencia entre MoonPay e order local

### Testing / Validation

Sem pagamento real obrigatorio:

- testes automatizados de webhook com payload valido
- testes automatizados com payload inconsistente
- testes com mock de resposta MoonPay
- teste sandbox se disponivel

Opcional depois:

- 1 teste real controlado em ambiente seguro

### Difficulty

Media a dificil

### Main Risk

Quebrar o fluxo de confirmacao se a reconciliacao for implementada sem mapear corretamente o formato real da MoonPay

## Block 4: Sanitize Public Health Response

### Goal

Parar de expor detalhes internos de erro no endpoint publico de health.

### Current Code

Arquivo principal:

- `src/routes/health.js`

### Desired End State

- resposta publica continua util para monitoramento
- detalhes sensiveis ficam em log interno

### Implementation Blocks

#### Block 4A. Sanitizar resposta publica

Mudancas:

- substituir `db.error: err.message` por algo generico
- exemplo:
  - `db: { connected: false }`
  - `error: 'Database unavailable'`

#### Block 4B. Preservar diagnostico interno

Mudancas:

- manter detalhe completo em log interno
- manter `security-event` para falhas repetidas

### Testing / Validation

- simular falha de DB
- confirmar que resposta publica nao vaza detalhe tecnico
- confirmar que logs internos continuam uteis

### Difficulty

Facil

### Main Risk

Praticamente so perder detalhe demais no endpoint, o que se resolve mantendo bom log interno

## Block 5: Lock Down Mock Checkout

### Goal

Evitar que mock checkout fique exposto em qualquer ambiente que nao seja estritamente local/controlado.

### Current Code

Arquivos principais:

- `src/routes/billing.js`
- `config/index.js`
- `src/services/billing-catalog.js`

### Desired End State

- mock checkout nunca fica publico por acidente em staging
- mock mode so roda em ambiente explicitamente seguro

### Implementation Blocks

#### Block 5A. Restringir mock mode para ambiente local

Mudancas:

- mock checkout so deve existir quando:
  - `NODE_ENV=development`
  - e/ou host local
  - e/ou env explicita de override segura

Melhor direcao:

- nao basta `nodeEnv !== 'production'`
- staging tambem deve ser tratado como sensivel

#### Block 5B. Exigir autenticacao forte ou admin

Mudancas:

- mesmo em mock mode, proteger rotas com auth
- opcionalmente limitar a admin

#### Block 5C. Opcional: remover endpoint HTML publico

Direcao:

- manter apenas API interna/test helper
- ou esconder completamente fora de fluxo local de desenvolvimento

### Testing / Validation

- em desenvolvimento local:
  - mock continua funcionando
- em staging-like:
  - rota retorna `404` ou `403`

### Difficulty

Facil

### Main Risk

Quebrar conveniencia de dev se a protecao ficar dura demais sem uma alternativa local clara

## Cross-Cutting Validation Plan

Depois de cada bloco:

- rodar `npm run lint`
- se houver mudanca de frontend, rodar `npm --prefix frontend run build`
- rodar `node --test` nos testes afetados
- revisar `git diff` antes de propor commit

Testes que provavelmente vao precisar ser criados ou ajustados:

- CORS / origin cases
- trusted-origin / CSRF-style request rejection
- webhook validation matrix
- health response sanitization
- mock checkout availability rules

## Suggested Commit Split

Separar por escopo:

1. `security: sanitize public health response`
2. `security: lock down mock checkout`
3. `security: restrict trusted frontend origins`
4. `security: harden proxy-aware IP resolution`
5. `security: reconcile moonpay webhook before granting access`

## Ponto importantes

- O bot hoje nao parece depender so de UI para liberar acesso principal; isso e bom e deve ser preservado.
- O ponto mais perigoso em potencial e o webhook de billing.
- O ponto com maior chance de vazamento silencioso de dados e a politica ampla de origins para preview.
- O ponto de IP/proxy nao deve ser alterado no escuro; precisa combinar codigo e infra.
- O mock checkout deve ser tratado como ferramenta local, nao como feature de ambiente intermediario.
