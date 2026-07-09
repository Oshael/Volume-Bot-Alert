# Plano De Alertas Cross-Process Sem Fallback

Plano de implementacao para o runtime separado:

- `volume-bot-alert-web`
- `volume-bot-alert-worker`

## Objetivo

Corrigir definitivamente os alertas depois da separacao web/worker:

1. O worker deve usar presenca real compartilhada, nao sessoes validas como aproximacao.
2. Eventos criados pelo worker devem chegar ao Socket.io do web.
3. Eventos nao entregues durante desconexao ou restart devem ser recuperados.
4. Mudancas de configuracao devem chegar ao cache do worker.
5. O browser nao deve depender de polling continuo de alert feeds.

O runtime continuara com uma instancia web e uma worker. Escala horizontal de
processos nao faz parte deste plano.

## Estado Atual Confirmado

### Presenca

O frontend envia `live:presence` ao Socket.io do web. O web grava essa presenca
em um `Map` local de `user-alert-profile-cache`.

O worker esta em outro processo e nao enxerga esse `Map`. O fallback atual
consulta sessoes validas no banco, mas uma sessao valida nao prova que o usuario
esta ativo, em foreground ou dentro do periodo permitido em hidden.

Arquivos envolvidos:

- `frontend/src/services/socket/client.ts`
- `src/services/socket-hub.js`
- `src/services/user-alert-profile-cache.js`

### Entrega

O worker persiste os eventos, mas `backend-alert-publisher` tenta emitir por um
Socket.io local. Como `RUN_SOCKET_HUB=false` no worker, a emissao retorna `false`.
Hoje o frontend compensa isso consultando `/api/dashboard/alert-feeds`.

Arquivos envolvidos:

- `src/services/backend-alert-publisher.js`
- `src/services/backend-alert-feed.js`
- `src/services/socket-hub.js`
- `frontend/src/state/app-controller.ts`

### Configuracao

As rotas de configuracao invalidam somente o cache do processo web. O cache do
worker pode continuar usando thresholds antigos.

Arquivos envolvidos:

- `src/routes/config.js`
- `src/services/user-alert-profile-cache.js`
- `src/models/user-config.js`

## Arquitetura Alvo

```text
Browser --live:presence--> Web --UPSERT--> Postgres
                                             |
                                             v
                                      Worker / matcher

Worker --persiste evento--> Postgres --NOTIFY--> Web --Socket.io--> Browser
                                  |
                                  +--> replay de eventos nao vistos
```

Regras:

- Postgres e a fonte compartilhada de presenca, eventos e cursores.
- `LISTEN/NOTIFY` reduz a latencia, mas nao garante durabilidade.
- As tabelas de eventos existentes sao o log duravel.
- O web recupera eventos nao vistos quando o socket conecta ou volta a ficar ativo.
- A entrega e `at-least-once`; frontend e cursor continuam idempotentes.
- Uma notificacao perdida nao pode causar perda de alerta.

## Bloco 1 - Presenca Compartilhada

Objetivo: permitir que o worker enxergue a mesma presenca recebida pelo web.

Implementar:

1. Criar stage de schema para `user_alert_presences`.
2. Relacionar a presenca a `user_id`, sessao autenticada e conexao Socket.io.
3. Persistir:
   - modo `foreground` ou `hidden`;
   - ultimo heartbeat;
   - inicio e limite da tolerancia hidden;
   - desconexao;
   - identificador da instancia web e do socket.
4. Criar indices para leitura por usuario e expiracao.
5. Criar model com `upsert`, `disconnect`, `listActive` e limpeza de registros
   expirados.

Semantica a preservar:

- heartbeat atual: `15s`;
- presenca foreground expira apos a tolerancia atual do cache;
- hidden respeita a grace period atual;
- desconexao marca a conexao como encerrada;
- multiplas abas/sessoes do mesmo usuario sao agregadas sem se sobrescrever.

Validacao:

- `npm run db:schema-check`;
- teste de integracao para upsert, expiracao, desconexao e multiplas conexoes;
- confirmar que restart do web nao deixa usuario ativo indefinidamente.

## Bloco 2 - Web Grava E Worker Le Presenca

Objetivo: cortar a dependencia do heap do processo web.

Implementar no web:

1. Resolver a sessao autenticada usada pela conexao.
2. Gravar cada `live:presence` no model compartilhado.
3. Marcar a conexao como encerrada em `disconnect`.
4. Manter temporariamente o `Map` local apenas durante o rollout.

Implementar no worker:

1. Fazer `listActiveProfiles()` consultar a presenca compartilhada.
2. Carregar configuracoes apenas para usuarios realmente ativos.
3. Usar cache curto com expiracao limitada ao proximo vencimento de presenca.
4. Remover `listActiveSessionUserIds()` do fluxo normal.

Teste de regressao obrigatorio:

- uma sessao valida sem heartbeat nao recebe alertas;
- foreground ativo recebe;
- hidden recebe somente durante a grace period;
- fechar a ultima conexao torna o usuario inativo.

## Bloco 3 - Sincronizacao De Configuracao

Objetivo: o worker aplicar alteracoes sem restart e sem cache indefinido.

Solucao:

1. Ao salvar configuracao, publicar `pg_notify` com `userId` e versao.
2. O worker usa uma conexao dedicada com `LISTEN`.
3. Ao receber a notificacao, invalida o perfil daquele usuario.
4. Adicionar TTL maximo ao cache como protecao contra notificacao perdida.
5. Reutilizar a versao ou `updated_at` persistida para evitar recarregar dados
   que nao mudaram.

Validacao:

- alterar threshold no web e comprovar que o worker usa o novo valor;
- interromper o listener e comprovar que o TTL converge sem restart;
- nenhuma configuracao de outro usuario pode ser invalidada por engano.

## Bloco 4 - Transporte Worker Para Web

Objetivo: entregar imediatamente um evento persistido pelo worker.

Implementar:

1. Depois do commit do evento, o worker executa `pg_notify`.
2. O payload da notificacao contem somente tipo, ID do evento e usuario.
3. O web mantem uma conexao dedicada com `LISTEN`.
4. O web carrega o evento persistido por ID, valida o destinatario e emite na
   room correta do Socket.io.
5. Falha no `NOTIFY` deve ser registrada, mas nao desfaz o evento persistido.
6. Eventos repetidos sao aceitos e deduplicados pelo contrato existente.

Nao criar outbox nesta fase. As tabelas `user_alert_events` e
`gmgn_claim_alert_events` ja preservam os eventos. O replay do Bloco 5 cobre
restart, desconexao e notificacao perdida.

Validacao:

- evento do worker chega ao socket do web;
- payload adulterado ou evento de outro usuario nao e emitido;
- notificacao duplicada nao duplica o alerta visivel;
- web indisponivel durante a criacao nao perde o evento.

## Bloco 5 - Replay Server-Side

Objetivo: garantir entrega sem polling continuo do browser.

Implementar no web:

1. Ao autenticar o socket, consultar eventos posteriores ao cursor do usuario.
2. Repetir a consulta quando uma presenca volta para foreground.
3. Aplicar limite e paginacao para backlog grande.
4. Emitir os eventos pela mesma funcao usada pelo listener realtime.
5. Manter o acknowledgement/cursor atual com atualizacao monotona.
6. Impedir dois replays simultaneos para o mesmo socket.

O frontend continua deduplicando por identificador estavel. Replay nao e
fallback: e parte do protocolo duravel de entrega.

Validacao:

- alerta criado com browser offline aparece na reconexao;
- alerta criado durante restart do web aparece depois;
- cursor impede replay infinito;
- backlog acima do limite e drenado em paginas.

## Bloco 6 - Remover Fallbacks

Executar apenas depois dos blocos anteriores estarem observados em producao.

Remover:

- consulta de sessoes ativas como fonte de presenca do worker;
- polling periodico de `/api/dashboard/alert-feeds`;
- caminhos do publisher que tentam emitir em Socket.io local no worker;
- flags temporarias de dual-write e comparacao.

Manter:

- endpoint de feed, caso ainda seja usado para carregamento manual/historico;
- persistencia dos eventos;
- cursor e deduplicacao;
- replay server-side.

Validacao frontend obrigatoria:

- `npm run lint`;
- `npm --prefix frontend run build`;
- testes afetados;
- smoke do recebimento realtime e da reconexao.

## Observabilidade

Adicionar metricas ou logs compactos para:

- presencas ativas por modo;
- idade do heartbeat mais antigo ainda considerado ativo;
- eventos persistidos, notificados, emitidos e recuperados por replay;
- atraso entre persistencia e emissao;
- falhas e reconexoes dos listeners Postgres;
- invalidacoes de configuracao recebidas;
- tamanho e duracao de replay.

Alertas operacionais minimos:

- listener Postgres desconectado;
- eventos persistidos sem emissao/replay por tempo excessivo;
- presencas vencidas acumulando;
- crescimento anormal de backlog.

## Ordem De Implementacao E Deploy

1. Schema e model de presenca.
2. Dual-write no web e leitura comparativa no worker.
3. Corte do worker para presenca compartilhada.
4. Sincronizacao de configuracao.
5. `NOTIFY` no worker e `LISTEN` no web.
6. Replay server-side.
7. Remocao dos fallbacks.

Em cada corte:

1. aplicar schema antes do codigo dependente;
2. reiniciar worker e web;
3. validar `/api/health` dos dois servicos;
4. acompanhar os dois journals;
5. confirmar alerta real com uma unica sessao ativa;
6. confirmar que sessao valida sem presenca nao recebe.

## Rollback

Durante o rollout, manter flags independentes para:

- escrita de presenca compartilhada;
- leitura compartilhada no worker;
- transporte Postgres;
- replay server-side;
- polling legado do frontend.

Rollback nao deve religar o servico `combined` nem iniciar jobs no web. O retorno
temporario deve ser feito habilitando a leitura por sessao e o polling legado.

## Pontos Importantes

- Varios usuarios nao exigem varias instancias web. Manter uma web e uma worker
  evita introduzir fanout Socket.io antes do lancamento.
- `LISTEN/NOTIFY` sozinho perde mensagens em desconexoes; por isso o replay e
  obrigatorio.
- Uma sessao autenticada nao equivale a presenca ativa.
- Presenca precisa considerar multiplas abas e sessoes.
- O corte dos fallbacks deve acontecer somente depois de medir o caminho novo.
- Outbox dedicada sera necessaria apenas se o log de eventos atual deixar de ser
  suficiente ou se surgirem outros consumidores com acknowledgements proprios.
- Para multiplas instancias web, sera necessario fanout compartilhado de Socket.io
  e ownership de replay. Isso fica fora do escopo de lancamento.

## Criterio De Conclusao

O plano esta concluido quando:

- worker usa apenas presenca compartilhada;
- configuracao alterada chega ao worker sem restart;
- evento persistido pelo worker chega em realtime ao web;
- restart ou desconexao nao perde eventos;
- browser nao faz polling periodico para receber alertas;
- fallbacks podem ficar desligados por pelo menos 24 horas sem divergencias;
- web continua sem background jobs e worker continua sem Socket.io.
