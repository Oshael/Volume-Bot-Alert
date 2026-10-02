# Ativação da prova global de wallet transfers

Este procedimento contém escritas e mudanças de runtime. Só executar com
autorização explícita para o ambiente de destino; acesso SSH somente leitura
não autoriza migrations, deploy, edição de env ou start/restart.

## Pré-requisitos

- Revisar o checkout aprovado e preservar alterações e arquivos locais na VPS.
  Não usar reset/clean nem trocar o checkout compartilhado com workers ativos
  sem o procedimento de deploy do ambiente.
- Conferir a versão instalada, flags efetivas, serviço, leases e cursores.
  A instância existente é `trendscope-worker@robinhood-wallet-transfers.service`;
  ela herda a template conforme [runbook de serviços](new-worker-service-runbook.md).
  Não criar outro serviço nem duplicar credenciais no env da instância.
- O modo precisa ser `canonical_journal`. RPC e backfill continuam usando o
  manifesto anterior. A prova global exige o journal completo e disponível.
- Se posições unificadas estiverem habilitadas, preservar
  `ROBINHOOD_WALLET_UNIFIED_POSITION_LIVE_ENABLED=true` e conferir handoff:
  seed completo, seed.nextBlock igual à origem LIVE, e cursores LIVE de posições
  e transfers no mesmo próximo bloco. Não corrigir gaps com reset de cursor.
- Comparar a captura candidata com a instalada em transações REPEATABLE READ
  READ ONLY, usando os mesmos dados e participação: seleção, identidade/valor
  dos Transfers e identidade dos swaps selecionados devem coincidir. Incluir
  o ponto parado, faixa recente e o tamanho de lote proposto. Verificar
  exclusões, headers canônicos, disponibilidade do journal e ausência de truncamento.
  Paridade em amostras não prova redução de lag ou equivalência de todo o histórico.

## Schema e ordem de publicação

1. Manter transfers parado e conferir lease LIVE expirada, sem backfill/repair
   concorrente sobre os mesmos cursores. Preparar baseline e rollback antes de start.
2. Ler o relatório de schema com as exigências do checkout candidato. Aplicar
   apenas migrations necessárias e revisadas, uma por vez. Para o checkout que
   inclui publicações e prova global, são necessárias as Stages 260 e 261:

   ```sh
   node src/utils/db-init-stage260.js
   node src/utils/db-init-stage261.js
   npm run db:schema-check
   ```

   Stage 261 é exigida pelo reader e writer globais. Stage 260 é exigida pelo
   guard global do runtime, mesmo sem ligar um produtor de publicações. Se
   surgirem outros erros de schema, investigar antes de prosseguir.
3. Publicar primeiro os consumidores/leitores do ranking que precisam entender
   `canonical-global-v1`, inclusive no host web se ele usar o mesmo banco.
   Leitores antigos não incluem essa prova e podem declarar cobertura incompleta.
   Atualizar o worker mantendo-o parado; seguir o deploy existente e preservar flags.
4. Confirmar configuração, migrations e versão carregada. A prova global não
   exige bootstrap de participação versionada para o LIVE canônico.
5. Para a primeira ativação, propor explicitamente no plano de escrita um lote
   de até 100 blocos e intervalo de 2.000ms, mantendo os demais flags. Esses
   valores precisam de aprovação se diferirem da configuração instalada.
   Iniciar somente a instância existente de transfers. Aumentos de lote/cadência precisam preservar os limites
   do [contrato global](robinhood-wallet-transfer-global-scan-proof.md).

## Aceitação e acompanhamento

Registrar antes/depois em janelas comparáveis, indicando timestamps, duração e
carga concorrente. Com transfers parado só existe baseline dos demais processos;
para medir melhoria do próprio transfers, usar timings úteis anteriores ou
comparação controlada apropriada, sem religar o writer antigo por conveniência.

Observar avanço/lag de capture, swaps e transfers, taxas de processamento,
`lastResult.timing`, checkpoints, erros/retries, WAL por segundo e I/O/CPU.
Comparar deltas entre amostras; descartar médias desde o boot de iostat/vmstat.
Readiness de posições/ranking e atraso dos outros workers são guardrails.

O status deve mostrar `transferFilterMode=canonical-global-v1`,
`scopeManifest.format=global`, `globalScanId`, candidatos, exclusões e splits.
Confirmar avanço durável dos dois cursores quando posições estiverem habilitadas,
prova global com checkpoint canônico e ausência de novos manifests do catálogo
pelo LIVE canônico. Serviço ativo sozinho não comprova esse contrato.

Se um bloco exceder 100.000 logs/swaps ou 10.000 contratos, o worker falha sem
avançar. Reduzir lote resolve excesso de faixa, não excesso de um bloco. Investigar
`wallet_transfer_global_limit`, gaps e falhas estritas antes de retomar.
Se o lag principal/guardrails piorarem ou surgirem conflitos persistentes, parar
somente transfers e reabrir a avaliação; redução de payload não basta para aceitar.

## Rollback e histórico

Rollback operacional começa parando somente transfers. Preservar schema aditivo,
provas, cursores, dados financeiros, env e template. Não remover provas globais
nem retroceder cursores. Manter leitores capazes de interpretar o histórico misto;
antes de voltar a um writer anterior, avaliar o retorno das listas completas e
seu custo. Não tratar downgrade de todo o checkout como rollback isolado do worker.

**Ponto importante:** esta ativação limita o crescimento novo do manifesto LIVE
canônico. Não converte nem libera os 96,5 GiB antigos e não conclui a otimização
financeira das janelas 24h/7d/30d. Conversão e recuperação física são operações
separadas, com auditoria, validação e autorização próprias.
