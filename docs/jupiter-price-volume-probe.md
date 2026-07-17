# Jupiter price and volume probe

Documento operacional para testar Jupiter como fonte de preco e volume antes de qualquer integracao permanente.

## Objetivo

Validar se a Jupiter consegue cobrir o caso principal do bot:

- atualizar preco de tokens conhecidos com frequencia;
- obter volume agregado 5m/1h/6h/24h;
- detectar tokens sem preco, sem volume ou marcados como suspeitos;
- medir latencia e cobertura usando mints reais do nosso banco.

Isso nao substitui firehose onchain. O objetivo e decidir se Jupiter pode virar a camada principal de refresh para HOT/WARM/COLD tokens.

Plano de integracao relacionado:

- `docs/jupiter-refresh-alert-integration-plan.md`

## APIs testadas

### Price API

Endpoint:

```text
GET https://api.jup.ag/price/v3?ids=<mint1,mint2,...>
```

Uso:

- ate 50 mints por request;
- retorna `usdPrice`, `blockId`, `decimals`, `priceChange24h`;
- omite o mint quando nao ha preco confiavel.

### Tokens API

Endpoint:

```text
GET https://api.jup.ag/tokens/v2/search?query=<mint1,mint2,...>
```

Uso:

- ate 100 mints por request;
- retorna metadata, verificacao, organic score, liquidez, mcap e stats;
- stats incluem `buyVolume` e `sellVolume` em 5m, 1h, 6h e 24h.

## Script

```bash
npm run jupiter:probe
```

Variaveis:

```text
JUPITER_API_KEY              opcional; usa keyless se vazio
JUPITER_PROBE_ADDRESSES      lista de mints separados por virgula
JUPITER_PROBE_LIMIT          default 50, usado quando busca mints do banco
JUPITER_PROBE_DELAY_MS       default 2200ms sem key, 1100ms com key
```

Sem `JUPITER_PROBE_ADDRESSES`, o script tenta puxar tokens do banco:

1. `token_catalog`;
2. `user_tokens`;
3. erro se nao encontrar mints.

## Smoke keyless validado em 2026-07-04

Comando:

```bash
JUPITER_PROBE_ADDRESSES='So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' \
JUPITER_PROBE_DELAY_MS=2500 \
npm run jupiter:probe
```

Resultado:

- `requested=2`;
- `priced=2`;
- `tokenInfoFound=2`;
- `withVolume5m=2`;
- `withVolume1h=2`;
- Price latency total: `466ms`;
- Tokens latency total: `218ms`;
- SOL e USDC retornaram preco, `blockId`, liquidez, volume 5m e volume 1h.

## Como interpretar

Campos principais:

- `priced`: quantos mints voltaram na Price API;
- `missingPrice`: quantos foram omitidos por falta de preco confiavel;
- `tokenInfoFound`: quantos voltaram na Tokens API;
- `withVolume5m`: quantos tem volume 5m maior que zero;
- `withVolume1h`: quantos tem volume 1h maior que zero;
- `usage.totalRequests`: requests HTTP feitos pelo probe;
- `usage.totalBytes`: bytes de resposta baixados;
- `usage.price` e `usage.tokens`: requests, bytes, latencia e ultimos headers `x-ratelimit-*`/credits por endpoint, quando enviados;
- `samples`: amostra com preco, volume, liquidez, verificacao e `isSus`.

## Smoke com 250 tokens e API key em 2026-07-04

Resultado informado:

- `requested=250`;
- `priced=250`;
- `missingPrice=0`;
- `tokenInfoFound=250`;
- `missingTokenInfo=0`;
- `withVolume5m=199`;
- `withVolume1h=239`;
- Price latency total: `1487ms`;
- Tokens latency total: `1703ms`.

Leitura:

- cobertura de preco foi excelente para tokens reais do banco;
- cobertura de volume 1h foi alta;
- volume 5m menor que 1h e esperado, porque alguns tokens estao frios no curtissimo prazo;
- alguns `blockId` antigos indicam que precisamos medir stale price por token antes de producao;
- o probe agora imprime `usage` para estimar requests/bytes e capturar headers de rate limit quando a Jupiter retornar.

## Proximos testes

1. Rodar com 50 tokens reais do `token_catalog`.
2. Rodar com 250 tokens usando `JUPITER_API_KEY`.
3. Separar amostras por tier:
   - HOT: tokens monitorados/alertas;
   - WARM: tokens recentes do bot;
   - COLD: tokens antigos/mortos.
4. Medir:
   - taxa de `missingPrice`;
   - taxa de `missingTokenInfo`;
   - cobertura de volume 5m/1h;
   - latencia;
   - rate limit;
   - requests e bytes em `usage`;
   - presenca de `isSus`.

## Pontos importantes

- Price API nao entrega volume; volume vem da Tokens API.
- Tokens API entrega volume agregado/indexado pela Jupiter, nao volume onchain bruto nosso.
- Token sem preco confiavel pode ser omitido, nao retornar `null`.
- Para token novo ou recem-migrado, Price API pode falhar mesmo que exista rota; nesses casos Quote/Metis deve ser testado como fallback.
- Sem API key, o limite keyless e baixo; usar apenas smoke pequeno.
