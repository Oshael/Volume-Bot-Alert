# Auditoria de cobertura do journal canônico Robinhood

Escopo: todos os workers Robinhood que participam direta ou indiretamente do
fluxo live. Workers Solana, X, callouts e manutenção genérica não consomem a
Robinhood Chain e não entram no contrato deste journal.

## Contrato canônico necessário

O journal precisa preservar, em ordem canônica:

- bloco: número, hash, parent hash, timestamp, finality e tempos da captura;
- toda transação: hash, índice, `from`, `to`, status, `contractAddress`, `nonce`
  e `value` nativo;
- logs relevantes: address, topics completos, data, transaction hash/index e
  log index;
- uma versão explícita do contrato da captura.

O conjunto de tópicos live é a união exportada pelos decoders existentes:

- discovery: V2 `PairCreated`, V3 `PoolCreated`, V4 `Initialize` e launchpads;
- market: V2 `Swap`/`Sync`, V3 `Initialize`/`Swap`, V4
  `ModifyLiquidity`/`Swap`;
- liquidity: V2 `Sync`, V3 `Mint`/`Burn`/`Collect`/`Swap`/`Flash`, V4
  `ModifyLiquidity`/`Swap`/`Donate`;
- holders e mint hints: ERC-20 `Transfer`;
- creators: eventos Pons/Noxa/LaunchHood.

A captura é topic-only, sem depender do registry atual de pools ou tokens. Isso
é necessário para registrar uma pool criada e usada no mesmo bloco.

## Matriz dos workers

| Worker ou grupo | Evidência necessária | Cobertura/caminho alvo |
|---|---|---|
| head discovery | logs de factory/launchpad e ordem | coberto pelo event journal |
| head market | logs de swap/liquidity, timestamp e pool descoberta antes no bloco | coberto; roteador deve respeitar transaction/log index |
| processing | captura congelada e idempotente | somente PostgreSQL; receberá outbox do journal |
| derived, alerts, catalog staging e aggregate | observações/buckets/outboxes | downstream de processing; não exige RPC de captura |
| liquidity live | tópicos de liquidez e pools afetadas | coberto; valuation ainda usa `eth_call` no bloco âncora |
| holder live/apply | todos os `Transfer` dos tokens admitidos | coberto; filtro de token ocorre no consumidor |
| wallet-transfer live | `Transfer`, posições e checkpoint | coberto pelo evento + bloco |
| direct-creator | `to = null`, `receipt.contractAddress`, `tx.from` e launchpads | coberto pelo contexto completo |
| wallet-swap | observação aceita, `tx.from` e posição da transação | coberto; não precisará reler bloco |
| signed-origin | toda transação, `tx.from`, índice, timestamp e `nonce` | coberto a partir da captura v2 (Stage 192) |
| FRESH live | first buy canônico, `nonce`, timestamp e corte de 24h | v2 cobre o evento novo; seed/histórico anterior ao journal continua separado |
| BUNDLED funding | transferências nativas `from`/`to`/`value` no lookback | coberto a partir da captura v2; exige retenção maior que o lookback |
| token-deployment | mint hint, receipt/status e transição de bytecode | contexto coberto; `eth_getCode` n-1/n continua leitura permitida |
| first-buy e launch-anchor | swaps/posições já materializados | somente PostgreSQL downstream |
| wallet-position | swaps e transfers materializados | somente PostgreSQL downstream |
| sniper/insider shadow | holders, first buys e anchors materializados | somente PostgreSQL downstream |
| bundle-redistribution | swaps/transfers/funding materializados | somente PostgreSQL downstream |
| catalog projection | tokens descobertos, metadata e imagens | evento coberto; `eth_call` e fontes externas ficam assíncronos |
| holder summary/reconciliation/snapshot/intelligence | ledger e/ou Blockscout | não pertence ao hot path de captura |
| retention/journal-prune | tabelas persistidas | manutenção, sem dados novos da cadeia |
| holder backfill/cold/global | ranges históricos e reconciliação | manutenção; receipts/getLogs históricos isolados continuam permitidos |
| discovery/market backfill | ranges históricos | manutenção; `eth_getLogs` permitido somente fora do role live |
| V4 replay/archive discovery/probes | reparo e auditoria manual | manutenção explícita, nunca concorrente com captura atrasada |

## Dados que não vêm de receipts

Receipts não substituem estado de contrato. Os seguintes reads continuam
necessários, mas fora do capturador e sem `eth_getLogs` live:

- metadata ERC-20, supply e balances via `eth_call`;
- estado V2/V3/V4 e cotação WETH/USD via `eth_call` ou projeção por evento;
- `eth_getCode` para provar transições de implantação interna;
- APIs externas para metadata social, imagens e reconciliação.

Esses reads pertencem aos consumidores, devem ser cacheados/batched e não podem
segurar o cursor canônico. Falha externa não impede a captura do próximo bloco.

Os donos atuais de `eth_getLogs` que ainda precisam de cutover são os dois
pollers do head, liquidity, holder live/wallet-transfer e o fallback de eventos
da cotação WETH/USD. Backfills, replays, probes e archive discovery permanecem
classificados como manutenção. A Fatia 3 deve impedir que o fallback WETH/USD
seja alcançado pelo role live, usando estado ou eventos já journalizados.

## Lacunas encontradas e decisão

A Stage 191 não armazenava `nonce` nem `value`, portanto não sustentava
signed-origin/FRESH nem funding nativo sem nova leitura de blocos. A Stage 192
adiciona `nonce`, `value_wei` e `capture_version`. Linhas antigas permanecem
`capture_version = 1` e não podem ser usadas por esses consumidores; novos
commits são v2 e exigem ambos os campos.

O processo de captura também passa a exigir
`ROBINHOOD_CHAIN_CAPTURE_RPC_URL` apontando explicitamente para loopback e força
intervalo RPC zero. Isso impede fallback silencioso para o endpoint público que
produziu o falso baseline de aproximadamente 462 ms por bloco.

## Gate antes de migrar cada domínio

Um consumidor só entra em canário quando:

1. seu primeiro bloco está em `capture_version >= 2` quando usar nonce/value;
2. a identidade e a quantidade de eventos batem com a captura legada já
   persistida, sem executar nova auditoria por `eth_getLogs`;
3. replay, duplicata, ordem e perda de `NOTIFY` têm teste;
4. seu cursor alcança o journal e freshness/latência ficam observáveis;
5. o publicador legado e o novo nunca ficam ativos simultaneamente.
