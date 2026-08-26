# Operação do worker Pump/Fomo de callouts

Este runbook instala e opera somente o worker isolado `callouts`. Ele captura
perfis, observações de wallets e teses da Pump e Fomo, sem publicar alertas,
resumos ou dados no gráfico.

## Pré-condições

- código contendo o Stage 161 e o worker `callouts` já publicado na VPS;
- template compartilhado `/etc/systemd/system/trendscope-worker@.service` ativo;
- PostgreSQL fora de uma janela crítica de backfill;
- token Pump, customer JWT e refresh token Privy da Fomo, e `topicId` válidos;
- `CALLOUT_RETENTION_ENABLED=true` no env exclusivo da instância.

O processo carrega banco e `JWT_SECRET` do `.env` global do projeto. Não os
duplique em `/etc/trendscope/callouts.env`.

## 1. Instalar credenciais rotativas

Descubra o grupo Unix usado pela template:

```bash
systemctl show trendscope-worker@callouts.service -p User -p Group
```

Substitua `REPLACE_APP_USER` e `REPLACE_APP_GROUP` pelos valores retornados. O
token Pump é somente leitura; os dois segredos Fomo pertencem ao usuário do
serviço porque são substituídos atomicamente após uma renovação:

```bash
sudo install -d -o root -g REPLACE_APP_GROUP -m 0750 /etc/trendscope/secrets
sudo install -o root -g REPLACE_APP_GROUP -m 0640 /dev/null \
  /etc/trendscope/secrets/callouts-pump-token
sudo install -d -o REPLACE_APP_USER -g REPLACE_APP_GROUP -m 0700 \
  /var/lib/trendscope/callouts
sudo install -o REPLACE_APP_USER -g REPLACE_APP_GROUP -m 0600 /dev/null \
  /var/lib/trendscope/callouts/fomo-customer-token
sudo install -o REPLACE_APP_USER -g REPLACE_APP_GROUP -m 0600 /dev/null \
  /var/lib/trendscope/callouts/fomo-refresh-token
sudoedit /etc/trendscope/secrets/callouts-pump-token
sudoedit /var/lib/trendscope/callouts/fomo-customer-token
sudoedit /var/lib/trendscope/callouts/fomo-refresh-token
```

No navegador autenticado, capture o `jwt` enviado em `challengeResponse`, o
`refresh_token` e o header `privy-ca-id` da mesma sessão. Grave o JWT do
WebSocket em `fomo-customer-token` e o refresh no arquivo correspondente. Esse
JWT é o access token Privy; na resposta de renovação, seu campo é
`privy_access_token`, enquanto `token` pode ser nulo e não o substitui. O formato
JSON entre aspas usado pelo storage também é aceito. O CA ID vai no env da etapa
seguinte. Como o refresh token Privy é de uso único e rotacionado, feche essa aba
sem fazer logout depois da captura e não deixe o SDK do navegador competir com o
worker pela mesma sessão. Não registre tokens em shell history, journal ou
diagnósticos.

No Mac, `npm run fomo:auth-capture` automatiza essa coleta. O comando abre um
perfil temporário isolado em Chrome normal para o Google; após concluir o login
do Gmail, confirme no terminal. O processo fecha essa primeira janela e reabre o
mesmo perfil instrumentado somente para o login Fomo. Ele observa a resposta
Privy e os frames enviados ao WebSocket, exige que `privy_access_token`, refresh,
CA ID e `topicId` pertençam à mesma sessão, ignora o campo genérico `token` e
fecha o Chrome sem logout. A saída é um diretório `0700` temporário contendo os
dois arquivos de segredo e `callouts.env.fragment`, todos `0600`; nenhum segredo
é impresso no terminal. O diretório não é instalado nem enviado à VPS
automaticamente.

## 2. Instalar env e drop-in

Use `deploy/systemd/callouts.env.example` como base para
`/etc/trendscope/callouts.env`. Preencha `FOMO_WS_TOPIC_ID` e
`FOMO_PRIVY_CA_ID` com o `privy:caid` medido; os segredos continuam nos arquivos
acima.

```bash
sudoedit /etc/trendscope/callouts.env
sudo chown root:root /etc/trendscope/callouts.env
sudo chmod 600 /etc/trendscope/callouts.env
sudo systemctl edit trendscope-worker@callouts.service
```

Conteúdo do drop-in:

```ini
[Service]
EnvironmentFile=/etc/trendscope/callouts.env
```

Depois confira a composição sem imprimir o ambiente:

```bash
sudo systemctl daemon-reload
systemctl show trendscope-worker@callouts.service \
  -p EnvironmentFiles -p ExecStart -p User -p Group -p WorkingDirectory
```

O `ExecStart` efetivo deve resolver para `npm run start:worker:callouts`. O script
fixa porta `3017`, desliga socket/web e seleciona exclusivamente o grupo
`callouts`.

## 3. Aplicar schema em janela segura

Não execute esta etapa enquanto os backfills estiverem saturando o PostgreSQL.
Na janela aprovada, dentro do diretório do projeto:

```bash
node src/utils/db-init-stage161.js
npm run db:schema-check
```

O stage é aditivo. Ele cria tabelas e índices vazios; não inicia o worker nem
importa spools locais.

## 4. Primeiro start e soak

```bash
sudo systemctl enable --now trendscope-worker@callouts.service
systemctl status trendscope-worker@callouts.service --no-pager -l
journalctl -u trendscope-worker@callouts.service -n 50 --no-pager
```

Nos logs, valide apenas códigos, contagens e estados. Tokens, JWT, headers e
payloads completos nunca devem aparecer.

Confirme lease, checkpoints e crescimento com consultas pequenas:

```sql
SELECT lease_key, owner_id, heartbeat_at, lease_until,
       metadata->'telemetry' AS telemetry
FROM worker_leases
WHERE lease_key = 'callout-capture-worker';

SELECT collector_key, last_committed_at, updated_at
FROM callout_collector_checkpoints
ORDER BY collector_key;

SELECT platform, COUNT(*) AS profiles
FROM callout_profiles
GROUP BY platform;

SELECT platform, COUNT(*) AS callouts, MAX(captured_at) AS newest
FROM callout_events
GROUP BY platform;

SELECT COUNT(*) AS overdue
FROM callout_events
WHERE expires_at <= NOW();
```

Esperado: uma lease ativa, checkpoints `pump:live` e `fomo:live` avançando e
timestamps recentes. Em volume normal, `overdue` retorna a zero; durante backlog,
ele pode permanecer positivo enquanto `retention.lastResult.status` estiver em
`draining`, limitado a 5.000 deleções por ciclo. A telemetria da lease também
mostra erros e totais. Processo `active (running)` sem avanço não é saudável.

## Reparar chain ausente nos callouts Pump históricos

Os endpoints históricos da Pump podem omitir `chainId`. O runtime infere Solana
somente quando `coinMint` tem formato Base58 válido de endereço Solana; endereços
EVM sem rede permanecem `unknown_chain`. Audite e aplique o mesmo reparo no
arquivo permanente e nos eventos ainda retidos:

```bash
npm run callouts:repair-pump-solana
npm run callouts:repair-pump-solana -- --mode write
```

O primeiro comando é sempre dry-run. O write é idempotente, transacional e altera
somente linhas Pump sem evidência de chain e com formato Solana inequívoco.

## Enriquecer perfis Pump incompletos

O endpoint público `GET /users/{userIdentifier}` fornece `username`, avatar e X.
O collector consulta gradualmente os usuários da watchlist, sem cookie, atualiza
cada perfil no máximo uma vez por 24 horas e tenta falhas novamente após 15
minutos. Para perfis já persistidos sem username, use o backfill bounded:

```bash
npm run callouts:backfill-pump-profiles
npm run callouts:backfill-pump-profiles -- --mode write --limit 100 --concurrency 3
```

O dry-run não chama a Pump nem escreve no banco. O write preserva o
`platform_user_id` original do callout e persiste perfil, avatar, X e wallet na
mesma transação. Repita lotes até `candidates` chegar a zero; falhas são agregadas
somente por código seguro.

## Rotação de credenciais

O token Pump é relido em cada request. Na Fomo, o worker usa o customer JWT até
30 segundos antes de `exp`, chama `POST /api/v1/sessions` com o refresh token e
os headers públicos da sessão Privy, sem `Authorization`, replica o
`privy:caid` estável do navegador e grava atomicamente ambos os valores
retornados. A telemetria
`fomoAuthentication` expõe somente expiração, totais e códigos seguros.

`FOMO_PRIVY_REAUTH_REQUIRED` significa que a sessão foi revogada ou deixou de
ser renovável. Faça login novamente, substitua os dois arquivos preservando
dono/modo e reinicie somente esta instância:

```bash
sudo systemctl restart trendscope-worker@callouts.service
```

Após rotação, confirme novamente lease e freshness; não imprima os arquivos.

## Falhas e rollback

- `401/403` Pump pausa aquele collector até a credencial ser corrigida;
- `429` Pump respeita `Retry-After`;
- falha de commit Pump mantém o batch em memória e não avança checkpoint;
- Fomo renova a sessão sob demanda; falha transitória reconecta com backoff e
  `FOMO_PRIVY_REAUTH_REQUIRED` exige novo login;
- retenção apaga somente `callout_events` vencidos, em até cinco lotes de 1.000
  por ciclo; erro aplica backoff sem apagar perfis ou observações de wallets;
- perda da lease encerra o processo para impedir captura duplicada.

Rollback operacional:

```bash
sudo systemctl disable --now trendscope-worker@callouts.service
```

Parar o worker preserva perfis, wallets, callouts e checkpoints. Não remova
tabelas, credenciais ou drop-in durante o rollback inicial.
