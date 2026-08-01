# Telegram alert integration plan

Documento de decisao e execucao para integrar os alertas do TrendScope ao
Telegram com configuracao completa dentro do proprio bot, regras independentes
do painel web, bloqueio imediato por perda de acesso e sparkline anexada aos
alertas.

Este documento e a fonte de verdade para continuar o trabalho sem depender do
contexto da conversa.

Data inicial: 2026-07-29.

## Status

- Cortes 1 a 7 implementados e validados em fatias de ate 500 linhas.
- Corte 8 possui schema duravel, commit atomico do plano, destino shadow,
  fonte cacheada com gate de acesso, wiring desabilitado por default e
  lifecycle de claim/retry/settlement da outbox implementados ate o subcorte
  8G.
- Corte 9 iniciado: o subcorte 9A adiciona cutoff interno deterministico no
  ultimo bucket completo anterior a `triggeredAt`, sem expor `endAt` na rota
  publica.
- Subcorte 9B1 seleciona `sharp` 0.35.3 como dependencia de producao para
  rasterizacao; renderer e integracao permanecem pendentes para 9B2+.
- Subcorte 9B2 implementa renderer SVG/PNG 960x420 isolado, normalizacao de
  serie e fallback explicito para historico insuficiente; ainda sem worker.
- Subcorte 9C compoe historico, renderer e Bot API atras de portas testadas;
  fallback textual ocorre antes do primeiro envio, sem mascarar timeout de foto.
- Subcorte 9D adiciona formatter HTML por regra, links validados para o produto
  e explorer, sem incluir campos internos ou blobs do payload.
- Subcorte 9E1 adiciona um ciclo de worker concorrente atras de portas para
  contexto, access gate, envio e settlement; adaptadores runtime seguem pendentes.
- Subcorte 9E2 mantem o ownership com heartbeat durante o envio e bloqueia
  settlement quando outra instancia recupera o lease.
- Subcorte 9E3 carrega contexto relacional apenas para o claim ainda pertencente
  ao worker e produz entrada do sender sem decidir autorizacao.
- Subcorte 9E4A revalida acesso no envio, persiste suspensao e cancela backlog
  ainda nao reivindicado; reativacao sem replay permanece pendente.
- Subcorte 9E4B1 persiste o pedido de reativacao sem liberar a conexao; o novo
  baseline continua obrigatorio antes de voltar ao estado ativo.
- Subcorte 9E4B2A adiciona o epoch duravel e a transicao atomica de ativacao,
  ainda sem conecta-la ao runtime antes do contrato de baseline.
- Subcorte 9E4B2B descobre perfis pendentes e transforma a primeira observacao
  de cada token antigo em estado de baseline sem criar intent.
- Subcorte 9E4B2C ativa a conexao somente depois do commit do primeiro baseline
  Solana e mantem conclusao idempotente para avaliacoes concorrentes.
- Subcorte 9E4B2D adiciona reconciliacao isolada para reativar conexoes sem
  perfil Solana habilitado, com a ausencia do perfil revalidada atomicamente.
- Subcorte 9E5A compoe entrega e reconciliacao em runtime isolado, drenando a
  outbox antes da reativacao e mantendo lifecycle serial com backoff.
- Subcorte 9E5B liga esse runtime ao grupo `core` sob lease distribuido, com
  configuracao operacional limitada e shutdown gracioso.
- Subcorte 10A1 adiciona agregados operacionais sanitizados e contador runtime
  de fallback; exposicao no admin e health permanece para 10A2.
- Subcorte 10A2 conecta o diagnostico completo sanitizado ao admin e um resumo
  publico limitado ao health, sem tornar falha de metricas fatal para a API.
- Subcorte 10B registra o runbook manual de webhook, staging, observabilidade e
  rollback, incluindo a ausencia atual de registro automatico e modo shadow.
- Subcorte 10C adiciona o smoke visivel do fluxo de conexao e separa no
  checklist as evidencias locais das validacoes externas de staging.
- Vinculo, webhook, configuracoes independentes e avaliacao shadow possuem
  contratos implementados; entrega runtime continua desativada.
- Nenhum bot foi criado no BotFather.
- Nenhum token, webhook ou segredo do Telegram foi configurado.
- Ainda nao existe worker de entrega ou envio runtime de alertas.
- Claims ficam fora do MVP e desativados no backend Telegram.

## Decisoes confirmadas

- A conversa privada com o bot sera a interface principal e completa de
  configuracao do Telegram.
- O usuario podera configurar, dentro do Telegram, todos os thresholds,
  cooldowns, redes e regras suportadas.
- As configuracoes Telegram serao independentes das configuracoes do painel.
- Desabilitar um alerta no painel nao podera impedir o mesmo alerta no Telegram.
- Alterar um threshold no Telegram nao podera alterar o painel.
- O usuario precisara vincular sua conta TrendScope antes de usar alertas ou
  configuracoes no Telegram.
- O backend TrendScope continuara sendo a fonte de verdade para acesso.
- Perda de acesso suspendera imediatamente novas entregas e o uso dos menus.
- Recuperacao de acesso reativara automaticamente a integracao, preservando
  vinculo e configuracoes.
- Logout comum da sessao web nao suspendera o Telegram.
- Conta desativada, acesso revogado, acesso expirado ou perda de elegibilidade
  no token gate suspenderao o Telegram.
- Alertas de claim nao serao oferecidos, avaliados nem entregues pelo Telegram
  no MVP.
- O alerta Telegram tentara incluir uma sparkline rasterizada.
- Falha ao obter ou renderizar a sparkline nao podera impedir o alerta em texto.
- O produto deve ter persistencia duravel, idempotencia, retries, telemetria,
  seguranca e recuperacao operacional; envio fire-and-forget nao e aceitavel.

## Ponto importante

O pipeline atual cria `user_alert_events` depois de avaliar as configuracoes do
painel. Ele nao e uma fila neutra de sinais.

Consequencia: adicionar apenas um filtro Telegram sobre os eventos existentes
nao entrega configuracoes independentes. Se a regra estiver desativada no
painel, o evento pode nunca existir, mesmo que o Telegram esteja habilitado.

A implementacao deve separar:

1. observacao/sinal de mercado;
2. avaliacao por perfil e destino;
3. persistencia do evento de destino;
4. entrega pelo canal externo.

Nao devemos duplicar o worker de mercado inteiro nem executar duas coletas do
mesmo token. A mesma observacao deve alimentar os perfis do painel e Telegram,
com estados de cooldown, rearm e deduplicacao independentes.

## Contexto confirmado no repositorio

### Eventos e feed

- `src/models/user-alert-event.js` persiste alertas por usuario e rede.
- A deduplicacao atual usa `(user_id, chain, dedupe_key)`.
- `src/services/user-alert-matcher.js` avalia os perfis atuais e persiste
  eventos.
- `src/services/backend-alert-feed.js` enriquece um evento persistido com
  metadados de catalogo e constroi o payload do dashboard.
- `src/services/backend-alert-publisher.js` monta o payload e publica um
  `pg_notify`.
- `src/services/backend-alert-realtime.js` recebe a notificacao e envia o evento
  ao Socket.IO do runtime web.
- O `pg_notify` e efemero e nao representa confirmacao de entrega externa.

### Acesso

- `src/models/user-access.js` e a fonte consolidada de
  `hasProductAccess`.
- O acesso considera status manual, admin, pagamento, promo, expiracao e token
  gate.
- Admin tem acesso ativo pelo contrato atual.
- Status `grace` continua com acesso enquanto o resolvedor retornar
  `hasProductAccess: true`.
- `src/routes/admin.js` revoga acesso e sessoes explicitamente.
- `src/services/token-gate-webhook-service.js` reavalia acesso depois de eventos
  de saldo.
- `src/services/socket-hub.js` varre conexoes ativas a cada 60 segundos, mas o
  Telegram nao pode depender apenas dessa varredura.

### Sparkline

- `src/services/catalog-market-history.js` ja fornece series Solana e
  Robinhood.
- `src/models/token-market-bucket-1m.js` fornece a serie Solana.
- `src/models/robinhood-market-history-read.js` fornece historico Robinhood.
- A renderizacao atual vive no frontend em
  `frontend/src/ui/sections/shared.ts`.
- O Telegram precisa de imagem raster; o SVG da interface web nao deve ser
  enviado como se fosse foto.

### Workers

- `src/server.js` inicia workers por grupos e usa
  `src/services/worker-lease-manager.js` para singleton distribuido.
- A entrega Telegram deve reutilizar esse mecanismo.
- Telegram nao deve ser iniciado no runtime web apenas por causa do webhook.

## Experiencia do usuario

### Vinculo inicial

Fluxo recomendado:

```text
TrendScope Bot Settings
  -> Conectar Telegram
  -> backend cria token descartavel e expira em poucos minutos
  -> abre https://t.me/<bot_username>?start=<token_opaco>
  -> usuario pressiona Start
  -> webhook recebe /start <token_opaco>
  -> backend consome o token uma unica vez
  -> associa user_id, telegram_user_id e chat_id
  -> valida hasProductAccess
  -> abre o menu principal do bot
```

Regras:

- O token de vinculo precisa ser aleatorio, de uso unico e curto.
- Apenas o hash do token deve ser persistido.
- Nunca colocar `user_id`, email, JWT ou sessao web no deep link.
- Vincular apenas conversa privada no MVP.
- Um `telegram_user_id` nao pode controlar duas contas TrendScope ao mesmo
  tempo sem uma desvinculacao explicita.
- Uma conta TrendScope tera no maximo uma conversa privada Telegram ativa no
  MVP.
- Novo vinculo para a mesma conta deve exigir confirmacao e invalidar o destino
  anterior.
- O token do bot nunca aparece no navegador, banco de usuario, log ou payload.

### Papel do site

`Bot Settings -> Telegram` no site tera apenas:

- estado `desconectado`, `conectado`, `pausado` ou `acesso suspenso`;
- identidade Telegram vinculada, sem expor dados desnecessarios;
- botao `Conectar Telegram`;
- botao `Abrir Telegram`;
- botao `Desconectar`;
- ultima entrega bem-sucedida e ultimo erro resumido;
- explicacao de que thresholds e cooldowns sao configurados no Telegram.

O site nao tera um segundo editor completo das regras no MVP. Duas interfaces
editando os mesmos campos aumentariam risco de divergencia, conflito e manutencao
sem adicionar valor ao requisito confirmado.

### Menu principal no Telegram

O bot deve preferir mensagens editadas e teclados inline para nao poluir a
conversa.

Menu principal:

```text
TrendScope Alerts

Status: Ativo
Redes: Solana, Robinhood
Sparkline: Ativa

[ Alertas ]
[ Redes ] [ Sparkline ]
[ Pausar/Retomar ]
[ Status da conta ]
[ Ajuda ] [ Desconectar ]
```

Comandos globais:

- `/start` — vincular ou abrir o menu;
- `/settings` — abrir configuracoes;
- `/status` — mostrar acesso, estado e entrega;
- `/pause` — pausar entregas sem perder configuracoes;
- `/resume` — retomar quando houver acesso;
- `/help` — explicar uso;
- `/disconnect` — iniciar desvinculacao com confirmacao.

Comandos nao substituem os botoes; sao atalhos e recuperacao quando uma mensagem
antiga deixa de ser editavel.

### Navegacao de regras

```text
Alertas
  -> Solana
     -> Volume 5M
     -> Market Cap 5M
     -> HVNC
     -> Recent Surge 1H
     -> Recent Surge 6H
     -> Old Week Surge 1H
     -> Old Week Surge 6H
     -> Meteora Surge 1H
     -> Custom alerts, quando o contrato for definido
  -> Robinhood
     -> Volume 5M
     -> FDV 5M
     -> HVNC
     -> Recent Surge 1H
     -> Recent Surge 6H
     -> Old Week Surge 1H
     -> Old Week Surge 6H
     -> Custom alerts, quando o contrato for definido
```

Claims nao aparecem em menu, comando, callback, schema publico ou avaliacao
Telegram.

### Edicao de valor

Exemplo:

```text
Solana / Volume 5M

Estado: Ativo
Threshold: 50%
Cooldown: 5 min
Minimo de volume: $10.000

[ Ativar/Desativar ]
[ Alterar threshold ]
[ Alterar cooldown ]
[ Alterar volume minimo ]
[ Restaurar defaults ]
[ Voltar ]
```

Ao selecionar um campo numerico:

1. bot registra uma sessao curta de entrada;
2. bot pede o valor e mostra unidade, minimo, maximo e atual;
3. a proxima mensagem privada do mesmo usuario e validada;
4. valor invalido retorna erro sem apagar o anterior;
5. `/cancel` ou botao cancela a edicao;
6. valor valido e persistido atomicamente;
7. cache distribuido e invalidado;
8. menu e redesenhado com o valor confirmado pelo servidor.

Requisitos de qualidade:

- callbacks antigos nao podem sobrescrever estado novo silenciosamente;
- toda tela carrega uma versao de configuracao;
- escrita usa controle otimista ou revalida a versao;
- callbacks sao opacos e versionados;
- texto do usuario nunca vira SQL, HTML ou callback sem normalizacao;
- cada callback recebe resposta rapida para remover o spinner do Telegram;
- alteracoes irreversiveis exigem confirmacao.

## Configuracoes independentes

### Principio

O Telegram tera um perfil proprio por usuario e rede. Os defaults podem copiar
os defaults atuais do painel na criacao, mas depois nao existira sincronizacao
automatica entre os destinos.

Mudancas futuras nos defaults afetam apenas novos perfis ou uma restauracao
explicita; nao reescrevem configuracoes existentes.

### Solana

Campos minimos:

- alertas Telegram habilitados para a rede;
- volume 5M habilitado;
- threshold de volume 5M;
- cooldown de volume 5M;
- minimo de volume;
- market cap 5M habilitado;
- threshold de market cap 5M;
- cooldown de market cap 5M;
- minimo e maximo de market cap;
- HVNC habilitado;
- minimo de volume HVNC;
- cooldown HVNC;
- Recent Surge 1H habilitado, threshold e cooldown;
- Recent Surge 6H habilitado, threshold e cooldown;
- Old Week Surge 1H habilitado, threshold e cooldown;
- Old Week Surge 6H habilitado, threshold e cooldown;
- Meteora Surge 1H habilitado, threshold e cooldown.

Exclusoes:

- Pump claim;
- Bags claim;
- qualquer outro GMGN claim signal.

### Robinhood

Campos minimos:

- alertas Telegram habilitados para a rede;
- volume 5M habilitado;
- threshold de volume 5M;
- cooldown de volume 5M;
- minimo de volume;
- FDV 5M habilitado;
- threshold de FDV 5M;
- cooldown de FDV 5M;
- minimo e maximo de FDV;
- HVNC habilitado;
- minimo de volume HVNC;
- cooldown HVNC;
- Recent Surge 1H habilitado, threshold e cooldown;
- Recent Surge 6H habilitado, threshold e cooldown;
- Old Week Surge 1H habilitado, threshold e cooldown;
- Old Week Surge 6H habilitado, threshold e cooldown.

Exclusoes:

- market cap de Solana;
- Meteora;
- Pump/Bags claim.

### Cooldown e rearm

Cooldown nao deve ser somente um atraso de entrega. Ele participa da decisao de
gerar um evento Telegram.

Cada regra Telegram precisa de estado independente contendo, conforme a regra:

- ultimo valor observado;
- baseline;
- ultimo disparo;
- proximo percentual de repeticao;
- armado/desarmado;
- expiracao do estado;
- versao da regra aplicada.

Reutilizar o estado do painel violaria a independencia confirmada.

## Arquitetura alvo

```text
fontes de mercado / catalogo
             |
             v
 observacao normalizada por token e rede
             |
       +-----+---------------------+
       |                           |
       v                           v
perfil painel                 perfil Telegram
configs atuais                configs Telegram
estado atual                  estado independente
       |                           |
       v                           v
user_alert_events             telegram alert intent
       |                           |
       v                           v
pg_notify / Socket.IO         telegram_alert_deliveries
                                   |
                                   v
                         access gate just-in-time
                                   |
                         +---------+---------+
                         |                   |
                         v                   v
                  sparkline PNG         texto fallback
                         |                   |
                         +---------+---------+
                                   |
                                   v
                       Telegram Bot API
```

### Fronteira de avaliacao

A mudanca preferida e fazer `user-alert-matcher` receber uma observacao uma vez
e avaliar uma lista de perfis de destino:

- perfil `dashboard`;
- perfil `telegram`, somente quando conectado, ativo e com acesso.

O adaptador de cada perfil traduz configuracoes persistidas para o contrato
comum do matcher.

O calculo puro da regra deve ser compartilhado. Persistencia de estado, dedupe e
publicacao devem ser especificos do destino.

O estado de uma regra Telegram nao pode avancar para `triggered` apenas porque a
avaliacao produziu um resultado em memoria. A criacao do intent duravel e a
transicao de estado correspondente precisam ocorrer na mesma transacao. Sem
isso, uma queda entre as duas operacoes perderia o alerta e ainda poderia
manter cooldown, rearm ou dedupe bloqueando uma nova tentativa valida.

Consequentemente, o adaptador e a coordenacao da observacao pertencem ao Corte
7, mas a ativacao runtime de mutacoes `triggered` depende do sink transacional
da outbox no Corte 8. Ate esse sink existir, a porta Telegram permanece
injetavel para shadow/teste e nao avanca estado de disparo em producao.

Evitar:

- copiar `user-alert-matcher.js` para um matcher Telegram;
- consultar o Telegram durante a avaliacao;
- renderizar imagem dentro da transacao do evento;
- bloquear o worker de mercado em uma chamada externa;
- deixar falha Telegram reverter evento do painel.

## Modelo de dados proposto

Nomes finais serao confirmados no bloco de schema.

```sql
telegram_connections(
  id,
  user_id UNIQUE,
  telegram_user_id UNIQUE,
  chat_id UNIQUE,
  username,
  first_name,
  status,                 -- active, paused, access_suspended, disconnected
  linked_at,
  disconnected_at,
  access_suspended_at,
  last_update_id,
  last_delivery_at,
  last_error_code,
  last_error_at,
  created_at,
  updated_at
)

telegram_link_tokens(
  id,
  user_id,
  token_hash UNIQUE,
  expires_at,
  consumed_at,
  created_at
)

telegram_alert_profiles(
  id,
  user_id,
  connection_id,
  chain,
  enabled,
  sparkline_enabled,
  sparkline_hours,
  version,
  created_at,
  updated_at,
  UNIQUE(user_id, chain)
)

telegram_alert_rule_settings(
  id,
  profile_id,
  rule_key,
  enabled,
  settings_json,
  version,
  created_at,
  updated_at,
  UNIQUE(profile_id, rule_key)
)

telegram_alert_rule_states(
  profile_id,
  rule_key,
  token_address,
  state_json,
  updated_at,
  PRIMARY KEY(profile_id, rule_key, token_address)
)

telegram_alert_deliveries(
  id,
  connection_id,
  profile_id,
  rule_key,
  chain,
  token_address,
  dedupe_key,
  event_payload,
  triggered_at,
  status,                 -- pending, claimed, retry, sent, cancelled, failed
  attempts,
  next_attempt_at,
  lease_owner,
  lease_until,
  telegram_message_id,
  telegram_file_id,
  last_error_code,
  last_error,
  delivered_at,
  created_at,
  updated_at,
  UNIQUE(connection_id, dedupe_key)
)

telegram_updates(
  update_id PRIMARY KEY,
  received_at,
  processed_at,
  status,
  last_error
)

telegram_input_sessions(
  telegram_user_id PRIMARY KEY,
  action,
  payload_json,
  expires_at,
  created_at,
  updated_at
)
```

`settings_json` so e aceitavel com schema fechado por `rule_key`, validacao
estrita e defaults versionados. Nao sera um deposito de configuracao arbitraria.

IDs do Telegram devem ser armazenados com tipo capaz de representar o contrato
da Bot API sem truncamento.

## Controle de acesso

### Invariante

Nenhuma chamada `sendMessage`, `sendPhoto`, `editMessageText` ou equivalente
relacionada ao produto pode ser iniciada sem uma verificacao recente de
`hasProductAccess`.

### Barreiras

1. **Vinculo:** nao concluir o vinculo sem acesso.
2. **Webhook:** resolver acesso antes de processar menu, callback ou entrada.
3. **Avaliacao:** nao produzir novo intent para perfil sem acesso.
4. **Outbox:** verificar acesso novamente antes de chamar a Bot API.
5. **Eventos de acesso:** suspender proativamente em revogacao, desativacao e
   perda de token gate.
6. **Expiracao por horario:** reconciliador pequeno suspende conexoes vencidas;
   o gate just-in-time continua sendo a garantia principal.

### Suspensao

Quando o acesso some:

- `telegram_connections.status = access_suspended`;
- entregas pendentes ou em retry viram `cancelled` com motivo de acesso;
- novas avaliacoes sao ignoradas;
- comandos mostram apenas estado de acesso e orientacao para renovar;
- configuracoes permanecem intactas;
- o vinculo permanece intacto;
- o bot pode enviar no maximo uma notificacao transacional de suspensao, se a
  politica de produto aprovar, sem repetir spam.

### Reativacao automatica

Quando `hasProductAccess` volta:

- conexao `access_suspended` volta para `active`;
- configuracoes anteriores sao preservadas;
- estados de regra antigos nao devem causar replay retroativo;
- baseline/cursor e atualizado para o momento da reativacao;
- eventos ocorridos durante a suspensao nao sao enviados;
- o bot pode enviar uma confirmacao unica de reativacao.

### Limite real de "imediato"

Uma mensagem cuja requisicao HTTPS ja foi aceita pela Bot API pode chegar mesmo
que o acesso seja revogado no mesmo instante. Nao existe transacao distribuida
entre Postgres e Telegram.

Garantia implementavel:

- depois que a perda de acesso for observada e persistida, nenhuma nova chamada
  de entrega e iniciada;
- chamadas em voo sao contabilizadas e, quando possivel, podem ser seguidas por
  tentativa de exclusao, mas exclusao nao e garantia de seguranca;
- autorizacao nunca depende apenas de cache ou sweep.

## Outbox e entrega

### Garantias

- persistencia antes de tentar envio;
- pelo menos uma tentativa por intent elegivel;
- idempotencia interna por `connection_id + dedupe_key`;
- nenhum retry para erro permanente;
- backoff limitado para erro transitorio;
- respeito a `retry_after` em flood control;
- claim de lote com lease para tolerar crash;
- concorrencia limitada por bot e por chat;
- payload imutavel por entrega;
- telemetria de fila e latencia.

### Erros permanentes

Exemplos a classificar:

- bot bloqueado pelo usuario;
- chat inexistente;
- usuario migrou ou destino deixou de ser valido;
- payload invalido depois de validacao local;
- conexao substituida.

Acao:

- nao repetir indefinidamente;
- marcar conexao conforme o caso;
- preservar erro resumido para site e admin;
- nunca registrar token ou corpo sensivel.

### Erros transitorios

Exemplos:

- timeout;
- resposta 5xx;
- indisponibilidade de rede;
- flood control com `retry_after`;
- falha temporaria de renderizacao.

Falha de historico ou renderizacao pode cair para texto antes da chamada ao Bot
API. Falha ambigua de `sendPhoto` deve ser reagendada sem um segundo envio em
texto, evitando duplicidade.

## Sparkline no alerta

### Formato

Recomendacao inicial:

- PNG 960x420;
- fundo consistente com a identidade TrendScope;
- ticker e rede;
- janela configurada;
- linha e area;
- minimo, maximo e valor final;
- variacao percentual;
- marcador vertical no instante do alerta;
- label MCAP para Solana e FDV para Robinhood;
- contraste legivel no modo claro e escuro do Telegram.

### Serie

- fonte: `catalog-market-history`;
- janela configuravel, com defaults definidos no bloco de produto;
- corte em `triggeredAt`, nao no horario de retry;
- limite de pontos antes de renderizar;
- normalizacao de valores nao finitos;
- comportamento explicito para menos de dois pontos;
- sem consulta a API externa no renderer.

O contrato atual de market history termina em `now`. Para representar o instante
do alerta de forma deterministica, o servico interno precisara aceitar um
`endAt` controlado e testado, sem necessariamente expor esse parametro na rota
publica.

### Renderizacao

Gerar SVG puro no backend e rasterizar para PNG.

Dependencia recomendada a validar no primeiro bloco de imagem:

- `sharp`, se o deploy Linux e o lockfile aceitarem os binarios suportados;
- alternativa pura e controlada se `sharp` introduzir risco operacional
  desproporcional.

Nao usar servico externo de chart:

- evitar vazamento de token/metricas;
- evitar nova dependencia de disponibilidade;
- manter visual consistente;
- permitir teste deterministico.

### Envio

- usar `sendPhoto` com upload multipart;
- legenda formatada em HTML seguro;
- respeitar o limite da legenda;
- teclado inline com `Abrir no TrendScope` e explorer/terminal aprovado;
- se a legenda exceder o limite, resumir por contrato, nao truncar HTML no meio;
- se nao houver imagem, usar `sendMessage`;
- guardar `telegram_file_id` apenas quando seu reuso for semanticamente seguro.

Nao reutilizar a mesma foto para outro evento apenas porque o token e igual: a
janela, o instante e os valores podem ser diferentes.

## Payload do alerta

O payload Telegram reutiliza os campos normalizados do feed, nao o JSON bruto.

Exemplo:

```text
VOLUME 5M - TOKEN

Rede: Solana
Variacao: +82%
Market cap: $140K -> $255K
Volume 5M: $96K
Liquidez: $42K
Idade: 3h 18m
Contrato: AbCd...1234
Horario: 14:32:08
```

Regras:

- snapshot do payload no momento do intent;
- formatacao por `rule_key`;
- escape central de HTML;
- ausencia de campo nao vira `undefined`, `NaN` ou linha vazia;
- endereco completo fica em botao/copiar quando possivel;
- links passam pelas mesmas regras de seguranca de URL do produto;
- dados internos de risco podem ser incluidos somente se fizerem parte do
  contrato visivel do feed;
- `customSoundDataUrl` e qualquer blob nunca entram no Telegram.

## Webhook e seguranca

- endpoint HTTPS dedicado;
- validar `X-Telegram-Bot-Api-Secret-Token` com comparacao segura;
- permitir somente metodos e content type esperados;
- limitar tamanho do corpo;
- deduplicar por `update_id`;
- responder rapidamente e processar trabalho pesado fora da requisicao;
- armazenar apenas campos necessarios do update;
- nao reutilizar `requireTrustedOrigin`, pois Telegram nao e um navegador;
- aplicar rate limit por `telegram_user_id` e tipo de acao;
- webhook nao pode executar comandos administrativos;
- callback sempre revalida ownership da conversa;
- input session expira;
- desconexao e troca de conta exigem confirmacao;
- logs redigem tokens, deep links e dados privados.

Ambientes:

- um bot/token por ambiente;
- webhook de staging nao pode consumir updates de producao;
- `TELEGRAM_BOT_TOKEN` apenas em secret manager/env;
- `TELEGRAM_WEBHOOK_SECRET` separado do token;
- preflight operacional usa `getMe` de forma controlada; o health publico nao
  chama a Bot API nem expoe resposta sensivel.

## Configuracao de runtime

Variaveis esperadas:

```text
TELEGRAM_ALERTS_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_WEBHOOK_PUBLIC_URL=
TELEGRAM_DELIVERY_BATCH_SIZE=
TELEGRAM_DELIVERY_CONCURRENCY=
TELEGRAM_DELIVERY_TIMEOUT_MS=
TELEGRAM_MAX_ATTEMPTS=
```

O processo deve falhar de forma clara quando
`TELEGRAM_ALERTS_ENABLED=true` e secrets obrigatorios estiverem ausentes.

O default sera desabilitado. Deploy de codigo e ativacao operacional sao passos
separados.

## Observabilidade e operacao

Status minimo:

- bot configurado;
- webhook configurado;
- ultimo update recebido;
- conexoes por estado;
- perfis ativos por rede;
- entregas pending/claimed/retry/sent/failed/cancelled;
- idade da entrega pendente mais antiga;
- latencia p50/p95 da entrega;
- contagem de fallback sem sparkline;
- erros por codigo;
- flood control e `retry_after`;
- ultimo ciclo do worker;
- ownership do lease.

Admin/status nao deve expor:

- bot token;
- webhook secret;
- token de vinculo;
- texto privado recebido;
- chat IDs completos sem necessidade operacional.

Alertas operacionais:

- fila crescendo;
- entrega mais antiga acima do SLA;
- webhook sem updates quando esperado;
- taxa elevada de bloqueio;
- flood control persistente;
- falha sistematica do renderer;
- worker sem lease/heartbeat.

## Testes proporcionais ao risco

### Unitarios

- validacao por regra, rede, unidade e limites;
- cooldown/rearm independentes do painel;
- claims rejeitados em todos os contratos Telegram;
- parser de comandos e callbacks;
- sessao de input e expiracao;
- formatter HTML;
- selecao de fallback texto/foto;
- classificacao de erros e backoff;
- renderer deterministico com serie fixa;
- acesso suspenso/reativado sem replay.

### Integracao

- token de vinculo: expiracao, uso unico e ownership;
- webhook secret obrigatorio;
- dedupe por `update_id`;
- persistencia atomica de configuracao e versao;
- isolamento painel versus Telegram;
- outbox idempotente;
- claim concorrente da entrega;
- revogacao cancela pendentes;
- reativacao preserva configuracoes;
- expiracao bloqueia envio mesmo com cache antigo;
- conta desativada bloqueia comandos;
- schema e constraints.

### Smoke/E2E

Somente para fluxos visiveis que nao estao protegidos em camada menor:

- site gera link e mostra conexao;
- deep link de fixture conclui vinculo;
- menu Telegram de fixture altera um threshold;
- alerta de fixture produz foto e legenda;
- perda de acesso muda status e impede nova entrega;
- recuperacao reativa sem replay.

Nao replicar todas as variacoes numericas no smoke test.

### Validacao obrigatoria por bloco

- `npm run lint`;
- `node --test ...` para os testes afetados;
- `npm run db:schema-check` em blocos de schema/init;
- `npm --prefix frontend run build` quando o site mudar;
- `npm run test:smoke` apenas quando o fluxo visivel estiver montado;
- revisao completa do diff antes de sugerir commit.

## Plano de implementacao em cortes

Estimativa inicial total: 3.200 a 4.200 linhas alteradas, incluindo testes,
schema, frontend e documentacao de operacao. A estimativa sera recalculada antes
do primeiro corte.

Cada corte tera no maximo 500 linhas alteradas e exigira autorizacao propria.

### Corte 1 — Contratos e cliente Bot API

Arquivos provaveis:

- `config/index.js`;
- `.env.example`;
- `src/services/telegram-bot-client.js`;
- `src/services/telegram-error-policy.js`;
- testes unitarios correspondentes.

Entrega:

- configuracao segura;
- `getMe`, `sendMessage`, `sendPhoto`, edicao e callback answer;
- timeout, redacao e classificacao de erro;
- nenhuma rota ou schema.

### Corte 2 — Schema de vinculo

Arquivos provaveis:

- novo `db-init-stageXX`;
- `src/utils/db-init.js`;
- `src/utils/runtime-schema.js`;
- models de connection/link token/update;
- testes de schema/models.

Entrega:

- tabelas de vinculo e update idempotente;
- sem webhook publico ainda.

### Corte 3 — API web de conexao

Arquivos provaveis:

- rota autenticada de integracao;
- model/service de link;
- API frontend;
- Bot Settings minimo;
- testes de rota e build.

Entrega:

- gerar deep link;
- status;
- desconectar;
- sem editor web de thresholds.

### Corte 4 — Webhook e vinculo

Arquivos provaveis:

- rota webhook;
- processador de updates;
- servico de comandos basicos;
- testes de secret, dedupe e `/start`.

Entrega:

- vinculo completo;
- menu inicial basico.

### Corte 5 — Persistencia de perfis e regras

Arquivos provaveis:

- novo stage de schema;
- models de profile/settings/input session;
- validadores por regra;
- testes unitarios e de schema.

Entrega:

- configuracoes independentes persistidas;
- claims impossiveis de habilitar.

### Corte 6 — Interface completa no Telegram

Pode exigir mais de um corte de ate 500 linhas.

Entrega:

- navegacao por rede/regra;
- edicao de thresholds/cooldowns;
- pause/resume/reset;
- controle de versao;
- ajuda e confirmacoes.

### Corte 7 — Adaptador de avaliacao independente

Pode exigir mais de um corte de ate 500 linhas por tocar o matcher central.

Entrega:

- mesma observacao avaliada por painel e Telegram;
- estado, cooldown, rearm e dedupe separados;
- nenhuma regressao no painel.
- porta de destino isolada, ainda sem ativar `triggered` em runtime antes da
  outbox transacional.

Risco alto: `user-alert-matcher.js` e arquivo central. Warning de complexidade ou
aumento de acoplamento exige extracao antes de continuar.

### Corte 8 — Outbox e worker

Pode exigir mais de um corte.

Entrega:

- intent duravel;
- persistencia atomica do intent e da transicao de estado `triggered`;
- claim/lease/retry;
- access gate just-in-time;
- suspensao e reativacao;
- telemetria.

### Corte 9 — Sparkline PNG

Subcortes:

- 9A: cutoff interno no ultimo bucket completo anterior a `triggeredAt` para
  Solana e Robinhood;
- 9B1: dependencia `sharp` 0.35.3 registrada, exigindo Node >= 20.9 e binario
  compativel com a arquitetura/libc do host;
- 9B2: renderer SVG/PNG deterministico atras de porta testada;
- 9C: sender isolado com `sendPhoto`, fallback `sendMessage` e IDs de settlement;
- 9D: formatter HTML por regra e links seguros do token;
- 9E1: ciclo do worker com claim, access gate e settlement atras de portas;
- 9E2: heartbeat serializado durante o sender e deteccao de lease perdido;
- 9E3: adapter SQL de contexto e politica explicita da sparkline;
- 9E4A: access gate persistente, suspensao e cancelamento de pending/retry;
- 9E4B1: marcador duravel de acesso recuperado, ainda sob suspensao;
- 9E4B2A: epoch de reativacao e transicao atomica, ainda sem wiring;
- 9E4B2B: baseline state-only por token antigo, ainda sem ativacao;
- 9E4B2C: ativacao Solana pos-commit e invalidacao do cache de perfis;
- 9E4B2D: fallback reconciliado quando nao existe perfil Solana habilitado;
- 9E5A: runtime isolado de entrega e reconciliacao, ainda sem wiring no servidor;
- 9E5B: configuracao, lease distribuido e wiring no grupo `core`;
- 10A1: contrato sanitizado de metricas e telemetria;
- 10A2: wiring no status administrativo e resumo publico de health;
- 10B: runbook de webhook e operacao controlada;
- 10C: smoke essencial e checklist final de rollout;
- implementacao local encerrada; staging e rollout permanecem externos.

Entrega:

- `endAt` interno no market history;
- renderer SVG/PNG;
- foto com legenda;
- fallback em texto;
- teste visual/deterministico do arquivo.

### Corte 10 — Operacao e fluxo montado

Entrega:

- webhook registration/runbook;
- admin status;
- health/metrics;
- smoke tests essenciais;
- ativacao inicialmente desabilitada;
- checklist de rollout e rollback.

## Rollout

1. Deploy com `TELEGRAM_ALERTS_ENABLED=false`.
2. Aplicar schema e executar schema check.
3. Criar bot de staging e validar webhook.
4. Vincular apenas conta admin.
5. Testar menus, thresholds e isolamento do painel.
6. Nao assumir modo shadow: ele ainda nao possui flag Telegram dedicada.
7. Validar intents em teste automatizado e staging isolado.
8. Habilitar entrega somente para o admin de staging.
9. Validar sparkline, retry, bloqueio e reativacao.
10. Liberar para pequeno grupo.
11. Observar fila, flood control e spam.
12. Ampliar apenas com evidencia.

Rollback:

- desligar `TELEGRAM_ALERTS_ENABLED`;
- manter vinculos e configuracoes;
- parar worker e webhook sem apagar dados;
- nao alterar alertas do painel;
- reativar depois sem replay historico.

## Fora de escopo do MVP

- claims Pump/Bags/GMGN;
- grupos, supergrupos, canais e topicos;
- mais de uma conversa por conta;
- editor web completo dos thresholds Telegram;
- Telegram Mini App;
- pagamento ou renovacao dentro do Telegram;
- comandos administrativos;
- broadcast global;
- alertas retroativos durante suspensao;
- servico externo de geracao de chart;
- audio customizado;
- localizacao ou idioma por usuario;
- entrega por outros canais.

## Pendencias antes do primeiro corte

Estas decisoes nao impedem este documento, mas precisam ser fechadas antes dos
blocos correspondentes:

- defaults e limites exatos de cada cooldown;
- janelas permitidas da sparkline;
- contrato de custom alerts no Telegram;
- se suspensao e reativacao enviam uma mensagem transacional unica;
- SLA de entrega alvo;
- dependencia de rasterizacao aprovada para producao;
- politica de retencao das deliveries e updates;
- identidade visual final da imagem;
- URLs/botoes permitidos em cada rede.

## Criterio de conclusao

A integracao so esta concluida quando:

- usuario vincula a conta sem expor credenciais;
- configura todas as regras suportadas dentro do Telegram;
- thresholds e cooldowns sao independentes do painel;
- claims nao podem ser ativados;
- cada alerta elegivel gera no maximo uma entrega logica;
- foto apresenta sparkline coerente com o instante do alerta;
- falha da imagem cai para texto;
- perda de acesso impede novas chamadas de entrega;
- recuperacao reativa automaticamente sem replay;
- retries sobrevivem a restart;
- worker e webhook possuem telemetria;
- schema, lint, testes, build e smoke aplicaveis passam;
- rollout pode ser desligado sem afetar o painel.
