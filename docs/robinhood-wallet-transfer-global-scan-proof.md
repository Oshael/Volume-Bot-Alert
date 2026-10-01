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
origem de um objeto arbitrário. O produtor LIVE ainda não implementa esse contrato.

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
antes do commit, sem declarar completo um bloco/lote truncado.

O leitor agrega os quatro formatos e mantém os gates de continuidade, checkpoint
canônico, seed/LIVE e disponibilidade raw. Sem todas essas provas, ranking permanece
incompleto; o manifesto global sozinho não prova cobertura temporal ou financeira.

**Ponto importante:** este corte prepara schema, validação, persistência e leitura.
Não conecta o produtor LIVE, não troca o worker nem aplica a migration na VPS.
Antes da ativação faltam produtor global limitado, seleção coerente por lote,
integração com o commit financeiro e paridade do fluxo completo.
