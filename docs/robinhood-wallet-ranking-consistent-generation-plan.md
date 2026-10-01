# Ranking de wallets Robinhood: plano simplificado

## Decisão proposta

Reusar a projeção financeira, o snapshot de leitura e a publicação compacta
existentes. Avaliar cálculo em conjunto no PostgreSQL antes de criar qualquer
mecanismo próprio para congelar posições e preços.

A proposta de captura de valores anteriores, registro de gerações em execução,
barreiras nos writers e tabelas de sobreposição foi retirada do escopo
recomendado. A estimativa anterior de sete etapas e 2.500–3.200 linhas não é
um orçamento aprovado nem uma necessidade demonstrada.

Esta revisão altera apenas o plano. Não altera código, schema, API, flags ou
serviços; a VPS continua com permissão somente leitura.

## Evidência e limites

**Observações do código:**

- `src/models/robinhood-wallet-ranking-read-snapshot.js` já usa REPEATABLE READ
  READ ONLY. Dentro de uma mesma execução, posições, preços, eventos e revisões
  podem ser lidos no mesmo snapshot sem captura própria. O teste de integração
  existente confirma que uma atualização concorrente não muda a segunda leitura.
- O wrapper limita cada statement a 5 segundos e a inatividade a 30 segundos,
  mas não impõe prazo total à transação. Isso precisa de limite explícito;
  paginação ilimitada dentro dele não é uma solução aceitável.
- `src/models/robinhood-wallet-ranking-publication.js` já mantém até 100 wallets
  por janela, com checkpoint, CAS e proteção contra reorg. O payload enviado
  é limitado a 64 KiB. O LIVE pode avançar sem invalidar um resultado coerente
  anterior; leitura informa diferença de revisões.
- `src/services/robinhood-wallet-ranking-page.js` ainda recalcula a cada página.
  Compartilhar um resultado evita que cada cliente repita esse trabalho, mas
  não torna barato o cálculo inicial nem resolve o teto de 1.000 posições.
- ALL usa quantidade atual, custo remanescente e preço. Janelas finitas
  reconstruem o saldo inicial e aplicam os eventos ordenados, com redução
  proporcional. São problemas diferentes para execução, com a mesma métrica.

**Hipótese a testar:** calcular e agregar ALL em conjunto no banco pode custar
menos que transportar milhões de posições e fazer leituras por lote no Node.
Ela é rejeitada se a consulta não concluir no orçamento, divergir da referência
ou causar pressão incompatível com o LIVE. SQL e cache, por si só, não provam
escala nem redução do lag.

**Causa confirmada:** esta revisão não identifica a fase responsável pelo lag.
O efeito de desligar transfers foi relatado pelo operador, mas não isola
consulta de escopo, projeção financeira, grafo, commit ou outro trabalho.

## Caminho mínimo para validar o desenho

1. Adicionar prazo total ao snapshot existente e executar um leitor ALL em
   shadow. Ler o checkpoint, `asOf`, revisões e fontes dentro desse snapshot.
   O leitor usa consulta em conjunto, agrupa todas as posições por wallet e
   devolve somente top 100 e metadados. Não ordenar milhões de posições por
   wallet para transportá-las ao acumulador, nem criar um índice dessa ordem
   antes de demonstrar que ele é necessário.
2. Testar paridade do ALL contra o domínio atual em fixtures que incluem
   mais de 1.000 posições, somas por wallet, preços pequenos, perdas,
   desempates, custo desconhecido, fontes ausentes e atualizações concorrentes.
   Reusar a seleção de preço/mercado existente; não fazer uma cópia aproximada
   dela. Precisão e arredondamento por posição, antes da soma por wallet,
   fazem parte do contrato. Divisão NUMERIC não deve ser presumida equivalente
   à aritmética racional sem esses testes.
3. Se o leitor passar nos testes e no orçamento medido, conectar o cálculo
   compartilhado ao armazenamento da Stage 260 e fazer a API paginar o
   resultado publicado. Reusar o mecanismo existente de `worker_leases` para
   impedir cálculos simultâneos entre processos; não criar tabela de jobs.
   Coalescer avisos após commit e conservar somente uma execução pendente.
4. Avaliar 24h/7d/30d separadamente, após essa medição. Preservar os gates de
   cobertura e o replay proporcional existentes. Não usar apenas
   `quantidade * (preço atual - preço inicial)` quando houve eventos na janela,
   nem declarar exato um histórico truncado. Só dimensionar esse corte após
   localizar o custo dominante e provar uma alternativa equivalente.

Um prazo experimental de 10 segundos para a execução completa, com statements
limitados a no máximo 5 segundos e ao tempo restante, é um ponto de partida
para teste local, não uma configuração aprovada de produção. Timeout deve
abortar, liberar a conexão e não publicar universo parcial. Não estender o
prazo automaticamente até conseguir atravessar o universo.

Uma tentativa que não termina nesse orçamento continua sendo uma limitação.
Se a leitura em conjunto falhar no universo real, reavaliar uma projeção
incremental focada com a evidência de custo; não retomar automaticamente o
plano de captura próprio nem prometer que um cache resolve o universo inteiro.

## Execução compartilhada e contrato público

A publicação é feita depois de encerrar a transação de leitura, usando o corte
capturado nela e o gate de checkpoint/reorg/CAS existente. Antes de conectar
fontes, verificar que seus writers publicam as revisões necessárias; a presença
da tabela de revisões não dispensa essa verificação.

A API deve informar `asOf`, instante de publicação, diferença de revisões e
atraso. `isFresh` não é TTL: preços podem expirar sem revisão nova. Expiração
é trabalho temporal limitado. Avisos LIVE disparam trabalho coalescido;
reconexão/readiness usam as revisões duráveis. Não escolher uma cadência de
produção antes de medir duração, concorrência, custo e tolerância de freshness.

Falta de primeira geração completa retorna indisponibilidade explícita.
Uma geração anterior válida pode continuar visível com atraso informado;
reorg invalidado não admite esse fallback. Requisição de outro `asOf` e cursor
de geração substituída precisam de tratamento explícito, sem recálculo global
silencioso por request. A mudança da API só ocorre com fluxo validado.

## Escopo seguinte e validação

O próximo corte proposto é apenas a prova ALL com prazo total: aproximadamente
350–480 linhas alteradas, incluindo testes e documentação. Fronteiras previstas:
`src/models/robinhood-wallet-ranking-read-snapshot.js`, seleção SQL reutilizável
em `src/models/robinhood-wallet-ranking-price-read.js`, um leitor ALL dedicado
e testes unitários/de integração correspondentes. Não inclui nova migration,
triggers, serviço, alteração dos writers ou troca da API.

A contagem deve ser refinada antes de implementar; acima de 500 linhas exige
divisão e autorização. O corte de publicação/API depende do resultado do
experimento. Não há estimativa fechada para as janelas finitas nem promessa de
que dois cortes concluam o redesenho inteiro. Validar com lint e testes de
paridade/concorrência; se surgir necessidade de índice/schema, apresentar o
plano de execução e o escopo antes de editar.

A medição de universo grande deve começar com EXPLAIN sem ANALYZE. Executar
medição completa somente em ambiente apropriado e com timeout; não provocar
um scan prolongado na VPS só para obter um benchmark. Comparar duração,
linhas/bytes transportados, memória, temporários, waits e idade do resultado.

## Espaço em disco e aceitação operacional

Os 96,5 GiB observados são principalmente provas históricas de tokens varridos,
não resultados de ranking. `robinhood-wallet-transfer-scope-writer.js` já usa
scope/version quando há baseline pronto; ainda recai no formato legado antes
do baseline. Confirmar crescimento por delta e preservar prova histórica são
prioridades de armazenamento independentes do cálculo ALL.

A recuperação física continua exigindo conversão histórica validada e uma
operação autorizada à parte. Não apagar arrays referenciados, remover gates de
cobertura ou prometer espaço livre porque a API passou a ler publicação.

**Ponto importante:** o novo plano retira estruturas novas e captura adicional,
mas sua viabilidade no universo real ainda precisa ser medida. Não houve
correção do lag ou recuperação de espaço nesta revisão. Só aceitar uma futura
mudança como remediação após comparar o mesmo lag primário e guardrails em
janelas equivalentes; se não melhorar, reabrir o diagnóstico.
