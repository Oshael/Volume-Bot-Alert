# Operação do worker Pump/Fomo de callouts

Este runbook instala e opera somente o worker isolado `callouts`. Ele captura
perfis, observações de wallets e teses da Pump e Fomo, sem publicar alertas,
resumos ou dados no gráfico.

## Pré-condições

- código contendo o Stage 161 e o worker `callouts` já publicado na VPS;
- template compartilhado `/etc/systemd/system/trendscope-worker@.service` ativo;
- PostgreSQL fora de uma janela crítica de backfill;
- token Pump, JWT Fomo e `topicId` válidos;
- retention de 72 horas operacional antes de ultrapassar o primeiro período de
  retenção. Até esse corte existir, o soak deve ser curto e supervisionado.

O processo carrega banco e `JWT_SECRET` do `.env` global do projeto. Não os
duplique em `/etc/trendscope/callouts.env`.

## 1. Instalar credenciais rotativas

Descubra o grupo Unix usado pela template:

```bash
systemctl show trendscope-worker@callouts.service -p User -p Group
```

Substitua `REPLACE_APP_GROUP` abaixo pelo grupo retornado. Os arquivos precisam
ser legíveis pelo processo, mas não por outros usuários:

```bash
sudo install -d -o root -g REPLACE_APP_GROUP -m 0750 /etc/trendscope/secrets
sudo install -o root -g REPLACE_APP_GROUP -m 0640 /dev/null \
  /etc/trendscope/secrets/callouts-pump-token
sudo install -o root -g REPLACE_APP_GROUP -m 0640 /dev/null \
  /etc/trendscope/secrets/callouts-fomo-jwt
sudoedit /etc/trendscope/secrets/callouts-pump-token
sudoedit /etc/trendscope/secrets/callouts-fomo-jwt
```

Cada arquivo contém somente o valor da credencial, com newline final opcional.
Não registre o conteúdo em shell history, journal ou comandos de diagnóstico.

## 2. Instalar env e drop-in

Use `deploy/systemd/callouts.env.example` como base para
`/etc/trendscope/callouts.env`. Preencha somente o `FOMO_WS_TOPIC_ID`; os segredos
continuam nos arquivos acima.

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
```

Esperado: uma lease ativa, checkpoints `pump:live` e `fomo:live` avançando e
timestamps recentes. Processo `active (running)` sem avanço não é saudável.

## Rotação de credenciais

O token Pump é relido em cada request. O JWT Fomo é relido no próximo challenge.
Substitua o arquivo preservando dono/modo e nunca edite o valor no repositório.
Para forçar um novo challenge imediatamente, reinicie somente esta instância:

```bash
sudo systemctl restart trendscope-worker@callouts.service
```

Após rotação, confirme novamente lease e freshness; não imprima os arquivos.

## Falhas e rollback

- `401/403` Pump pausa aquele collector até a credencial ser corrigida;
- `429` Pump respeita `Retry-After`;
- falha de commit Pump mantém o batch em memória e não avança checkpoint;
- Fomo reconecta com backoff e usa o feed HTTP para reconciliação limitada;
- perda da lease encerra o processo para impedir captura duplicada.

Rollback operacional:

```bash
sudo systemctl disable --now trendscope-worker@callouts.service
```

Parar o worker preserva perfis, wallets, callouts e checkpoints. Não remova
tabelas, credenciais ou drop-in durante o rollback inicial.
