# Jupiter refresh and alert integration plan

Documento de decisao para integrar Jupiter como fonte principal de preco/volume do bot sem perder o contexto debatido nos testes de QuickNode.

Data: 2026-07-04.

## Resumo executivo

Decisao atual:

- Jupiter vira o caminho principal para refresh de preco e volume de tokens conhecidos.
- QuickNode JSON-RPC/WebSocket deixa de ser caminho principal para alertas.
- QuickNode continua util para probes, validacao onchain, experimentos de trade stream e comparacao de custo.
- gRPC/Geyser so volta a ser prioridade se o objetivo virar tape/indexador estilo Axion.

Motivo:

- Jupiter retornou preco, volume, liquidez e metadata para tokens reais do banco com excelente cobertura.
- Tokens recem-criados/novos tambem retornaram preco e volume.
- 250 tokens consumiram apenas 8 requests por causa do batching.
- QuickNode sem gRPC funcionou, mas ficou caro/ruidoso para firehose com PumpSwap, Meteora e Raydium juntos.

## O que o produto precisa

O objetivo do bot nao e mostrar todos os trades onchain.

O objetivo e:

- manter tokens relevantes com preco fresco;
- detectar tokens mortos/revivendo;
- detectar surge por variacao de preco/mcap;
- usar volume/liquidez para filtrar ruido;
- alertar oportunidades com boa velocidade sem construir um indexador completo.

Logo, a arquitetura deve priorizar:

- refresh frequente por token;
- tiers de prioridade;
- calculo rolling em memoria;
- persistencia minima para recuperar restart;
- custo previsivel por request.

## APIs da Jupiter

### Price API

Uso:

- refresh de preco;
- `blockId` para medir recencia;
- `priceChange24h` como contexto, nao como regra principal.

Limites usados no probe:

- ate 50 mints por request.

Campos relevantes:

- `usdPrice`;
- `blockId`;
- `decimals`;
- `priceChange24h`.

Observacao:

- Price API nao entrega volume.
- Mint sem preco confiavel pode ser omitido.

### Tokens API

Uso:

- volume agregado;
- liquidez;
- mcap;
- verificacao/suspeita;
- metadata para contexto.

Limites usados no probe:

- ate 100 mints por request.

Campos relevantes:

- `stats5m.buyVolume`;
- `stats5m.sellVolume`;
- `stats1h.buyVolume`;
- `stats1h.sellVolume`;
- `stats6h`;
- `stats24h`;
- `liquidity`;
- `mcap`;
- `isVerified`;
- `audit.isSus`;
- `priceBlockId`;
- `updatedAt`;
- `firstPool`.

Observacao:

- menor janela pronta de volume vista ate agora e 5m;
- nao vimos `stats1m`;
- volume e indexado/agregado pela Jupiter, nao volume onchain bruto nosso.

### Quote/Metis

Uso futuro:

- fallback quando Price API omitir um token;
- validar token recem-migrado;
- confirmar rota/liquidez quando o dado estiver suspeito;
- evitar depender de QuickNode para todo caso novo.

Observacao:

- Quote tende a ser mais caro por token do que Price/Tokens em batch;
- usar somente para excecoes, nao para refresh geral.

## Resultados observados

### Smoke keyless com SOL/USDC

Resultado:

- `requested=2`;
- `priced=2`;
- `tokenInfoFound=2`;
- `withVolume5m=2`;
- `withVolume1h=2`;
- Price latency total: `466ms`;
- Tokens latency total: `218ms`.

### Probe com 250 tokens reais e API key

Resultado:

- `requested=250`;
- `priced=250`;
- `missingPrice=0`;
- `tokenInfoFound=250`;
- `missingTokenInfo=0`;
- `withVolume5m=194`;
- `withVolume1h=240`;
- Price latency total: `1870ms`;
- Tokens latency total: `1720ms`.

Uso medido:

```text
Price API:
  requests=5
  bytes=59,585
  rateLimitCurrent=5
  rateLimitRemaining=5

Tokens API:
  requests=3
  bytes=609,849
  rateLimitCurrent=8
  rateLimitRemaining=2

Total:
  requests=8
  bytes=669,434
```

Leitura:

- 250 tokens custaram 8 requests;
- cobertura de preco foi completa;
- cobertura de volume 1h foi alta;
- volume 5m menor e esperado para tokens frios;
- alguns tokens podem ter `blockId` antigo e precisam de regra de stale.

### Probe com 2 tokens novos

Tokens:

```text
93MNH6G8VH5bZrTykvJK9efhYfAT6WFTpxmsJo1rpump
CTrw3WQQQUm3QByuko7MDpJok7Lkwbs2i4aGtaMepump
```

Resultado:

- `requested=2`;
- `priced=2`;
- `missingPrice=0`;
- `tokenInfoFound=2`;
- `missingTokenInfo=0`;
- `withVolume5m=2`;
- `withVolume1h=2`;
- `totalRequests=2`;
- Price latency: `417ms`;
- Tokens latency: `264ms`.

Leitura:

- Jupiter retornou preco, volume 5m/1h e liquidez para tokens novos nao verificados;
- isso reduz muito a necessidade de firehose onchain para detectar tokens recem-vivos.

## Estimativa de consumo

Com refresh completo Price + Tokens no mesmo ciclo:

```text
250 tokens  = 5 Price requests + 3 Tokens requests = 8 requests
500 tokens  = 10 Price requests + 5 Tokens requests = 15 requests
1000 tokens = 20 Price requests + 10 Tokens requests = 30 requests
```

Se rodar refresh completo a cada 1s:

```text
250 tokens  ~= 20.7M requests/mes
500 tokens  ~= 38.9M requests/mes
1000 tokens ~= 77.8M requests/mes
1500 tokens ~= 116.6M requests/mes
```

Mas essa nao deve ser a arquitetura final, porque volume nao precisa atualizar a cada 1s.

Modelo recomendado:

```text
HOT:
  Price API a cada 1s
  Tokens API a cada 5s-10s

WARM:
  Price API a cada 5s-15s
  Tokens API a cada 30s-60s

COLD:
  Price API + Tokens API a cada 1min-5min
```

Exemplo de consumo mais realista para 1000 HOT tokens:

```text
Price 1s:
  1000 / 50 = 20 req/s

Tokens 10s:
  1000 / 100 = 10 requests a cada 10s = 1 req/s

Total:
  21 req/s
  ~54.4M requests/mes
```

## Tiers de monitoramento

### HOT

Entram aqui:

- tokens em watchlist/alertas ativos;
- tokens perto de threshold;
- tokens com fast surge;
- tokens recem-revividos;
- tokens com volume/liquidez recentes relevantes.

Frequencia:

- Price: 1s;
- Tokens/volume: 5s-10s.

Saida esperada:

- calculo realtime de surge;
- mcap/price change curto;
- alertas rapidos.

### WARM

Entram aqui:

- tokens vistos recentemente;
- tokens com algum volume, mas nao perto de alerta;
- tokens que sairam de HOT recentemente.

Frequencia:

- Price: 5s-15s;
- Tokens/volume: 30s-60s.

### COLD

Entram aqui:

- tokens mortos/historicos;
- tokens antigos do banco;
- candidatos que queremos observar sem custo alto.

Frequencia:

- Price + Tokens: 1min-5min.

Promocao:

- se voltou preco fresco;
- se `volume5m`/`volume1h` passou minimo;
- se mcap subiu forte;
- se liquidez ficou suficiente.

## Regras de alerta

### Surge 1h

Regra base:

```text
priceChange1h = ((currentPrice / baselinePrice1h) - 1) * 100
mcapChange1h  = ((currentMcap / baselineMcap1h) - 1) * 100
```

O alerta nao deve depender de gravar apenas bucket de 5m.

Fluxo:

- coletar HOT a cada 1s;
- calcular em memoria a cada ciclo;
- comparar com baseline de aproximadamente 1h atras;
- publicar quando cruzar threshold e gates.

Gates sugeridos:

```text
currentMcap >= 50k
volume1h >= 10k
liquidity >= 5k
priceChange1h >= 40%
```

### Surge 6h

Necessario para paridade com a regra atual da Dex.

Regra base:

```text
priceChange6h = ((currentPrice / baselinePrice6h) - 1) * 100
mcapChange6h  = ((currentMcap / baselineMcap6h) - 1) * 100
```

Fluxo:

- usar preco atual do ciclo HOT/WARM;
- comparar com baseline de aproximadamente 6h atras;
- usar `stats6h` da Tokens API como volume de janela;
- publicar como alerta de movimento sustentado, nao como alerta imediato.

Gates sugeridos:

```text
currentMcap >= 50k
volume6h >= 25k
liquidity >= 5k
priceChange6h >= 100%
```

Observacao:

- o baseline de 6h nao precisa de ponto a cada 1s;
- checkpoints de 1m/5m sao suficientes para essa janela;
- o alerta 6h complementa `surge1h`, `fast surge` e `revival`.

### Fast surge

Necessario porque token novo/revivendo pode nao ter baseline de 1h.

Exemplo:

```text
12:00 mcap = 100k
12:05 mcap = 200k
change5m = +100%
```

Regra sugerida:

```text
currentMcap >= 50k
liquidity >= 5k
volume5m >= 5k
mcapChange5m >= 50%
```

### Revival

Objetivo:

- detectar token morto/frio voltando a vida.

Regra sugerida:

```text
baselineMcap <= 30k OR volume1h anterior ~= 0
currentMcap >= 60k
volume5m >= 3k
mcapChange5m >= 80%
liquidity >= 5k
```

Observacao:

- estes valores sao ponto de partida, nao regra final;
- precisam de dry-run contra dados reais antes de publish.

## Memoria e persistencia

Nao precisamos persistir todo preco cru a cada 1s para sempre.

Precisamos:

- calcular rapido em memoria;
- sobreviver a restart sem perder completamente o baseline;
- manter historico suficiente para 1h, 6h e janelas curtas.

Modelo recomendado:

```text
Memoria HOT:
  ultimos 10min em pontos densos de 1s ou 5s/10s dependendo do volume

Memoria WARM:
  de 10min ate 2h em pontos de 15s-30s

Memoria LONG:
  de 2h ate 7h em pontos de 1m-5m

Persistencia:
  checkpoint a cada 10s-15s para HOT
  checkpoint a cada 30s-60s para WARM
  checkpoints de 1m-5m para baseline 6h e historico
```

Importante:

- bucket de 5m e grosso demais para decidir alerta realtime;
- 5m serve para historico antigo e baseline 6h, nao para calcular o gatilho imediato;
- o alerta precisa usar o preco atual e baseline em memoria.

## Volume 1m

Status:

- Jupiter Tokens API trouxe `stats5m`, `stats1h`, `stats6h`, `stats24h`;
- nao vimos `stats1m`.

Decisao:

- usar `volume5m` como menor volume confiavel pronto;
- nao tentar volume1m exato agora;
- usar price/mcap change curto para reatividade de 1m/5m.

Motivo:

- volume1m exato exige trade stream/indexador;
- isso volta ao problema caro de QuickNode/gRPC;
- `volume5m` ja corta grande parte do ruido.

## Papel do QuickNode daqui pra frente

QuickNode nao deve ser fonte primaria de preco/volume para alertas neste momento.

Usos validos:

- gastar creditos restantes para medir eficiencia do JSON-RPC sem gRPC;
- comparar amostras Jupiter vs onchain;
- validar tokens suspeitos;
- buscar transacoes pontuais;
- estudar volume1m real;
- preparar caso futuro de gRPC/indexador.

Nao usar QuickNode agora para:

- tentar firehose completo em producao;
- substituir Jupiter no refresh por token;
- publicar alertas reais antes de provar custo/qualidade.

## Plano de implementacao

### Bloco 1 - Cliente Jupiter

Criar servico puro para:

- Price API batch;
- Tokens API batch;
- headers/usage;
- normalizacao de preco, mcap, liquidez, volume e flags.

Sem schema novo ainda.

### Bloco 2 - Tracker em memoria

Criar tracker para:

- snapshots por token;
- janelas 5m/15m/1h/6h;
- baseline mais proximo;
- stale `blockId`;
- dedupe/controle de cooldown.

### Bloco 3 - Dry-run de tiers

Rodar sem publicar alerta:

- HOT 1s;
- Tokens API a cada 10s;
- WARM/COLD simulado;
- relatorio de consumo projetado.

### Bloco 4 - Regras de alerta em dry-run

Gerar apenas logs:

- surge1h;
- surge6h;
- fast surge;
- revival;
- motivo de skip;
- mcap/volume/liquidity gates.

### Bloco 5 - Persistencia minima

So depois do dry-run:

- tabela/buckets de checkpoints;
- recuperacao de baseline apos restart;
- schema check obrigatorio.

### Bloco 6 - Integracao com alertas reais

Somente depois:

- ligar no matcher/publicador;
- cooldown;
- UI/explicacao do trigger;
- metricas de falso positivo.

## Pontos importantes

- Jupiter e o caminho principal agora, mas nao substitui firehose se o produto virar tape completo.
- Price API nao tem volume; volume vem da Tokens API.
- O menor volume pronto visto foi 5m, nao 1m.
- Surge 6h precisa ser mantido para paridade com a Dex.
- Volume 6h deve vir de `stats6h` da Tokens API.
- Para alerta rapido, usar price/mcap change curto, nao volume1m.
- Coletar HOT a cada 1s nao significa persistir tudo cru a cada 1s.
- Bucket de 5m para baseline de alerta causaria delay/distorcao; nao usar assim.
- Baseline 6h aceita buckets maiores, desde que o preco atual venha do ciclo fresco.
- QuickNode restante deve ser usado como laboratorio, nao como base de producao.
- Todo alerta real precisa passar por dry-run com motivo de trigger e motivo de skip.
