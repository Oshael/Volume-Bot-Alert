# Plano de execução — holders locais e descarte de evidências consumidas

Data: 2026-10-04. Escopo: Robinhood, captura recente, inicialização dos holders,
replay local e retenção das evidências necessárias a esse fluxo.

Status: cortes 1–3 implementados localmente, com Stages 265 e 266 autorizados.
Corte 4 pendente. A proteção está desligada por padrão; implantação,
alterações de ambiente, reinícios e remoções na VPS exigem autorização operacional.

## 1. Resultado esperado

Tokens cujo nascimento e transferências foram capturados localmente conseguem
inicializar e manter holders usando o PostgreSQL, mesmo depois que o node pruned
deixa de fornecer o histórico correspondente.

Evidências intermediárias são descartadas depois de cumprirem sua função e a
janela de recuperação. O estado atual necessário ao bot continua persistido:
creator/criação, proveniência mínima, saldos, cobertura e checkpoint canônico.
Atualizações substituem o estado atual; versões completas não se acumulam sem
uma necessidade explícita de recuperação.

**Ponto importante:** eliminar evidência intermediária exige resultado durável,
confirmação de todos os consumidores necessários e proteção contra reorg/retry.
Concluir a tarefa de creator não confirma que os holders consumiram os dados.

## 2. Escopo e fronteiras

Incluído:

- proteger dados de candidatos enquanto criação e cobertura aguardam validação;
- reutilizar o leitor canônico local para replay com cobertura comprovada;
- inicializar o ledger e entregar sua continuidade ao live de forma atômica;
- descartar evidências consumidas com gates, limites e telemetria;
- conservar os fatos mínimos consultados continuamente pelo bot.

Fora desta entrega:

- recuperar os 10.213 tokens históricos identificados no diagnóstico;
- corrigir detecção de factory/creator, tratada separadamente;
- alterar o significado de creator, holder, DEV HOLD ou classificações;
- implementar os projetos completos de retenção de wallet transfers e espaço;
- reconstruir toda a história desde a criação após descartar seus insumos;
- criar uma dependência permanente do Archive ou usar Blockscout.

A independência pretendida vale para continuidade e recuperação dentro da
cobertura preservada. Histórico anterior à captura, lacunas não preservadas ou
reprocessamento anterior à base recuperável exigem uma recuperação específica.
Não garantir ausência de Archive para qualquer falha histórica futura.

Este plano complementa os planos de
[independência do Archive](robinhood-wallet-classification-archive-independence-plan.md)
e [retenção raw e espaço](robinhood-raw-retention-and-space-recovery-plan.md).
Proteções existentes de outros consumidores continuam obrigatórias.

## 3. Evidência de partida

### Observações na VPS

Coletas de 2026-10-04, timezone `America/Fortaleza`:

| Janela | Observação | Fonte e limite da conclusão |
| --- | --- | --- |
| 02:39 | 10.213 tokens com criação e creator conhecidos, sem holder state e sem bloqueio administrativo | Catálogo, atribuições, states e bloqueios; não comprova ausência de todos os registros legados |
| 02:39 | Todos os blocos de criação dessa coorte ficam abaixo de 61.139.787 | Comparação com o floor de admissão vigente; explica exclusão atual, não a origem histórica do buraco |
| 02:47 | Holders live em `canonical_journal`; política `tracked`; pruner do journal ativo com retenção configurada de 72h e 20.000 blocos | Configuração efetiva do processo e cursores; não demonstra que todos os eventos elegíveis já foram removidos |
| 02:47 | Backfill global usa leitor RPC no código implantado; flag global estava desligada na coleta de 02:39 | Inspeção de código e configuração; habilitar a flag não materializa dados históricos ausentes |

### Contratos confirmados no código

- A [captura canônica](../src/services/robinhood-chain-capture-worker.js) inclui
  `Transfer` independentemente de o contrato já estar no catálogo de holders.
- O [journal de captura](../src/models/robinhood-chain-capture-journal.js) grava
  eventos canônicos e hints de mint. Hint de mint não é prova de deployment.
- O [leitor local](../src/models/robinhood-canonical-holder-source.js) possui
  leitura por token, global e validação de fronteira/checkpoint.
- O [replay incremental](../src/services/robinhood-holder-backfill-executor.js)
  já oferece `canonical_recent`, mas mantém rotas RPC, inclusive para gaps e
  reparo por receipts. Esse modo não representa um replay estritamente local.
- O [bootstrap](../src/models/robinhood-holder-bootstrap.js) exige criação
  comprovada e aplica gates de data e bloco; retirar gates sem substituir sua
  garantia de cobertura produziria uma inicialização insegura.
- O [escopo live](../src/models/robinhood-holder-ledger.js) acompanha states
  elegíveis e coortes globais ativas; `tracked` não copia todo contrato desconhecido
  para o journal de holders.
- A [retenção do journal](../src/models/robinhood-holder-journal-retention.js)
  protege states e coortes elegíveis. Eventos sem essa proteção podem expirar.
- A atribuição guarda creator, fonte, bloco, transação e factory. A
  [tarefa de deployment](../src/models/robinhood-token-deployment-outbox.js)
  é apagada após concluir; não há motivo para inventar um arquivo permanente
  de traces completos como requisito deste plano.

### Hipóteses e questões abertas

- Não foi determinada a causa original da ausência de state nos 10.213 tokens.
- Não foi provada a cobertura histórica completa desses tokens em outras tabelas.
- É preciso escolher o marcador durável de pendência de holders. A vida da
  outbox de creator, isoladamente, não atende ao contrato de proteção.
- Definir quais candidatos realmente precisam de holders. Contratos excluídos,
  ativos de referência e logs incompatíveis não devem virar cópias permanentes
  indiscriminadas; exclusões devem ser explícitas e observáveis.

## 4. Contrato de dados e descarte

| Classe | Conteúdo mínimo | Quando pode sair |
| --- | --- | --- |
| Evidência intermediária de criação | Insumos de validação usados pelo resolver, quando armazenados | Resultado canônico persistido, consumidores necessários atendidos e janela de recuperação cumprida |
| Fato atual de criação/creator | Endereço, origem da atribuição, bloco, transação, factory quando aplicável e referência canônica necessária | Continua necessário enquanto o token é acompanhado; correções seguem os guards existentes |
| Transferência pendente | Token, origem/destino, valor, bloco/hash, transação, índices e contexto canônico | Após aplicação completa nos consumidores necessários e cumprimento da janela de recuperação |
| Ledger atual | Saldos positivos por carteira, holder count, versão, cobertura e checkpoint | Atualizado continuamente; saldo zero segue o contrato existente |
| Base recuperável e versões anteriores | Estado necessário para reiniciar/reverter dentro da janela definida | Versões antigas expiram após existir substituta válida e passar a janela de recuperação |

Raw saudável mantém como referência inicial a janela existente de 72h. Uma
pendência que ultrapasse essa janela precisa ter seus insumos mínimos preservados
ou bloquear o descarte correspondente. O atraso vira incidente observável.
Não aumentar silenciosamente a retenção global nem apagar uma pendência por idade.

Um hash/checkpoint identifica uma prova, mas não substitui os saldos ou eventos
necessários para reconstruí-la. A base recuperável deve sobreviver a restart e
não depender apenas de um bloco raw que será apagado.

O descarte revalida, na mesma fronteira transacional:

1. canonicalidade, geração/fence e versões ainda válidas;
2. resultado e cobertura gravados, incluindo eventual cauda vazia;
3. consumidores concluídos ou insumos mínimos materializados para suas pendências;
4. ausência de reorg/recovery ou retry que ainda exija a evidência;
5. janela de recuperação e bounds exatos do lote candidato.

Prova ausente, desatualizada ou inconclusiva bloqueia o descarte. `applied=true`
no ledger de holders, sozinho, não libera dados utilizados por outros domínios.

## 5. Capacidade e limites de crescimento

Medições de 2026-10-04, 03:05–03:09 Fortaleza, por tamanho físico das relações e
índices, estimativas de linhas do catálogo e pequenas amostras de tuplas:

| Item | Referência de dimensionamento |
| --- | --- |
| Prova compacta de criação, state e referências | Reserva preliminar de 2–4 KB/token: 20–40 MB para 10 mil tokens; formato final ainda não definido |
| Saldo atual | Cerca de 904 bytes/par token-carteira no armazenamento atual; 1 milhão de pares equivale a aproximadamente 0,84 GiB |
| Journal de holders | Cerca de 1.199 bytes/linha estimada, incluindo índices e espaço já alocado |
| Eventos sem holder state | 9.314 logs com formato ERC-20 em 203s, distribuídos em 99 contratos, numa janela de 2.000 blocos |
| Preservação ampla desses eventos | Se o ritmo e o formato permanecessem iguais: aproximadamente 4,4 GiB/dia, 13,3 GiB/72h ou 31 GiB/7 dias |

Esses números não são crescimento adicional comprovado: há dados já salvos,
contratos possivelmente excluídos e bloat/espaço reutilizável nas relações.
`reltuples` é estimativa; uma amostra curta não representa o volume diário.
WAL, backups, réplicas e espaço temporário não estão incluídos.

Antes de ativar qualquer preservação nova, medir fluxo elegível, bytes/evento,
crescimento líquido, índice, WAL e orçamento no mountpoint correspondente.
Priorizar reaproveitamento de evidência existente. Não copiar todo receipt,
trace ou evento bruto para uma segunda tabela sem necessidade demonstrada.

Alertar inicialmente em 24h e 48h de pendência, antes da referência de 72h.
Definir orçamento de bytes e capacidade de drenagem no preflight. Ultrapassar
o orçamento bloqueia expansão do rollout e exige intervenção; não autoriza
descarte inseguro nem interrupção silenciosa da captura necessária.

## 6. Quatro cortes de implementação

Estimativa inicial: 1.400–1.800 linhas no total, incluindo código, testes,
schema e documentação dos cortes. Cada corte altera no máximo 500 linhas e
exige autorização própria. Este documento de planejamento é uma entrega separada.

### Corte 1 — proteger pendências de cobertura

- Escolher uma identidade durável para a pendência de holders, independente da
  conclusão da tarefa de creator, usando estruturas existentes quando suficientes.
- Ligar sua criação aos eventos capturados e commits de domínio apropriados.
- Proteger os insumos mínimos até a cobertura e a entrega ao live serem confirmadas.
- Prever uma pequena migration aditiva se faltar o marcador/índice necessário;
  confirmar desenho e número de stage antes de editar, sem reescrever init antigo.
- Limitar candidatos e tornar exclusões/pendências observáveis.

Arquivos previstos: `robinhood-chain-capture-journal.js` apenas para wiring,
um módulo isolado de proteção se necessário, `robinhood-holder-journal-retention.js`,
`robinhood-retention-safety-audit.js` e eventual init novo.

Validação: integração de persistência/proteção, creator concluído antes dos
holders, duplicata, conflito canônico, exclusão explícita e rollback transacional.
Schema novo também exige schema-check e integração de schema.

Saída: remover a tarefa de creator não permite perder os insumos pendentes dos
holders; a ausência de prova continua bloqueando remoção.

### Corte 2 — replay local com cobertura comprovada

- Reutilizar `robinhood-canonical-holder-source.js` e separar a política de fonte
  do scanner/execução, evitando duplicar leitores e regras de saldos.
- Integrar replay global e incremental ao modo estritamente local proposto.
- Cobertura insuficiente produz pendência/bloqueio explícito, sem fallback RPC
  histórico silencioso. O modo legado de recuperação fica separado.
- Cobrir também checkpoint, head seguro e reparo hoje chamado de receipts.
  A leitura de logs locais não é uma verificação independente de receipts;
  déficit não resolvido deve permanecer bloqueado.

Arquivos previstos: `robinhood-canonical-holder-source.js`,
`robinhood-holder-backfill-executor.js`, `robinhood-holder-global-backfill-worker.js`
e wiring mínimo em `config/index.js`, conforme o desenho de fonte.

Validação: unitários do roteamento/limites e integração para cobertura completa,
abaixo do floor, acima da fronteira, gap interno, evento ausente, reorg e déficit.
Testar que o modo local não chama RPC histórico.

Saída: um replay coberto produz os mesmos saldos/cobertura do fixture canônico;
um replay incompleto não avança nem publica saldo zero inventado.

### Corte 3 — inicialização e entrega ao live

- Inicializar somente após criação comprovada e insumos locais completos desde
  o ponto inicial exigido pelo contrato do token.
- Substituir os gates que impedem admissão local apenas por garantias equivalentes
  de cobertura; não remover simplesmente limites de data/bloco.
- Capturar e consumir a cauda enquanto ocorre replay, com idempotência e versões.
- Confirmar a entrega ao live antes de liberar a pendência do corte 1.
- Aceitar atribuição atrasada sem perder o primeiro mint ou contar eventos duas vezes.

Arquivos previstos: `robinhood-holder-bootstrap.js`, `robinhood-holder-ledger.js`
e os módulos existentes de captura/handoff estritamente necessários.

Validação: integração de admissão tardia, prova atrasada, restart no meio do replay,
evento duplicado/fora de ordem, disputa com writer live, falha antes do commit e reorg.

Saída: o token chega a `live` com saldos, count e fronteira consistentes;
a proteção só termina após essa entrega durável.

### Corte 4 — descarte, observabilidade e operação

- Reutilizar os pruners/gates existentes para descarte limitado e revalidado.
- Expirar evidência intermediária consumida e versões antigas elegíveis,
  preservando o fato atual de creator e a base recuperável dos holders.
- Validar os consumidores externos ao ledger antes de liberar raw compartilhado.
- Expor idade, motivo, bytes preservados, taxa de entrada/drenagem e replay por fonte.
- Documentar as flags efetivamente criadas, implantação e rollback em
  `docs/bot-reference.md` apenas quando o contrato operacional estiver implementado.

Arquivos previstos: `robinhood-holder-journal-retention.js`,
`robinhood-retention-safety-audit.js`, `robinhood-chain-event-pruner.js`,
configuração/telemetria estritamente necessária e documentação operacional.

Validação: integração de consumidor pendente, ACK desatualizado, troca de geração,
janela não cumprida, reorg, lote limitado e retomada. Confirmar manutenção dos
campos consultados por DEV HOLD e dos insumos de wallet classification/redistribution.

Saída: somente evidência elegível é removida; atraso, erro e inconclusão permanecem
visíveis. Medir espaço reutilizável separadamente de bytes liberados no filesystem.

## 7. Arquitetura e execução dos cortes

Previsão: captura, holders e retenção, aproximadamente 10–12 arquivos de produção
incluindo eventual migration/helper. A lista é estimativa; o primeiro desenho
deve confirmar dependências e evitar duplicar responsabilidades de outros planos.
Fan-out acima de 12 arquivos ou lógica nova em dois hubs exige checkpoint
arquitetural antes de editar. Hubs ficam limitados a composição/wiring.

O caminho live reage aos eventos depois do commit durável. Consumidores toleram
entrega repetida, fora de ordem, restart e reorg. O reparo local pode usar a
exceção de polling para uma fila finita, isolada do live:

- cursor por token/campanha e frontier canônica; identidade de evento inclui
  chain, block hash, transaction hash e log index;
- proposta inicial: até 100 candidatos, ranges de 250 blocos e concorrência 1;
  teto de leitura respeita o leitor existente de 5.000 blocos;
- cadência normal de reparo de 1s, readiness retry de 5s e backoff de erro de
  1s até 30s com jitter; confirmar os knobs no desenho do corte;
- prioridade do live, pausas/redução diante de lag ou pressão, sem varredura
  periódica de todo o catálogo para substituir eventos já disponíveis;
- telemetria de fonte, next block, cobertura, atraso, geração e última conclusão.

Após cada corte: consolidar, executar lint e os menores testes relevantes,
revisar o diff completo, confirmar escopo/linhas e commitar somente aquele corte.
Não repetir validação aprovada sem mudança relevante. Respeitar as regras de
estimativa, compactação e autorização do `AGENTS.md`.

## 8. Implantação, comparação e rollback

1. Capturar baseline de tokens recentes sem state, idade da pendência, tempo
   criação→`live`, taxas de entrada/drenagem, lag de captura/holders, CPU, I/O,
   waits/locks, WAL e crescimento físico/reutilizável por mountpoint.
2. Aplicar apenas migrations revisadas e aprovadas, executar schema-check e
   habilitar proteção antes de qualquer alteração que aumente o descarte.
3. Validar leitor/replay local com fixtures e piloto limitado, mantendo dados
   intactos e conferindo contagens, saldos, checkpoints e chamadas RPC históricas.
4. Ativar inicialização/entrega gradualmente para candidatos novos elegíveis.
   Exercitar restart e recuperação dentro da janela preservada.
5. Habilitar descarte por último, após paridade, gates de todos os consumidores
   e orçamento de disco aprovados. A primeira remoção exige aprovação operacional.
6. Comparar as mesmas métricas e guardrails com o baseline em janelas comparáveis;
   reabrir o diagnóstico se cobertura/freshness não melhorarem.

Reutilizar os grupos existentes de holders e maintenance. O mapa exato de
reinícios depende dos módulos efetivamente alterados e deve ser registrado no
rollout de cada corte, seguindo o
[runbook de serviços](new-worker-service-runbook.md). Não duplicar banco/segredos
nos overrides das instâncias nem alterar a template compartilhada.

Rollback antes do descarte desativa o comportamento novo e preserva insumos e
proteções necessários à fila. Rollback depois do descarte não recria eventos;
exige base recuperável mais cauda completa ou recuperação histórica explícita.
Nunca avançar watermark manualmente para liberar uma remoção.

## 9. Critérios finais e acompanhamento

- [x] Corte 1: proteção de pendências validada, incluindo término antecipado do creator.
- [x] Corte 2: replay local completo e gaps bloqueados, sem RPC histórico silencioso.
- [x] Corte 3: inicialização tardia e entrega ao live idempotentes e recuperáveis.
- [ ] Corte 4: descarte seguro, orçamento/alertas e operação documentados.
- [ ] Piloto novo chega a holders `live` sem perder mint, transfers ou cobertura.
- [ ] Reinício/reorg dentro da janela preservada mantém o contrato ou bloqueia com motivo.
- [ ] Creator/proveniência, saldos e checkpoint atuais sobrevivem ao descarte intermediário.
- [ ] Idade de pendências e crescimento líquido permanecem dentro dos limites aprovados.
- [ ] Buracos antigos continuam separados, sem serem apresentados como resolvidos por este plano.

Esta checklist acompanha execução futura; evidência e validação precisam existir
antes de marcar qualquer item. O estado operacional efetivo continua em
`docs/bot-reference.md`, sem transformar progresso deste plano em comportamento implantado.
