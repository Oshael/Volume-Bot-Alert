# Estratégia atual — Scraping / Monitoramento de Fomo.family e Pump.fun

## Objetivo

Construir um sistema de descoberta e monitoramento de traders para encontrar alpha e analisar moedas, sem executar trades.

A ideia central é:

1. usar leaderboard / rankings para descobrir traders interessantes;
2. adicionar esses traders ao conjunto monitorado;
3. capturar novos callouts / atividades;
4. armazenar wallet, token, timestamp, tese quando necessário, market cap e métricas de performance;
5. enriquecer os eventos posteriormente com dados on-chain;
6. manter histórico próprio, independente de o trader continuar ou não no leaderboard.

---

# 1. Arquitetura geral

```text
LEADERBOARD / DISCOVERY
        ↓
novos traders
        ↓
WATCHLIST
        ↓
feed / API da plataforma
        ↓
novo callout / atividade
        ↓
wallet + token + timestamp + metadata
        ↓
BANCO PRÓPRIO
        ↓
dados on-chain / preço / MC / performance
        ↓
SCORING / ALPHA / ALERTAS
```

A plataforma deve ser usada, idealmente, como camada de descoberta e sinal.

Sempre que possível, depois de identificar uma wallet, os dados de compra, venda, posição e performance devem ser reconstruídos diretamente da blockchain ou de outras fontes públicas.

Isso reduz dependência operacional das plataformas e diminui a necessidade de republicar conteúdo proprietário.

---

# 2. Fomo.family

## O que já confirmamos

O frontend recebe teses estruturadas pelo WebSocket:

```text
wss://prod-api.fomo.family/ws
```

O handshake medido é:

```text
server → {"type":"challenge"}
client → {"type":"challengeResponse","jwt":"..."}
server → {"type":"challengeAccepted"}
```

Depois da autenticação, o client envia:

```text
{"type":"subscribe","topicType":"trading_activity","topicId":"<profile UUID>"}
```

Frames `data/trading_activity` com `payload.type=thesis` incluem profile, tese,
token, network, `tradeId` e métricas. O JWT expira e seu lifecycle ainda precisa
ser resolvido para operação autônoma na VPS.

Também foram confirmados endpoints HTTP públicos, sem cookie ou Authorization:

```text
GET /v2/leaderboard?limit=50
GET /v2/leaderboard/{24h|7d|30d}?limit=100
GET /feed/tradingActivity?limit=50&threshold=1000
GET /trades/{tradeId}
```

O leaderboard liga diretamente o perfil a `address` (Solana) e `evmAddress`.
Trade detail liga o autor à `trade.userAddress` usada naquele evento.

## Estratégia recomendada

### Descoberta

Usar o leaderboard da Fomo, especialmente:

```text
Top Profits 24h
```

como fonte de descoberta.

Executar periodicamente:

```text
Top 100 atual
    ↓
comparar com traders já conhecidos
    ↓
identificar novos traders
    ↓
preservar perfis e wallet observations
```

Não remover imediatamente traders que saírem do ranking.

A watchlist deve ser cumulativa.

Exemplo:

```text
Dia 1: 100 traders
Dia 2: +38 novos
Dia 3: +29 novos

Watchlist total: 167
```

Isso cria um histórico de pessoas que demonstraram performance em algum momento.

## Captura

Prioridade:

### Opção A — WebSocket direto

Caminho principal já comprovado:

```text
script
  ↓
autentica
  ↓
conecta em prod-api.fomo.family/ws
  ↓
subscribe trading_activity
  ↓
salva eventos
```

### Opção B — Playwright interceptando o WebSocket

Se recriar a autenticação diretamente for chato:

```text
Playwright
   ↓
perfil Chrome persistente
   ↓
sessão já logada
   ↓
Fomo abre WebSocket normalmente
   ↓
script intercepta frames
```

Essa opção é mais pesada, mas ainda muito melhor que scraping de HTML.

### Opção C — DOM scraping

Só usar se a Fomo mudar a arquitetura e impedir acesso razoável aos dados estruturados.

---

# 3. Pump.fun

## O que já confirmamos diretamente

A versão web atual usa:

```text
https://frontend-api-v3.pump.fun
```

A sessão web é autenticada por cookie:

```text
auth_token=<JWT>
```

O JWT sozinho foi testado e retornou:

```text
GET /auth/my-profile
HTTP 200
```

Portanto, não precisamos de `_ga`, `cf_clearance`, `__cf_bm` ou navegador completo para as chamadas que testamos.

## Endpoints atuais confirmados

### Perfil autenticado

```text
GET /auth/my-profile
```

### Leaderboard de callouts

```text
GET /callout/leaderboard?limit=50
```

O retorno contém, entre outras coisas:

```text
userId
user_uuid
primaryWallet
wallets
topCallouts
totalCallouts
avgMultiple
medianMultiple
pct2xOrMore
onePointFiveXPercent
onePointTwoXPercent
averageTimeToPeak
```

Dentro dos callouts:

```text
calloutId
coinMint
marketCap
calloutPrice
multiple
createdAt
maxPriceSol
thesis
peakTimestamp
```

### Callouts de um usuário

```text
GET /callout/list/{userId}
```

Parâmetros:

```text
limit
sortBy
sortOrder
pageToken
```

### Callouts de uma moeda

```text
GET /callout/top/{mint}
```

### Callout individual

```text
GET /callout/{calloutId}
```

### Callout de user + mint

```text
GET /callout/user/{userId}/mint/{mint}
```

### Feed de quem a conta segue

```text
GET /following-positions/alerts
```

Parâmetros observados:

```text
pageSize
cursor
kinds=callout,update,trade
minTradeAmountUsd=10
```

Esse endpoint foi testado e retornou HTTP 200 com dados reais.

Exemplo de dados presentes:

```text
kind
author
userId
userName
walletAddress
xUsername
coinMint
chainId
coinName
symbol
marketCap
callout
position
reply
repost
trade
totalCallouts
```

Dentro de `callout`:

```text
calloutId
calledOutAtMcap
multiple
thesis
calloutTimestamp
likes
updates
maxMultiplier
maxMultiplierAt
calloutPrice
viewCount
```

## Endpoint legado / aparentemente morto

Existe código no bundle para:

```text
GET /callout/recent
```

mas o teste atual retornou:

```text
HTTP 400
Validation failed (uuid is expected)
```

O backend está interpretando `recent` como se fosse:

```text
/callout/{calloutId}
```

Portanto, devemos tratar `/callout/recent` como código legado ou rota atualmente inexistente.

---

# 4. Estratégia atual para Pump

A estratégia mais simples hoje é repetir o modelo da Fomo.

## Descoberta

Usar:

```text
/callout/leaderboard?limit=50
```

e, se possível, aumentar a cobertura / paginação / variações do ranking.

Executar periodicamente:

```text
leaderboard
   ↓
extrair userId / wallet
   ↓
comparar com banco
   ↓
watchlist cumulativa de traders
```

## Monitoramento

O caminho inicial não depende de Follow externo:

```text
/callout/list/{userId}
```

é consultado de forma incremental para os perfis descobertos. O endpoint
`/following-positions/alerts` complementa a captura dos perfis já seguidos.

Fluxo:

```text
Top callers
    ↓
watchlist interna
    ↓
/callout/list/{userId} + /following-positions/alerts
    ↓
callout / update / trade
    ↓
banco
```

Essa abordagem evita a necessidade imediata de descobrir o feed global do mobile.

---

# 5. Feed global mobile da Pump

O app possui, segundo observação manual, um feed com callouts de todos os traders.

Ainda não identificamos o endpoint atual desse feed.

O bundle web atual não revelou uma rota global ativa equivalente.

Por isso, se quisermos capturar o feed global, a próxima linha de investigação é o app mobile.

## Ordem de investigação

### 1. Celular real + proxy

Preferência inicial.

```text
Pump app
   ↓
Wi-Fi
   ↓
proxy HTTP(S)
   ↓
Proxyman / Charles / mitmproxy
```

Procedimento:

```text
abrir feed global
↓
limpar captura
↓
pull-to-refresh uma única vez
↓
parar captura
↓
comparar requests novas
```

Buscar por hosts / paths contendo:

```text
callout
feed
alerts
positions
frontend-api
pump.fun
```

### 2. Android emulator

Se o proxy no telefone real não revelar o tráfego:

```text
Android Studio Emulator
   ↓
Pump
   ↓
proxy
   ↓
captura de requests
```

### 3. Instrumentação

Somente se houver:

- certificate pinning;
- app attestation;
- payload proprietário;
- bloqueio de proxy.

### 4. UI scraping

Último recurso.

Não queremos depender de:

- OCR;
- leitura visual;
- scroll automatizado;
- elementos de interface.

---

# 6. Automação de follows

Precisaremos identificar os endpoints atuais usados para:

```text
Follow trader
Unfollow trader
Following list
```

Procedimento recomendado:

```text
Network
↓
Clear
↓
clicar Follow manualmente
↓
identificar request nova
↓
Copy as cURL
↓
reduzir request ao mínimo necessário
```

Depois implementar a ação no crawler.

Precisamos verificar:

- limite máximo de follows;
- rate limit;
- cooldown;
- proteção anti-bot;
- necessidade de CSRF;
- status codes;
- comportamento em duplicate follow.

Não devemos disparar centenas de follows simultaneamente.

Usar fila e ritmo conservador.

---

# 7. Banco de dados mínimo

## Perfis

```text
platform
platform_user_id
username
x_username
first_seen
last_seen
first_leaderboard_seen
best_rank
times_in_top
currently_followed
```

## Wallet observations

```text
platform + platform_user_id
address_original + address_normalized
chain_family + chain_key + raw_chain_id
relation_type + source_type + source_field
source_record_id + confidence
first_seen_at + last_seen_at
resolution_status
```

Uma nova wallet cria ou atualiza sua própria observação; nunca substitui outra
wallet do perfil.

## Leaderboard snapshots

```text
timestamp
platform
user_id
rank
period
profit
score
```

## Callouts

```text
platform
callout_id
user_id
wallet
coin_mint
chain
thesis
called_at
called_at_market_cap
callout_price
multiple
max_multiple
peak_timestamp
```

## Trades / atividade

```text
platform
user_id
wallet
coin_mint
side
amount
amount_usd
timestamp
transaction_signature
```

---

# 8. Dados on-chain como camada principal de longo prazo

Sempre que uma wallet for conhecida:

```text
wallet
  ↓
blockchain indexer / RPC
  ↓
transações reais
  ↓
compras / vendas
  ↓
preço / tamanho / timing
```

Dessa forma podemos calcular internamente:

- entrada;
- saída;
- tamanho;
- realized PnL;
- unrealized PnL;
- hit rate;
- tempo até 2x;
- tempo até pico;
- drawdown;
- frequência;
- consistência.

Isso também reduz nossa dependência das métricas calculadas pela Fomo/Pump.

---

# 9. Scoring futuro

Não confiar apenas em Top Profit 24h.

Exemplo de score:

```text
frequência em Top 100
+
frequência em Top 10
+
performance mediana dos callouts
+
% de calls > 2x
+
tempo médio até o movimento
+
consistência em diferentes períodos
-
outliers extremos
-
calls com baixa liquidez
```

Queremos encontrar traders consistentemente bons antes do movimento, não apenas alguém que acertou uma única moeda absurda.

---

# 10. Riscos operacionais

Os principais riscos práticos são:

```text
mudança de endpoint
JWT expirado
rate limit
conta bloqueada
limite de follows
Cloudflare / WAF
mudança de schema
feature movida para outro backend
```

Por isso:

- salvar tudo localmente;
- usar retry com backoff;
- logar status codes;
- versionar schemas;
- separar adapters por plataforma;
- evitar requests desnecessárias;
- não depender de HTML se JSON/API existir.

---

# 11. Estrutura de software sugerida

```text
src/
├── platforms/
│   ├── fomo/
│   │   ├── auth
│   │   ├── leaderboard
│   │   ├── follows
│   │   └── websocket
│   │
│   └── pump/
│       ├── auth
│       ├── leaderboard
│       ├── follows
│       ├── alerts
│       └── callouts
│
├── discovery/
│   └── leaderboard_watcher
│
├── ingest/
│   ├── callouts
│   └── trades
│
├── chain/
│   ├── solana
│   └── evm
│
├── scoring/
│
├── storage/
│
└── alerts/
```

---

# 12. Estado da investigação

## Pump

- client e endpoints read-only confirmados;
- normalização de perfil, wallets e callouts implementada;
- captura contínua local por watchlist, cursor e spool comum implementada;
- persistência direta e retenção limitada de 72 horas implementadas;
- Follow externo não faz parte do caminho crítico.

## Fomo

- handshake, challenge, subscribe e thesis do WebSocket confirmados;
- leaderboards, feed HTTP recente e trade detail confirmados no HAR;
- wallets Solana/EVM do perfil e wallet usada no trade estão disponíveis;
- captura contínua local, lifecycle do JWT e spool comum implementados.
- persistência direta e retenção limitada de 72 horas implementadas.

---

# 13. Estratégia recomendada para MVP

Não tentar resolver tudo de uma vez.

### Pump MVP

```text
leaderboard
→ watchlist interna
→ callouts por perfil + following alerts
→ worker da VPS
→ commit direto no PostgreSQL
```

### Fomo MVP

```text
leaderboard
→ WebSocket trading_activity
→ feed HTTP de reconciliação
→ trade detail para side wallets
→ worker da VPS
→ commit direto no PostgreSQL
```

Depois:

```text
wallets descobertas
→ blockchain
→ analytics próprio
→ scoring
→ alertas
```

Esse é o caminho com menor complexidade e maior chance de colocar um sistema funcional rapidamente.

---

# 14. Plano de execução aprovado

## 14.1 Resultado pretendido

Implementar uma pipeline durável de descoberta e atividade de traders sem
executar trades e sem exigir wallet tracking on-chain em todas as redes desde o
primeiro dia.

O resultado deve permitir:

1. descobrir perfis em leaderboards da Pump e da Fomo;
2. preservar o histórico dos perfis encontrados;
3. associar a eles todas as wallets informadas pelas plataformas;
4. capturar callouts, updates e trades disponíveis;
5. manter cursores e deduplicação próprios;
6. enriquecer imediatamente apenas as redes suportadas;
7. manter as demais wallets e atividades como dados pendentes de enriquecimento;
8. calcular scoring somente depois de existir amostra histórica suficiente;
9. publicar alertas apenas depois de a captura estar estável e auditada.

O PostgreSQL continua sendo a fonte de verdade do produto. Durante períodos em
que o banco estiver ocupado com backfills, ferramentas de investigação poderão
usar um spool NDJSON local e limitado. Esse spool é transporte temporário, não
uma segunda fonte de verdade.

## 14.2 Escopo funcional fechado

O produto é um scraper/monitor de callouts da Pump e da Fomo, usando API ou
WebSocket estruturados antes de considerar scraping visual. Ele deve entregar:

- cadastro histórico de `profile ↔ wallet ↔ chain`;
- captura dos callouts e respectivas teses, tokens, timestamps e market caps;
- alertas de novos callouts conforme regras aprovadas;
- callouts posicionados no gráfico expandido pelo timestamp do evento;
- tese individual ou resumo atribuído de várias teses próximas no chart;
- consulta das moedas compradas/vendidas pelas wallets ligadas a perfis;
- correlação entre callout e compra on-chain quando ambas forem comprovadas.

Existem três evidências diferentes e elas não podem ser confundidas:

```text
callout          = o perfil publicou uma call/tese
wallet action    = a wallet comprou ou vendeu on-chain
correlated       = o callout e a ação on-chain foram ligados com segurança
```

Robinhood terá a primeira consulta de wallet actions porque já possui swaps
atribuídos. Solana e outras redes preservam perfis, wallets, callouts e teses em
`stored/untracked` até seus adapters on-chain serem implementados.

## 14.3 Decisões de arquitetura

- Pump e Fomo entram por adapters separados.
- Normalização, deduplicação e persistência são comuns às plataformas.
- A implementação deve seguir as convenções atuais do repositório: `services`,
  `models`, migrations por stage, config central e worker groups isolados.
- Não criar um novo subsistema paralelo baseado em scraping de DOM quando JSON,
  API ou WebSocket estiver disponível.
- O worker deve ser opt-in, desligado por default e não pode entrar
  automaticamente em `BACKGROUND_WORKER_GROUPS=all`.
- Discovery e captura de atividade não dependem do pipeline on-chain estar
  disponível para a rede observada.
- Enriquecimento on-chain fica atrás de um adapter por chain.
- Robinhood pode ser o primeiro adapter de enriquecimento.
- Solana e outras redes começam em modo `stored/untracked` até existir atribuição
  de wallet confiável para aquela chain.
- `user_wallets` permanece reservado para autenticação e token gate. Wallets de
  traders usam domínio e tabelas próprios.
- Nenhum evento de plataforma pode ser convertido automaticamente em sinal
  Smart Money sem validação, confidence e regra de publicação explícita.

## 14.4 Checkpoint arquitetural

A entrega integral deve ultrapassar 12 arquivos de produção e 500 linhas. Por
isso, o trabalho será dividido em slices independentes de no máximo 500 linhas
alteradas cada, com validação e revisão do diff ao final de cada slice.

Cada slice precisa:

- preservar comportamento existente quando suas flags estiverem desligadas;
- manter um único limite de responsabilidade;
- possuir rollback claro;
- incluir somente a menor validação que protege o contrato alterado;
- terminar antes de iniciar o slice seguinte;
- resultar em commit próprio quando estiver completo e aprovado.

---

# 15. Arquitetura-alvo

```text
Pump API                     Fomo API / WebSocket
   └── adapter Pump             └── adapter Fomo
             └──────────┬──────────┘
                        ↓
               normalização comum
                        ↓
        perfis + wallets + snapshots + eventos
                        ↓
             dedupe + cursor + PostgreSQL
                        ↓
       enrichment por chain + scoring histórico
                        ↓
       alertas + gráfico expandido + perfis
```

As fontes externas servem para descoberta e sinal. Os dados on-chain continuam
sendo preferidos para afirmar compra, venda, tamanho, posição e PnL quando o
adapter da chain existir.

## 15.1 Fronteiras de responsabilidade

- **Adapter de plataforma:** autenticação, transporte, paginação, rate-limit,
  normalização e classificação de erros. Não consulta on-chain, calcula score,
  publica alerta ou executa Follow durante discovery.
- **Domínio comum:** perfis, histórico de wallets, snapshots, eventos,
  idempotência, cursor, freshness e estado de enriquecimento.
- **Adapter de chain:** valida `chain_key + address`, busca evidência on-chain e
  produz métricas com confidence/proveniência. Sem cobertura, mantém pendente.
- **Publicação:** consome somente eventos commitados e tolera replay, duplicação
  e ordem diferente da observada.

---

# 16. Contratos de dados

### Perfil de plataforma

Chave `(platform, platform_user_id)`. Guarda username, display name, X, URL,
status, `first_seen_at`, `last_seen_at` e metadata. O perfil não é identificado
pela wallet: ele pode informar várias, e uma wallet pode aparecer em plataformas
diferentes.

### Wallet observada

Guarda perfil, endereço original/normalizado, `chain_key`, `chain_family`,
`raw_chain_id`, tipo da relação, campo de origem, confidence, datas e
`resolution_status` (`resolved`, `unknown_chain`, `invalid_address`,
`unsupported_chain` ou `conflicting_evidence`).

Regras:

- wallet observada não significa wallet on-chain já rastreada;
- não inferir rede EVM somente pelo endereço;
- preservar `raw_chain_id` e o endereço original;
- Solana mantém case; EVM só normaliza após validar 20 bytes;
- tracking on-chain só nasce com a chain resolvida;
- resolução posterior não apaga a evidência original.

O vínculo é uma observação versionada, não uma coluna definitiva de ownership.
Cada evidência preserva `source_type`, `source_field`, `observed_at` e confidence:

- `platform_reported`: wallet declarada pela plataforma no perfil/leaderboard;
- `activity_used`: wallet usada em um trade atribuído ao perfil;
- `onchain_correlated`: vínculo confirmado posteriormente por evidência on-chain.

Na Fomo, `address` e `evmAddress` do leaderboard são evidências
`platform_reported`. `trade.userAddress`, obtido pelo `tradeId` de uma tese, é
`activity_used`: comprova a wallet usada naquele evento, mas não afirma que seja
a única wallet do perfil. Novas observações nunca sobrescrevem as antigas. Isso
permite descobrir side wallets e reutilizar o histórico quando novos adapters
de chain forem adicionados.

### Leaderboard e atividade

Snapshot usa `(platform, period, captured_at, platform_user_id)` e tipa rank,
profit, score e métricas comparáveis; campos instáveis ficam em JSON. Saída do
Top N não remove o perfil nem seus snapshots.

Eventos iniciais são `callout`, `update`, `trade`, `reply` e `repost`. Guardam
plataforma/ID/tipo/perfil, wallet, chain IDs, token, side, valores, market cap,
tese, tempos, payload sanitizado e `schema_version`. Preferir ID da plataforma;
sem ele, usar fingerprint determinístico de campos estáveis, nunca só timestamp.

Tese original e resumo derivado são campos distintos. O resumo mantém IDs dos
callouts de origem, intervalo temporal, versão do summarizer e atribuição aos
perfis/plataformas. O chart nunca apresenta resumo derivado como texto original.

JWT, cookies, CSRF, headers de autenticação e sessão nunca entram em payload ou
logs.

### Cursor operacional

Cada stream mantém separadamente cursor, watermark, última tentativa/sucesso,
último evento, falhas consecutivas, backoff e versão. Exemplos:
`pump:leaderboard`, `pump:following_alerts`, `pump:user_callouts:<user_id>`,
`fomo:leaderboard` e `fomo:trading_activity`.

---

# 17. Modo de trabalho enquanto o PostgreSQL estiver ocupado

## 17.1 Trabalho permitido sem banco

- clients HTTP e WebSocket com `fetch`/transport injetável;
- parsers e normalizadores puros;
- fixtures sanitizadas;
- testes unitários;
- probes read-only executados manualmente;
- captura local NDJSON limitada;
- reconexão e backoff;
- redaction de segredos;
- contrato do schema sem aplicar migrations.

## 17.2 Spool NDJSON local

O envelope do spool deve conter:

```text
spool_version
platform
stream
captured_at
sequence
dedupe_key
payload
```

Requisitos:

- append-only;
- um writer por arquivo;
- rotação por tamanho e tempo;
- limite total configurável de disco;
- recuperação que ignore somente a última linha parcial;
- permissões locais restritas;
- payload sanitizado;
- uso restrito a probes, desenvolvimento e diagnóstico;
- não participa do caminho normal do worker na VPS.

Na VPS, collectors e repositories gravam diretamente no PostgreSQL. O avanço de
checkpoint deve ocorrer na mesma transação dos eventos e identidades aceitos.
Downstream, scoring e alertas consomem somente dados já commitados.

## 17.3 Trabalho adiado até o banco ter folga

- aplicar migrations no PostgreSQL compartilhado;
- executar testes de integração contra o schema;
- ligar workers persistentes;
- criar índices sobre tabelas já volumosas;
- executar queries analíticas ou scoring histórico;
- ligar enriquecimento Robinhood que leia grandes faixas.

---

# 18. Plano por slices

## Slice 1 — Pump read-only e contratos

Escopo estimado: 6–8 arquivos, 300–450 linhas.

- **Entrega:** client autenticado sem logs de token; leaderboard, perfil,
  callouts e following alerts; paginação comprovada; normalizadores, fixtures,
  erros HTTP e probe NDJSON sanitizado.
- **Fora:** banco, worker, Follow, feed mobile e alertas.
- **Validação:** testes do client/normalização/redaction, lint e probe read-only
  opcional. Sai quando payloads reais normalizam, erro não avança cursor e
  nenhum segredo aparece no output.

## Slice 2 — Fomo WebSocket e evidência

Escopo estimado: 6–8 arquivos, 300–450 linhas.

- **Dependência:** sessão autenticada e handshake/subscribe obtidos manualmente
  ou com perfil persistente autorizado.
- **Entrega:** inspetor de frames, client direto ou fallback Playwright,
  reconnect com jitter/backoff, normalizador, fixtures e NDJSON sanitizado.
- **Validação:** testes de frames/reconexão/redaction, lint e soak read-only.
  Sai quando autenticação, subscribe e schema têm fixture reproduzível.

## Slice 3 — Domínio comum e spool

Escopo estimado: 7–9 arquivos, 350–500 linhas.

- **Entrega:** contratos comuns; normalização EVM/Solana; resolução de chain;
  fingerprint; spool limitado; interface de import sem PostgreSQL.
- **Validação:** testes table-driven de identidade/dedupe e de recuperação,
  rotação/limite do spool, mais lint. Sai quando as duas plataformas produzem o
  mesmo envelope sem perder metadata específica.

## Slice 4 — Identidades e discovery público da Fomo

Escopo estimado: 4–6 arquivos, 300–450 linhas.

- **Entrega:** client read-only para leaderboards, feed recente e trade detail;
  normalização comum de perfil e wallet observations; distinção entre
  `platform_reported` e `activity_used`; suporte a side wallets multichain.
- **Fora:** PostgreSQL, worker contínuo, Follow, enrichment e alertas.
- **Validação:** testes de transporte sem auth, schema, chain resolution,
  provenance e payloads inválidos, mais lint. Sai quando perfis do leaderboard
  e wallets usadas em trades geram observações sem sobrescrever evidências.

## Slice 5 — Captura contínua local da Fomo

Escopo estimado: 6–8 arquivos, 350–500 linhas.

- **Entrega:** WebSocket como caminho live; feed público como bootstrap e
  reconciliação limitada; lifecycle de credencial; perfis, wallets e teses no
  spool comum; reconnect, backoff e freshness.
- **Validação:** testes de replay, reconnect, expiração de JWT, dedupe e limite
  do spool, mais lint. Sai quando restart recupera continuidade sem depender do
  PostgreSQL e uma credencial expirada não produz loop agressivo.

## Slice 6 — Captura contínua local da Pump

Escopo estimado: 6–9 arquivos, 350–500 linhas.

- **Entrega:** leaderboard alimentando watchlist cumulativa; callouts por perfil
  e following alerts incrementais; perfis, wallets e teses no spool comum;
  paginação limitada, cursor local, deadline, backoff e freshness.
- **Validação:** testes de paginação, watchlist, dedupe, 401/403/429 e retomada,
  mais lint. Sai quando não depender somente dos perfis seguidos pela conta e
  não repetir callouts após restart.

## Slice 7 — Schema, persistência direta e retenção PostgreSQL

Escopo estimado: múltiplos slices de até 500 linhas.

- **Pré-condição:** janela segura e database de teste isolado.
- **Entrega:** stage inerte; tabelas/constraints/índices; repositories
  idempotentes; perfis e wallet observations permanentes; theses/callouts brutos
  com retenção de 72 horas; checkpoint transacional para os collectors.
- **Validação:** integração de replay/conflito/expiração,
  `db:schema-check:test` e lint. Sai quando replay não duplica, falha parcial não
  avança checkpoint e retenção não remove identidade histórica.

## Slice 8 — Workers opt-in e operação na VPS

Escopo estimado: múltiplos slices de até 500 linhas.

- **Entrega:** worker group isolado; leases; collectors gravando diretamente via
  repositories; cursores duráveis; health/freshness; flags; supervisão e runbook
  de recuperação, sem downstream.
- **Validação:** worker/lease/commit-cursor, restart e soak. Sai quando Pump e
  Fomo acumulam identidades e teses continuamente após reinício.

## Slice 9 — Follows externos

Escopo estimado: 5–7 arquivos, 250–400 linhas.

- **Pré-condições:** request real medida, limites conhecidos e autorização
  explícita para escrever na conta.
- **Entrega:** fila separada, allowlist/dry-run, concorrência 1, jitter, limites,
  idempotência e pausa em 401/403/429, sem unfollow automático.
- **Validação:** testes dos gates, lint e canário de um perfil autorizado. Sai
  quando repetição é segura e falha da conta não afeta captura.

## Slice 10 — Enrichment por chain

Escopo estimado: 6–10 arquivos, 350–500 linhas por adapter.

- **Entrega:** registry por chain; adapter Robinhood; estados explícitos;
  proveniência/confidence/versão; outras redes pendentes sem dados inventados.
- **Validação:** casos Robinhood, limites/timeout, reprocessamento idempotente,
  teste backend e lint. Sai quando adapter ausente não bloqueia captura.

## Slice 11 — Resumos, alertas e superfícies do produto

Escopo estimado: múltiplos slices backend/frontend de até 500 linhas.

- **Pré-condições:** captura persistente estável e contrato de leitura aprovado.
- **Entrega:** agrupamento adaptativo de teses em janelas de 10–30 minutos;
  resumo derivado com links/IDs das fontes; alertas idempotentes; API por
  token/período; markers no gráfico expandido; lista de perfis/wallets com
  compra Robinhood comprovada; estados visuais distintos para `callout`,
  `wallet action` e `correlated`.
- **Validação:** testes backend do contrato, menor teste frontend afetado,
  `npm run lint` e `npm --prefix frontend run build`. Sai quando nenhum callout
  é exibido como compra sem evidência on-chain.

## Slice 12 — Scoring

Escopo estimado: múltiplos slices de até 500 linhas, definidos depois da amostra.

- **Pré-condições:** captura estável, amostra suficiente, métricas auditadas e
  regras aprovadas.
- **Entrega:** score versionado/explicável, janelas, proteção contra liquidez e
  outliers, shadow mode e publicação idempotente após soak.
- **Regra:** pesos finais só são definidos após observar a distribuição real.

---

# 19. Política operacional inicial

## Pump

- leaderboard começa em intervalo conservador de 15 minutos;
- following alerts começa em canário de 30 segundos;
- reduzir para 5–10 segundos somente se rate-limit e soak permitirem;
- cada rodada possui limite de páginas e deadline;
- cursor só avança depois do commit;
- 429 respeita `Retry-After` ou backoff exponencial com jitter;
- 401/403 pausa a sessão e exige intervenção;
- feed mobile global permanece investigação opcional.

## Fomo

- `trading_activity` usa WebSocket como caminho live;
- reconnect começa curto e cresce até um teto configurável;
- conexão restabelecida reconcilia de forma limitada com
  `/feed/tradingActivity`; esse feed não substitui o live porque possui janela
  curta;
- leaderboard pode usar polling porque é discovery, não caminho live de atividade;
- Playwright é fallback de autenticação, não parser principal;
- DOM scraping permanece último recurso.

## Follows

- discovery apenas cria candidato interno;
- follow externo exige fila habilitada separadamente;
- nenhum burst de centenas de requests;
- nenhuma estratégia automática de unfollow no MVP;
- saída do leaderboard não remove histórico nem watchlist;
- status da plataforma e status interno são persistidos separadamente.

## Segurança

- tokens entram somente por ambiente ou secret provisionado;
- nenhum token real em fixture, commit, log ou telemetria;
- logs usam IDs, status e contagens, nunca cookies/headers completos;
- probes são read-only por default;
- escrita externa exige flag e confirmação explícitas;
- payload bruto passa por redaction allowlist antes de ser salvo.

---

# 20. Rollout e definição de conclusão

## 20.1 Etapas de rollout

```text
fixtures
→ probe read-only
→ captura local
→ schema inerte
→ worker dry-run
→ worker persistindo sem downstream
→ soak
→ enrichment Robinhood
→ alertas/markers canário
→ scoring shadow
→ scoring publicado
```

Nunca pular diretamente de endpoint descoberto para worker com publicação.

## 20.2 O que significa “plano integral aplicado”

O plano estará integralmente aplicado quando:

- Pump e Fomo possuírem adapters comprovados;
- discovery e atividade forem retomáveis e idempotentes;
- perfis e wallet observations forem preservados multichain;
- redes não suportadas permanecerem consultáveis para enriquecimento futuro;
- follow externo estiver isolado, limitado e auditável;
- PostgreSQL for a fonte de verdade do worker desde o primeiro commit;
- Robinhood tiver enriquecimento sem acoplar o domínio comum à chain;
- alertas de callout forem idempotentes e atribuídos à fonte;
- o gráfico expandido mostrar tese/resumo no ponto temporal correto;
- compras Robinhood forem exibidas apenas para wallets/perfis comprovados;
- callout, wallet action e correlação forem visualmente distintos;
- scoring for versionado e explicável;
- alertas consumirem apenas eventos commitados;
- documentação operacional refletir flags, workers, schema e recuperação reais.

“Integral” não significa que todas as chains já terão tracking on-chain. Significa
que o sistema não perde as wallets/eventos dessas chains e possui uma fronteira
clara para adicionar o adapter posteriormente.

## 20.3 Atualização da documentação operacional

`docs/bot-reference.md` só deve ser atualizado nos slices que realmente mudarem
schema, runtime, flags, workers, deploy, recuperação ou contratos públicos. Este
plano, sozinho, não altera o estado operacional atual.

---

# 21. Ordem imediata de trabalho

1. Slices 1–3 concluídos: probes Pump/Fomo, contrato de thesis e spool comum;
2. executar Slice 4, identidades e discovery público da Fomo;
3. executar Slice 5, captura contínua local da Fomo;
4. executar Slice 6, captura contínua local da Pump;
5. executar Slice 7 em subslices de schema e persistência direta, aplicando o
   stage somente em janela segura;
6. executar Slice 8 e fazer soak na VPS sem downstream;
7. medir amostra e retenção antes de resumos, alertas, enrichment em massa ou
   scoring;
8. manter follows externos adiados até autorização específica de escrita.

Essa ordem permite usar tempo de engenharia enquanto os backfills Robinhood
continuam, sem adicionar carga relevante ao PostgreSQL e sem descartar dados de
wallets pertencentes a redes ainda não suportadas.
