# Plano de execução — retenção raw e recuperação de espaço Robinhood

Este documento complementa o [plano de independência do Archive](robinhood-wallet-classification-archive-independence-plan.md). Ele define o trabalho **ainda pendente** para operar o LIVE com raw de no máximo três dias e recuperar espaço físico, sem tratar um watermark, duas tabelas novas ou um backfill concluído como autorização automática para apagar dados.

Status: plano, não rollout aprovado. Nenhum comando de remoção deve ser executado com base apenas neste texto. A VPS e o PC Archive não estão acessíveis por este repositório; as últimas coletas enviadas pelo operador são evidência histórica, não uma medição atual.

## 1. Resultado esperado e limites

- O caminho LIVE da VPS funciona com o node pruned e não consulta o PC Archive em operação normal.
- A meta é manter raw canônico e transfers raw por **no máximo três dias**. A auditoria deve ocorrer dentro dessa janela, com folga para repair; se falhar, a remoção é bloqueada e o desvio vira incidente visível, não uma extensão silenciosa da política.
- Cada fato ainda necessário após essa janela tem prova durável mínima, identificável e recuperável; trabalho sem prova vira `archive_required`, nunca conclusão vazia.
- Partições antigas de transfers são removidas somente após prova de cobertura e revalidação final. A liberação do filesystem é medida por mountpoint, não inferida da contagem de linhas removidas.
- `robinhood_chain_events` e suas dependências têm uma trilha de retenção separada; não se atribui a um corte de transfers a recuperação do NVMe que armazena essa tabela.
- O PC Archive serve para o passado, indisponibilidade maior que a janela local e reparos excepcionais. Não vira fallback silencioso de worker LIVE.

Não há como garantir simultaneamente raw de três dias, pendências de duração ilimitada e independência total do Archive **sem reter alguma evidência dessas pendências**. O tamanho dessa evidência deve ser medido antes de ligá-la em produção; se não couber, a política de retenção ou a capacidade precisa de uma decisão explícita, não de uma deleção arriscada.

## 2. Ponto de partida confirmado no código

| Área | Estado atual | Implicação |
| --- | --- | --- |
| Retenção de transfers | `RAW_RETENTION_DAYS = 30` em `src/models/robinhood-token-transfer-persistence.js`; planner e reparo de sumário reutilizam a constante | A meta de três dias **não está implementada** para essas partições. Não reduzir a constante antes dos gates. |
| Evidência `unknown` | Stage 243 cria `robinhood_wallet_transfer_pending_evidence`; a escrita depende de `ROBINHOOD_WALLET_TRANSFER_PENDING_EVIDENCE_ENABLED=true`, desligada por padrão | Existe captura opt-in, mas ainda não há cobertura dos dados antigos nem limite de crescimento. |
| Reorg e reclassificação | Stage 244 grava disposições append-only; reclassificação usa evidência sem raw quando o bloco canônico local ainda existe. O rollback de transfers exige raw na faixa órfã. O rollback de posições unificadas usa preimagens LIVE contínuas após um dia raw `dropped`, inclusive replay do prefixo canônico de lote. | As duas tabelas não tornam o raw descartável; faltam ativação/cobertura comprovada das preimagens, expurgo, orçamento de disco, ensaio integral de reorg e reparo de eventos cujo bloco canônico local também saiu. |
| Auditoria de transfers | O compaction audit pode marcar um dia `verified`; retention readiness consulta dependências e retorna `readyForDrop=false` em todos os casos | Watermark `verified` não é permissão de `DROP`; as sondas `candidate` e `unknown` falham fechadas. |
| Eventos canônicos | `robinhood:retention-safety-audit` protege consumidores; `robinhood:chain-events-prune` apaga eventos em batches com cutoff auditado | O pruner não elimina sozinho a dependência de funding/redistribution e `DELETE` não devolve automaticamente bytes do heap ao filesystem. |

Observações operacionais anteriores: havia `archive_required` de funding/redistribution bloqueando a poda de `chain_events`, e auditorias de partições de transfer encontraram `unknown`, gaps de endpoint e candidatos de posição. Esses números mudam com o LIVE; recolher baseline antes de qualquer intervenção. A alta participação de `unknown` em amostras anteriores impede assumir que a Stage 243 será pequena.

## 3. Contrato de dados e decisão de retenção

Fluxo desejado:

```text
captura canônica -> raw quente (até 3 dias)
                 -> classificação/projeção final durável
                 -> evidência pendente mínima, só quando ainda houver consumidor
                 -> disposição terminal ou reparo Archive explícito
                 -> auditoria por dia/bloco -> remoção controlada do raw
```

Para cada evento pendente preservado, o contrato precisa fixar identidade canônica (chain, bloco/hash, transação, índices e tempo), payload mínimo para repetir a decisão, versão da regra, origem da evidência e estado frente a reorg. A decisão final e sua lineage devem continuar disponíveis independentemente da partição raw. Evidência antiga não pode ser considerada válida após reorg só porque permanece na tabela: o marcador `orphaned` ou prova canônica equivalente deve ser aplicado antes de novo consumo.

A tabela de pendências não deve receber cópias de todos os transfers. Em cada dia, medir: fração `unknown`, bytes de heap/índices/WAL por evento, entradas e saídas por hora, idade p95/p99, itens sem resolução após 72 horas e projeção de capacidade. A arquitetura preferida é evidência imutável com identidade idempotente e disposição append-only, evitando `UPDATE`/`DELETE` por evento e milhares de dead tuples. A política de expurgo físico das evidências terminais deve ser definida antes da ativação; particionamento por dia ou outra estrutura recuperável só será escolhido após o perfil real de longevidade dos pendentes. Pendentes que não terminam não podem ser eliminados por TTL sem virar reparo Archive explícito.

## 4. Trilha A — transfers raw no volume principal

### A0. Baseline e orçamento de capacidade — sem escrita operacional

Medir simultaneamente por 15–30 minutos: entradas, resoluções e reclassificações de `unknown`, lag do wallet-transfer, ocupação e crescimento por mountpoint, tamanho diário de partições raw, WAL, waits/locks e tempos das fases do worker. Levantar quais partições mais antigas têm watermark, quais têm `unknown`, gaps de endpoint, reparos de posição e dependências de redistribution. Estimar crescimento da evidência por dia e total projetado sob a idade observada das pendências; aprovar um orçamento em GB e alertas antes de ativar a flag.

**Gate A0:** baseline datado, capacidade livre suficiente para o piloto e margem de rollback, e estimativa de evidência baseada em dados reais. Se a projeção não couber, não habilitar Stage 243 por tentativa: reduzir a população preservada com uma regra comprovada ou obter capacidade/armazenamento frio antes.

### A1. Fechar o contrato do LIVE sem raw

Adaptar a seleção e a aplicação de reclassificação para consumir a evidência pendente mesmo quando a partição raw já saiu; impedir escrita numa partição recriada acidentalmente. Reconciliar disposição `reclassified`/`orphaned`, canonicalidade e versões de regra numa transação cercada pelo mesmo fence do writer. Examinar todos os consumidores identificados pelo readiness — endpoint roles, posição transfer/sell e redistribution — e persistir seus insumos mínimos ou provar que sua fila já está materializada antes de permitir o corte do raw. Uma sonda `candidate` não deve ser reinterpretada como `absent` sem evidência.

Adicionar testes de integração para: evento preservado sem raw, repetição/idempotência, reorg antes/depois da remoção, versão alterada, falha transacional e consumidor downstream pendente. Só depois habilitar a captura para novos eventos, com monitoramento de tamanho e taxa. Manter a flag desligada durante o desenvolvimento.

**Gate A1:** um evento recente `unknown` pode chegar a resultado final com raw presente ou ausente, com a mesma decisão e efeitos; reorg e erro não geram classificação falsa nem cursor adiantado. O crescimento medido fica dentro do orçamento aprovado.

### A2. Cobrir o legado e provar uma partição

Para partições antigas, fazer reparo no PC Archive de forma retomável e idempotente **enquanto o raw ainda existe**, ou materializar a evidência mínima faltante com lineage canônica. Selecionar uma partição-piloto pequena e antiga; comparar contagem, somas e amostra determinística de decisões/projeções com o raw e com o replay Archive. Verificar o estado das filas downstream e registrar manifesto do dia, versão de regra, watermark, checkpoint e hash canônico. Isso precisa acontecer antes de qualquer remoção.

O readiness deixa de ser `readyForDrop=false` apenas após implementação de um gate final atômico/fail-closed: partição anexada e bounds exatos, dia além dos três dias, watermark atual, cobertura de evidência de pendentes, posição/sumário reconciliados, todos os consumidores além do fim do dia ou materializados, ausência de dependências raw `candidate`/`unknown`, checkpoint canônico, ausência de reorg/recovery ativo e nenhuma nova escrita elegível. Um gap de papel pode ser diferido somente quando a evidência `unknown` está íntegra e a descoberta/reclassificação sem raw funciona; o gate final ainda precisa validar o caminho de resolução e sua capacidade. Revalidar imediatamente antes da ação destrutiva sob lock/fence apropriado; se o estado mudar, abortar.

**Gate A2:** relatório do piloto assinado operacionalmente, replay/paridade aprovados e readiness final `readyForDrop=true` **somente** para o dia específico. Se o Archive não conseguir reproduzir uma decisão derivada, preservar a prova local correspondente; não chamar a diferença de tolerável sem decisão explícita.

### A3. Remoção-piloto e política diária

Em uma janela aprovada pelo operador, remover **uma** partição validada usando o fluxo implementado e flag de confirmação específica. Registrar tamanho físico antes/depois em `/`, `/srv/trendscope-data` e `/srv/trendscope-data-2`, além de lag LIVE, WAL, bloqueios, erros, filas e resultados de classificação. Não executar `DROP` manual sugerido por relatório de catálogo. Após soak e restart sem Archive no caminho LIVE, ampliar gradualmente para os dias elegíveis. Só então mudar o contrato de 30 para três dias; a mudança de constante e o drop não devem ocorrer na mesma etapa cega. Monitorar diariamente itens que estourariam 72 horas: se `archive_required` virar rotina, o LIVE ainda não cumpriu a meta e a política precisa ser reaberta.

Rollback de código não recria raw apagado. Após a primeira remoção, recuperação histórica depende de replay Archive comprovado e do manifesto; antes disso, rollback é desligar o writer novo e manter o raw. Nunca avançar cursores manualmente ou marcar uma pendência resolvida para liberar uma partição.

## 5. Trilha B — `chain_events` no NVMe de 500 GB

Esta trilha é independente da A **e sua triagem de capacidade é imediata**, sem esperar os cortes de transfers. O espaço de `/srv/trendscope-data-2` só pode ser atribuído ao objeto cujo tablespace está nesse mountpoint; índices movidos ou partições de transfers no volume principal não resolvem sua pressão. Recolher `df`, tamanho real de heap/índices/filhos, crescimento em bytes/hora, WAL e localização dos objetos imediatamente antes da operação. Se a projeção de espaço livre acabar antes da execução segura, a ação correta é criar margem física/capacidade; não desligar um gate de retenção.

1. Fechar as dependências do `robinhood:retention-safety-audit`: funding e redistribution `archive_required`, outbox, refreshes, holder, cursores e checkpoints. Reparar histórico com PC Archive quando a prova não existe na VPS. Itens pendentes não são dispensados só por serem antigos.
2. Quando o audit autorizar um cutoff, executar apenas um piloto pequeno do pruner existente, medindo tempo, WAL, lag dos workers e bytes reutilizáveis. Um `DELETE` cria espaço **reutilizável pelo PostgreSQL**, mas não implica queda de `df`; portanto não prometer recuperação física imediata com esse passo.
3. Para recuperar bytes do filesystem de uma relação monolítica, escolher uma estratégia física separada depois de calcular espaço temporário, I/O, locks e tempo de execução: migração online para particionamento com descarte de partições antigas, ou reescrita/repack controlada. Com o volume quase cheio, nenhuma dessas opções deve começar sem espaço temporário comprovado ou capacidade adicional. `VACUUM FULL` em produção não é o atalho presumido.
4. Validar que o mecanismo futuro acompanha reorg, inserts novos e consumidores antes de reduzir a janela para três dias. Repetir a mesma auditoria de segurança imediatamente antes de cada corte físico.

**Gate B:** nenhum `archive_required` ou outro bloqueio no prefixo candidato, redução física comprovada por `df` quando essa for a meta, e nenhuma regressão sustentada de captura, wallet-transfer, holders ou classification. Se o pruner só aumentar WAL/dead tuples sem melhorar a métrica de capacidade, parar e revisar a estratégia; não confundir progresso lógico com liberação de disco.

## 6. Ordem dos cortes de código e validação

Cada corte exige autorização própria, no máximo 500 linhas de código/testes/schema, revisão integral do diff e commit por escopo. O plano operacional pode ser detalhado sem consumir esse limite.

| Corte | Entrega única | Validação mínima e saída |
| --- | --- | --- |
| 0 | Instrumentação/relatório read-only de capacidade, cobertura e taxa de pendências | Comparar duas janelas; sem alteração de LIVE. |
| 1 | Contrato de leitura/aplicação sem raw para evidência pendente, sem habilitar writer | Testes de integração de sucesso, conflito, reorg e falha; auditor ainda bloqueia drop. |
| 2 | Política de crescimento/expurgo das evidências e writer opt-in com orçamento/telemetria | Medir bytes/dia, WAL, dead tuples e latência antes/depois; desligar flag se exceder o orçamento. |
| 3 | Reparação legada e manifesto/paridade por partição | Piloto em partição intacta; nenhuma remoção. |
| 4 | Readiness final + operação confirmada de uma partição de transfer | Revalidação canônica na execução, testes destrutivos em ambiente isolado e aprovação humana na VPS. |
| 5 | Rollout gradual para três dias, soak e documentação operacional | `df` realmente cai; LIVE segue saudável sem Archive; backlog histórico explicitado. |
| B | Trilha física de `chain_events`, em paralelo aos cortes A após triagem imediata e auditoria | Medir espaço físico, WAL e lag; não misturar com cortes de transfers. |

Em qualquer corte de comportamento: `npm run lint` e o menor teste afetado; schema/init também requer `npm run db:schema-check` e integração de persistência. Mudanças de flag ou worker exigem medição antes/depois no mesmo intervalo e revisão dos guardrails. O manual operacional em `docs/bot-reference.md` só deve ser atualizado quando o comportamento efetivo mudar, sem registrar progresso temporário como estado permanente.

## 7. Critérios finais de aceite

1. Três dias são a política **implementada e observada**; não apenas o objetivo do documento.
2. Uma partição antiga é removida com manifesto, cobertura completa, revalidação canônica final e autorização do operador; a capacidade recuperada é medida no mountpoint correto.
3. `unknown` posterior ao corte consegue ser reclassificado sem raw, ou é explicitamente `archive_required` conforme o contrato aprovado — nunca some em silêncio.
4. A evidência pendente tem crescimento líquido conhecido, orçamento, alerta e mecanismo de descarte de itens terminais; não vira uma segunda tabela raw sem prazo.
5. Captura, funding, redistribution, holders, wallet-transfer e posições mantêm frontiers/lag saudáveis após restart, reorg ensaiado e Archive indisponível para o LIVE.
6. O NVMe de `chain_events` tem estratégia própria que recupera espaço **físico** de modo sustentável. Até lá, a pressão desse volume continua um risco aberto, mesmo que transfers sejam resolvidos.

## 8. Condições de parada

Parar antes de escrita destrutiva se faltar margem física para rollback/replay, se uma auditoria der timeout ou `unknown`, se aparecer dependência nova do raw, se houver reorg/recovery ativo, se qualquer consumidor estiver atrás da faixa, se a capacidade da evidência exceder o orçamento, ou se a medição de lag/WAL piorar sem ganho na métrica primária. Reportar o bloqueio e pedir uma decisão específica; não contornar o gate alterando cursor, retenção ou status de fila.
