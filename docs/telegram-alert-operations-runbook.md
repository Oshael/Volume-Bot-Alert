# Runbook operacional — alertas Telegram

Status: preparado a partir do contrato local em 2026-08-01. Este documento nao
prova deploy, migracao, registro no Telegram ou ativacao em producao.

## Escopo e limites atuais

O backend expoe o webhook em:

```text
POST /api/telegram/webhook
```

Para o dominio atual, a URL completa esperada e:

```text
https://api.trendscope.pro/api/telegram/webhook
```

O contrato implementado:

- aceita apenas `POST` com `application/json`;
- limita o corpo a 64 KiB;
- exige `X-Telegram-Bot-Api-Secret-Token`;
- compara o secret de forma resistente a timing;
- deduplica por `update_id` no PostgreSQL;
- processa apenas `message` e `callback_query`; outros updates sao ignorados;
- retorna `503` enquanto `TELEGRAM_ALERTS_ENABLED=false`;
- nao registra nem remove o webhook automaticamente.

`TELEGRAM_WEBHOOK_PUBLIC_URL` e atualmente declarativa: a configuracao exige a
variavel quando Telegram esta ativo, mas o operador ainda precisa chamar
`setWebhook` na Bot API.

Nao existe flag de shadow exclusiva para Telegram. Ao habilitar o runtime
`core`, deliveries elegiveis podem ser enviadas. O primeiro rollout deve usar
um bot de staging e somente uma conta admin; nao trate o runtime atual como
shadow sem envio.

## Pre-requisitos

- bot exclusivo para o ambiente, criado no BotFather;
- token, username e secret fora do Git e dos logs;
- DNS publico e HTTPS valido para a API;
- processo web e worker `core` identificados antes de qualquer restart;
- Node >= 20.9 no host que renderiza sparklines com `sharp`;
- backup recente do PostgreSQL;
- janela sem backfill ou migracao pesada concorrente.

O Telegram aceita `secret_token` com 1 a 256 caracteres usando apenas letras,
numeros, `_` e `-`. Uma geracao compativel e:

```bash
openssl rand -hex 32
```

Nunca copie o valor gerado para tickets, chat, historico compartilhado ou para
este repositorio.

## Inventario antes do deploy

No host web e no host de workers, registre o commit e descubra os nomes reais
das unidades. Nao presuma que os exemplos de systemd existem:

```bash
cd /opt/trendscope/app
git status --short
git branch --show-current
git log -1 --oneline
systemctl list-units --type=service --all \
  | grep -Ei 'trendscope|volume|telegram|worker-core'
```

Nao reinicie Robinhood live ou backfill para ativar Telegram. Apenas o processo
web e o worker do grupo `core` pertencem a este rollout.

## Configuracao inicial desabilitada

Configure o web e o worker `core` com valores do mesmo ambiente:

```env
TELEGRAM_ALERTS_ENABLED=false
TELEGRAM_BOT_TOKEN=<secret>
TELEGRAM_BOT_USERNAME=<username-sem-arroba>
TELEGRAM_WEBHOOK_SECRET=<secret-compativel>
TELEGRAM_WEBHOOK_PUBLIC_URL=https://api.trendscope.pro/api/telegram/webhook
APP_BASE_URL=https://www.trendscope.pro
```

Mantenha os limites de entrega nos defaults de `.env.example` durante staging.
O processo falha no startup se Telegram estiver habilitado e um dos valores
obrigatorios estiver ausente.

## Schema

Os stages Telegram sao 84 a 89, 93 e 94. Eles devem ser executados em ordem no
host autorizado a migrar o banco:

```bash
cd /opt/trendscope/app
for stage in 84 85 86 87 88 89 93 94; do
  runuser -u trendscope -- node "src/utils/db-init-stage${stage}.js" || break
done
runuser -u trendscope -- npm run db:schema-check
```

Pare no primeiro erro. Nao habilite Telegram se o schema check falhar. Esses
comandos nao devem competir com backfill saturando o PostgreSQL; aguarde uma
janela segura em vez de interpretar lentidao como falha de contrato.

## Preflight do bot

Carregue as variaveis pelo mecanismo de secrets do host. Nao use `curl -v`, nao
imprima o token e nao salve respostas brutas em artefatos compartilhados.

Valide a identidade e compare o username com `TELEGRAM_BOT_USERNAME`:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" \
  | jq '{ok, id: .result.id, username: .result.username}'
```

Com o recurso ainda desabilitado, o health publico deve continuar `200` e
mostrar o componente como `disabled`:

```bash
curl --fail-with-body --silent --show-error \
  https://api.trendscope.pro/api/health \
  | jq '{status, telegramAlerts}'
```

Um `POST` no webhook deve retornar `503` enquanto a flag estiver desligada.
Isso confirma a protecao, mas ainda nao valida processamento de updates.

## Ativacao controlada de staging

1. Confirme schema, HTTPS, bot e commit.
2. Confirme que nenhuma conta nao administrativa esta vinculada.
3. Altere `TELEGRAM_ALERTS_ENABLED=true` apenas no processo web de staging.
4. Reinicie somente o web e confirme que subiu sem erro de configuracao.
5. Registre o webhook imediatamente.
6. Valide `getWebhookInfo` e um comando `/start` da conta admin.
7. Habilite e reinicie somente o worker `core` de staging.
8. Observe health/admin, fila e erros antes de testar alertas.

O intervalo entre os passos 4 e 7 pode aparecer como `degraded` no componente
Telegram do health. O status HTTP geral continua avaliando a disponibilidade da
API e do banco.

Nao habilite web e worker em producao geral neste corte. A promocao exige os
smokes e o checklist de rollout dos cortes seguintes.

## Registro do webhook

Na primeira ativacao isolada de staging, descarte updates antigos de testes:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --form-string "url=${TELEGRAM_WEBHOOK_PUBLIC_URL}" \
  --form-string "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --form-string 'allowed_updates=["message","callback_query"]' \
  --form-string 'drop_pending_updates=true' \
  | jq '{ok, description}'
```

`drop_pending_updates=true` elimina updates acumulados. Use somente na primeira
ativacao de staging ou num reset deliberado. Para atualizar URL/secret sem
descartar backlog, omita esse parametro.

Confira o registro sem expor o token:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" \
  | jq '{
      ok,
      url: .result.url,
      pending: .result.pending_update_count,
      lastErrorDate: .result.last_error_date,
      lastErrorMessage: .result.last_error_message,
      allowedUpdates: .result.allowed_updates
    }'
```

Aceite o registro somente quando:

- `ok` for `true`;
- `url` for exatamente `TELEGRAM_WEBHOOK_PUBLIC_URL`;
- `allowedUpdates` contiver apenas `message` e `callback_query`;
- `pending` estabilizar proximo de zero;
- novos `lastErrorDate` e `lastErrorMessage` nao aparecerem.

## Validacao do endpoint

Com Telegram habilitado:

- secret ausente ou incorreto deve retornar `401`;
- content type diferente de JSON deve retornar `415`;
- JSON maior que 64 KiB deve retornar `413`;
- JSON vazio com secret correto deve retornar `400` por falta de `update_id`.

Teste minimo sem criar update no banco:

```bash
curl --silent --show-error -o /dev/null -w '%{http_code}\n' \
  -X POST "${TELEGRAM_WEBHOOK_PUBLIC_URL}" \
  -H 'Content-Type: application/json' \
  -H "X-Telegram-Bot-Api-Secret-Token: ${TELEGRAM_WEBHOOK_SECRET}" \
  --data '{}'
```

O resultado esperado e `400`. Execute apenas em host confiavel: o header fica
temporariamente visivel nos argumentos do processo. Nunca use tracing ou `-v`.

Depois, use a interface do produto para gerar o deep link da conta admin, abra
o bot e pressione Start. Nao construa nem compartilhe manualmente o token do
deep link.

## Observabilidade

Health publico:

```bash
curl --fail-with-body --silent --show-error \
  https://api.trendscope.pro/api/health \
  | jq '.telegramAlerts'
```

O resumo publico nao deve conter lease, PID, hostname ou `lastError` interno.

No status administrativo `/api/admin/ws-status`, confirme:

- `telegramAlerts.health` em `ok` depois que o worker `core` adquirir a lease;
- `telegramAlerts.metricsAvailable=true`;
- lease fresca;
- fila `pending/retry` sem crescimento continuo;
- latencia p50/p95 compativel com staging;
- ausencia de crescimento continuo em `rateLimited24h` e erros;
- fallback de sparkline observavel, sem impedir entrega textual.

Nao exponha o bearer administrativo em comandos compartilhados. Prefira a tela
autenticada ou um secret temporario no host autorizado.

## Criterios de parada

Interrompa o rollout se ocorrer qualquer um destes casos:

- schema check falha;
- `getMe` retorna bot ou username inesperado;
- webhook aponta para ambiente diferente;
- health Telegram permanece `degraded` apos a lease `core` estabilizar;
- `pending_update_count` cresce continuamente;
- fila `pending/retry` envelhece continuamente;
- erro de auth, secret, TLS ou certificado;
- envio para conta que nao seja o admin de staging;
- duplicidade de mensagem ou perda de ownership do delivery;
- rate limiting recorrente;
- impacto material no PostgreSQL ou nos workers Robinhood.

## Rollback

1. Defina `TELEGRAM_ALERTS_ENABLED=false` no web e no worker `core`.
2. Reinicie somente essas duas unidades.
3. Remova o webhook para impedir retries continuos do Telegram.
4. Confirme `/api/health` com Telegram `disabled`.
5. Preserve conexoes, perfis, regras e deliveries para diagnostico.
6. Nao apague tabelas nem reenvie backlog manualmente.

Remocao preservando updates pendentes no Telegram:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook" \
  --form-string 'drop_pending_updates=false' \
  | jq '{ok, description}'
```

Se o rollback ocorreu por update malformado, loop ou backlog inseguro, use
`drop_pending_updates=true` somente mediante decisao explicita, pois a operacao
descarta updates ainda nao entregues.

O rollback nao deve apagar vinculos ou configuracoes e nao deve gerar replay de
alertas historicos quando o recurso voltar.

## Checklist final de rollout

Evidencias locais obrigatorias:

- [ ] commit e diff revisados por escopo;
- [ ] `npm run lint` sem erros ou novos warnings;
- [ ] `npm --prefix frontend run build` aprovado;
- [ ] testes unitarios e de integracao Telegram afetados aprovados;
- [ ] `npx playwright test tests/smoke/telegram-settings.spec.js` aprovado;
- [ ] `npm run db:schema-check` aprovado no banco-alvo restaurado/teste;
- [ ] `TELEGRAM_ALERTS_ENABLED=false` permanece como default e no primeiro deploy;
- [ ] Node >= 20.9 e `sharp` carregam no host do worker `core`.

Evidencias externas de staging, ainda nao satisfeitas pelo codigo local:

- [ ] bot e username confirmados com `getMe`;
- [ ] bot/token exclusivos do ambiente;
- [ ] HTTPS e URL exata do webhook confirmados;
- [ ] `setWebhook` e `getWebhookInfo` aprovados;
- [ ] somente a conta admin de staging vinculada;
- [ ] comandos, menus, callback e edicao de threshold validados;
- [ ] lease do worker `core` fresca e health Telegram em `ok`;
- [ ] uma entrega com PNG e uma entrega com fallback textual observadas;
- [ ] retry, bloqueio e reativacao sem replay observados;
- [ ] fila, latencia, rate limit e erros estaveis durante a janela de observacao;
- [ ] rollback ensaiado sem apagar configuracoes ou afetar alertas do painel.

Registre commit, ambiente, horario, operador e resultados. Nao anexe tokens,
deep links, chat IDs, payloads ou respostas brutas da Bot API.

## Referencias externas

- Telegram Bot API: <https://core.telegram.org/bots/api#setwebhook>
- Guia oficial de webhooks: <https://core.telegram.org/bots/webhooks>
