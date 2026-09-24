# Retenção física de `robinhood_chain_events`

## Objetivo e estado observado

Manter pelo menos três dias de eventos canônicos disponíveis ao LIVE e devolver ao filesystem o espaço dos eventos expirados, sem `VACUUM FULL`. A política temporal já é de três dias no pruner, mas a tabela ainda é monolítica: `DELETE` abre espaço reutilizável dentro do PostgreSQL e não constitui retenção física sustentável.

Em 24/09/2026, após reconstruir `idx_rh_chain_events_order` em `trendscope_raw`, `/srv/trendscope-data-2` passou de 12.531.404.800 para 33.793.499.136 bytes livres. A relação `robinhood_chain_events` tinha cerca de 411 GB. Um `EXPLAIN` sem `ANALYZE` estimou 364,5 milhões de linhas antes de um cutoff de três dias e 66,1 milhões depois dele. São estimativas do planejador, não contagens nem orçamento de migração. Recolher medidas atuais antes de qualquer operação.

O piloto de 5.000 `DELETE`s levou 2,27 segundos e não demonstrou queda em `df`. Não extrapolar esse tempo para centenas de milhões de linhas: WAL, cascades, autovacuum e concorrência variam. Não usar `--until-drained` para pagar a dívida histórica; o audit do comando roda uma vez no início da execução.

## Restrição de esquema

`robinhood_chain_events` tem PK `(chain, block_hash, log_index)`, FK para transações e índices por ordem e tópico. Quatro tabelas referenciam essa PK com `ON DELETE CASCADE`: `robinhood_chain_domain_outbox`, `robinhood_canonical_head_candidates`, `robinhood_chain_v3_balance_snapshots` e `token_launchpad_lifecycle_events`. A captura LIVE escreve eventos e filhos na mesma transação. Trocar apenas o nome da tabela por uma cópia recente deixaria as FKs apontando para o OID antigo.

Particionar por bloco exige uma chave única que contenha `block_number`. Os filhos precisam referenciar a nova chave; `robinhood_chain_v3_balance_snapshots` ainda não armazena `block_number`. As consultas que dependem de `(chain, block_hash, log_index)`, os deletes de reorg e a validação de esquema precisam ser revisados. Não presumir que `DROP` de uma partição apaga filhos como um `DELETE` com cascade: testar e remover referências antigas de modo comprovado antes do descarte físico.

## Decisão técnica

Usar uma tabela sombra particionada por intervalos de `block_number`, com partições suficientemente estreitas para limitar o excedente sobre 72 horas. A regra de elegibilidade usa **tempo do bloco canônico**, não apenas diferença de altura. Descartar uma partição somente quando todos os seus blocos forem anteriores a três dias **e** o cutoff do safety audit, não houver recuperação/reorg ativo, e as referências dos quatro filhos estiverem resolvidas. Eventos na partição de fronteira continuam sujeitos a `DELETE` limitado, com o mesmo gate e piso temporal; isso não impede que as partições inteiramente expiradas sejam removidas fisicamente.

O tamanho do intervalo de blocos e o número máximo de partições são parâmetros de projeto a definir com a taxa de blocos medida. Uma partição grande demais retém muitos bytes além de três dias; uma pequena demais aumenta custo de planejamento, FKs e manutenção. Pré-criar a próxima faixa antes de a captura alcançá-la e falhar fechado se ela faltar. Não criar partições de forma oportunista em cada evento LIVE.

Evitar `UPDATE` e `DELETE` em massa na sombra. A FK da sombra para transações usa
`ON DELETE CASCADE`: remover primeiro transações ainda referenciadas por eventos
espelhados geraria tuplas mortas nessas partições. A limpeza de transações deve
ignorar essas referências até a partição elegível ser descartada. Reorgs podem
exigir remoções pontuais; medir separadamente seus efeitos. Antes e depois de
cada piloto, comparar por partição deltas de `n_tup_upd`, `n_tup_del`, estimativa
de `n_dead_tup` e bytes de heap/índices. Contadores acumulados isolados não provam
taxa de geração de tuplas mortas.

`pg_repack` integral e reescrita simples não são o primeiro corte: a relação atual é maior do que o espaço livre dos volumes, e um repack integral precisa de espaço temporário da ordem da tabela e de seus índices. Depois de pagar a dívida histórica, um repack poderia recuperar espaço uma vez, mas manteria a tabela monolítica e a próxima dívida voltaria a crescer. A migração para partições resolve a retenção física recorrente.

## Fronteiras de implementação

Este é um checkpoint de arquitetura. Estimativa: 14 a 20 arquivos de produção, além de testes, esquema e referência operacional; cerca de 1.500 a 2.500 linhas ao longo de cinco a sete cortes de no máximo 500 linhas cada. Os limites são:

1. **Prova do desenho:** reproduzir em PostgreSQL 16 as FKs para o pai particionado, `ON DELETE CASCADE`, descarte de partição, reorg e queries sem `block_number`. Fixar chave, largura da partição e índices com um teste de integração pequeno. Nenhuma alteração na VPS.
2. **Esquema aditivo:** criar tabela sombra e partições iniciais sem trocar leitores ou writers. Adicionar `block_number` ao filho V3 com preenchimento limitado e prova de igualdade com o evento pai. Verificar schema e índices. Nenhuma cópia histórica massiva.
3. **Espelhamento LIVE:** escrever na sombra na mesma transação que confirma captura, com idempotência por identidade canônica e tratamento de reorg. O caminho antigo continua autoritativo. Medir WAL, latência de captura e crescimento por volume; permitir desligar o espelho sem perder o cursor.
4. **Cópia recente e paridade:** copiar somente a janela necessária, em lotes limitados por bloco e orçamento de disco; capturar o tail pelo espelho. Conferir contagem, identidade, hashes, payload, filhos e ausência de gaps por faixa. Medir também os filhos antigos fora da janela; descartá-los somente após a mesma prova de consumo ou preservar separadamente a evidência que ainda precisa sobreviver. Não avançar cursor nem marcar evidência como resolvida para fazer a paridade passar.
5. **Cutover das FKs e do writer:** parar a captura somente na transação curta de troca; revalidar cutoff, reorg, paridade e espaço. Provar zero referências de filhos ausentes da tabela nova, trocar as quatro FKs para a nova chave e validá-las antes de remover a tabela antiga. Um nome novo sem reatar FKs não é cutover. Se não houver modo de manter os filhos íntegros durante a troca, adiar o cutover.
6. **Descarte controlado:** testar uma partição expirável com audit imediatamente antes, prova de que nenhum filho precisa de sua linha, lock curto, medição de `df`, WAL e lag. Só então habilitar a política recorrente no worker de manutenção existente. Não criar um serviço permanente novo.
7. **Remoção da tabela antiga:** somente após soak, restart, reorg ensaiado, paridade repetida e rollback definido. Medir o tamanho de cada volume antes/depois; não considerar o projeto concluído por contagem de linhas ou `n_dead_tup` menor.

Cada corte é validado e cometido separadamente. Mudança de schema exige `npm run db:schema-check` e integração de persistência; comportamento backend exige `npm run lint` e o menor teste afetado. Revisar o diff completo antes de cada commit. Não iniciar o próximo corte por ter apenas testes verdes.

## Gates operacionais para a migração

- Medir no mesmo instante `df -B1` dos três volumes, tamanho de heap/índices, WAL, temporários, crescimento em bytes/hora e frontiers da captura e dos quatro consumidores. Usar a amostra real da janela a copiar para um limite superior de bytes; a estimativa de linhas do `EXPLAIN` não basta.
- Orçar a cópia recente, índices, log de mudanças, WAL, temporários e margem de falha **no volume em que cada objeto será criado**. Se qualquer orçamento superar o livre disponível, criar capacidade antes de começar. O índice movido deu margem, não espaço ilimitado.
- Confirmar `chain_events.ready_for_pilot`, ausência de `archive_required`/`blocked` nas dependências e checkpoints canônicos imediatamente antes de cada corte destrutivo. O bloqueio do holder journal é separado; um `ready_for_pilot` global falso não deve ser confundido com o gate da tabela de eventos.
- Não rodar poda histórica paralela à construção de índice ou à cópia da sombra. Se o worker de manutenção estiver habilitado para `chain_events`, contabilizar seus lotes e desativá-los durante a cópia controlada para evitar disputa e WAL não orçado.
- Antes de qualquer `DROP`, provar que os quatro filhos não guardam referências que precisem sobreviver. Se a relação antiga ainda sustentar um leitor ou uma FK, o descarte é bloqueado.

## Critério de aceite

O LIVE escreve e lê pela tabela particionada após restart e reorg; os quatro filhos mantêm integridade referencial; o gate impede remover qualquer evento com menos de 72 horas ou exigido por consumidor/classificação; ao menos uma partição antiga foi removida e o `df` do volume correto caiu de forma mensurada; a política continua removendo partições expiradas sem replay histórico nem `VACUUM FULL`.
