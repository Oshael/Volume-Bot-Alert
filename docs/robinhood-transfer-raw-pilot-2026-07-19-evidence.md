# Piloto de retenção transfer raw — evidência de 2026-07-19

Estado: **rascunho para decisão operacional; remoção não autorizada**. Este
documento preserva o resultado enviado pelo operador em 2026-09-23. Os comandos
não informaram uma hora de medição para todos os resultados. Revalidar os gates
imediatamente antes de qualquer operação destrutiva.

## Identidade da partição

- Partição: `public.robinhood_token_transfer_events_2026_07_19`, dia UTC
  `2026-07-19`.
- Watermark `rh_transfer_v1`: versão `0`, checkpoint `65684313`, hash
  `0x928ef2879d82050a8f4f5872b2c95bcd13a61ce60f5ae6afe2350a49a2492f08`.
- Eventos raw: `2.135.606`; classificados na versão: `2.135.606`.
- Elegíveis a transfer/edge: `604.928`, soma raw
  `74426142752118239393023723190536`.

## Evidência observada

| Verificação | Resultado informado | Alcance |
| --- | --- | --- |
| Checkpoint Archive | chain ID `4663` e hash do checkpoint conferem | Ancora o RPC consultado; não reexecuta todas as decisões. |
| Raw x watermark | Contagem e soma elegível conferem | Agregado do dia. |
| Recibos Archive | 24/24 no primeiro probe; 100 eventos/64 recibos no probe limitado; 56/56 na amostra por tipo | Amostras que podem se sobrepor; não representam os 2.135.606 eventos. |
| Classificação por tipo | 44/56 repetem com os insumos atuais; 12 divergências, todas `wallet_self` | Testa a regra atual; papéis históricos não foram reconstruídos. |
| `wallet_self` | 35/35 têm `from_wallet = to_wallet`; os 35 tiveram recibos conferidos no Archive | Prova a identidade de self-transfer, não o papel histórico da wallet. |
| Resumos por token | `summaryMismatchCount=0`; contagem e soma elegíveis idênticas ao raw | Paridade exata de resumos para a partição, conforme auditoria read-only. |
| Posição e cursores | `positionComplete=true`, `cursorComplete=true`, `checkpointCanonical=true` | Fronteira além do dia e checkpoint atual canônico; não é replay de cada posição. |

O código da Stage 138 exige endpoints iguais para `wallet_self`. A projeção de
transfers aceita apenas `wallet_transfer` e `dex_flow` em arestas/resumos;
self-transfer não ajusta posições. Isso explica por que as 12 diferenças de
classificação **não implicam**, por si, diferenças nesses agregados. Não foi
estabelecida a causa histórica das diferenças: o conjunto de papéis atual pode
ter mudado ou a decisão original pode ter passado pela correção da Stage 138.

## Exceções que precisam de decisão explícita

O valor raw armazenado é `wallet_self` em todos os casos abaixo. A coluna final
é a decisão da regra com os insumos atuais. Os pares `transaction_hash` +
`log_index` localizam os casos; um manifesto canônico completo ainda exige
`block_time`, bloco/hash e os campos Transfer. O payload Transfer pode ser
consultado no recibo Archive que foi conferido no audit.

| transaction_hash | log_index | replay atual |
| --- | ---: | --- |
| `0x01ffa5c1f91a89751f12351695d8d4016099d4da14b1a28427746f80606be043` | 1 | `unknown` |
| `0x24fd28499139094c674a518f8191fb0960b74f59b1f3a0728e6fbfc92bf537d6` | 30 | `unknown` |
| `0x37692e985529c37a5d6f11956d4f60f4998927935612fbf9633e44f5fff1173e` | 17 | `unknown` |
| `0x54985f1b6ac95550b949e301fa22b1fc335c3b88cc42df2e4f58d2f435655d22` | 62 | `contract_flow` |
| `0x8c0c35ab6f17563523404dbc34ceb3ca092c4e2cc077bd2bab3f8e41125841c4` | 48 | `unknown` |
| `0x951df386ad80c57f61dafe3448aeb7f53aadc9dc779bb26d0b476bd1055c4f19` | 6 | `unknown` |
| `0xab50364c0ccea7e3015f7444d8da15842fbf0dd484ed31b37758408d14843165` | 40 | `unknown` |
| `0xbd5b3ba8b3a65a98c664c29a0d83efb115ac7a8edb0dc10fe483e6ea5ec3b696` | 14 | `unknown` |
| `0xeff1c519cc2fc8005037b8e786861485620b0d0679d50647b27103499b9cf0f2` | 1 | `unknown` |
| `0xf85d3f0068e75174ed3aa203274c264353fda87bee74c413c02a9dd28a94a487` | 5 | `unknown` |
| `0xfb5209bad7e19a487a8038081941ffbe55f2624892c5a42f50895500ba354667` | 8 | `unknown` |
| `0xfc9e9a0cec30bc90d9f5b3cbb114cf481f24bafa9ef349e287e62aa8faad9266` | 0 | `contract_flow` |

## Limites e decisão pendente

Os 12 pares acima registram a decisão raw que o replay com papéis atuais não
reproduziu, mas ainda não formam um manifesto canônico completo. O relatório
**não** demonstra paridade histórica
integral nem converte `archiveReplay.status=sample_only` em `matched`. Ele também
não contém aprovação de operador e não serve como `--pilot-report` para o
comando de drop.

Antes do piloto: completar a identidade canônica dessas exceções e decidir
explicitamente se o invariante sem efeito financeiro basta; reexecutar
readiness, conferir espaço e localização física, e obter relatório operacional
aprovado vinculado ao watermark/checkpoint atuais. A transação de drop deve
revalidar os gates sob locks. A política geral continua em 30 dias.
