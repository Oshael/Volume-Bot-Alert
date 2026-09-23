# Piloto de retenção transfer raw — evidência de 2026-07-18

Estado: **piloto de 18/07 executado; o comando relatou a remoção da partição**.
Resultados enviados pelo operador em 2026-09-23, sem hora exata em todas as
consultas. A amostra não prova replay histórico integral nem autoriza retenção
geral de três dias.

## Partição e projeção

- `public.robinhood_token_transfer_events_2026_07_18`, dia UTC 2026-07-18.
- Watermark `rh_transfer_v1`, versão `1`, checkpoint `70814885`, hash
  `0xee4b8ae56bc408068275f7a264702a46a75194e4c9ce04859a3b4a9aea09907a`.
- Chain ID Archive `4663`; 2.391.278 eventos raw; 621.812 transfers elegíveis;
  soma raw elegível `2262882450600031326157858235460420`.

## Observações

| Verificação | Resultado | Limite |
| --- | --- | --- |
| Resumo e classificação | `rawEventCount=targetClassifiedEventCount=2391278`, `summaryMismatchCount=0`, contagem e soma elegíveis conferem | Agregados do dia, não replay de cada decisão. |
| Cursores e checkpoint | `positionComplete`, `cursorComplete`, `evidenceComplete`, `checkpointCanonical` e `classificationComplete` verdadeiros na auditoria read-only | São verificações pontuais; o gate transacional repete os critérios no momento do drop. |
| Recibos Archive | 24/24 recibos da amostra por tipo e 24/24 da amostra determinística conferem | Amostras, possivelmente sobrepostas; não cobrem os 2.391.278 eventos. |
| Decisões por tipo | 23/24 reproduzidas com os papéis atuais; uma diferença em `wallet_transfer` | A regra atual e os papéis persistidos podem divergir dos insumos históricos. |
| `wallet_self` | 172/172 têm `from_wallet=to_wallet` | Censo da identidade self, sem reconstrução dos papéis históricos. |
| Readiness | `blockedReasons=[]`, `provisionalGatesClear=true`, `readyForDrop=false`; gap de endpoint diferido | Ainda requer revalidação sob locks antes do drop. |

A cobertura de `unknown` preservado retornou `absent` na última sonda read-only
(59,327 s); a consulta exata anterior retornou `unpreserved_unknown=false`
(70,836 s). As sondas de reparo de posição, checkpoint e preimage não
encontraram bloqueio. O tempo das consultas explica por que uma tentativa
anterior de readiness de 60 s terminou em `unknown`, sem provar falta de
evidência.

## Divergência amostrada

O evento `0x23004b2d3fe35075ef78307d85f5a70c2a287a8081df4ec04fc59fa8f60e330a:10`
foi armazenado como `wallet_transfer`, enquanto a regra atual retorna
`contract_flow` (`known_contract_endpoint`). A linha raw está no bloco
`12587704`, hash
`0x0bf3967c2f3db3e16a4a05ebfca0caab00d9b5e696cae16bb8781fb9441d6d3a`,
às `2026-07-17 22:31:07-03`, índice de transação `4`. Token
`0x7e86381a763f0ecca2bdf27c54eac403ddd48123`; origem
`0x42f0a3b8405e1f19e97e22cf7e5526b20c5f8982`; destino
`0xf578b20020678ea4d5ee3700a03e7da6eacc6303`; valor raw
`3886049765533112256`.

O registro atual de papéis cobre esse bloco com origem `wallet` e destino
`contract`, mas a evidência de contrato do destino foi obtida no bloco
`18139112`, posterior ao evento. O Archive retornou `eth_getCode` igual a
`0x` para o destino no bloco `12587704` (zero bytes). Isso apoia a
classificação armazenada para esta linha e mostra que a decisão com papéis
atuais não é um replay histórico fiel. Não estabelece a classificação de
outros eventos do dia. O gate valida novamente a identidade e classificação
da linha, o censo de `wallet_self` e todos os critérios transacionais;
`recipientCodeBytesAtEvent=0` registra a medição Archive e não é reconsultado
no momento do drop.

## Alcance operacional

O [manifesto JSON](robinhood-transfer-raw-pilot-2026-07-18-report.json)
contém uma exceção limitada a esse evento e ao dia 18. A execução exige o
hash e versão esperados do watermark e a flag específica do dia; mudança no
checkpoint, resumo, raw, evidência ou posição aborta a transação.

O comando aplicado retornou `dropped=true`, partição
`public.robinhood_token_transfer_events_2026_07_18`, heap anterior
`base/17549/9003749`, tamanho total anterior `1.962.450.944` bytes e watermark
versão `1 → 2`; durou 60,740 s. O `df -B1` enviado após a execução mostrou
`72.366.526.464` bytes livres em `/` e `18.303.873.024` em
`/srv/trendscope-data-2`. Não foi enviada uma medição imediatamente anterior
nessa execução, portanto não há delta líquido de espaço atribuível ao drop.
A confirmação independente por catálogo e estado dos cursores ainda está
pendente. A remoção do transfer raw libera `/`; `chain_events` em
`/srv/trendscope-data-2` continua uma frente separada, e a retenção geral de
transfers continua em 30 dias.
