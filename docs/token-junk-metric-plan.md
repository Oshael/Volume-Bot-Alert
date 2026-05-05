# Token Junk Metric Plan

## Objetivo

Construir uma metrica explicavel para qualificar tokens como:

- `junk_permanent`
- `junk_probable`
- `valid_but_weak`
- `valid`

O foco inicial nao e automatizar bloqueio global. O foco inicial e:

1. formar um conjunto de exemplos rotulados
2. medir sinais que o bot ja possui
3. separar sinais estruturais de sinais comportamentais
4. validar falso positivo antes de qualquer automacao

## Premissas

- O bot hoje ja possui bons sinais de mercado e historico.
- O bot nao possui, hoje, sinais on-chain profundos suficientes para declarar `safe eterno`.
- `junk_permanent` so deve existir quando a evidencia for forte e auditavel.
- Sinais dinamicos de mercado servem melhor para `junk_probable` do que para bloqueio permanente.
- Toda classificacao precisa ser reversivel e explicavel.

## Classes

### `junk_permanent`

Token com evidencia forte de que deve ser excluido globalmente.

Exemplos de base para essa classe:

- sinais estruturais muito fortes
- combinacao extremamente consistente de sinais de lixo
- baixa chance de falso positivo

Essa classe deve exigir motivo auditavel e reversao simples.

### `junk_probable`

Token com perfil ruim o bastante para evitar gasto extra de enrichment e para priorizar ocultacao/ignorar, mas sem confianca suficiente para bloqueio global permanente.

### `valid_but_weak`

Token fraco, feio, pequeno ou mal distribuido, mas sem evidencia suficiente para classificar como lixo.

Essa classe e importante para reduzir falso positivo.

### `valid`

Token aceitavel ou bom para os padroes desejados.

## Sinais Ja Disponiveis No Bot

Pelo codigo atual, estes sinais ja existem ou podem ser derivados sem novas fontes:

- `mcap`
- `priceUsd`
- `volume5m`
- `volume1h`
- `volume6h`
- `volume24h`
- `priceChange1h`
- `priceChange6h`
- `priceChange24h`
- `tokenCreatedAt`
- `pairAddress`
- `pairUrl`
- `imageUrl`
- `twitterUrl`
- `monitorPriority`
- `mcapDelta`
- `prevMcap`
- `prevVolume5mCanonical`
- historico 1m por token
- score de lateralizacao e seus sub-sinais
- resumo de Meteora: `tvl`, `poolCount`, `change1h`, `change6h`, `change24h`, `noPool`

Referencias de codigo:

- `src/services/catalog-worker.js`
- `src/routes/dashboard.js`
- `src/routes/catalog.js`
- `src/models/token-market-bucket-1m.js`
- `src/models/token-meteora-state.js`

## Sinais Estruturais Vs Comportamentais

### Estruturais

Sinais que podem, no futuro, participar de `junk_permanent`:

- authorities ativas
- concentracao anormal de holders
- metadata estrutural suspeita
- outras evidencias on-chain fortes

Observacao:

- Esses sinais ainda dependem de enriquecimento externo, como Helius/RPC.

### Comportamentais

Sinais que o bot ja consegue medir e que devem alimentar score:

- mcap muito baixo junto com liquidez fraca
- volume recente morto
- historico curto demais
- range excessivo
- drift excessivo
- volatilidade alta demais
- cobertura historica ruim
- ausencia de pool/TVL util em Meteora
- padrao recorrente de rompimento ruim ou queda forte

Esses sinais nao devem gerar `junk_permanent` sozinhos.

## Estrutura Inicial Da Metrica

A metrica deve ser formada por duas camadas:

### 1. Regras duras

Usadas para cortar casos obvios ou sinalizar falta de contexto.

Exemplos:

- sem historico suficiente -> `inconclusive`
- volume recente extremamente morto -> forte penalidade
- range/drift absurdos -> forte penalidade

### 2. Score ponderado

Usado para compor o veredito final.

Saida esperada:

- `junk_permanent`
- `junk_probable`
- `valid_but_weak`
- `valid`

Toda saida precisa carregar:

- `reasonCodes`
- `signalsUsed`
- `confidence`

Observacao importante:

- As regras abaixo sao regras de trabalho e precisam ser revisadas antes de qualquer implementacao definitiva no runtime do bot.
- Nada aqui deve virar bloqueio automatico sem validacao humana previa da versao inicial.

## Dataset Inicial

Precisamos de um conjunto de exemplos rotulados manualmente.

Meta inicial:

- `30-50` tokens `junk`
- `30-50` tokens `nao junk`

Se nao der para chegar nisso de inicio, comecar menor:

- `10-20` `junk`
- `10-20` `nao junk`

O grupo `nao junk` precisa incluir:

- tokens feios ou fracos que nao devem ser bloqueados
- casos ambigüos
- low caps legitimos

Sem isso, a metrica vai tender a super-bloquear.

## Formato Minimo Do Dataset

Formato sugerido por linha:

```json
{
  "address": "TOKEN_CA",
  "label": "junk_permanent | junk_probable | valid_but_weak | valid",
  "confidence": "high | medium | low",
  "reason": "motivo curto humano",
  "notes": "observacoes opcionais"
}
```

Campos obrigatorios:

- `address`
- `label`
- `reason`

Campos opcionais:

- `confidence`
- `notes`

## Workflow De Coleta

### Fase 1

Coletar CAs e rotular manualmente.

Nao precisamos de automacao ainda.

### Fase 2

Para cada CA coletado, extrair:

- snapshot atual do dashboard/catalogo
- historico 1m
- resumo Meteora
- score/sinais de lateralizacao

### Fase 3

Montar uma tabela comparativa:

- token
- label humano
- sinais medidos
- veredito esperado

### Fase 4

Detectar quais sinais realmente separam:

- `junk` de `valid_but_weak`
- `junk_probable` de `junk_permanent`

## O Que Nao Fazer Agora

- nao automatizar block global
- nao usar `safe eterno`
- nao colocar enrichment pesado no loop principal do catalogo
- nao depender de uma unica heuristica magica
- nao assumir que low cap = junk

## Primeiro Entregavel

Antes de escrever codigo de classificacao, precisamos produzir:

1. um dataset inicial rotulado
2. uma tabela com os sinais atuais do bot por token
3. uma primeira lista de sinais candidatos para score

## Proximo Passo Pratico

Comecar a coletar amostras no seguinte formato:

```json
[
  {
    "address": "CA_1",
    "label": "junk_probable",
    "reason": "volume morto e historico muito ruim",
    "confidence": "medium"
  },
  {
    "address": "CA_2",
    "label": "valid_but_weak",
    "reason": "baixo cap, mas nao parece lixo",
    "confidence": "medium"
  }
]
```

Quando houver massa critica suficiente, o proximo passo tecnico sera criar um coletor offline que:

- recebe uma lista de CAs
- consulta os endpoints/dados internos do bot
- consolida os sinais em um arquivo unico para analise

Comandos previstos:

```bash
npm run token-junk:normalize
TOKEN_JUNK_API_BASE="https://api.trendscope.pro" \
TOKEN_JUNK_API_TOKEN="SEU_TOKEN" \
npm run token-junk:collect
```

## Funil De Analise

O fluxo desejado nao e consultar Helius em todos os tokens.

O fluxo correto e afunilar os tokens com base nos dados baratos que o bot ja possui.

### Etapa 1. Classificacao barata

Usar apenas dados que ja existem no bot:

- snapshot atual de mercado
- historico 1m
- resumo/historico Meteora
- sinais de lateralizacao
- sinais simples do DexScreener

Saidas possiveis desta etapa:

- `legit`
- `valid_but_weak`
- `junk_probable`
- `needs_structural_review`
- `inconclusive`

### Etapa 2. Fila de enrichment estrutural

Somente tokens em classes ambigüas ou suspeitas seguem para enrichment via Helius/RPC.

Exemplos de candidatos:

- tokens do dataset manual que ainda nao tem sinais estruturais
- `junk_probable` com confianca insuficiente para bloqueio
- tokens suspeitos de fake volume
- tokens com liquidez/mcap suspeitos
- tokens com comportamento estranho de buy/sell
- tokens que parecem bons demais ou ruins demais para o comportamento estrutural esperado

### Etapa 3. Decisao enriquecida

Depois do enrichment Helius/RPC:

- confirmar `junk_probable`
- promover para `junk_permanent` apenas se houver base forte
- rebaixar para `valid_but_weak`
- manter como `legit`

### Etapa 4. Cache e exclusao futura

Tokens marcados como `legit` deixam de consumir enrichment estrutural ate que:

- a classificacao seja explicitamente removida
- apareca algum gatilho de revisao
- a regra mude manualmente

Tokens marcados como `junk_permanent` tambem saem da fila normal de enrichment.

## Regras Provisorias Do Funil

Estas regras sao provisorias e precisam ser revisadas antes da implementacao final.

### Regras para NAO chamar Helius

- token ja marcado manualmente como `legit`
- token ja marcado manualmente como `junk_permanent`
- token sem relevancia suficiente e sem sinais suspeitos
- token ja enriquecido recentemente e sem gatilho novo

### Regras para chamar Helius

- token ainda nao tem classificacao estrutural
- token esta em `junk_probable`
- token esta em `valid_but_weak`, mas com sinais de manipulacao
- token apresenta suspeita de fake volume
- token esta proximo de virar `junk_permanent`
- token foi marcado manualmente para revisao

### Regras para escalonamento

- primeiro usar somente sinais baratos
- depois usar Helius para sinais estruturais
- nao fazer analise pesada de fluxo entre wallets em todos os casos
- reservar analise mais cara para casos realmente ambiguos

## O Que Esperamos Medir Com Helius/RPC

DexScreener nao cobre bem os sinais estruturais necessarios para confirmar varios tipos de lixo.

A camada Helius/RPC deve buscar, no minimo:

- `holderCount`
- concentracao do supply no `top 5`
- concentracao do supply no `top 10`
- concentracao do supply no `top 20`
- classificacao basica dos maiores holders
- `mintAuthorityActive`
- `freezeAuthorityActive`
- metadata estrutural relevante do mint

Dependendo da precisao da primeira versao, podemos expandir depois para:

- indicios mais fortes de fake volume
- recorrencia das mesmas wallets
- leitura mais profunda de contas top holders

## Sinais Estruturais Alvo

### Holder count

Sinal esperado:

- poucos holders para market cap alto aumenta risco

### Concentracao do supply

Sinais esperados:

- `% top 5`
- `% top 10`
- `% top 20`

Quanto maior a concentracao fora de contas tecnicas conhecidas, maior o risco.

### Mint authority

Sinal esperado:

- se a moeda ainda e mintable, isso pesa negativamente

### Freeze authority

Sinal esperado:

- se a moeda ainda e freezable, isso pesa negativamente

### Holder structure

Sinal esperado:

- separar concentracao natural de concentracao maliciosa
- evitar tratar conta de pool, burn, treasury ou conta tecnica conhecida como holder comum

## Heuristicas Iniciais De Fake Volume

Fake volume nao deve ser tratado como dado absoluto; ele deve ser inferido por combinacao de sinais.

Sinais candidatos:

- buy/sell imbalance muito alto
- muito volume para pouca quantidade de transacoes
- subida excessivamente reta
- liquidez fraca demais para o market cap
- holders baixos para o porte da moeda
- concentracao alta de supply
- pouca renovacao estrutural de holders

Essas heuristicas tambem precisam ser revisadas antes de implementacao.

## Arquitetura Desejada No Codigo

Helius nao deve rodar no caminho critico do `catalog-worker`.

O desenho correto e uma camada separada de enrichment estrutural.

### Componentes necessarios

#### 1. Cliente Helius/RPC

Arquivo sugerido:

- `src/services/helius.js`

Responsabilidades:

- encapsular chamadas Helius/RPC
- timeout
- retries leves
- rate limiting local
- normalizacao de payload
- erros padronizados

Chamadas candidatas:

- `getAsset`
- `getTokenLargestAccounts`
- `getMultipleAccounts` ou equivalente necessario

#### 2. Normalizador de sinais estruturais

Arquivo sugerido:

- `src/services/token-risk-structural-signals.js`

Responsabilidades:

- transformar respostas cruas da Helius/RPC em sinais simples
- calcular:
  - `holderCount`
  - `% top 5`
  - `% top 10`
  - `% top 20`
  - `mintAuthorityActive`
  - `freezeAuthorityActive`
- anexar `reasonCodes`

#### 3. Cache de enrichment estrutural

Opcoes:

- tabela dedicada no banco
- ou armazenamento inicial simples se o uso continuar offline

Se for para usar no bot de verdade, o ideal e tabela dedicada.

Arquivo/tabela sugeridos:

- model: `src/models/token-risk-enrichment.js`
- tabela: `token_risk_enrichment`

Campos sugeridos:

- `token_address`
- `source`
- `holder_count`
- `top_5_pct`
- `top_10_pct`
- `top_20_pct`
- `mint_authority_active`
- `freeze_authority_active`
- `raw_summary_json`
- `last_enriched_at`
- `expires_at`
- `enrichment_status`
- `last_error`

#### 4. Fila de enrichment

Arquivo sugerido:

- `src/services/token-risk-enrichment-worker.js`

Responsabilidades:

- buscar tokens candidatos ao enrichment
- respeitar rate limit
- processar em lotes pequenos
- atualizar cache/resultados
- evitar chamadas duplicadas

Importante:

- esse worker deve ser separado do `catalog-worker`
- ele nao deve rodar para o catalogo inteiro

#### 5. Seletor de candidatos a Helius

Arquivo sugerido:

- `src/services/token-risk-candidate-selector.js`

Responsabilidades:

- usar somente sinais baratos do bot
- decidir quais tokens vao para enrichment
- excluir tokens ja marcados como `legit`
- excluir tokens `junk_permanent`
- priorizar tokens ambiguos e suspeitos

#### 6. Motor da metrica final

Arquivo sugerido:

- `src/services/token-junk-metric.js`

Responsabilidades:

- unir:
  - sinais baratos
  - sinais estruturais
  - rotulos manuais
- gerar classificacao final
- gerar `confidence`
- gerar `reasonCodes`

#### 7. Ferramentas offline

Ja iniciadas:

- `src/utils/normalize-token-junk-dataset.js`
- `src/utils/collect-token-junk-samples.js`

Ferramentas futuras:

- exportador de feature table
- comparador entre rotulo humano e score calculado
- relatorio de falso positivo / falso negativo

## Regras De Integracao Com O Bot

Antes de integrar Helius no runtime:

1. validar a metrica offline
2. validar falso positivo
3. confirmar thresholds
4. definir TTL de cache
5. definir politicas de reprocessamento

Politicas recomendadas:

- `legit`: nao reenriquecer sem gatilho manual ou mudanca de regra
- `junk_permanent`: nao reenriquecer no fluxo normal
- `junk_probable`: pode reenriquecer se houver duvida
- `valid_but_weak`: reenriquecer somente se houver suspeita nova

## Gatilhos Possiveis De Reprocessamento

Esses gatilhos ainda precisam ser revisados:

- mudanca forte no comportamento de buy/sell
- salto anormal de market cap
- queda abrupta de liquidez
- token marcado manualmente para revisao
- classificacao antiga conforme politica de expiracao

## O Que Nao Devemos Fazer

- nao chamar Helius em todo token do catalogo
- nao colocar Helius no loop principal do Dex
- nao usar sinais dinamicos sozinhos para `junk_permanent`
- nao tratar bearer token ou enrichment estrutural como detalhe sem risco operacional
- nao automatizar bloqueio sem auditoria inicial dos resultados

## Backlog Tecnico

Ordem sugerida para transformar o plano em implementacao:

### 1. Cliente Helius/RPC

Objetivo:

- criar `src/services/helius.js`
- encapsular chamadas Helius/RPC
- adicionar timeout, tratamento de erro e rate limit local

Dependencias:

- nenhuma

### 2. Normalizador de sinais estruturais

Objetivo:

- criar `src/services/token-risk-structural-signals.js`
- converter respostas da Helius/RPC em sinais prontos para score

Sinais iniciais:

- `holderCount`
- `% top 5`
- `% top 10`
- `% top 20`
- `mintAuthorityActive`
- `freezeAuthorityActive`

Dependencias:

- cliente Helius/RPC

### 3. Persistencia/cache de enrichment

Objetivo:

- criar model `src/models/token-risk-enrichment.js`
- criar tabela `token_risk_enrichment`
- salvar sinais estruturais e TTL

Dependencias:

- normalizador de sinais estruturais
- alteracao de schema/init

### 4. Seletor de candidatos para Helius

Objetivo:

- criar `src/services/token-risk-candidate-selector.js`
- usar sinais baratos do bot para decidir quais tokens merecem enrichment

Dependencias:

- coletor e sinais atuais do bot
- definicao provisoria das regras do funil

### 5. Worker de enrichment estrutural

Objetivo:

- criar `src/services/token-risk-enrichment-worker.js`
- processar candidatos em fila separada
- respeitar rate limit e cache

Dependencias:

- cliente Helius/RPC
- model de enrichment
- seletor de candidatos

### 6. Motor da metrica final

Objetivo:

- criar `src/services/token-junk-metric.js`
- combinar sinais baratos, sinais estruturais e marcacoes manuais
- retornar classificacao, confidence e reason codes

Dependencias:

- sinais estruturais
- seletor de candidatos
- regras revisadas

### 7. Ferramentas offline de validacao

Objetivo:

- gerar feature table
- comparar score com rotulo humano
- medir falso positivo e falso negativo

Dependencias:

- coletor offline
- motor da metrica final

### 8. Integracao gradual no bot

Objetivo:

- conectar a metrica ao runtime real sem colocar Helius no loop principal do Dex
- usar cache e fila separada

Dependencias:

- metricas validadas offline
- thresholds revisados
- persistencia pronta

## Pontos Importantes

- `junk_permanent` exige um padrao bem mais forte que `junk_probable`.
- O maior risco do projeto e falso positivo em token fraco legitimo.
- O dataset de contraexemplos e obrigatorio para a metrica nao ficar enviesada.
- A metrica precisa ser explicavel e reversivel desde o inicio.
- O desenho correto e validar a metrica offline antes de integra-la ao runtime principal.
