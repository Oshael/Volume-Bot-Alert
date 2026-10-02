# Preparação de mapas dos scopes históricos

Ferramenta manual, fora do LIVE. Ela prepara uma representação equivalente dos
arrays inline e conjuntos por hash, sem retirar a fonte nem trocar referências
dos ranges. O progresso confirmado é o mapa imutável gravado por hash. Repetir um
range valida/reutiliza esse mapa, sem reservar novamente IDs de tokens conhecidos.
Mapas novos são inseridos em `robinhood_wallet_transfer_scope_bitmap_staging`
(Stage 263), sem `INSERT`/`UPDATE` na tabela legada de conjuntos. Mapas publicados
anteriormente nas colunas da Stage 262 também são validados e reutilizados.

**Ponto importante:** aprovação de código não autoriza executar `--commit` na VPS.
Esta preparação não libera os 96,5 GiB nem comprova correção do lag. Ela pode
acrescentar espaço e WAL; a recuperação física e a retirada dos arrays são operações
posteriores. A tabela de preparação não tem FK para os conjuntos legados, pois
arrays inline ainda não têm referência por hash: não limpar mapas “órfãos”.
Leitores e gates de cobertura não consultam essa tabela; a preparação não publica
mapas nem muda a fonte de verdade do ranking.

Antes de publicar/reiniciar código que exige esse schema, aplicar Stage 262 e
Stage 263 (`node src/utils/db-init-stage263.js`) e executar `npm run db:schema-check`.
Manter os leitores compatíveis publicados. Conferir orçamento de disco/WAL, slots/archive,
leases e frontier de capture, swaps e transfers. Não iniciar quando o LIVE estiver
atrasado ou houver pressão de disco/I/O. A ferramenta não instala schemas nem
ativa/reinicia workers. Não existe loop de retries, serviço ou timer.

Execute a simulação limitada:

```sh
node src/utils/convert-robinhood-wallet-transfer-scope-history.js \
  --projection-version=rh_transfer_v1 --stream=live --max-ranges=1
```

Após autorização específica do piloto, a mesma chamada com `--commit` prepara
até um range. Use os mesmos parâmetros nas comparações. Não acrescentar
`--commit` às chamadas seguintes sem autorização para a campanha/lotes.
Para o primeiro dicionário grande, simular/autorizar explicitamente o budget de
30s (`--budget-ms=30000`) e conferir IDs consumidos antes de repetir um timeout.

Defaults: um range, até 450.000 tokens por conjunto e budget de 10s. Máximos:
10 ranges, 500.000 tokens e 30s, configurados por `--max-ranges`, `--max-tokens`
e `--budget-ms`. Cada statement tem timeout de até 3s e lock timeout de 500ms;
o budget é conferido entre statements e antes do commit. A conexão e operações
em memória não são interrompidas instantaneamente por esse budget.

Cada range tem sua própria transação. Em escrita, um advisory lock exclusivo
impede conversores concorrentes; a fonte fica bloqueada para alteração e seu
checkpoint canônico fica protegido até o commit. Não inserir no dicionário por
outros caminhos durante a campanha. Reservas são feitas apenas para tokens
ausentes, em grupos de até 5.000. Falhas fazem rollback do range, mas sequences
PostgreSQL podem consumir IDs mesmo com rollback: não há reutilização. O teto
de 1.000.000 considera esses IDs consumidos. A simulação não reserva IDs e seus
tamanhos refletem uma conversão independente de cada range no estado atual.

O conversor valida endereços únicos/normalizados, hash legado, limites, checkpoint
canônico e hash reconstruído do mapa persistido. O array inline pode vir fora de
ordem; o hash usa a cópia ordenada. Provas versionadas encerram o lote. O conversor
não cria prova global, altera cursores, declara continuidade nem mede planos de
cobertura; os gates do ranking continuam nos leitores existentes.

A saída JSONL tem eventos `progress` após cada transação e `complete` no final.
`storage=staging` identifica a preparação separada; `storage=legacy` indica um
mapa já existente nas colunas compatíveis. Ambos precisam passar pela validação
do hash reconstruído; `verified-existing` não significa publicação ou continuidade.
Guarde a saída fora do disco sob pressão. `resume.highWaterId` fixa o maior ID da coorte
inicial; `resume.afterId` identifica o último range concluído, não necessariamente
um bloco. Retome com ambos, usando a mesma projeção/stream e o mesmo modo:

```sh
node src/utils/convert-robinhood-wallet-transfer-scope-history.js \
  --projection-version=rh_transfer_v1 --stream=live \
  --after-id=ULTIMO_ID --through-id=LIMITE_DA_COORTE --max-ranges=1
```

Esses placeholders devem ser substituídos pelos números do relatório. Para preparar
mapas na retomada autorizada, acrescente `--commit`. Não avançar o cursor usando
um relatório de simulação para pular ranges ainda não preparados. IDs são ordenados
para execução; isso não certifica ausência de gaps/overlaps de blocos.

Em erro, a saída `failed` conserva o último progresso confirmado. Se o processo
morrer após commit e antes de imprimir, repita a partir do último relatório salvo:
a validação do mapa torna a repetição segura. Pare diante de corrupção, schema
ausente, checkpoint não canônico ou capacidade esgotada. Para lock/timeout,
priorize o LIVE e só repita manualmente após pelo menos 30s e reavaliar pressão;
nunca avance IDs para contornar o range que falhou.

Depois do piloto, comparar na mesma janela taxas de WAL e I/O, espaço livre, avanço
e lag dos consumidores com o baseline anterior. Se piorarem, interromper a campanha.
Mapas preparados ficam armazenados; arrays/referências mantidos permitem continuar
usando a fonte antiga. Auditar toda a coorte e medir equivalência/custo de cobertura
antes de propor a publicação de referências compactas e remoção de payloads.
A publicação futura precisa disponibilizar os mapas nas colunas compreendidas
pelos leitores da Stage 262 e, para inline, trocar referências. Essa operação,
a retirada dos arrays e a recuperação física não estão implementadas no conversor.
