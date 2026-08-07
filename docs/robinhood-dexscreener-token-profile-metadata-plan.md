# Plano: metadata de Token Profiles do DexScreener para Robinhood

Status: planejado, ainda não implementado  
Data da decisão: 2026-08-02

## 1. Objetivo

Consumir `GET https://api.dexscreener.com/token-profiles/latest/v1` no processo
isolado da Robinhood para preencher rapidamente a imagem de tokens que publicaram
um Token Profile no DexScreener.

O fluxo será aditivo. Ele não substituirá as fontes on-chain, Robinhood Stock API,
IPFS, Blockscout nem a recuperação por endereço já existentes.

Resultado esperado:

- tokens Robinhood com profile recente ganham imagem em até aproximadamente um
  ciclo da projeção do catálogo;
- o catálogo Solana continua com seu fluxo atual;
- falha ou indisponibilidade do feed não interrompe ingestão, projeção, alertas ou
  atualização de mercado da Robinhood;
- uma imagem já existente nunca é sobrescrita pelo profile.

## 2. Evidência no código atual

### Solana

`src/services/dex-discovery-worker.js` já chama
`dexscreener.getLatestTokenProfiles()`, mas usa o feed somente para descobrir
endereços com `chainId === 'solana'`.

Depois da descoberta, metadata e mercado da Solana são atualizados pelo catálogo
com `batchGetTokens(..., { chain: 'solana' })`, que usa
`/tokens/v1/solana/{addresses}`. Portanto, a implementação proposta não deve
alterar o worker Solana.

### Robinhood

O reparo atual de imagem está no worker de projeção Robinhood:

1. `logo()` de contratos pons;
2. Robinhood Stock API;
3. `tokenURI()`/IPFS;
4. `icon_url` do Blockscout;
5. DexScreener por endereço.

O fallback Dex por endereço é feito por
`src/services/robinhood-image-metadata.js`. A fila opcional de metadata social usa
`/tokens/v1/robinhood/{addresses}` em
`src/services/robinhood-social-metadata-queue.js`.

O cliente compartilhado já expõe `getLatestTokenProfiles()` em
`src/services/dexscreener.js`; não é necessário criar outro cliente HTTP.

## 3. Contrato e limitações do endpoint

Endpoint oficial:

```text
GET https://api.dexscreener.com/token-profiles/latest/v1
```

Campos relevantes:

```json
{
  "chainId": "robinhood",
  "tokenAddress": "0x...",
  "icon": "https://...",
  "header": "https://...",
  "description": "...",
  "links": [
    { "type": "twitter", "label": "...", "url": "https://..." }
  ]
}
```

A referência oficial informa limite de 60 requests por minuto. O polling proposto
faz no máximo uma chamada por minuto no processo Robinhood e reutiliza o cache,
deduplicação de requests em voo e cooldown já existentes no cliente DexScreener.

Limitações que afetam o desenho:

- é um feed global dos profiles mais recentes, não uma consulta por address;
- não oferece paginação ou histórico garantido;
- um token pode sair da janela antes de ser processado durante downtime;
- nem todo token Robinhood terá profile pago/publicado;
- retorno HTTP válido pode não conter nenhum item Robinhood;
- `icon`, `links` e até `tokenAddress` são opcionais no contrato.

Por essas razões, o endpoint não pode ser a única fonte de imagem.

Referência: <https://docs.dexscreener.com/api/reference>

## 4. Decisões de comportamento

### 4.1 Escopo por chain

Aceitar somente itens cujo `chainId`, normalizado em lowercase, seja exatamente
`robinhood`. Endereços devem passar por `normalizeTokenAddress('robinhood', ...)`.

O sincronizador não cria tokens no catálogo. A descoberta e identidade continuam
sendo responsabilidade do pipeline on-chain da Robinhood.

### 4.2 Prioridade da imagem

O profile DexScreener só poderá preencher `last_image_url` quando:

1. o token já existir em `token_catalog` com `chain = 'robinhood'`;
2. `robinhood_blockscout_checked_at` estiver preenchido, provando que as fontes de
   maior prioridade já foram tentadas;
3. `last_image_url` continuar vazio;
4. `icon` for uma URL segura aceita por `sanitizeAssetUrl`.

O update existente usa:

```sql
last_image_url = COALESCE(last_image_url, $2)
```

Isso preserva a imagem em uma corrida entre workers, mas a checagem anterior ao
update também é necessária para não fazer o profile Dex chegar antes das fontes
on-chain.

Profiles sem `icon` válido não devem chamar `recordDexscreenerMetadata()`. Isso
evita atualizar `robinhood_dexscreener_checked_at` e bloquear temporariamente o
fallback por endereço sem ter resolvido a imagem.

### 4.3 Links sociais

A imagem do profile é controlada pela nova configuração específica e independe de
`ROBINHOOD_SOCIAL_METADATA_ENABLED`.

Website, X e comunidade encontrados em `links` só serão persistidos quando
`ROBINHOOD_SOCIAL_METADATA_ENABLED=true`, preservando o significado atual dessa
flag. URLs devem passar pelas funções de segurança e classificação existentes em
`src/utils/dex-social-links.js` e `src/utils/url-safety.js`.

O campo `header` e a `description` ficam fora da primeira implementação porque não
há destino correspondente no catálogo nem uso visível no bot.

### 4.4 Falhas e recuperação

O sincronizador é best-effort:

- consulta nula, timeout, 429 ou resposta inválida não falha o ciclo principal da
  projeção Robinhood;
- se o throttle compartilhado indicar `pauseDiscovery`, o ciclo é pulado;
- tokens ainda ausentes no catálogo ou ainda não checados pelas fontes prioritárias
  ficam numa fila em memória, limitada e com TTL curto;
- a fila em memória apenas cobre a corrida profile-versus-descoberta; ela não é uma
  promessa de histórico;
- o fallback existente por address continua sendo a recuperação durável para feeds
  perdidos ou downtime.

Valores iniciais recomendados:

```text
intervalo: 60 segundos
pending TTL: 30 minutos
pending máximo: 500 endereços
```

## 5. Arquitetura proposta

Não criar outro processo systemd. O dono correto é o
`robinhood-catalog-projection-worker`, que já possui lease exclusivo e é responsável
pelo reparo assíncrono de metadata Robinhood.

A lógica nova fica atrás de um serviço pequeno; o worker de projeção recebe apenas
wiring e composição.

```text
Robinhood catalog projection worker (1/min)
  |
  +-- projeção e fontes prioritárias atuais
  |
  +-- Robinhood DexScreener profile sync
        |
        +-- getLatestTokenProfiles()
        +-- filtra chainId=robinhood
        +-- normaliza/deduplica address
        +-- sanitiza icon e links
        +-- consulta metadata existente em lote
        +-- grava somente imagem ausente após tentativa prioritária
        +-- mantém pendências recentes em memória
```

Ordem dentro do ciclo:

1. executar o batch atual da projeção, incluindo on-chain/Blockscout;
2. executar o sync de profiles isoladamente;
3. anexar o resumo do sync à telemetria do ciclo;
4. se o sync falhar, registrar a falha e manter o resultado do batch principal como
   válido.

## 6. Configuração

Adicionar:

```dotenv
ROBINHOOD_DEXSCREENER_PROFILE_ENABLED=false
ROBINHOOD_DEXSCREENER_PROFILE_INTERVAL_MS=60000
ROBINHOOD_DEXSCREENER_PROFILE_PENDING_TTL_MS=1800000
ROBINHOOD_DEXSCREENER_PROFILE_PENDING_MAX=500
```

O default deve ser `false` no primeiro deploy. A ativação é explícita depois que a
versão estiver instalada e o worker de projeção estiver saudável.

O intervalo mínimo deve ser 60 segundos para acompanhar o cache atual e manter
distância segura do limite oficial.

## 7. Arquivos previstos

Produção:

- `src/services/robinhood-dexscreener-profile-sync.js`
  - parsing, filtro por chain, deduplicação, fila pendente e persistência;
- `src/services/robinhood-catalog-projection-worker.js`
  - construção e execução best-effort do sincronizador;
- `src/utils/dex-social-links.js`
  - extrator reutilizável para o formato `links` do Token Profile;
- `config/index.js`
  - parsing das novas opções;
- `deploy/systemd/robinhood.env.example`
  - flags documentadas para produção;
- `src/server.js`
  - somente se for necessário expor campos adicionais de telemetria; não deve
    receber regra de negócio.

Persistência:

- reutilizar `robinhoodCatalog.listMetadata()`;
- reutilizar `robinhoodCatalog.recordDexscreenerMetadata()`;
- nenhuma migration ou mudança de schema é prevista.

Testes e documentação:

- novo teste unitário para o sincronizador;
- extensão do teste do worker de projeção apenas para o contrato de integração;
- extensão dos testes de config;
- atualização de `docs/bot-reference.md` quando o comportamento for implementado.

Estimativa da implementação: 350 a 450 linhas alteradas, contando código, testes e
documentação. Deve caber em uma única fatia abaixo do limite de 500 linhas. Se a
estimativa ultrapassar 500 durante a execução, o trabalho deve parar antes de
expandir o escopo.

## 8. Telemetria mínima

Adicionar ao resumo do worker:

```text
tokenProfiles.status
tokenProfiles.received
tokenProfiles.robinhood
tokenProfiles.valid
tokenProfiles.resolvedImages
tokenProfiles.existingImages
tokenProfiles.pending
tokenProfiles.skippedMissingCatalog
tokenProfiles.skippedPriorityPending
tokenProfiles.invalid
tokenProfiles.errors
tokenProfiles.lastSuccessAt
```

Evitar log por token em operação normal. Registrar somente:

- início do recurso com intervalo configurado;
- resumo agregado quando houver itens Robinhood;
- falha de consulta/persistência com mensagem limitada;
- transição para pause/cooldown do DexScreener.

## 9. Testes proporcionais ao risco

### Unitário: sincronizador

O menor teste capaz de proteger a regressão deve verificar:

1. ignora profiles de outras chains;
2. normaliza e deduplica addresses Robinhood;
3. rejeita `icon` inseguro ou ausente sem marcar o token como checado;
4. não grava quando já existe imagem;
5. não grava antes de `robinhood_blockscout_checked_at`;
6. grava a imagem segura quando as fontes prioritárias já falharam;
7. mantém uma entrada temporariamente pendente quando catálogo/prioridade ainda não
   estão prontos;
8. respeita throttle e falha sem derrubar o chamador;
9. só inclui links sociais quando a flag atual estiver habilitada.

### Integração no worker

Estender o teste existente apenas para confirmar que:

- o batch principal roda antes do profile sync;
- erro do profile sync não transforma um batch principal bem-sucedido em falha;
- o resumo/telemetria contém o resultado agregado do sync.

Não é necessário E2E de browser: o risco está em parsing, prioridade e persistência,
todos observáveis na camada unitária/serviço.

Validações da fatia:

```bash
npm run lint
node --test tests/robinhood-dexscreener-profile-sync.test.js \
  tests/robinhood-catalog-projection-worker.test.js \
  tests/runtime-worker-groups.test.js
```

Como não há schema, `npm run db:schema-check` não é obrigatório para esta mudança.

## 10. Rollout

### Antes de habilitar

1. publicar a versão com a flag desligada;
2. confirmar que o worker Robinhood usa `BACKGROUND_WORKER_GROUPS=robinhood`;
3. confirmar saúde do `robinhood-catalog-projection-worker`;
4. verificar que não há cooldown DexScreener ativo.

### Habilitação

No env exclusivo do processo Robinhood:

```dotenv
ROBINHOOD_DEXSCREENER_PROFILE_ENABLED=true
```

Reiniciar somente o serviço Robinhood correspondente e acompanhar os logs do novo
sync. GMGN e o grupo `market` não participam desse fluxo.

### Consulta de validação

```sql
SELECT address,
       symbol,
       last_image_url,
       robinhood_blockscout_checked_at,
       robinhood_dexscreener_checked_at,
       metadata_updated_at
FROM token_catalog
WHERE chain = 'robinhood'
  AND address IN (
    '0x27436d7f4add44aca19a0b10387c17da5d5de9a0'
  );
```

Para WIF, o aceite operacional é `last_image_url` preenchido e
`robinhood_dexscreener_checked_at` posterior ao deploy, sem alteração nos workers
Solana ou GMGN.

### Rollback

```dotenv
ROBINHOOD_DEXSCREENER_PROFILE_ENABLED=false
```

Reiniciar somente o processo Robinhood. As imagens já persistidas permanecem e os
fallbacks atuais continuam ativos.

## 11. Critérios de aceite

- apenas `chainId=robinhood` é processado;
- WIF e outros profiles recentes conseguem preencher imagem ausente;
- imagens existentes não são sobrescritas;
- fontes on-chain/Blockscout são tentadas antes do profile;
- profile sem icon válido não atualiza o timestamp DexScreener;
- links respeitam `ROBINHOOD_SOCIAL_METADATA_ENABLED`;
- endpoint lento, nulo ou em 429 não bloqueia o ciclo principal;
- Solana continua usando seu pipeline atual sem nova chamada ou branch;
- GMGN e o grupo `market` não são tocados;
- lint e testes afetados passam;
- diff final fica dentro da fatia autorizada e é revisado integralmente.

## 12. Ponto importante

O Token Profile resolve rapidamente imagens publicadas/pagas no DexScreener, mas
não cobre todos os tokens e não oferece busca histórica por address. Retirar o
fallback atual criaria um buraco permanente após downtime. Por isso a implementação
deve manter o feed como fast path e o lookup por address como reparo durável.
