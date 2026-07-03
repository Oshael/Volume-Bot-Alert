# Chart alert markers plan

## Status

Planejamento aprovado em 2026-07-03. Nenhuma parte da feature descrita neste documento foi implementada ainda.

Este documento e a fonte de verdade para retomar a implementacao sem depender do contexto da conversa original.

## Objetivo

Mostrar no chart expandido os alertas configuraveis disparados para o usuario autenticado nas ultimas 24 horas.

Cada marker deve representar o momento e o market cap registrados quando o alerta foi disparado:

- eixo X: `triggeredAt` do evento
- eixo Y: `mcap` persistido no payload do evento

O marker deve aparecer em tempo real quando o chart estiver aberto. Ao abrir o chart posteriormente, a UI deve carregar do backend os eventos das ultimas 24 horas.

## Decisoes confirmadas

- O historico do chart e individual por usuario.
- Somente alertas configuraveis pelo usuario entram no chart.
- `Clean All` limpa apenas o painel de alertas e nao remove markers do chart.
- Markers permanecem visiveis por exatamente 24 horas a partir de `triggeredAt`.
- Eventos antigos nao serao apagados fisicamente do banco.
- A janela de 24 horas e uma regra de consulta e exibicao.
- O marker usa timestamp e market cap do disparo, sem se limitar ao centro do candle.
- Hover mostra um resumo.
- Clique fixa o tooltip com detalhes.
- Markers visualmente sobrepostos devem ser agrupados com `+N`.
- Codigos iniciais: `V`, `$`, `H`, `S` e `L`.

## Fora de escopo

- Apagar `user_alert_events` do banco.
- Alterar cooldown, rearm, fingerprint ou deduplicacao dos alertas.
- Fazer `Clean All` apagar historico do chart.
- Mostrar alertas globais de Pump/Bags.
- Mostrar alertas administrativos de token review.
- Redirecionar o usuario para uma pagina externa ao clicar no marker.
- Transformar o chart em um historico permanente ou ferramenta de auditoria.
- Adicionar resolucao inferior a 5 minutos.

## Estado real do codigo

### Persistencia

- Eventos configuraveis por usuario sao persistidos em `user_alert_events`.
- A tabela contem `user_id`, `rule_key`, `kind`, `token_address`, `payload`, `triggered_at` e `created_at`.
- O payload criado por `src/services/user-alert-matcher.js` inclui `mcap` por meio de `buildSharedPayload()`.
- O estado de cooldown e rearm fica em `user_alert_rule_state`, separado do historico de eventos.
- Cursores de entrega ficam em `alert_delivery_cursors`, tambem separados dos eventos.
- Existe indice adequado para a consulta por usuario, token e horario:
  - `idx_user_alert_events_user_token_triggered`
  - `(user_id, token_address, triggered_at DESC, id DESC)`

Nao e necessaria alteracao de schema para esta feature.

### Feed e tempo real

- `backend-alert-publisher` publica o evento depois do commit da transacao.
- `socket-hub` envia `alert:event` para a room do usuario correspondente.
- O frontend recebe o payload em `AppController.connectRealtime().onAlertEvent`.
- O payload realtime ja possui `triggeredAt`, `mcap`, `kind`, `ruleKey` e metricas do alerta.

### Lista de alertas atual

- O painel usa `state.data.alerts`.
- A lista local e limitada a 120 entradas.
- A lista e persistida em `localStorage` por `frontend/src/utils/bar-storage.ts`.
- `Clean All` remove entradas dessa lista local.

O chart nao deve reutilizar `state.data.alerts` como fonte historica. Isso faria `Clean All`, o limite de 120 e o ciclo do `localStorage` alterarem os markers.

### Chart expandido

- O chart fica em `frontend/src/ui/sections/layout-sections.ts`.
- Ele usa Lightweight Charts 5.2 com `CandlestickSeries`.
- Candles sao atualizados em tempo real por `trendscope:expanded-chart-live-candle`.
- O viewport do chart ja e preservado entre rerenders e troca de granularidade.
- O chart possui resolucoes de 5m ou superiores.
- A API nativa de series markers prende markers aos pontos existentes da serie.

Como o requisito e posicionar dentro do intervalo usando timestamp e MCAP, a implementacao deve usar um overlay customizado sincronizado com as escalas, nao `createSeriesMarkers()`.

## Alertas incluidos

Usar uma allowlist explicita de `ruleKey`:

- `monitored-vol`
- `monitored-mcap`
- `hvnc`
- `recent-surge-1h`
- `recent-surge-6h`
- `old-week-surge-1h`
- `old-week-surge-6h`
- `meteora-surge`

## Alertas excluidos

- `gmgn-claim-signal`: evento global, nao configurado individualmente pelo usuario.
- `admin-token-review`: evento administrativo, fora de `user_alert_events`.
- `gmgn-vol-1m`: evento user-scoped, mas seu threshold e habilitacao sao globais por ambiente; nao e configuravel pelo usuario na UI atual.
- Qualquer futura regra deve ser excluida por padrao ate ser adicionada explicitamente a allowlist.

## Retencao de 24 horas

Definicao:

```text
visible = triggeredAt >= serverNow - 24h
```

Regras:

- O backend aplica o cutoff usando o relogio do servidor.
- O frontend aplica novamente o cutoff para remover markers enquanto o chart permanece aberto.
- O frontend deve usar `generatedAt` retornado pelo servidor para reduzir efeito de diferenca entre relogios.
- Um timer agenda a proxima expiracao; nao e necessario polling frequente.
- Eventos continuam no banco depois de expirar visualmente.
- Reabrir o chart nao pode restaurar um evento ja expirado.

## Contrato backend proposto

Endpoint autenticado:

```http
GET /api/dashboard/chart-alert-events?address=<TOKEN_ADDRESS>
```

O endpoint sempre usa o usuario autenticado. Nao deve aceitar `userId` do cliente.

Resposta proposta:

```json
{
  "generatedAt": "2026-07-03T06:00:00.000Z",
  "windowHours": 24,
  "address": "TOKEN_ADDRESS",
  "count": 2,
  "truncated": false,
  "events": [
    {
      "id": 123,
      "ruleKey": "monitored-vol",
      "kind": "monitored-vol",
      "address": "TOKEN_ADDRESS",
      "triggeredAt": "2026-07-03T05:47:42.000Z",
      "mcap": 100000,
      "pct": 82.4,
      "label": "VOL",
      "prevVolume5m": 12000,
      "volume5m": 21888
    }
  ]
}
```

Regras do endpoint:

- validar o token address com o validador existente
- consultar somente `user_alert_events`
- filtrar pelo `user_id` autenticado
- filtrar pelo token solicitado
- filtrar `triggered_at >= NOW() - INTERVAL '24 hours'`
- filtrar pela allowlist de `rule_key`
- ordenar por `triggered_at ASC, id ASC`
- aplicar limite defensivo de 500 eventos por token
- retornar `truncated: true` se houver mais de 500
- nao ler nem atualizar cursores de entrega
- nao marcar eventos como vistos
- nao carregar metadata atual do catalogo para substituir o snapshot historico

O endpoint do chart e leitura historica. Ele nao deve reutilizar a semantica de `mode=unseen` do feed normal.

## Modelo frontend proposto

Criar tipo isolado, por exemplo:

```ts
export interface ChartAlertEvent {
  id: number;
  ruleKey: string;
  kind: string;
  address: string;
  triggeredAt: string;
  mcap: number | null;
  pct: number | null;
  label: string | null;
  prevVolume5m?: number | null;
  volume5m?: number | null;
  prevMcap?: number | null;
  meteoraCurrentTvl?: number | null;
  meteoraBaselineTvl24h?: number | null;
  surgeWindow?: "1H" | "6H" | null;
}
```

Nao adicionar esses eventos diretamente a `state.data.alerts`.

Preferencia arquitetural:

- criar um modulo de historico do chart com cache por usuario e address
- manter TTL curto apenas para evitar refetch ao fechar e reabrir imediatamente
- fazer upsert por `ruleKey + id`
- limpar o cache quando a sessao ou usuario mudar
- podar eventos expirados antes de entregar ao renderer

## Fluxo inicial

1. Usuario abre o chart expandido de um token.
2. Candles existentes sao montados normalmente.
3. Frontend chama o endpoint de chart alerts em paralelo.
4. Eventos retornados sao normalizados, deduplicados e filtrados.
5. O overlay cria os markers.
6. O timer da proxima expiracao e agendado.
7. Falha no endpoint nao impede o chart de abrir.

## Fluxo realtime

1. `user-alert-matcher` persiste o evento e o estado da regra na mesma transacao.
2. Depois do commit, `backend-alert-publisher` envia o evento pelo socket.
3. O controller continua atualizando o painel de alertas como hoje.
4. Em paralelo, publica um evento interno dedicado ao chart.
5. Se o address do evento for o chart aberto e a regra estiver na allowlist, o cache faz upsert.
6. O overlay insere o marker imediatamente, sem esperar o candle fechar.
7. Eventos duplicados recebidos pelo fetch e socket sao consolidados pelo ID.

Evento interno sugerido:

```text
trendscope:expanded-chart-alert
```

O evento deve carregar o snapshot historico recebido pelo socket. Nao deve consultar metadata atual para recalcular o MCAP do disparo.

## Posicionamento exato

### Coordenada X

Para um alerta `03:47:42` em resolucao de 5 minutos:

```text
bucketStart = 03:45:00
bucketDuration = 300 segundos
fraction = (03:47:42 - 03:45:00) / 300
fraction = 0.54
logicalPosition = candleLogicalIndex + 0.54
x = timeScale.logicalToCoordinate(logicalPosition)
```

Procedimento:

1. Converter `triggeredAt` para timestamp UTC em segundos.
2. Resolver o bucket correspondente usando a granularidade ativa.
3. Localizar o indice logico do candle daquele bucket.
4. Calcular a fracao temporal dentro do bucket.
5. Converter a posicao logica fracionaria em coordenada X.

Se o bucket exato estiver ausente:

- interpolar entre candles anterior e posterior quando ambos existirem
- nao inventar posicao fora do range quando nao houver referencia suficiente
- registrar o evento como nao projetavel para diagnostico

### Coordenada Y

```text
y = candleSeries.priceToCoordinate(event.mcap)
```

Regras:

- usar exclusivamente o `mcap` persistido no evento
- nao substituir por market cap atual do token
- ocultar o marker quando a coordenada estiver fora da area visivel
- se `mcap` for ausente ou invalido, usar fallback acima do candle correspondente
- o tooltip deve indicar `MCAP do disparo indisponivel` no fallback

## Sincronizacao com o chart

O overlay deve recalcular posicoes em `requestAnimationFrame`, consolidando varias causas no mesmo frame.

Disparadores:

- primeira carga dos eventos
- novo alerta realtime
- expiracao de evento
- `timeScale.subscribeVisibleLogicalRangeChange`
- `timeScale.subscribeSizeChange`
- `ResizeObserver` do container
- wheel sobre o chart ou escala de preco
- pointer move durante drag das escalas
- pointer up depois de drag
- atualizacao do candle live
- troca de granularidade
- restauracao do viewport

Cleanup obrigatorio:

- remover listeners DOM
- cancelar animation frame pendente
- cancelar timer de expiracao
- remover listeners internos de chart alerts
- remover overlay e tooltip
- limpar estado de hover/pin do chart fechado

## Representacao visual

Mapeamento inicial:

| Codigo | Regra | Cor sugerida |
| --- | --- | --- |
| `V` | volume | azul |
| `$` | market cap | verde |
| `H` | HVNC | amarelo |
| `S` | price surge | laranja |
| `L` | Meteora/liquidez | roxo |

Regras visuais:

- marker pequeno e legivel em fundo escuro
- codigo e cor devem identificar juntos; nao depender apenas de cor
- area clicavel maior que o desenho visual
- marker nao cria linha horizontal permanente
- marker nao altera auto-scale do chart
- marker fica acima do canvas por overlay absoluto
- markers fora do viewport nao ficam no DOM interativo

## Colisao e agrupamento

Markers mantem suas coordenadas exatas enquanto nao colidem visualmente.

Depois da projecao:

1. ordenar por X, Y e prioridade
2. detectar markers cujas hit areas se sobrepoem
3. formar cluster apenas para os markers sobrepostos
4. usar o marker de maior prioridade como representante
5. mostrar `+N` ao lado do codigo
6. listar todos os eventos no tooltip

Prioridade inicial:

```text
H > S > L > $ > V
```

O agrupamento e recalculado depois de zoom, resize ou mudanca de escala. Ao aumentar o zoom, markers antes agrupados podem se separar novamente.

## Tooltip

### Hover

Mostrar resumo compacto:

- nome do alerta
- horario exato local
- MCAP no disparo
- percentual ou metrica principal
- `N alertas` quando for cluster

### Clique

- fixa o tooltip
- lista todos os eventos do cluster
- mostra metricas especificas por regra
- nao navega para pagina externa
- clique fora ou `Esc` fecha
- novo clique em outro marker troca o pin

Conteudo por regra:

- volume: volume anterior, volume atual e variacao
- market cap: MCAP anterior, MCAP atual e variacao
- HVNC: volume 24h e MCAP
- surge: janela 1h/6h, price change e threshold
- Meteora: TVL anterior, TVL atual e variacao

## Acessibilidade

- marker interativo deve ser `button`
- incluir `aria-label` descritivo
- permitir foco por teclado
- `Enter` ou `Space` fixa o tooltip
- `Esc` fecha
- tooltip fixado usa semantica que permita leitura por screen reader
- cor nunca e o unico identificador

## Tratamento de falhas

- Falha ao buscar historico nao bloqueia candles.
- Payload invalido e descartado individualmente.
- Timestamp invalido nao gera marker.
- MCAP invalido usa fallback explicitamente identificado.
- Evento de regra fora da allowlist e ignorado.
- Evento de outro token nao atualiza o chart aberto.
- Evento expirado recebido por race nao e exibido.
- Resposta truncada gera log de diagnostico e indicacao discreta no tooltip/legend, sem travar a UI.

## Blocos de implementacao

Estimativa total: 850 a 1.150 linhas adicionadas, incluindo testes e CSS.

Cada bloco deve permanecer proximo ou abaixo de 300 linhas e gerar commit separado por escopo.

### Bloco 1 - consulta backend

Estimativa: 200 a 280 linhas.

- ampliar `user-alert-event` com filtro temporal
- criar consulta por usuario e token
- aplicar allowlist
- mapear snapshot sem metadata atual
- testar usuario, token, cutoff, ordenacao e limite

Validacao:

```bash
node --test tests/user-alert-event.test.js tests/backend-alert-feed.test.js
```

Commit sugerido:

```text
feat(alerts): add user chart alert history query
```

### Bloco 2 - endpoint e cliente

Estimativa: 180 a 260 linhas.

- criar rota autenticada
- validar address
- criar tipos e client frontend
- testar auth, isolamento e contrato

Validacao:

```bash
node --test tests/dashboard.test.js tests/backend-alert-feed.test.js
npm run lint
npm --prefix frontend run build
```

Commit sugerido:

```text
feat(api): expose chart alert history
```

### Bloco 3 - cache e realtime

Estimativa: 180 a 260 linhas.

- modulo de cache por usuario/address
- fetch ao montar chart
- dedupe fetch/socket
- evento interno realtime
- timer de expiracao
- independencia de `Clean All`

Validacao:

- testes unitarios de normalizacao, dedupe e expiracao
- `npm run lint`
- `npm --prefix frontend run build`

Commit sugerido:

```text
feat(frontend): sync chart alert history
```

### Bloco 4 - projecao e agrupamento

Estimativa: 220 a 300 linhas.

- modulo puro de calculo X/Y
- fallback para gaps e MCAP ausente
- codigos e prioridades
- colisao e clusters
- testes tabelados

Validacao:

```bash
node --test tests/chart-alert-markers.test.js
npm run lint
npm --prefix frontend run build
```

Commit sugerido:

```text
feat(chart): project alert marker coordinates
```

### Bloco 5 - renderer

Estimativa: 180 a 280 linhas.

- overlay isolado
- marker DOM
- listeners de escala e viewport
- integracao com candle live
- lifecycle e cleanup

Validacao:

- `npm run lint`
- `npm --prefix frontend run build`
- teste manual em 5m, 15m, 1h e 4h

Commit sugerido:

```text
feat(chart): render realtime alert markers
```

### Bloco 6 - tooltip e acabamento

Estimativa: 180 a 280 linhas.

- hover
- pin por clique
- cluster `+N`
- conteudo por regra
- teclado e acessibilidade
- estilos responsivos

Validacao:

- testes afetados
- `npm run lint`
- `npm --prefix frontend run build`
- `npm run test:smoke` quando existir fluxo Playwright aplicavel
- revisao de `git diff`

Commit sugerido:

```text
feat(chart): add alert marker details
```

## Estrutura de arquivos sugerida

Arquivos existentes que provavelmente mudam:

- `src/models/user-alert-event.js`
- `src/services/backend-alert-feed.js`
- `src/routes/dashboard.js`
- `frontend/src/services/api/catalog.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/styles/app.css`
- `tests/user-alert-event.test.js`
- `tests/backend-alert-feed.test.js`
- `tests/dashboard.test.js`

Novos arquivos sugeridos:

- `frontend/src/services/charts/chart-alert-history.ts`
- `frontend/src/services/charts/chart-alert-markers.ts`
- `tests/chart-alert-history.test.js`
- `tests/chart-alert-markers.test.js`

Evitar concentrar toda a feature em `layout-sections.ts` ou `app-controller.ts`. Ambos ja sao arquivos centrais; logica de historico, projecao e renderer deve permanecer em modulos isolados.

## Estrategia de testes

### Unitarios

- cutoff exatamente em 24h
- evento 1ms antes/depois do cutoff
- isolamento por usuario
- isolamento por token
- allowlist de regras
- ordenacao por timestamp e ID
- normalizacao de MCAP e timestamp
- dedupe entre fetch e socket
- expiracao sem polling constante
- projecao em 5m, 15m, 1h e 4h
- posicao fracionaria dentro do bucket
- gap entre candles
- marker fora do viewport
- cluster e desagrupamento depois de zoom
- prioridade do representante

### Integracao

- rota exige autenticacao
- usuario nao consulta evento de outro usuario
- endpoint nao altera delivery cursor
- `Clean All` nao altera resposta do endpoint
- socket e fetch representam o mesmo evento sem duplicacao

### Visual/manual

- marker aparece sem esperar candle fechar
- marker permanece cravado durante zoom temporal
- marker permanece cravado durante escala vertical
- marker acompanha resize
- troca de granularidade recalcula a posicao
- hover nao move o chart
- clique fixa tooltip
- `Esc` fecha tooltip
- cluster separa quando houver espaco
- marker some ao completar 24h

## Criterios de aceite

1. Abrir um token com alerta das ultimas 24h mostra o marker correto.
2. O marker usa o timestamp e MCAP persistidos no evento.
3. Um alerta novo aparece no chart aberto sem esperar o candle fechar.
4. Zoom, scroll, resize e troca de granularidade nao deslocam o marker da coordenada correspondente.
5. Hover mostra resumo e clique fixa detalhes.
6. Markers sobrepostos formam cluster `+N`.
7. `Clean All` nao remove markers.
8. Eventos de outro usuario nunca aparecem.
9. Pump/Bags, admin review e GMGN 1m nao aparecem.
10. O marker some ao completar 24h, mesmo com o chart aberto.
11. Falha no historico nao impede o chart de carregar.
12. Nenhuma mudanca e feita em cooldown, rearm ou deduplicacao.

## Pontos importantes

- A fonte historica e o banco, nao o painel local.
- A janela de 24h e visual; o banco continua retendo os eventos.
- `Clean All` e deliberadamente independente do chart.
- O timestamp do servidor evita depender do relogio do navegador.
- O MCAP representa o snapshot de avaliacao do bot, nao um tick de exchange no mesmo milissegundo.
- Eventos antigos sem MCAP nao podem ter coordenada Y exata.
- O endpoint nao deve atualizar cursores nem consumir eventos unseen.
- O renderer deve ser isolado para nao aumentar ainda mais os arquivos centrais.
- A implementacao deve parar ao fim de cada bloco para validar testes, lint, build e diff antes do proximo commit.
