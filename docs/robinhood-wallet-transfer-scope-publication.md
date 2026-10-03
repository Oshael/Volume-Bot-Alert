# Publicação dos mapas históricos auditados

O comando manual publica mapas novos por hash nas colunas da Stage 262.
Ele preserva arrays legados, ranges, referências, cursores e dicionário. Mapas
sem conjunto legado ganham uma linha compacta; ranges inline ainda não a usam.
Não altera a métrica do ranking nem instala/reinicia serviços.

Exige Stages 262/263 e o checkpoint final da auditoria Stage263. Valida checksum,
conclusão, identidade do dicionário/codec, prova dos bytes e decode/hash de cada
mapa. Um mapa publicado diferente é erro, não overwrite. Conjuntos legados com
arrays e sem mapa são reportados como `deferred-array-cutover` e não são escritos:
acrescentar o bitmap pode obrigar o GIN a reinserir centenas de milhares de tokens.
Eles precisam de publicação e retirada do array em uma operação atômica separada.

Primeiro simule, com o checkpoint real na VPS:

```sh
node src/utils/publish-robinhood-wallet-transfer-scope-maps.js \
  --checkpoint=/var/tmp/robinhood-stage263-readonly-audit-checkpoint.json \
  --max-maps=1 --budget-ms=30000
```

**Ponto importante:** a simulação não autoriza escrita. A publicação na VPS exige
autorização específica; só então adicionar `--commit`. Esta operação acrescenta
mapas compactos, mas não libera os 96,5 GiB nem troca a leitura dos arrays.

Defaults: um mapa, budget de 10s. Máximos: 50 mapas e 30s por chamada. Um cliente,
transação por mapa, timeout de statement de até 3s, lock de 250ms e advisory lock
compartilhado com o conversor, sem retries automáticos. Simulação usa transações
REPEATABLE READ READ ONLY. O budget é verificado entre statements e antes do commit;
não interrompe imediatamente decode em memória. Uma falha faz rollback somente
do mapa corrente, mantendo o progresso já confirmado.

Antes de cada lote autorizado, conferir espaço livre de pelo menos 10 GiB,
leases/erros atuais, avanço LIVE, WAL/I/O e ausência de outro conversor/auditor.
Priorizar o bot; em timeout/lock, parar e diagnosticar antes de repetir. Medir
os mesmos indicadores antes e depois do piloto. Não mudar flags ou timeouts.

JSONL `progress` registra somente decisões concluídas; `failed` preserva a última
posição confirmada. Retomar com o mesmo checkpoint, modo e
`--after-hash=HASH_DO_ULTIMO_MAPA`. Hashes são ordenados, não IDs de blocos.
Não usar o cursor da simulação para pular publicações. Se houve commit sem log,
repetir a partir do último cursor: o mapa existente é validado e reutilizado.
`cohort-end` significa que a lista foi percorrida; mapas `deferred-array-cutover`
continuam pendentes. Não usar esse cursor para pular a futura troca dos arrays.

A publicação não recertifica canonicalidade dos ranges depois da auditoria.
Ela disponibiliza payloads equivalentes por hash sem mudar cobertura. Trocar
ranges inline exige remover seu array na mesma transação pela constraint do
schema. Essa troca, a retirada de arrays por hash e a recuperação física são
operações posteriores, com validação de cobertura e autorização próprias.
