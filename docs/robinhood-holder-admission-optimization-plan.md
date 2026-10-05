# Admissão incremental de tokens para holders

## Objetivo e evidência

Reduzir a descoberta repetida no catálogo e o tempo entre uma proof exata persistida
e a admissão do token, preservando o replay, a captura live, a idempotência e o reorg.

Na coleta de 05/10/2026, 02:45:51–02:55:51 America/Fortaleza, a descoberta
`WITH untracked` executou 1.466 vezes, retornou 91 linhas e acumulou 392,3 segundos
de execução SQL. Capture e backfill chamam `seedNewTokens`. Esses números demonstram
trabalho repetido; não confirmam que ele seja a causa dos erros de cursor ou do lag.

O escopo completo de aproximadamente 441 mil tokens é outra consulta. Sua otimização
fica fora desta implementação; misturá-la impediria atribuir o ganho à admissão.

## Compatibilidade com a configuração atual

O backfill observado usa `rpc`, o LIVE usa `canonical_journal` e o cold está
desligado. A admissão local e a proteção de cobertura não estavam configuradas no
ambiente exclusivo do processo. O código só preenche
`robinhood_holder_coverage_pending` quando a proteção de cobertura está habilitada.

Essa tabela protege a evidência desde o mint até o handoff local; seus estados e ACKs
não são uma fila genérica de descoberta. Reutilizá-la para o modo RPC mudaria o
contrato de pruning e exigiria ampliar o cutover para replay local. Esta proposta
mantém a fonte RPC atual e introduz uma fila própria de admissão. Não ativa a
admissão local, não altera o escopo dos holders e não cria outro serviço permanente.

## Fluxo proposto

1. O INSERT de um token RH no catálogo registra sua identidade numa outbox durável.
2. A persistência de uma atribuição exata registra ou atualiza a mesma identidade.
   Uma proof tardia gera novo sinal mesmo que `first_seen_at` permaneça inalterado.
3. O NOTIFY da outbox só é entregue após o commit. Ele acorda a admissão no backfill
   existente do grupo `robinhood-holders`.
4. O consumidor reclama um batch e chama a admissão existente com endereços
   explícitos. A consulta deixa de materializar todo o catálogo nessa rota.
5. As condições atuais são relidas sob o lock do cursor. O estado continua entrando
   em `backfilling`; o replay e o handoff existentes seguem inicializando os saldos.
6. O ACK só conclui a geração reclamada. Um sinal novo durante a lease mantém trabalho
   pendente. Falha ou encerramento do consumidor permite retentativa/reclaim.

O catálogo e as atribuições são fontes de verdade. O evento carrega a identidade;
não autoriza a admissão por si. Proof antes do catálogo, duplicatas, eventos fora de
ordem e reorg exigem releitura da elegibilidade e dos fences existentes. Durante
recovery, não se admite usando uma proof retirada ou uma geração obsoleta.

## Contrato e limites

- Chave idempotente: `(chain, token_address)`, restrita a Robinhood.
- Versão por identidade: incrementada a cada sinal relevante; claim/ACK usam essa
  versão para preservar sinais concorrentes.
- Batch inicial: até 100 endereços; concorrência de admissão: 1. Os shards do replay
  continuam com sua configuração atual.
- Lease inicial: 60 segundos, com reclaim de leases vencidas.
- Falta de catálogo/proof, cursor ocupado ou recovery: retentativa de readiness
  iniciando em 5 segundos e limitada a 60 segundos. Erros de execução usam backoff
  limitado e não impedem o processamento de outras identidades.
- Bloqueios administrativos, tokens já admitidos e exclusões definitivas são
  classificados separadamente; não entram em loop de admissão.
- O backfill é o único dono da admissão no modo novo. O capture não executa o seed
  integral nesse modo. A rota anterior continua disponível enquanto o modo novo
  estiver desabilitado.
- O primeiro rollout é para a configuração RPC observada; a combinação com a
  admissão local existente deve falhar na configuração até ter um contrato próprio.

Um bootstrap de reconciliação separado, com keyset pelo índice `(chain, address)`,
batch limitado e cursor retomável, cobre tokens existentes antes dos produtores.
Ele é idempotente, enfileira identidades e não inicializa saldos. Deve terminar antes
de desligar a descoberta antiga. Não haverá varredura periódica integral de entidades
no caminho LIVE.

O fallback do consumidor inspeciona somente trabalho durável vencido na outbox:
cadência normal proposta de 5 segundos para recuperar NOTIFY perdido/reconexão;
watermark é a versão por identidade, prioridade é `next_attempt_at` e o claim tem
batch/concurrency limitados. O evento acorda trabalho pronto imediatamente, respeitando
backoff de erros. Essa leitura serve continuidade da fila, não redescoberta do catálogo.

A lease expõe: modo, pendências reclamadas/concluídas/adiadas, erros, reclaim,
idade do trabalho vencido e tempo da fase de admissão. O processamento de notificações
usa o listener compartilhado existente, evitando uma conexão por consumidor.

## Escopo estimado e etapas

Estimativa inicial: aproximadamente **850 linhas adicionadas mais removidas** entre
produção, testes e referência operacional. Serão duas fatias, cada uma de até 500
linhas. O plano é operacional e não integra essa estimativa de código.

### Fatia 1 — persistência e contrato, aproximadamente 450 linhas

- Nova migration, proposta como `src/utils/db-init-stage267.js`: tabela, índices,
  produtores transacionais para catálogo/atribuições e NOTIFY.
- Novo repository `src/models/robinhood-holder-admission-queue.js`: claim, ACK por
  versão, retry e reclaim.
- `src/utils/runtime-schema.js`: registrar o contrato exigido pelo modo novo.
- Testes unitários e de integração da fila/produtores: commit/rollback, duplicata,
  proof tardia, lease abandonada e sinal novo durante a lease.
- O modo novo permanece desabilitado; esta fatia não remove a busca antiga.

### Fatia 2 — consumidor e cutover, aproximadamente 400 linhas

- Serviço de coordenação de admissão atrás de uma interface própria.
- `src/services/robinhood-holder-backfill-worker.js`: composição com o consumidor,
  wake por evento e telemetria, preservando a execução dos shards.
- `src/services/robinhood-holder-live-worker.js`: suprimir o bootstrap duplicado
  somente no modo novo, após validar a existência do consumidor.
- `src/models/robinhood-holder-bootstrap.js`: descoberta por batch de endereços,
  preservando a revalidação transacional e os limites atuais.
- `config/index.js`: flag opt-in e validações de compatibilidade.
- Utilitário de reconciliação inicial e testes das fronteiras alteradas.
- `docs/bot-reference.md`: configuração, rollout, recuperação e rollback.

O desenho envolve holders, produtores de persistência e contrato de schema.
Estimativa de até 9 arquivos de produção, sem lógica nova em dois hubs: a regra de
admissão fica no coordenador/repository; configuração e schema fazem composição.
Se a implementação exigir ampliar o orçamento ou outros subsistemas, revisar o escopo
antes de editar além do aprovado.

## Validação e ativação

Cada fatia exige `npm run lint`, os testes afetados e revisão completa do diff.
A primeira exige também `npm run db:schema-check` e integração em banco de teste
confirmado por `assertUsingTestDatabase`. Não executar limpeza ou migration de testes
no banco da VPS. A segunda cobre persistência do fluxo, tokens com proof tardia,
reinício, recovery/reorg e ausência de admissão duplicada por capture e backfill.

Produção é uma etapa posterior: aplicar a migration com o modo ainda desligado,
validar produtores, reconciliar identidades existentes e então ativar a flag no grupo
`robinhood-holders`. Reiniciar somente a instância existente seguindo
`docs/new-worker-service-runbook.md`; preservar env exclusivo e a template compartilhada.

Comparar uma janela de dez minutos contra a baseline: chamadas/tempo SQL de descoberta,
tempo proof→admissão, pendências e idade, admissão/replay por segundo, lag dos holders,
erros stale, lag do capture, CPU e I/O. Menos queries sozinho não confirma melhora do
fluxo. O rollout deve parar se tokens deixarem de ser admitidos ou a fronteira regredir.

Rollback: desligar a flag e voltar à descoberta antiga, preservando outbox e estados.
Não apagar a fila para recuperar o serviço nem remover a proteção de cobertura.

**Ponto importante:** a mudança reduz redescoberta; não permite publicar holders sem
replay e cobertura comprovados. A otimização do escopo completo e a correção dos erros
de liquidez permanecem trabalhos separados.
