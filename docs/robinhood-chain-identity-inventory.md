# Robinhood chain identity inventory

Inventario do Bloco 9A. Este documento registra onde `address` ainda funciona
como identidade global e define a direcao da migracao. Nenhum schema foi
alterado neste bloco.

## Contrato novo

- chains canonicas: `solana`, `ethereum`, `bsc`, `base`, `robinhood`;
- aliases aceitos somente de forma explicita: `sol -> solana`,
  `eth -> ethereum`;
- endereco Solana preserva casing e deve ser base58 com 32-44 caracteres;
- endereco EVM deve ter 20 bytes e e normalizado para lowercase;
- identidade logica: `chain + normalizedAddress`;
- chave em memoria: `<chain>:<normalizedAddress>`;
- chain ausente ou desconhecida falha; a primitive nova nunca assume Solana.

Implementacao: `src/utils/token-identity.js`.

## Colisoes confirmadas no banco

| Dominio | Identidade atual | Risco | Destino |
| --- | --- | --- | --- |
| `token_catalog` | `address UNIQUE`; `chain` nao participa | colisao direta e update cross-chain | `(chain,address)` |
| `user_tokens` | migrado no stage 54 | token EVM pode ocupar identidade errada | `(user_id,chain,address)` ativo |
| `user_blocklist` | migrado no stage 55 | bloqueio cruza chains | unique composta ativa |
| starred/pinned/bootstrap | migrado no stage 54 | preferencias cruzam chains | unique composta ativa |
| folder items | migrado no stage 54 | pasta nao distingue chain | PK/FK compostas ativas |
| market snapshots | legado `token_address` | risco contido por guard Solana-only | nao reutilizar; aposentadoria fisica opcional |
| buckets 1m/volume/agg | PK inicia em `token_address` | OHLC/volume pode colidir | guards Solana + indexes parciais EVM; nao reconstruir PK gigante |
| risk review/enrichment/evidence | migrado no stage 56 | avaliacao Solana pode atingir EVM | storage chain-aware; auto non-Solana bloqueado |
| admin blocked tokens/evidence | migrado no stage 55 | ban global acidental | PK/rows chain-aware ativas |
| alert rule state/custom rules | `token_address` sem chain | estado e trigger cruzam chains | adicionar `chain` |
| admin review alerts | open unique por token/kind | dedupe cross-chain | chain no unique parcial |

## Dominios que devem permanecer Solana-only

Estes dominios nao devem ser generalizados mecanicamente. Devem receber guard
explicito `chain=solana`, e Robinhood deve usar implementacao separada:

- `token_meteora_snapshots` e `token_meteora_state`;
- GMGN discovery, security, info, kline e claim signals;
- Helius risk enrichment e holder analysis;
- PumpFun/Bags/Bonk/LaunchLab classifiers;
- Jupiter price e rotas de compra Solana;
- wallet token gate permanece Solana-only;
- mock trading e exclusao permanente do escopo Robinhood atual: nao migrar
  stores, rotas, quick buy, posicoes, ordens, historico, PnL ou UI sem um pedido
  futuro explicito do usuario.

## Modelos e consultas criticas

- `src/models/token-catalog.js` possui dezenas de `WHERE address = ...`, joins
  com user tokens/admin blocklist e upsert que conflita apenas por address;
- modelos de user token, blocklist, starred, pinned e folders recebem somente
  address;
- modelos legados de buckets agora gravam/leem/apagam somente
  `chain='solana'`; persistencia Robinhood exata permanece no Bloco 10;
- `token_market_snapshots` nao participa do runtime atual; seu modelo rejeita
  non-Solana antes do banco e a tabela permanece somente como fonte de dois
  backfills manuais legados;
- modelos de risk review, enrichment, junk evidence e admin block usam somente
  address;
- alert rule state, custom alerts e feeds usam token address como lookup;
- backfills CoinGecko e jobs de cleanup selecionam/deletam por address.

Essas consultas nao serao alteradas antes do schema aditivo. Adicionar apenas a
coluna na aplicacao sem indexes/constraints compostas criaria uma falsa sensacao
de isolamento.

## Caches e estado em memoria

- DexScreener usa `tokenCache` e `inFlightRequests` por address;
- catalog worker tem alguns keys `chain:address`, mas caches de prioridade,
  churn e manual GMGN ainda incluem caminhos address-only;
- UI Meteora summary, backend alert feed e risk sync agrupam por address;
- o store frontend compartilhado principal ja usa
  `trackedTokensByIdentity[<chain>:<address>]`; `sparklineByAddress`,
  `meteoraByAddress`, listas ordenadas, trading maps e viewport maps ainda usam
  address e devem permanecer Solana-only ate migracao explicita;
- o cache de chart alert history agora rejeita eventos non-Solana, e cards de
  alerta non-Solana ocultam Chart, Star e Block enquanto esses contratos
  continuarem address-only; resolucoes administrativas por alert id permanecem
  chain-aware;
- dismissed/starred/pinned/manual lists persistem apenas address no cliente.

Mesmo quando formatos Solana e EVM normalmente nao colidem, formato diferente
nao substitui uma identidade explicita. Todos os caches compartilhados devem
usar a primitive de key ou permanecer protegidos como Solana-only.

## Rotas, payloads e sockets

- o contrato `availableChains` de `/api/config` e a fonte de disponibilidade
  para a futura UI e atualmente retorna somente Solana; badges ou ingestion
  nao habilitam uma chain automaticamente;
- `uiPrefs.chainFilters` persiste filtro mestre, Radar, feed e notificacoes em
  listas separadas e non-empty; selecoes especificas sao subconjuntos do
  mestre; feed, audio e notificacoes ja consomem suas selecoes sem apagar o
  cache; o Bid Zone foi ocultado e o filtro Radar restante sera aplicado a
  Recent/Old Week sem migrar mock trading;
- catalog aceita `chain`, mas a normalizacao legada fazia unknown virar Solana;
- varias rotas recebem somente `:address` e carregam catalogo, history, risk,
  alerts ou trading sem chain;
- payloads de dashboard e websocket frequentemente expõem address sem uma
  chain obrigatoria;
- frontend monta links de explorer/terminal assumindo Solana em componentes
  compartilhados.

Antes do rollout, endpoints multi-chain devem exigir chain ou usar uma rota
explicitamente chain-scoped. Compatibilidade legada pode assumir Solana apenas
em endpoints documentados como Solana-only.

## Ordem segura para os proximos sub-blocos

1. Bloco 9B adiciona colunas `chain` com default Solana, backfill e indexes
   compostos sem remover constraints antigas.
2. Bloco 9C migra modelos por dominio, sempre passando identidade completa.
3. Frontend/payloads adotam `chain + address` depois que APIs retornarem chain.
4. Bloco 9D remove uniques/FKs address-only somente apos auditoria de todas as
   consultas e rollback testado.

## Bloqueios vigentes apos 9C.2

- Robinhood pode usar `token_catalog` somente com identidade `(chain,address)`;
- nao gravar observacoes Robinhood nos buckets legados: `NUMERIC(20,12)` perde
  precos abaixo de `1e-12` e `pair_address VARCHAR(64)` nao comporta pool id v4;
- nao reutilizar risk tables, blocklists ou alert state antes do sub-bloco deles;
- nao executar workers GMGN/Meteora/PumpFun/Helius para Robinhood;
- nao habilitar persistencia do cache social antes de store chain-aware;
- nao remover nenhum contrato legado no Bloco 9A.
