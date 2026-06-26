# Plano de implementação: acesso por wallet e saldo do token

## Objetivo

Permitir que um usuário conecte uma wallet Solana, prove posse da wallet por assinatura e tenha benefícios no bot conforme o saldo direto do token lançado na PumpFun.

Regras de produto aprovadas:

- saldo direto na wallet, sem somar LP, staking, CEX ou wallets secundárias
- 1 wallet por conta
- a mesma wallet não pode ser vinculada a mais de uma conta
- login por wallet deve existir para usuários com saldo suficiente
- username gerado automaticamente com os últimos 4 caracteres da wallet, com opção de mudar depois
- `>= 2.000.000` tokens: acesso token-gated ilimitado enquanto o saldo continuar nesse nível
- `>= 1.000.000` tokens: 50% de desconto nos planos pagos
- primeiras 2 semanas do token: `>= 100.000` tokens ganha free access temporário
- se o saldo confirmado cair abaixo do threshold, perde o benefício correspondente
- se o usuário comprar um plano com desconto, o período pago continua válido mesmo se vender os tokens depois
- tolerância operacional de 30 a 60 minutos apenas para falha de RPC/indexador, não para saldo confirmado abaixo do threshold

## Baseline validado no repositório

Arquivos relevantes atuais:

- `src/models/user.js`
- `src/models/user-access.js`
- `src/middleware/auth.js`
- `src/routes/auth.js`
- `src/routes/pre-access.js`
- `src/routes/billing.js`
- `src/services/billing-service.js`
- `src/services/billing-catalog.js`
- `src/services/moonpay-commerce.js`
- `src/services/helius.js`
- `src/models/billing-order.js`
- `src/utils/db-init.js`
- `src/utils/runtime-schema.js`
- `frontend/src/state/app-controller.ts`
- `frontend/src/state/app-state.ts`
- `frontend/src/ui/app-shell.ts`

Fatos importantes do código atual:

- O login principal hoje é email + senha + OTP.
- O cadastro normal exige invite, email e senha.
- `users.email` e `users.password_hash` são `NOT NULL` no schema atual.
- O acesso ao produto hoje é calculado principalmente por `users.access_status`, `users.access_expires_at` e `users.access_source`.
- `src/models/user-access.js` aceita fontes `manual`, `payment`, `admin`, `promo`, `invite`; ainda não existe fonte `token`.
- `src/middleware/auth.js` usa `userAccess.buildAccessSnapshot(user)` para decidir se o usuário entra no bot.
- Pagamento confirmado por MoonPay chama `userAccess.extendForUserWithRunner(..., source: 'payment')`.
- `src/services/helius.js` já tem cliente Helius com `getTokenAccounts`, `getTokenSupply` e outros métodos RPC/DAS.

Conclusão técnica:

Não devemos implementar token-gating apenas gravando `users.access_status = active`. Isso conflita com a arquitetura atual, porque saldo de token é dinâmico e pode cair a qualquer momento, enquanto o acesso pago é um crédito de dias que deve continuar válido mesmo após venda dos tokens. A solução correta é criar uma camada separada de entitlement/token snapshot e fazer um resolver decidir o acesso final.

## Modelo do token PumpFun

Assumiremos Solana token fungível lançado pela PumpFun.

Depois do lançamento, precisamos confirmar:

- mint address
- token program usado pelo mint
- decimals reais do mint
- supply real via RPC

Não devemos hardcodar decimals. O supply padrão informado é 1 bilhão, mas o cálculo de thresholds deve usar `decimals` obtido por RPC, não `Number`.

Referências úteis:

- Solana RPC `getTokenAccountsByOwner`: usado para consultar contas SPL Token de uma wallet por mint.
- Solana RPC `getTokenSupply`: usado para confirmar supply e decimals do mint.

## Regra exata de saldo

O backend deve comparar saldo usando inteiros em unidades raw do token.

Exemplo:

```txt
thresholdWholeTokens = 2_000_000
thresholdRaw = BigInt(thresholdWholeTokens) * (10n ** BigInt(decimals))
eligible = walletBalanceRaw >= thresholdRaw
```

Isso evita erro com floats e deixa a regra objetiva:

- `2.000.000` tokens inteiros ou mais: acesso token-gated
- `1.999.999,999...` tokens: perde acesso token-gated
- `2.000.000` vendendo `1` token inteiro vira `1.999.999`: perde acesso token-gated

Para desconto:

```txt
discountThresholdRaw = 1_000_000 * 10^decimals
discountEligible = walletBalanceRaw >= discountThresholdRaw
```

Para free access das duas primeiras semanas:

```txt
launchPromoThresholdRaw = 100_000 * 10^decimals
promoEligible = now between promoStartAt and promoEndAt
  AND walletBalanceRaw >= launchPromoThresholdRaw
```

## Helius é obrigatório?

Não.

Opções viáveis:

1. Helius
   - Melhor encaixe para o projeto agora, porque já existe `src/services/helius.js`.
   - Menor esforço inicial.
   - Pode usar DAS `getTokenAccounts` ou RPC padrão por trás.

2. RPC Solana padrão
   - Qualquer endpoint RPC confiável pode usar `getTokenAccountsByOwner` e `getTokenSupply`.
   - Exemplos de provedores: QuickNode, Alchemy, Chainstack, Triton, Syndica, Ankr ou RPC próprio.
   - Exige criar/adaptar cliente genérico no projeto.

3. Indexador próprio
   - Mais controle e menor dependência externa.
   - Mais custo operacional.
   - Não recomendo para MVP.

Recomendação para MVP:

- usar Helius como provider primário, porque já está integrado
- desenhar a interface como `tokenBalanceProvider`, para trocar Helius por outro RPC depois sem reescrever auth/billing
- opcionalmente adicionar provider fallback em bloco posterior

## Modelo de acesso final

O acesso final do usuário deve ser resolvido por prioridade, não por um único campo em `users`.

Ordem recomendada:

1. `is_active = false`: bloqueio total
2. `role = admin`: acesso total
3. `users.access_status = revoked`: bloqueio total
4. acesso pago/manual/invite/promo atual: acesso até expirar
5. token tier `>= 2.000.000`: acesso enquanto saldo confirmado ou snapshot válido dentro da tolerância
6. promo de lançamento `>= 100.000`: acesso até fim da janela de 2 semanas
7. sem entitlement: sem acesso ao bot, mas pode entrar no fluxo de pagamento quando tiver conta vinculada

O resolver deve retornar também:

- `accessReason`: `admin`, `payment`, `invite`, `token_unlimited`, `token_launch_promo`, `none`
- `tokenTier`: `unlimited`, `discount_50`, `launch_free`, `none`
- `discountPercent`: `50` ou `0`
- `tokenBalanceUi`
- `tokenBalanceRaw`
- `tokenSnapshotCheckedAt`
- `tokenSnapshotExpiresAt`
- `requiresAccountCompletion`

## Fluxo de login por wallet

### 1. Challenge

Frontend pede ao backend um challenge:

```txt
POST /api/wallet-auth/challenge
```

Backend cria nonce curto, salva hash e retorna mensagem para assinar.

A mensagem deve conter:

- domínio/app
- wallet address
- nonce
- issued at
- expires at
- intenção: login no bot

### 2. Assinatura

Frontend chama `signMessage` na wallet.

Para MVP, pode começar com Phantom/Solana provider detectado em `window.solana`. Depois pode evoluir para wallet adapter/Wallet Standard.

### 3. Verificação backend

Backend valida:

- challenge existe
- challenge não expirou
- challenge não foi usado
- assinatura Ed25519 bate com a public key da wallet
- wallet address é Solana pubkey válida

### 4. Conta

Se a wallet já estiver vinculada:

- carregar usuário existente
- atualizar `last_login`
- atualizar snapshot do saldo
- resolver acesso
- emitir sessão normal apenas se tiver acesso final

Se a wallet for nova e saldo `>= 2.000.000` ou estiver na promo de lançamento com `>= 100.000`:

- criar usuário interno automaticamente
- gerar username com últimos 4 caracteres da wallet
- resolver conflito de username adicionando sufixo curto
- vincular wallet
- emitir sessão normal se o entitlement permitir

Se a wallet for nova e não tiver acesso por token:

- não criar uma conta completa silenciosa
- mostrar opção para criar/vincular conta normal e comprar plano integral

### 5. Username automático

Regra recomendada:

```txt
wallet = 7v3ABC...9xYz
base = user_9xYz
se existir: user_9xYz_2, user_9xYz_3, ...
```

Esse username deve ser editável depois no perfil.

### 6. Conflito com schema atual

O schema atual exige `email` e `password_hash`.

Para suportar wallet-only sem pedir email/senha, existem duas opções:

1. Alterar `users.email` e `users.password_hash` para aceitarem `NULL`.
2. Criar usuário interno com email sintético e password hash sentinela.

Recomendação pragmática para MVP:

- manter `users` compatível criando email sintético não utilizável, por exemplo `wallet_<address>@wallet.local`
- criar `auth_method = wallet` ou metadata equivalente em tabela separada
- bloquear login por email para contas wallet-only sem email real
- quando o usuário quiser pagar plano normal após vender tokens, pedir email/senha e converter a conta para conta completa

Essa abordagem reduz risco de quebrar login, billing, admin e testes existentes.

## Tabelas novas

### `user_wallets`

Armazena vínculo 1:1 entre usuário e wallet.

Campos:

- `id`
- `user_id`
- `wallet_address`
- `chain = solana`
- `wallet_provider`
- `is_primary`
- `linked_at`
- `last_login_at`
- `last_verified_at`
- `metadata`

Constraints:

- unique `wallet_address`
- unique `user_id` para garantir 1 wallet por conta

### `wallet_auth_challenges`

Armazena nonces de assinatura.

Campos:

- `id`
- `wallet_address`
- `nonce_hash`
- `message_hash`
- `issued_at`
- `expires_at`
- `consumed_at`
- `ip_address`
- `user_agent`

Regras:

- nonce expira rápido, por exemplo 5 minutos
- nonce é single-use

### `token_holding_snapshots`

Armazena resultado das verificações de saldo.

Campos:

- `id`
- `user_id`
- `wallet_address`
- `mint_address`
- `token_program`
- `decimals`
- `balance_raw`
- `balance_ui_string`
- `tier`
- `discount_percent`
- `has_unlimited_access`
- `has_launch_promo_access`
- `checked_at`
- `expires_at`
- `rpc_provider`
- `rpc_slot`
- `rpc_error`
- `metadata`

Regras:

- não usar `Number` para `balance_raw`
- salvar `balance_raw` como string ou numeric/decimal sem conversão para float
- `expires_at` deve refletir a tolerância operacional configurada

## Configuração necessária

Adicionar variáveis de ambiente/config:

```txt
TOKEN_GATE_ENABLED=true
TOKEN_GATE_MINT_ADDRESS=
TOKEN_GATE_CHAIN=solana
TOKEN_GATE_RPC_PROVIDER=helius
TOKEN_GATE_BALANCE_CACHE_SECONDS=60
TOKEN_GATE_RPC_FAILURE_GRACE_SECONDS=3600
TOKEN_GATE_UNLIMITED_THRESHOLD=2000000
TOKEN_GATE_DISCOUNT_THRESHOLD=1000000
TOKEN_GATE_DISCOUNT_PERCENT=50
TOKEN_GATE_LAUNCH_PROMO_ENABLED=true
TOKEN_GATE_LAUNCH_PROMO_START_AT=
TOKEN_GATE_LAUNCH_PROMO_END_AT=
TOKEN_GATE_LAUNCH_PROMO_THRESHOLD=100000
```

Observação:

- `TOKEN_GATE_RPC_FAILURE_GRACE_SECONDS` pode ser 1800 a 3600 para a tolerância de 30 a 60 minutos.
- a janela de 2 semanas precisa ser timestamp explícito, não “duas semanas a partir do deploy”, para evitar divergência operacional.

## Billing com desconto

Regra:

- desconto só se aplica no momento de criar o pedido
- backend deve recalcular saldo antes de criar o checkout
- usuário abaixo de `1.000.000` paga valor integral
- usuário `>= 1.000.000` e `< 2.000.000` paga 50%
- usuário `>= 2.000.000` não precisa comprar para acessar, mas ainda pode comprar se quiser
- se pagou com desconto e depois vendeu, o período comprado continua válido

Mudanças necessárias:

- `billing-service.createOrderForUser` deve receber contexto de desconto calculado pelo backend
- `billing_orders.metadata` deve registrar:
  - saldo raw no momento do pedido
  - tier usado
  - desconto aplicado
  - preço base
  - preço final
  - snapshot id
- validação de webhook deve comparar valor final do pedido com o valor confirmado pelo provider

Ponto crítico:

O billing agora suporta paylink dinâmico por plano. Quando `providerPaylinkDynamic: true`, o backend usa o mesmo `providerPaylinkId` e envia `requestAmount` na criação da charge com o preço final calculado, incluindo desconto. `amountMinor` continua representando centavos para a UI (`1500 = USDC 15.00`), enquanto o `requestAmount` enviado ao provider usa valor decimal humano (`15` para `15 USDC`, `7.5` para `7.50 USDC`). Se um plano não for dinâmico, o fluxo antigo com `discountProviderPaylinkId` separado continua sendo o caminho seguro para desconto.

## Comportamento quando o saldo cai

Regra operacional:

- se a consulta ao saldo funcionar e retornar abaixo do threshold, o benefício cai imediatamente
- se a consulta ao saldo falhar, manter último snapshot válido por 30 a 60 minutos
- se passar da tolerância sem nova confirmação, remover acesso token-gated por segurança

Isso evita duas falhas:

- não derruba usuários por instabilidade temporária do provider
- não mantém acesso indefinido após venda do token

Quando o acesso token-gated cair:

- se o usuário ainda tiver acesso pago ativo, continua no bot
- se não tiver acesso pago, sessão normal deve ser encerrada ou forçada para tela de acesso/pagamento
- websocket deve receber evento de revogação ou reconectar sem acesso

## Revalidação híbrida de saldo

O MVP inicial usa verificação sob demanda:

- login por wallet
- conectar/verificar wallet no perfil
- criação de pedido de billing com desconto
- leitura de snapshot válido pelo resolver de acesso

No estado atual, uma verificação real de saldo via Helius consome 2 chamadas por wallet:

1. `getTokenSupply(mint)` para obter `decimals`
2. `getTokenAccounts({ owner, mint })` para somar o saldo direto da wallet

O resolver de acesso não deve chamar RPC a cada request autenticado. Ele deve usar o último snapshot válido em `token_holding_snapshots`, respeitando `TOKEN_GATE_BALANCE_CACHE_SECONDS`.

Para reduzir a janela entre venda do token e perda do benefício sem transformar cada request em chamada RPC, o desenho recomendado é híbrido:

1. Snapshot sob demanda continua sendo a fonte canônica.
   - O backend sempre recalcula saldo antes de conceder login por wallet, vincular wallet ou aplicar desconto no billing.
   - O webhook/stream nunca concede nem remove acesso diretamente.
2. Job periódico leve cobre usuários com benefício ativo.
   - Rodar apenas para wallets com tier `unlimited`, `launch_free` ou `discount_50`.
   - Intervalo inicial recomendado: 5 a 10 minutos.
   - O job cria novo snapshot e, se o saldo confirmado cair abaixo do threshold, revoga o benefício token-gated.
3. Webhook/stream marca wallets como `needs_refresh`.
   - Eventos de transferência envolvendo wallets monitoradas e o mint configurado apenas invalidam/agendam refresh.
   - O backend faz uma consulta canônica de saldo depois do evento antes de alterar acesso.
4. Grace por falha de provider é diferente de saldo confirmado baixo.
   - Se a consulta retornar saldo abaixo do threshold, o benefício cai.
   - Se a consulta falhar por erro de provider/RPC, manter o último snapshot por `TOKEN_GATE_RPC_FAILURE_GRACE_SECONDS`.

Provedores possíveis para o modo evento/stream:

- Helius Webhooks ou LaserStream
- QuickNode Streams
- Alchemy webhooks/infra Solana, se o plano suportar o evento necessário
- Triton/Yellowstone gRPC
- RPC WebSocket próprio com `accountSubscribe`

Ponto crítico:

O desenho híbrido deve tratar eventos como sinal de invalidez, não como verdade final. A verdade final continua sendo uma consulta de saldo por `mint` e `owner`, comparada em raw units com `BigInt`.

## Frontend necessário

Fluxos novos:

- botão `Login with Wallet`
- botão `Connect Wallet` em conta/perfil
- tela de assinatura da mensagem
- estado de carregamento de saldo
- exibição do tier:
  - `Unlimited enquanto mantiver 2M+`
  - `50% desconto com 1M+`
  - `Free access de lançamento com 100k+`
- aviso de última verificação e próxima revalidação
- CTA para completar conta com email/senha quando wallet-only quiser comprar plano normal
- UI para mudar username depois

Dependências:

- MVP mínimo: integração direta com `window.solana`
- versão melhor: wallet adapter/Wallet Standard para Phantom, Solflare e outras wallets

Recomendação:

- começar com provider Solana detectado no browser para reduzir escopo
- só adicionar wallet adapter completo depois que o backend estiver sólido

## Blocos de implementação

### Bloco 1: schema e modelos backend

Escopo aproximado: 250 a 350 linhas.

Entregas:

- criar estágio de DB para:
  - `user_wallets`
  - `wallet_auth_challenges`
  - `token_holding_snapshots`
- atualizar `src/utils/db-init.js`
- atualizar `src/utils/runtime-schema.js`
- criar modelos:
  - `src/models/user-wallet.js`
  - `src/models/wallet-auth-challenge.js`
  - `src/models/token-holding-snapshot.js`
- testes de modelos/schema

Validação:

- `npm run lint`
- `npm run db:schema-check`
- `node --test ...` nos testes novos/afetados

### Bloco 2: serviço de assinatura e login por wallet

Escopo aproximado: 250 a 350 linhas.

Entregas:

- `src/services/wallet-auth-service.js`
- rotas:
  - `POST /api/wallet-auth/challenge`
  - `POST /api/wallet-auth/verify`
- verificação Ed25519 da assinatura
- criação/vínculo de usuário wallet-only
- username automático baseado nos últimos 4 caracteres da wallet
- bloqueio de wallet já usada por outra conta

Decisão técnica pendente:

- usar dependências pequenas como `tweetnacl`/`bs58`, ou verificar assinatura com `crypto` nativo montando chave Ed25519 em formato correto.

Recomendação:

- usar dependências pequenas e testadas para reduzir risco criptográfico.

Validação:

- `npm run lint`
- `node --test ...` nos testes de auth/wallet

### Bloco 3: serviço de saldo e tiers

Escopo aproximado: 250 a 350 linhas.

Entregas:

- `src/services/token-holding-service.js`
- interface de provider desacoplada de Helius
- implementação inicial usando `src/services/helius.js`
- cálculo raw com `BigInt`
- leitura de decimals via `getTokenSupply`
- snapshot com tier:
  - `unlimited`
  - `discount_50`
  - `launch_free`
  - `none`
- configs do token gate

Validação:

- `npm run lint`
- `node --test ...` nos testes de token holding

### Bloco 4: access resolver e enforcement

Escopo aproximado: 250 a 350 linhas.

Entregas:

- novo resolver de acesso que combina:
  - admin
  - revoked/deactivated
  - paid/manual/invite/promo
  - token unlimited
  - launch promo
- atualizar `src/middleware/auth.js`
- atualizar auth de websocket, se existir enforcement separado
- worker/job para revalidar snapshots periodicamente
- revogação de sessão/socket quando token-gated cair e não houver acesso pago

Validação:

- `npm run lint`
- `node --test ...` nos testes de auth/access/socket afetados
- `npm run test:smoke` se cobrir login/acesso

### Bloco 5: billing com desconto

Escopo aproximado: 200 a 300 linhas, sem contar ajustes de provider.

Entregas:

- recalcular token tier antes de criar pedido
- aplicar 50% somente se saldo atual `>= 1.000.000`
- registrar preço base, desconto e preço final no pedido
- preservar acesso pago mesmo se saldo cair depois
- expor preço com desconto no estado público de billing

Dependência externa:

- validar no devnet da MoonPay/Helio se o paylink criado como dinâmico aceita `requestAmount` no formato decimal humano esperado para a moeda configurada.

Validação:

- `npm run lint`
- `node --test ...` nos testes de billing
- `npm run test:smoke` quando aplicável

### Bloco 6: frontend wallet login e estado de entitlement

Escopo aproximado: 300 a 450 linhas, possivelmente dividido em dois sub-blocos.

Entregas:

- botão de login por wallet
- assinatura de challenge
- estado visual de saldo/tier
- tela de completar conta quando wallet-only perder acesso e quiser pagar
- edição de username
- mensagens de erro claras:
  - wallet sem saldo suficiente
  - wallet já vinculada
  - assinatura recusada
  - provider indisponível

Validação:

- `npm run lint`
- `npm --prefix frontend run build`
- testes afetados, se existirem

### Bloco 7: revalidação híbrida e hardening operacional

Escopo aproximado: 250 a 400 linhas, dividido em sub-blocos se incluir webhook/stream.

Entregas:

- job periódico para revalidar wallets com benefício token ativo
- campo/estado operacional para marcar wallet como `needs_refresh`
- endpoint seguro para evento de provider, quando escolhermos Helius Webhooks, QuickNode Streams ou outro
- dedupe de eventos por assinatura/id externo
- refresh canônico de saldo após evento
- revogação de sessão/socket quando o novo snapshot confirmado remover acesso token-gated e não houver acesso pago ativo
- rate limit específico para wallet auth e balance refresh
- logs estruturados para falha de RPC e tier changes
- admin/debug endpoint para inspecionar snapshot de uma conta
- job de limpeza de challenges expirados
- métricas mínimas:
  - quantidade de holders por tier
  - falhas RPC
  - revogações por saldo baixo
  - descontos aplicados

Validação:

- `npm run lint`
- `node --test ...` nos testes de worker/revalidação/access
- teste manual vendendo/transferindo token e conferindo que o evento agenda refresh, mas a decisão final vem do novo snapshot

## Ordem recomendada

1. Bloco 1: schema/modelos
2. Bloco 3: saldo/tier
3. Bloco 2: assinatura/login por wallet
4. Bloco 4: resolver/enforcement
5. Bloco 5: billing desconto
6. Bloco 6: frontend
7. Bloco 7: revalidação híbrida e hardening

Motivo:

O cálculo de saldo precisa existir antes de decidir login e billing. O resolver precisa existir antes do frontend depender do estado final. Billing vem depois porque depende do snapshot/tier confiável.

## Estimativa total

Implementação completa:

- backend/schema/auth/access/billing: 1.200 a 1.700 linhas
- frontend: 400 a 700 linhas
- testes: 500 a 900 linhas

Total estimado:

- 2.100 a 3.300 linhas entre código e testes

Por isso, não deve ser feito em uma única mudança. Cada bloco deve ficar perto de 300 linhas de código funcional quando possível, com testes e validação por camada.

## Ponto importantes

- A tolerância de 30 a 60 minutos não deve manter acesso quando o backend confirmou saldo abaixo do threshold. Ela só cobre falha ou indisponibilidade da consulta.
- O threshold deve usar unidades raw com `BigInt`; não usar `Number`, `parseFloat` ou `uiAmount` para decisão de acesso.
- A regra de `2.000.000` é exata: qualquer saldo abaixo disso perde acesso token-gated.
- O acesso pago precisa continuar independente do saldo depois da compra.
- A promoção de 2 semanas precisa de `start_at` e `end_at` configurados explicitamente.
- A wallet-only account conflita com o schema atual porque `email` e `password_hash` são obrigatórios; para MVP, email sintético é menos arriscado do que tornar email/senha nullable em todo o sistema.
- Helius não é obrigatório, mas é o provider mais barato em complexidade agora porque já existe cliente no repo.
- Se MoonPay usar paylinks fixos, o desconto de 50% exigirá paylinks separados por plano; com paylink dinâmico, o desconto usa o mesmo paylink e `requestAmount`.
- O acesso por token deve ser revogável em HTTP e websocket; se só bloquear HTTP, usuários conectados podem continuar recebendo dados em tempo real.
- Não contar LP/staking reduz escopo, mas usuários que colocarem tokens em pool podem perder acesso mesmo ainda tendo exposição econômica ao token.
- A decisão de criar conta automaticamente para holders deve ser limitada a quem tem acesso por token ou promo; para quem não tem saldo suficiente, é melhor pedir criação/vinculação normal antes de billing.

## Perguntas pendentes antes de implementar

1. Qual será o mint address final do token?
2. A janela de 2 semanas começa no horário exato do lançamento do token ou no horário em que a feature entrar em produção?
3. O free access de `100.000` tokens nas primeiras 2 semanas deve dar acesso total ao bot ou acesso limitado?
4. Quer começar com Phantom/`window.solana` no MVP ou já suportar múltiplas wallets no primeiro bloco de frontend?
5. Quer que usuários com `>= 2.000.000` ainda vejam opção de comprar plano pago ou escondemos checkout enquanto tiverem acesso por token?
