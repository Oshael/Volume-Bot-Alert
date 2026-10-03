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
schema. Essa troca e a recuperação física são operações posteriores, com
validação de cobertura e autorização próprias.

## Troca atômica dos arrays por hash

O mesmo comando tem um modo explícito `--cutover-hashed-arrays`. Não muda o
comportamento da publicação normal. Primeiro publicar os mapas novos e simular
um candidato legado, usando o mesmo checkpoint final da auditoria:

```sh
node src/utils/publish-robinhood-wallet-transfer-scope-maps.js \
  --checkpoint=/var/tmp/robinhood-stage263-readonly-audit-checkpoint.json \
  --cutover-hashed-arrays --max-maps=1 --budget-ms=30000
```

Selecionar o candidato pela ordem de hashes do recibo; quando necessário, usar
`--after-hash` com o hash imediatamente anterior, pertencente ao mesmo recibo.
Hashes já compactos são verificados e reportados como `verified-existing`.
`would-cutover-array` identifica uma retirada pendente; um hash sem linha na
tabela publicada é erro. O limite conta decisões, incluindo mapas já compactos.

**Ponto importante:** adicionar `--commit` somente após autorização específica
para retirar o array de um candidato identificado. Isso substitui sua representação
legada por um bitmap equivalente, e o trigger de imutabilidade impede recolocar
o array depois do commit. A aprovação da publicação anterior não autoriza essa
retirada, nem a troca de ranges inline ou a recuperação física.

No commit, bloqueia somente o conjunto corrente (`FOR UPDATE`), lê seu array
atual e compara todos os membros, na mesma ordem, com o decode do mapa auditado.
Conserva hash, referências, ranges, cursores e dicionário. Publica bitmap e
metadados e define `token_addresses=NULL` num único UPDATE. Confere novamente
os bytes, contagem e hash retornados antes do commit. Divergência, lock ou timeout
faz rollback do conjunto atual; fontes já trocadas em commits anteriores ficam
registradas no progresso. Repetir uma troca confirmada somente valida o mapa,
sem UPDATE. A simulação permanece REPEATABLE READ READ ONLY e não bloqueia linhas.

Valem os mesmos limites de concorrência, statements, locks, budget e proteções
LIVE. Começar com um único conjunto autorizado, escolhendo o menor disponível,
comparar a cobertura do leitor e a saúde anterior/posterior, e medir o UPDATE
antes de ampliar o lote. O menor conjunto disponível pode ainda ser grande;
o resultado do teste local não prevê seu tempo de execução na VPS.
Erro exige parada e diagnóstico; não há retry automático. O LIVE tem precedência.

O relatório usa `operation=hashed-array-cutover` e, na escrita,
`mode=cutover-hashed-arrays`; `array-cutover` significa troca confirmada. Retomar
somente com o cursor dessa operação, nunca com o cursor da publicação ou da
simulação. Se um commit ocorreu sem log, repetir o hash é seguro. O checkpoint
da auditoria original permanece intacto; seus arrays deixaram de estar preservados
nos conjuntos retirados, portanto não reutilizar a antiga prova de preservação
como se fosse uma auditoria posterior à troca.

O leitor passa a usar o bitmap já suportado, conservando as regras de canonicalidade,
continuidade e disponibilidade raw. Não muda a métrica de posições abertas.
Os arrays inline da tabela de scans permanecem intocados. O UPDATE deixa versões
antigas/TOAST para manutenção posterior: não promete devolver os 96,5 GiB ao
filesystem, não instala manutenção e não executa VACUUM FULL, REINDEX ou remoções.
