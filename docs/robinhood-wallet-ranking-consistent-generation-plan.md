# Gerações consistentes do ranking de wallets Robinhood

## Objetivo e limite operacional

Preservar o ganho das posições ainda abertas nas janelas 24h, 7d, 30d e ALL,
incluindo redução proporcional após vendas/transfers, precisão decimal,
desempate por endereço e exclusão de wallets com posições incertas.

Este documento propõe o trabalho local seguinte. Não autoriza migrations,
deploy, mudanças de flags, serviços ou limpeza na VPS. A permissão remota
permanece somente leitura. A arquitetura deve ser validada em shadow antes
de substituir a fonte da API; nenhuma melhoria do lag foi demonstrada por ela.

## Contratos existentes e impedimentos

- `src/models/robinhood-wallet-ranking-position-read.js` pagina o estado atual
  por token/wallet. As posições são atualizadas no lugar; filtrar por
  `through_block <= corte` perde a posição antiga de pares alterados depois
  dele. Não reconstrói o universo naquele bloco.
- A Stage 126 oferece chave primária por token/wallet, mas não índice para
  percorrer posições abertas por wallet/token. Ordenação global repetida sem
  índice precisa ser avaliada pelo plano de execução antes de uso.
- `src/models/robinhood-wallet-ranking-price-read.js` seleciona preços e mercado
  de valuation em buckets mutáveis. `asOf` limita timestamps; não congela as
  versões das linhas entre transações. Uma atualização posterior do mesmo
  bucket pode até retirar da consulta a versão anterior elegível.
- As preimagens da Stage 245 são opcionais, guardam o estado anterior de lotes
  LIVE e expiram em três dias. Não cobrem preços nem todas as formas de repair.
  Não usar sua existência como prova de snapshot completo do ranking.
- `src/services/robinhood-wallet-ranking-aggregate.js` já consome lotes de até
  100 posições ordenadas por wallet/token com memória limitada. Cabe ao leitor
  provar um corte consistente e o fim do universo.
- A Stage 260 publica um resultado compacto com CAS, checkpoint e revisão de
  reorg. Não prova que os lotes de entrada foram lidos na mesma geração.

## Alternativas

| Estratégia | Consistência | Custo/limitação | Decisão proposta |
| --- | --- | --- | --- |
| Repetir consultas ao estado atual com o mesmo `asOf` | Não garantida | Mistura posições, preços e universo | Rejeitar |
| Uma transação REPEATABLE READ para todo o universo | Garantida dentro da transação | Snapshot longo durante milhões de cálculos e retenção de versões MVCC | Rejeitar como motor global |
| Descartar o cálculo sempre que qualquer revisão avançar | Evita publicar mistura | Pode nunca concluir com LIVE e preços ativos | Somente referência limitada de teste |
| Copiar integralmente todas as posições a cada geração | Possível com corte atômico | Duplica uma base grande e aumenta WAL/espaço | Rejeitar como caminho recorrente |
| Preservar apenas os valores sobrescritos durante um corte ativo | Possível com captura transacional completa | Novo protocolo de captura, orçamento e leitura por sobreposição | Prototipar localmente, com gates |

## Protocolo proposto para bootstrap consistente

1. Registrar uma geração durável com bloco/hash, `asOf`, revisões das cinco
   fontes, projeção, lease, prazo e limites. Admitir no máximo um corte ativo
   por projeção, compartilhado entre as quatro janelas.
2. Armar a captura por uma barreira curta, compartilhada pelos writers antes
   de alterar fontes. A abertura precisa excluir commits que escapem da
   captura. Capturar metadados sem essa barreira não congela a origem.
3. Na primeira mudança de cada identidade depois do corte, preservar somente
   os campos anteriores necessários ao ranking. Inserções sem linha anterior
   precisam de marcador de ausência; fechamentos e deletes devem preservar
   posições que estavam abertas no corte. Repetições não criam novas cópias.
4. Aplicar o mesmo princípio às identidades de preço/valuation necessárias às
   quatro janelas. Não substituir isso por consultas tardias aos buckets atuais.
   Alterações retrospectivas de swaps, transfers, classificação ou decimais
   devem preservar evidência ou invalidar a geração antes de modificar a fonte.
5. Ler, em transações curtas, a união do estado atual não sobrescrito com o
   estado anterior capturado. O marcador de ausência/posição fechada também
   exclui a linha atual; não filtrar os marcadores antes dessa exclusão.
   A consulta deve recuperar linhas apagadas e não admitir wallets nascidas
   depois do corte. Paginação por wallet/token precisa de índice apropriado.
6. Se expirar o prazo, o orçamento de captura ou a lease, abandonar a geração
   de forma atômica e deixar o LIVE prosseguir. O ranking não pode bloquear
   indefinidamente um writer para salvar um cálculo. Quantificar linhas,
   bytes, WAL e espera de locks antes de habilitar qualquer captura.
7. Reorg invalida a geração. Repairs e retenção, incluindo remoção de partições
   que não dispara triggers por linha, participam do protocolo ou impedem a
   admissão. A validação final precisa ocorrer na transação de publicação;
   checar validade numa consulta anterior deixa uma corrida.
8. Publicar somente após EOF comprovado de todas as entradas e validação do
   corte. Retomar um acumulador perdido exige replay determinístico da mesma
   origem, ou checkpoint de estado suficiente; apenas retomar seu cursor perde
   somas e candidatos já processados. Limpar capturas somente após tornar a
   geração inacessível, em lotes limitados.

Esse protocolo é uma proposta, não uma capacidade já disponível. Sua primeira
implementação fica opt-in e sem alterar a API. Não há orçamento de produção
aprovado; tamanho do índice, taxa de mudanças durante o corte e duração de
bootstrap são gates de aceitação, não suposições sobre a capacidade da VPS.

## Fluxo recorrente e custo

Bootstrap consistente não justifica repetir um scan completo após cada aviso.
O funcionamento recorrente deve consumir eventos duráveis de pares alterados,
coalescer mudanças de preço e agendar expirações de janela. A atualização de
preço afeta todas as posições abertas do token, mesmo sem trades novos.
Resumos por par/wallet precisam preservar a fórmula e ter orçamento medido;
somar compras e vendas diárias não preserva redução proporcional.

O worker futuro reage ao sinal já existente após commit, recuperando trabalho
durável após perda de NOTIFY. Backfill/reconciliação têm cursor, limites e
prioridade inferior ao LIVE. Nenhum serviço está incluído no primeiro corte;
quando houver serviço, seguir `docs/new-worker-service-runbook.md` e a template
`trendscope-worker@.service`.

## Escopo e cortes para autorização

O bloco de bootstrap/publicação deve ser planejado como aproximadamente
2.500–3.200 linhas alteradas, contando código, testes e documentação, com
12–16 arquivos de produção, distribuídas em cortes de até 500 linhas.
A estimativa precisa ser refinada por corte; crescimento acima de 20% exige
nova direção. O fluxo incremental
recorrente e a conversão dos 96,5 GiB de escopos são blocos separados.

| Corte | Entrega | Arquivos/boundaries previstas | Validação |
| --- | --- | --- | --- |
| 1, 400–480 linhas | Registro e lifecycle de geração com lease, prazo, limites e exclusão de concorrência; ainda incapaz de afirmar captura pronta | `src/utils/db-init-stage261.js`, `src/utils/runtime-schema.js`, `src/models/robinhood-wallet-ranking-generation.js`, teste de integração próprio, `docs/bot-reference.md` | Schema, CAS concorrente, lease expirada, rollback, lint |
| 2 | Barreira e captura compacta de posições; migrations/index necessários | Adapter dedicado e participação dos caminhos LIVE/repair/reorg | Mudança antes/depois da abertura, insert, close, delete, replay, orçamento excedido sem perder escrita LIVE |
| 3 | Congelamento de preços/valuation e invalidação de evidência retrospectiva | Adapter dedicado para fontes de mercado e evidência | Bucket sobrescrito, baseline, troca de mercado, correção histórica, retenção/partição |
| 4 | Leitor por sobreposição e keyset wallet/token | Repositório de leitura dedicado | Universo acima de 1.000, posição apagada/fechada, nova wallet, cursor, EXPLAIN, timeout |
| 5 | Enriquecimento e cálculo compartilhado com reinício seguro | Builder dedicado reutilizando domínio/coverage existentes | Quatro janelas, partial tardio, tiny gains, falta/truncamento de evidência, replay |
| 6 | Publicação acoplada à validade da origem e executor shadow limitado | Repositório de publicação e runner dedicado | Corrida com reorg/expiração, CAS, concorrência, falha e preservação da geração anterior |
| 7 | Leitura HTTP de publicação, freshness e rollout | Boundary da página/API e documentação operacional | Cursor estável, auth, stale/indisponível, frontend e integração quando aplicável |

As etapas da tabela são fronteiras de entrega; se uma ultrapassar 500 linhas,
ela precisa ser dividida antes da implementação e da autorização respectiva.
Cada corte exige revisão integral de seu diff e commit por escopo. O primeiro
não instala captura, worker, índice grande nem altera o resultado servido.
Antes dos demais, mapear todos os writers/pruners relevantes e verificar
que cabem no fan-out previsto. Não habilitar um subconjunto da captura.

## Aceitação e diagnóstico

Testes de integração devem usar conexões simultâneas: abrir corte, ler um lote,
alterar as fontes, fechar/reabrir/deletar posições e ler os lotes seguintes.
Comparar ao resultado de referência do corte, não apenas ao estado final atual.
Provar recuperação após restart, at-least-once e rejeição de cortes inválidos.

Medir tempo total, p95 de lotes/commits, linhas e bytes capturados, WAL/s,
esperas de locks, memória e idade da publicação. Na VPS, comparar o mesmo
lag primário e guardrails contra uma janela equivalente antes da ativação.
Se o lag não melhorar, reabrir o diagnóstico; menos consultas ou memória não
confirmam a causa do incidente. A captura de valores anteriores adiciona custo
ao writer e só pode ser aceita se esse custo respeitar o orçamento medido.
