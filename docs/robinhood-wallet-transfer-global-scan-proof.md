# Prova compacta de leitura global de Transfer

A Stage 261 acrescenta `robinhood_wallet_transfer_global_scans`, sem alterar
arrays, versões ou ranges antigos. Não converte o histórico de 96,5 GiB.
O leitor de cobertura exige esse schema antes de atualizar seu código:
`node src/utils/db-init-stage261.js`, seguido de `npm run db:schema-check`.
Esse procedimento exige autorização de escrita no ambiente de destino; a VPS
permanece somente leitura nesta revisão.

O formato `canonical-global-v1` registra uma faixa integral, checkpoint, versão
de cursor, contagens e somente contratos observados com Transfer não selecionados.
Não observar Transfer de um token prova ausência apenas numa leitura global
completa. Encontrar logs omitidos impede cobertura desse token. Contratos presentes
apenas em swaps não mudam essa prova de Transfer.

`buildGlobalScanProof` recebe contratos descobertos antes de decodificar, a seleção
coerente com o lote e contagens exatas. O produtor precisa provar faixa integral
canônica, limites sem truncamento e validação estrita dos logs selecionados antes
de afirmar `complete` e `selectedLogsValidated`. Esses campos não certificam a
origem de um objeto arbitrário. O produtor LIVE `canonical_journal` usa
`readSelectedRange`: consulta headers, logs globais, swaps e participação atual
num único snapshot REPEATABLE READ READ ONLY. Inclui contratos presentes apenas
em swaps na seleção financeira. Valida estritamente Transfers selecionados;
contratos omitidos permanecem explicitamente excluídos. Headers ausentes, cobertura
indisponível e logs selecionados inválidos abortam antes de avançar o cursor.

`persistGlobalScanProof(client,batch,capture)` revalida e trava o cursor inicial,
exige fronteira inteira de bloco e checkpoint canônico, e não abre/commita transação.
O chamador deve persistir efeitos financeiros, avançar cursor e publicar invalidação
na mesma transação. A leitura rejeita provas cuja versão/progresso ainda não estão
confirmados pelo cursor. Retries da mesma identidade/payload reutilizam a prova;
payload divergente falha. Reorg torna o checkpoint órfão inelegível; replay cria
outra prova. A FK conserva a identidade do cursor: sua remoção exige tratar
explicitamente as provas associadas.

Limites: até 5.000 blocos, 100.000 logs, 10.000 contratos e 450.002 bytes na
representação textual de exceções. O banco reforça contagens e limites; listas
com null ou endereços inválidos são recusadas. Exceder limites exige subdividir
antes do commit, sem declarar completo um bloco/lote truncado. O produtor reduz
a faixa pela metade ao exceder linhas/contratos; um único bloco acima do limite
falha com `wallet_transfer_global_limit`, sem fallback para o catálogo completo.
Swaps também têm teto de 100.000 linhas. Cada statement tem até 5s, lock timeout
de 1s e orçamento compartilhado de 15s entre consultas/tentativas; transferência
e processamento local não têm prazo rígido. O worker mantém retry/backoff e
telemetria de candidatos, exclusões, subdivisões, manifesto e taxa/lag do cursor.

O leitor agrega os quatro formatos e mantém os gates de continuidade, checkpoint
canônico, seed/LIVE e disponibilidade raw. Sem todas essas provas, ranking permanece
incompleto; o manifesto global sozinho não prova cobertura temporal ou financeira.

**Ponto importante:** aplique Stage 261 e verifique schema antes de atualizar
leitor e worker canônico. O commit grava prova, efeitos financeiros, cursores e
invalidação na mesma transação; RPC e backfill preservam o manifesto anterior.
Antes da ativação faça paridade somente leitura em faixas reais e registre
baseline/guardrails para comparar throughput, lag, WAL e I/O. Esta integração
não recupera o histórico de 96,5 GiB nem comprova correção do lag observado.
