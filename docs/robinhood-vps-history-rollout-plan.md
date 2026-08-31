# Plano de Replay Historico Robinhood na VPS

Documento operacional para preparar, validar, implantar e acompanhar o worker da
Robinhood Chain sem depender do contexto da conversa.

## Objetivo

Executar o worker Robinhood desde o inicio da chain, construir um historico
compacto de pools, swaps e candles e continuar acompanhando novos blocos usando
o RPC publico ate a troca de provedor.

O rollout deve:

- preservar os processos Solana existentes;
- manter Robinhood invisivel para usuarios;
- manter alertas Robinhood desativados;
- tolerar rate limit e timeout do RPC publico;
- nao descartar swaps por falha pontual de `totalSupply`;
- manter apenas dados consolidados no longo prazo;
- ser retomavel depois de restart ou indisponibilidade da VPS.

## Fora de Escopo

- holders e saldos por wallet;
- snapshot diario de holders;
- top holders e concentracao;
- alertas Robinhood para usuarios;
- publicacao de Robinhood no frontend;
- troca do RPC publico pelo futuro provedor definitivo.

Holders devem ser tratados em um projeto separado.

## Decisoes Fechadas

1. O worker comeca no bloco `0` quando ainda nao existem cursores persistidos.
2. Depois de alcancar a ponta, ele pode continuar acompanhando a rede.
3. O RPC publico sera usado mesmo depois do catch-up ate a troca de provedor.
4. O historico permanente sera formado por agregados compactos.
5. Observacoes, logs processados e buckets intermediarios serao removidos somente
   depois de comprovada a consolidacao.
6. Robinhood permanecera invisivel tanto na descoberta de capacidades quanto nos
   endpoints de usuario.
7. Falha pontual de `totalSupply` nao invalida preco, volume, swap ou candle.
8. Supply ausente sera resolvida por checkpoint e eventos de mint/burn quando
   possivel.
9. FDV ficara indisponivel somente quando nenhuma supply confiavel puder ser
   obtida ou reconstruida.

## Estado Atual Confirmado

Na VPS, os processos existentes sao administrados por systemd:

- `volume-bot-alert-web.service`;
- `volume-bot-alert-worker-core.service`;
- `volume-bot-alert-worker-market.service`;
- `volume-bot-alert-worker-maintenance.service`.

Os antigos `volume-bot-alert.service` e `volume-bot-alert-worker.service` devem
continuar parados e desabilitados.

O repositorio ja possui o script do worker RH, locks e cursores persistentes,
registry de pools, observacoes, buckets de 1 minuto/1 hora, agregados por token,
retention worker e backfill retomavel de agregados.

Os Cortes 1 a 5 preparam o codigo para o replay, mas o deploy definitivo ainda
depende da validacao integral, commit aprovado e instalacao operacional deste
documento. Nao tratar alteracoes ainda sem commit como codigo disponivel na VPS.

## Regra de Tamanho e Aprovacao

O trabalho sera feito em cortes independentes de no maximo 500 linhas alteradas.

Depois de cada corte:

1. parar de editar;
2. rodar lint e os testes afetados;
3. rodar schema check quando aplicavel;
4. revisar o diff completo;
5. informar arquivos, linhas alteradas, riscos e pendencias;
6. aguardar autorizacao para o proximo corte.

Uma autorizacao vale somente para o corte seguinte.

## Corte 1 - Robustez do RPC Publico

### Objetivo

Fazer consultas historicas reduzirem o intervalo e tentarem novamente quando o
RPC responder com timeout de range.

### Arquivos previstos

- `src/services/evm-json-rpc-client.js`;
- `src/services/evm-log-poller.js`;
- `tests/evm-json-rpc-client.test.js`;
- `tests/evm-log-poller.test.js`.

### Comportamento esperado

- classificar `-32000` relacionado a timeout/log range como adaptativo;
- nao classificar todo erro `-32000` indiscriminadamente;
- reduzir o range ate o minimo configurado;
- manter backoff para HTTP 429 e timeout de transporte;
- recuperar gradualmente o range depois de sucessos;
- preservar idempotencia e cursor depois de retry.

### Criterio de aceite

Um `eth_getLogs` amplo que retorne timeout deve ser dividido sem avancar o cursor
e sem perder logs.

## Corte 2 - Supply Historica e Procedencia do FDV

### Objetivo

Nao descartar swaps quando `totalSupply` falhar em blocos isolados e nao usar
silenciosamente supply atual como se fosse historica.

### Estrategia

Para cada token:

1. tentar `totalSupply` no bloco da observacao;
2. reutilizar checkpoint exato ja conhecido para o mesmo bloco/faixa;
3. consultar checkpoints vizinhos quando a chamada historica falhar;
4. procurar mint e burn usando somente eventos `Transfer` envolvendo o endereco
   zero;
5. aplicar os deltas entre checkpoints para reconstruir a supply;
6. registrar a procedencia da supply e da valuation;
7. manter preco, volume e swap mesmo quando FDV continuar desconhecido.

Nao sera criado um ledger de holders.

### Estados minimos de procedencia

- `exact_block_call`: lido diretamente no bloco;
- `reconstructed_mint_burn`: reconstruido entre checkpoints;
- `unchanged_between_anchors`: anchors iguais sem mudanca de supply detectada;
- `unavailable`: nenhuma evidencia suficiente.

Tokens rebasing/reflection, proxies e contratos sem eventos consistentes devem
falhar com status explicito, nunca com numero inventado.

## Corte 3 - Cotacao Historica WETH/USDG

### Objetivo

Converter swaps antigos de pools WETH para USD usando uma cotacao correspondente
ao periodo processado.

### Regras

- pools USDG continuam usando a politica de stablecoin configurada;
- pools WETH nao podem usar automaticamente a cotacao mais recente;
- leitura historica por `blockTag` e preferida quando o estado existir;
- quando o estado estiver podado, usar eventos do mercado canonico WETH/USDG;
- cache deve ser indexado por bloco/faixa, nao apenas por token;
- ausencia de cotacao nao pode produzir USD silenciosamente incorreto;
- eventos sem USD confiavel devem permanecer reparaveis.

## Corte 4 - Compactacao e Retencao

### Objetivo

Garantir que o dado detalhado seja apagado somente quando o equivalente compacto
estiver completo.

### Fluxo desejado

```text
processed log
  -> observacao de swap
  -> bucket 1m por mercado
  -> bucket 1h por mercado
  -> agregado por token 5m/15m/30m/1h/4h/1d
  -> limpeza dos intermediarios cobertos
```

### Regras de seguranca

- nunca apagar minuto sem cobertura horaria e agregada;
- nunca apagar horario por mercado sem agregados 1h/4h/1d equivalentes;
- manter pool registry e cursores permanentemente;
- preservar agregados por token;
- usar lotes pequenos com `SKIP LOCKED`;
- interromper limpeza quando houver buckets protegidos;
- expor contadores de examinados, protegidos e apagados;
- permitir reconciliacao retomavel depois de queda ou fila cheia.

## Corte 5 - Robinhood Invisivel para Usuarios

### Objetivo

Separar ingestao interna de exposicao publica.

### Configuracao esperada

Adicionar uma flag independente, desativada por padrao, equivalente a:

```env
ROBINHOOD_USER_VISIBILITY_ENABLED=false
```

### Superficies a proteger

- `availableChains` da configuracao publica;
- readiness/capabilities visiveis;
- dashboard e workspace;
- catalogo e sparklines;
- custom alerts;
- inscricoes de socket;
- qualquer rota que aceite `chain=robinhood` diretamente.

O worker deve continuar escrevendo no banco mesmo com visibilidade desativada.

## Corte 6 - Artefatos de Deploy systemd

### Objetivo

Adicionar documentacao e uma unit de exemplo sem alterar os servicos Solana.

### Informacoes que devem ser preenchidas na VPS

- usuario Linux do processo;
- grupo Linux;
- caminho absoluto do repositorio;
- caminho do Node/npm;
- caminho do arquivo de ambiente RH;
- dependencia real do PostgreSQL local ou remoto.

### Unit de referencia

Nome alinhado as units atuais de core, market e maintenance:

```text
volume-bot-alert-worker-robinhood.service
```

Templates versionados:

- `deploy/systemd/volume-bot-alert-worker-robinhood.service.example`;
- `deploy/systemd/robinhood.env.example`.

### Descoberta obrigatoria na VPS

Executar antes de editar a unit:

```bash
id
pwd
command -v node
command -v npm
readlink -f "$(command -v node)"
readlink -f "$(command -v npm)"
systemctl list-unit-files 'postgresql*' --no-pager
systemctl is-active postgresql.service
```

O `ExecStart` usa o caminho absoluto de `node`, nao o script npm. O script
`start:worker:robinhood` define `ROBINHOOD_INGESTION_ENABLED=true` na linha de
comando e poderia sobrepor um kill switch `false` do arquivo de ambiente.
Executar `node src/server.js` preserva a autoridade do `robinhood.env`.

Se o PostgreSQL for local, adicionar a unit real confirmada aos campos `After`
e `Requires`. Se for remoto, manter apenas `network-online.target`; nao declarar
uma dependencia local ficticia.

### Preparacao dos arquivos

Criar o diretorio protegido e instalar os templates sem iniciar o servico:

```bash
sudo install -d -m 0750 /etc/volume-bot-alert
sudo install -m 0600 deploy/systemd/robinhood.env.example \
  /etc/volume-bot-alert/robinhood.env
sudo install -m 0644 \
  deploy/systemd/volume-bot-alert-worker-robinhood.service.example \
  /etc/systemd/system/volume-bot-alert-worker-robinhood.service
```

Editar os dois arquivos, substituir todos os `REPLACE_*` e confirmar que nenhum
placeholder restou:

```bash
sudoedit /etc/volume-bot-alert/robinhood.env
sudoedit /etc/systemd/system/volume-bot-alert-worker-robinhood.service
sudo grep -n 'REPLACE_' /etc/volume-bot-alert/robinhood.env \
  /etc/systemd/system/volume-bot-alert-worker-robinhood.service
```

O `grep` deve terminar sem linhas. Depois, atribuir o env ao usuario/grupo real
do processo e preservar modo `0600`:

```bash
sudo chown REPLACE_APP_USER:REPLACE_APP_GROUP \
  /etc/volume-bot-alert/robinhood.env
sudo chmod 0600 /etc/volume-bot-alert/robinhood.env
```

Validar antes do `daemon-reload`:

```bash
sudo systemd-analyze verify \
  /etc/systemd/system/volume-bot-alert-worker-robinhood.service
```

Nao habilitar a unit enquanto houver erro, warning de executavel/diretorio
inexistente ou placeholder.

## Matriz de Validacao dos Cortes

Todo corte roda `npm run lint`, `git diff --check` e revisao integral de
`git diff`. Acrescentar as validacoes abaixo conforme o escopo:

| Corte | Validacoes direcionadas |
| --- | --- |
| RPC | `node --test tests/evm-json-rpc-client.test.js` e `node --test tests/evm-log-poller.test.js` |
| Supply/FDV | `node --test tests/robinhood-onchain-pipeline.test.js`, testes novos de supply e `npm run db:schema-check` se houver schema |
| WETH/USDG | `node --test tests/robinhood-weth-usd-quote.test.js`, `node --test tests/robinhood-onchain-pipeline.test.js` e `node --test tests/evm-market-metrics.test.js` |
| Retencao | `node --test tests/robinhood-retention-worker.test.js`, `node --test tests/robinhood-market-aggregate.test.js`, `node --test tests/robinhood-market-aggregate-worker.test.js`, `node --test tests/backfill-robinhood-market-aggregates.test.js` e schema check quando aplicavel |
| Visibilidade | `npm run test:config`, `npm run test:catalog`, `npm run test:dashboard`, testes de disponibilidade/socket e build do frontend se aplicavel |
| systemd/docs | validacao dos comandos contra a VPS, `systemd-analyze verify` na unit e revisao sem credenciais |

Nao executar integracao contra o banco de producao. O build do frontend e
obrigatorio se qualquer arquivo de frontend for alterado.

## Configuracao de Ambiente

### API web

O processo web deve manter:

```env
ROBINHOOD_INGESTION_ENABLED=false
ROBINHOOD_TRANSPORT_ENABLED=false
ROBINHOOD_PERSISTENCE_ENABLED=false
ROBINHOOD_ALERTS_ENABLED=false
ROBINHOOD_MARKET_AGGREGATE_READS_ENABLED=false
ROBINHOOD_USER_VISIBILITY_ENABLED=false
```

### Worker Robinhood

Arquivo separado, com permissao restrita:

```env
PORT=3004
RUN_SOCKET_HUB=false
RUN_BACKGROUND_JOBS=true
BACKGROUND_WORKER_GROUPS=robinhood
ROBINHOOD_INGESTION_ENABLED=true
ROBINHOOD_TRANSPORT_ENABLED=true
ROBINHOOD_PERSISTENCE_ENABLED=true
ROBINHOOD_ALERTS_ENABLED=false
ROBINHOOD_USER_VISIBILITY_ENABLED=false
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
ROBINHOOD_USE_ALCHEMY=false
ROBINHOOD_START_BLOCK=0
ROBINHOOD_SOCIAL_METADATA_ENABLED=false
ROBINHOOD_MARKET_AGGREGATES_ENABLED=true
ROBINHOOD_MARKET_AGGREGATE_READS_ENABLED=false
ROBINHOOD_MARKET_LOG_FILTER_MODE=topics-only
```

Segredos do banco e `JWT_SECRET` continuam obrigatorios porque o worker inicializa
o mesmo servidor, mesmo sem expor a porta ao publico.

O arquivo RH nao deve ser versionado e deve usar permissao `0600`.

### Worker existente de manutencao

`ROBINHOOD_RETENTION_ENABLED=true` deve permanecer no ambiente do
`volume-bot-alert-worker-maintenance.service`, que executa o grupo de manutencao.
Colocar essa flag apenas no worker RH nao inicia o retention worker.

## Preparacao do Banco

### Antes de alterar schema

1. confirmar o banco selecionado;
2. registrar tamanho atual;
3. gerar backup verificavel;
4. confirmar espaco livre na VPS;
5. nao apontar testes de integracao para producao.

### Inicializacao RH

`npm run db:init` nao instala sozinho todos os stages RH recentes.

Depois do backup e com o codigo definitivo, executar os stages `63` a `79` em
ordem. Cada stage deve parar o procedimento se falhar.

```bash
for stage in $(seq 63 79); do
  node "src/utils/db-init-stage${stage}.js" || exit 1
done
```

Depois:

```bash
npm run db:schema-check
```

Nao iniciar o worker se o schema check falhar.

## Checklist de Pre-deploy Local

- [ ] todos os cortes aprovados individualmente;
- [ ] nenhum holder ou ledger de wallet entrou no diff;
- [ ] `npm run lint` passou;
- [ ] testes RH afetados passaram;
- [ ] `npm run db:schema-check` passou;
- [ ] build frontend passou se aplicavel;
- [ ] diff completo foi revisado;
- [ ] commits separados por escopo;
- [ ] nenhuma credencial foi adicionada ao Git;
- [ ] rollback de cada migration foi documentado;
- [ ] branch/commit exato do deploy foi registrado.

## Sequencia de Deploy na VPS

1. Registrar commit atualmente implantado.
2. Confirmar que os servicos web e Solana estao saudaveis.
3. Fazer backup do banco e validar o arquivo produzido.
4. Atualizar o codigo pelo fluxo Git adotado na VPS.
5. Instalar dependencias com lockfile:

   ```bash
   npm ci --omit=dev
   ```

6. Executar migrations/stages aprovados em ordem.
7. Rodar `npm run db:schema-check`.
8. Criar `/etc/volume-bot-alert/robinhood.env` com permissao `0600`.
9. Instalar e preencher a unit `volume-bot-alert-worker-robinhood.service`.
10. Rodar `systemd-analyze verify` e corrigir todos os problemas.
11. Executar `systemctl daemon-reload`.
12. Nao reiniciar os servicos Solana se seus arquivos nao mudaram.
13. Iniciar somente entao o novo worker RH.
14. Nao adicionar a porta `3004` ao Nginx.
15. Confirmar no firewall que `3004` nao esta acessivel externamente.
16. Acompanhar logs, cursores, banco e espaco em disco.

Os comandos finais de ativacao sao:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now volume-bot-alert-worker-robinhood.service
```

Nao usar `restart` nas units web/core/market/maintenance apenas para instalar o
worker RH. Validar que continuaram ativas e com o mesmo PID quando nenhuma
configuracao delas foi alterada.

## Validacao Imediata na VPS

### systemd

```bash
systemctl status volume-bot-alert-worker-robinhood.service
journalctl -u volume-bot-alert-worker-robinhood.service -n 100 --no-pager
systemctl show volume-bot-alert-worker-robinhood.service \
  --property=User,Group,WorkingDirectory,ExecStart,EnvironmentFiles,MainPID,NRestarts
```

Confirmar nos logs:

- runtime sem socket;
- grupo ativo `robinhood`;
- chain ID esperado `4663`;
- lease de ingestao adquirida;
- ausencia de publicacao de alertas;
- ausencia de falha fatal de configuracao.

### Health local

```bash
curl -fsS http://127.0.0.1:3004/api/health
```

O health local nao autoriza exposicao da porta.

Confirmar o bind e a ausencia no proxy/firewall publico:

```bash
ss -ltnp | grep ':3004'
sudo nginx -T | grep -n '3004'
```

O primeiro comando deve mostrar somente o processo esperado. O segundo deve
terminar sem configuracao encaminhando trafego publico para `3004`.

### Cursores

```sql
SELECT stream, next_block, safe_head, checkpoint_block, updated_at
FROM robinhood_ingestion_cursors
WHERE chain = 'robinhood'
ORDER BY stream;
```

Os cursores `discovery` e `market` devem avancar. O cursor de mercado pode ficar
atras do discovery, mas nao deve ultrapassar a cobertura descoberta.

### Dados

```sql
SELECT COUNT(*) AS pools FROM robinhood_pool_registry;
SELECT COUNT(*) AS processed_logs FROM robinhood_processed_logs;
SELECT COUNT(*) AS observations FROM robinhood_market_observations;
SELECT COUNT(*) AS minute_buckets FROM robinhood_market_buckets_1m;
SELECT COUNT(*) AS hourly_markets FROM robinhood_market_buckets_1h;
SELECT granularity_minutes, COUNT(*)
FROM robinhood_market_buckets_agg
GROUP BY granularity_minutes
ORDER BY granularity_minutes;
```

## Monitoramento Durante o Catch-up

No inicio, verificar pelo menos diariamente:

- bloco atual da chain;
- `next_block` de discovery e market;
- lag de cada stream;
- quantidade de 429, timeout e range shrink;
- erros consecutivos do worker;
- tamanho das tabelas RH;
- espaco livre em disco;
- continuidade integral dos buckets de 1 minuto;
- cobertura de 5m/15m/30m/1h/4h/1d;
- uso de CPU, memoria e conexoes PostgreSQL;
- impacto nos workers Solana.

Consulta de tamanho:

```sql
SELECT relname,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_catalog.pg_statio_user_tables
WHERE relname LIKE 'robinhood_%'
ORDER BY pg_total_relation_size(relid) DESC;
```

Rate limit isolado nao e motivo para resetar cursores. O worker deve reduzir o
range, aguardar e continuar.

## Criterios de Go/No-go

### Go

- schema check aprovado;
- web e Solana saudaveis;
- RH nao aparece para usuarios;
- porta `3004` inacessivel externamente;
- cursores avancando;
- retries sem perda de cursor;
- agregados sendo produzidos;
- historico de 1 minuto preservado integralmente;
- disco com margem operacional definida.

### No-go

- FDV historico usando supply atual sem procedencia;
- cotacao WETH atual aplicada silenciosamente ao passado;
- cursor avancando depois de falha de persistencia;
- gaps depois de retry/range shrink;
- historico de 1 minuto incompleto ou regressivo;
- RH acessivel por rota publica;
- alertas RH publicados;
- degradacao relevante dos workers Solana;
- crescimento de disco sem estabilizacao ou explicacao.

## Pausa e Rollback Operacional

Para interromper o impacto sem apagar dados:

1. parar `volume-bot-alert-worker-robinhood.service`;
2. manter web, Solana e maintenance ativos;
3. preservar cursores e tabelas RH;
4. diagnosticar antes de reiniciar;
5. retomar do cursor persistido depois da correcao.

Nao resetar cursores e nao apagar tabelas como primeira resposta a erro.

Se o codigo precisar de rollback:

1. parar o worker RH;
2. voltar ao commit anterior pelo fluxo Git normal;
3. confirmar compatibilidade do schema aditivo;
4. reiniciar web/worker existentes individualmente;
5. manter o worker RH parado ate nova validacao.

O rollback de codigo nao implica apagar o historico ja coletado.

## Troca Futura de Provedor

Quando o novo provider estiver disponivel:

1. parar o worker RH;
2. validar chain ID e capacidades do novo endpoint;
3. trocar apenas o arquivo de ambiente do servico RH;
4. manter os mesmos cursores;
5. iniciar o worker;
6. confirmar que ele retomou sem gap e sem duplicacao;
7. somente depois considerar habilitar leituras e visibilidade RH;
8. habilitacao de alertas deve ser uma decisao separada.

## Pontos Importantes

- O RPC publico fornece logs historicos, mas pode nao fornecer estado historico
  podado.
- Supply deve usar anchors e mint/burn; holder indexing continua fora do escopo.
- Pools criadas nao significam pools com liquidez ou atividade.
- Varias pools do mesmo token coexistem; nao existe regra de primeira pool para
  sempre.
- O mercado principal pode mudar conforme volume e atividade recentes.
- O replay pode levar bastante tempo sem representar falha.
- A prioridade e consistencia e retomada, nao velocidade maxima.
- Nenhum endpoint RH deve ser liberado como efeito colateral da ingestao.
- Nenhum dado intermediario deve ser apagado antes de sua representacao compacta
  estar comprovadamente persistida.
