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

## Readiness e capacidade informados em 2026-09-23

O operador repetiu o readiness read-only, ainda com retenção de 30 dias. Para
`2026-07-19`, `blockedReasons=[]`, `provisionalGatesClear=true` e
`readyForDrop=false`; o gap de papel de endpoint permanece `candidate` diferido.
Para `2026-07-18`, `canonicalCheckpointNotProven_candidate` ainda bloqueia a
partição. Esses resultados não substituem a revalidação transacional final.

O `df -B1` enviado sem hora de medição mostrou bytes disponíveis: `/`
`70.955.597.824`, `/srv/trendscope-data` `72.093.966.336` e
`/srv/trendscope-data-2` `21.436.461.056`. O heap do piloto estava no volume
`/` na medição de localização anterior; reconfirmar antes da operação. A remoção
do piloto não recuperaria espaço no volume de `chain_events`, que exige uma
decisão operacional independente.

## Exceções aprovadas como critério do piloto

O valor raw armazenado é `wallet_self` em todos os casos abaixo. O hash da
transação, índice do log e tempo identificam a linha raw; bloco/hash e índice
da transação ancoram o evento canônico. Os horários preservam o offset `-03`
do resultado da VPS. A coluna final é a decisão da regra com os insumos atuais.
O payload Transfer não é copiado: os recibos Archive correspondentes foram
conferidos pela auditoria.
As 12 exceções ocorreram entre 00:03:01 e 00:34:14 UTC de 2026-07-19;
essa concentração temporal não estabelece sua causa.

| transaction_hash | log | block_time | bloco | block_hash | tx index | replay atual |
| --- | ---: | --- | ---: | --- | ---: | --- |
| `0x01ffa5c1f91a89751f12351695d8d4016099d4da14b1a28427746f80606be043` | 1 | `2026-07-18 21:27:16-03` | 13410055 | `0xbb58c196f19bbfed674ef5d0ad213720e6bedfa12526e471302b03bfef42492f` | 2 | `unknown` |
| `0x24fd28499139094c674a518f8191fb0960b74f59b1f3a0728e6fbfc92bf537d6` | 30 | `2026-07-18 21:03:01-03` | 13395564 | `0x7951e0eebe5ba15a64d60f72b58a9f890a65950cc8fd84df118a0753a176516c` | 4 | `unknown` |
| `0x37692e985529c37a5d6f11956d4f60f4998927935612fbf9633e44f5fff1173e` | 17 | `2026-07-18 21:23:49-03` | 13408001 | `0x8d4d124a0eab60459e4da50a1492af89c3cf915a9998a1b891b0dcee75cab604` | 4 | `unknown` |
| `0x54985f1b6ac95550b949e301fa22b1fc335c3b88cc42df2e4f58d2f435655d22` | 62 | `2026-07-18 21:20:17-03` | 13405878 | `0x582a731ef60b9f9175f260976231d2e2d5c4a573ed5ca801ac94b37140a46994` | 9 | `contract_flow` |
| `0x8c0c35ab6f17563523404dbc34ceb3ca092c4e2cc077bd2bab3f8e41125841c4` | 48 | `2026-07-18 21:03:25-03` | 13395797 | `0x993f718900e74a49ab85505151160369d9b43b67339d04615346b9f125fca308` | 4 | `unknown` |
| `0x951df386ad80c57f61dafe3448aeb7f53aadc9dc779bb26d0b476bd1055c4f19` | 6 | `2026-07-18 21:17:20-03` | 13404121 | `0xa0d0641a25a29d98ef393b63f0e7e664f0a53c5b6ff3a8226ffdbef68f18d184` | 2 | `unknown` |
| `0xab50364c0ccea7e3015f7444d8da15842fbf0dd484ed31b37758408d14843165` | 40 | `2026-07-18 21:24:20-03` | 13408309 | `0xe4af693eb0190dd86be55b96b704360e2e55819ca13fa689bc3dc7a5ed022fa9` | 5 | `unknown` |
| `0xbd5b3ba8b3a65a98c664c29a0d83efb115ac7a8edb0dc10fe483e6ea5ec3b696` | 14 | `2026-07-18 21:27:10-03` | 13409997 | `0xb829446dfee7550e1f75fa407e6828e2b0ecf0c51f7285292fb51b6486a64f0d` | 5 | `unknown` |
| `0xeff1c519cc2fc8005037b8e786861485620b0d0679d50647b27103499b9cf0f2` | 1 | `2026-07-18 21:14:12-03` | 13402250 | `0x0af4088267644372b0eebf5bc4d028e817ab3d7f3ffe4751aa95ad5924d1fffe` | 2 | `unknown` |
| `0xf85d3f0068e75174ed3aa203274c264353fda87bee74c413c02a9dd28a94a487` | 5 | `2026-07-18 21:13:34-03` | 13401867 | `0x5c42be2fb7165cb02ea5ae66fccb665a376ee137de12e2a2bd10b0714269a3f7` | 5 | `unknown` |
| `0xfb5209bad7e19a487a8038081941ffbe55f2624892c5a42f50895500ba354667` | 8 | `2026-07-18 21:34:14-03` | 13414226 | `0x79270673ae32ea522a791cdfc7af7b150af8590cc30334cb5ea537f6242b1dc5` | 3 | `unknown` |
| `0xfc9e9a0cec30bc90d9f5b3cbb114cf481f24bafa9ef349e287e62aa8faad9266` | 0 | `2026-07-18 21:20:57-03` | 13406277 | `0x7df4c3642e3486145e4a4c05ceee78034426e10d7ed62f6385508bd19c77a806` | 4 | `contract_flow` |

## Limites e aprovação operacional pendente

As 12 entradas acima preservam a classificação armazenada e sua âncora
canônica mínima. O relatório **não** demonstra paridade histórica integral
nem converte `archiveReplay.status=sample_only` em `matched`. O operador aceitou
em 2026-09-23 essas 12 diferenças como exceções **somente para o critério do
piloto de 19/07**. A causa histórica continua desconhecida. O
[relatório JSON](robinhood-transfer-raw-pilot-2026-07-19-report.json) identifica a amostra e as
12 âncoras sob o status `sampled_with_approved_exceptions`. Ele ainda não contém
`approvedBy` e `approvedAt`, portanto não autoriza o comando de drop.

Antes do drop: reexecutar readiness, conferir espaço e localização física, e
obter aprovação operacional do relatório vinculado ao watermark/checkpoint
atuais. A transação de drop deve revalidar os gates e as 12 exceções sob locks.
A política geral continua em 30 dias.
