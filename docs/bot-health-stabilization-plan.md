# Bot Health Stabilization Plan

## Purpose

Este documento transforma a analise de saude do bot em um plano pratico por etapas.

O objetivo nao e fazer "uma limpeza geral".

O objetivo e:

- recuperar confianca real nas validacoes
- alinhar banco de teste com o codigo atual
- remover falsos sinais de saude
- reduzir os hotspots de complexidade que aumentam risco de regressao
- deixar o bot mais previsivel para mudancas futuras

Este plano foi baseado no codigo e no estado atual observados no repositorio em `2026-04-09`.

## Current Health Snapshot

Nota geral atual:

- `6/10`

Leitura curta dessa nota:

- produto e arquitetura base estao vivos e funcionais
- documentacao principal esta boa e atualizada
- backend tem sinais claros de hardening
- mas a confianca de manutencao e de teste esta abaixo do ideal

## Progress Update

Status observado apos execucao das tres primeiras fases em `2026-04-09`:

- `Phase 1` concluida
- `Phase 2` concluida
- `Phase 3` concluida

Estado consolidado agora:

- o banco de teste esta alinhado com o schema atual exigido pelo codigo
- `tests/catalog.test.js` deixou de falhar por schema atrasado
- [tests/config.test.js](/Users/ezequielmarinho/Volume-Bot-Alert/tests/config.test.js) foi reescrito para `node:test` e alinhado ao contrato atual
- o gate oficial foi redefinido em [package.json](/Users/ezequielmarinho/Volume-Bot-Alert/package.json) para rodar em sequencia:
  - schema-check de teste
  - `admin`
  - `auth`
  - `catalog`
  - `config`
  - `billing`
- `npm test` passou de ponta a ponta no estado atual

Risco residual importante:

- a estabilidade do gate hoje depende de execucao sequencial
- as suites ainda compartilham o mesmo banco de teste
- isso significa que o problema de isolamento ainda nao foi eliminado na raiz

## Current Code Reality

Os pontos abaixo vieram do codigo e das validacoes executadas, nao de suposicao.

### Documentacao principal esta coerente

Docs principais:

- [README.md](/Users/ezequielmarinho/Volume-Bot-Alert/README.md)
- [docs/bot-reference.md](/Users/ezequielmarinho/Volume-Bot-Alert/docs/bot-reference.md)

Sinal positivo:

- os docs parecem acompanhar a arquitetura real atual
- eles descrevem corretamente o modelo de processo unico, workers, frontend separado e guard rails de teste

### O runtime principal parece mais saudavel que o ambiente de teste

Sinais positivos:

- `npm run lint` passou
- `npm --prefix frontend run build` passou
- `npm run db:schema-check` passou para o profile de runtime
- `tests/admin.test.js` passou isolado
- `tests/auth.test.js` passou isolado

### A base de teste esta atrasada em relacao ao codigo

Sinal mais importante encontrado:

- `NODE_ENV=test npm run db:schema-check` falhou

Stages faltando no banco de teste:

- stage 17
- stage 19
- stage 20
- stage 21
- stage 22
- stage 23
- stage 24
- stage 25
- stage 26
- stage 27

Consequencia concreta:

- o codigo atual espera colunas e tabelas que ainda nao existem no DB de teste

Exemplo objetivo:

- [src/models/token-catalog.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/models/token-catalog.js) ja escreve `last_liquidity_usd` e campos de txns
- [src/utils/db-init-stage26.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/utils/db-init-stage26.js) mostra que isso e schema oficial atual
- [tests/catalog.test.js](/Users/ezequielmarinho/Volume-Bot-Alert/tests/catalog.test.js) falhou justamente por falta dessa coluna no banco de teste

### A suite automatizada nao representa bem a saude real

Problemas observados:

- o script oficial em [package.json](/Users/ezequielmarinho/Volume-Bot-Alert/package.json) roda so:
  - `tests/admin.test.js`
  - `tests/auth.test.js`
  - `tests/catalog.test.js`
- existem muitos outros testes no repositorio fora do gate oficial
- alguns testes passam isolados e falham no lote
- alguns testes estao obsoletos

Exemplo objetivo:

- [tests/config.test.js](/Users/ezequielmarinho/Volume-Bot-Alert/tests/config.test.js) ainda usa estrutura de Jest e falha com `beforeAll is not defined`

### Ha concentracao excessiva de logica em hubs grandes

Hotspots claros:

- [frontend/src/state/app-controller.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/state/app-controller.ts)
- [frontend/src/ui/app-shell.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/app-shell.ts)
- [src/routes/catalog.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/routes/catalog.js)
- [src/services/catalog-worker.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/services/catalog-worker.js)
- [src/models/token-market-bucket-1m.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/models/token-market-bucket-1m.js)

Isso nao significa que o bot esta quebrado hoje.

Significa que:

- mudar fica caro
- revisar fica caro
- testar fica mais dificil
- regressao estrutural fica mais provavel

## Main Risks

### 1. Falso verde

Risco:

- achar que "tem bastante teste" equivale a "mudanca esta segura"

Problema real:

- o gate oficial nao cobre o repositorio de forma representativa
- parte do ambiente de teste esta atrasado

### 2. Regressao silenciosa em mudancas medias

Risco:

- mudar auth, catalogo, dashboard, billing ou regras de risco e so descobrir regressao depois

Problema real:

- testes nao estao confiaveis o bastante para servirem como contrato completo

### 3. Custo crescente de manutencao

Risco:

- cada feature nova ficar mais lenta, mais arriscada e mais cansativa de validar

Problema real:

- os hubs principais ja acumulam regra demais

### 4. Escala operacional fragil

Risco:

- escalar processo sem separar runtime e duplicar workers no mesmo DB

Problema real:

- a arquitetura ja documenta esse limite
- o codigo ja tem controles de role, mas o modo padrao ainda e `combined`

## Stabilization Strategy

Ordem recomendada:

1. recuperar paridade do banco de teste
2. fazer a suite voltar a ser confiavel
3. corrigir o gate oficial para refletir a cobertura real
4. limpar warnings baratos e remover codigo morto
5. atacar hubs grandes por blocos pequenos
6. endurecer validacao continua e disciplina de schema

Motivo:

- sem teste confiavel, refactor estrutural vira chute
- sem paridade de schema, qualquer conclusao sobre regressao fica contaminada
- so depois disso faz sentido investir forte em reducao de complexidade

## Execution Plan

### Phase 0: Freeze The Baseline

Objetivo:

- registrar o estado atual antes de mexer

Checklist:

- salvar este documento como referencia principal da estabilizacao
- manter a lista de sintomas reais observados:
  - `npm run lint` passa com warnings
  - `frontend build` passa
  - `runtime schema-check` passa
  - `test schema-check` falha
  - `admin/auth` passam isolados
  - `catalog` falha por schema de teste atrasado
  - `billing` falha no setup
  - `config.test.js` esta obsoleto
- nao misturar nesta fase nenhuma mudanca de feature

Saida esperada:

- baseline aceito
- ordem de trabalho aprovada

### Phase 1: Recover Test Database Parity

Objetivo:

- alinhar o banco de teste ao schema atual do codigo

Problema real que esta bloqueando:

- `NODE_ENV=test npm run db:schema-check` acusa ausencia de tabelas/colunas essenciais

Checklist:

- revisar `.env.test`
- confirmar que ele aponta para um DB isolado
- aplicar no banco de teste as stages pendentes:
  - `node src/utils/db-init-stage17.js`
  - `node src/utils/db-init-stage19.js`
  - `node src/utils/db-init-stage20.js`
  - `node src/utils/db-init-stage21.js`
  - `node src/utils/db-init-stage22.js`
  - `node src/utils/db-init-stage23.js`
  - `node src/utils/db-init-stage24.js`
  - `node src/utils/db-init-stage25.js`
  - `node src/utils/db-init-stage26.js`
  - `node src/utils/db-init-stage27.js`
- rodar:
  - `NODE_ENV=test npm run db:schema-check`

Saida esperada:

- schema-check do banco de teste passa
- `catalog.test.js` para de falhar por coluna/tabela ausente

Nao considerar a fase concluida se:

- apenas o banco de runtime estiver alinhado
- o banco de teste continuar atrasado

### Phase 2: Make The Test Suite Trustworthy

Objetivo:

- diferenciar teste quebrado por obsolescencia de teste que realmente protege comportamento atual

Checklist:

- consertar [tests/config.test.js](/Users/ezequielmarinho/Volume-Bot-Alert/tests/config.test.js):
  - migrar de Jest para `node:test`
  - ou remover/substituir se o fluxo atual nao existir mais
- investigar [tests/billing.test.js](/Users/ezequielmarinho/Volume-Bot-Alert/tests/billing.test.js):
  - entender por que o setup ja falha no registro/verify
  - validar se o teste esta assumindo comportamento antigo de auth/pre-access
- revalidar [tests/catalog.test.js](/Users/ezequielmarinho/Volume-Bot-Alert/tests/catalog.test.js) depois da paridade de schema
- identificar por que testes que passam isolados falham em lote:
  - isolamento de DB
  - competicao por `PORT`
  - ordem de bootstrap
  - reuse de `pool`
  - cache de modulo/config
- padronizar teardown:
  - fechar servidor
  - fechar pool
  - resetar mocks globais

Saida esperada:

- os testes principais passam de forma repetivel
- um mesmo arquivo nao muda de resultado entre execucao isolada e em lote sem motivo concreto

### Phase 3: Fix The Official Validation Gate

Objetivo:

- fazer o comando oficial representar o estado real que queremos proteger

Problema atual:

- o script `npm test` cobre pouco e ainda nao e estavel

Checklist:

- revisar [package.json](/Users/ezequielmarinho/Volume-Bot-Alert/package.json)
- redefinir estrategia de test runner:
  - manter um bloco rapido confiavel
  - separar suites lentas ou destrutivas com nomes claros
- proposta minima:
  - `npm test` para o gate essencial e estavel
  - manter suites adicionais com scripts dedicados
- incluir explicitamente o schema-check de teste no fluxo de preparacao quando fizer sentido
- garantir que o gate oficial falha por regressao real, nao por ambiente quebrado

Saida esperada:

- `npm test` volta a ser um sinal que da para confiar

### Phase 4: Cheap Hygiene Pass

Objetivo:

- reduzir ruido e baixar risco sem mudar comportamento funcional

Checklist:

- limpar warnings baratos de lint:
  - imports nao usados
  - helpers mortos
  - vars nao usadas
- atacar primeiro arquivos com ganho facil
- nao misturar nessa fase:
  - refactor profundo
  - alteracao de regra de negocio
  - redesign de API

Prioridade sugerida:

- [src/server.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/server.js)
- [src/routes/admin.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/routes/admin.js)
- [src/services/dexscreener.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/services/dexscreener.js)
- [frontend/src/ui/sections/lateralized-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/lateralized-section.ts)
- [frontend/src/ui/sections/monitored-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/monitored-section.ts)

Saida esperada:

- menos warnings triviais
- menos ruido mental
- terreno melhor para refactor estrutural

### Phase 5: Break The Main Hubs Safely

Objetivo:

- reduzir acoplamento e complexidade onde o custo de manutencao ja ficou alto

Ordem sugerida:

#### Block 5A. Frontend controller

Arquivo principal:

- [frontend/src/state/app-controller.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/state/app-controller.ts)

Direcao:

- separar auth flow
- separar pre-access/billing
- separar monitor refresh logic
- separar alert derivation
- separar route/workspace sync

#### Block 5B. Frontend shell/render

Arquivos principais:

- [frontend/src/ui/app-shell.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/app-shell.ts)
- [frontend/src/ui/sections/layout-sections.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/layout-sections.ts)

Direcao:

- extrair wiring por area
- reduzir funcoes com branching excessivo
- isolar builders de overlay, menus e modais

#### Block 5C. Catalog/runtime backend

Arquivos principais:

- [src/routes/catalog.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/routes/catalog.js)
- [src/services/catalog-worker.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/services/catalog-worker.js)

Direcao:

- extrair validadores
- extrair builders de payload
- extrair fluxo de promote/pumpfun/meta
- reduzir funcoes-hub de decisao de prioridade

#### Block 5D. Quant logic hotspots

Arquivo principal:

- [src/models/token-market-bucket-1m.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/models/token-market-bucket-1m.js)

Direcao:

- atacar por ultimo
- quebrar por grupo de heuristica
- preservar comportamento via testes antes de reestruturar

Saida esperada:

- reducao clara de complexity warnings
- arquivos centrais menos perigosos para mudancas futuras

### Phase 6: Operational Hardening For Future Changes

Objetivo:

- evitar voltar para o mesmo estado daqui a poucas semanas

Checklist:

- sempre rodar `NODE_ENV=test npm run db:schema-check` quando houver mudanca de schema relevante
- manter `npm run db:schema-check` no runtime como regra de release
- revisar se o banco de teste acompanha novas stages no mesmo trabalho
- explicitar scripts para:
  - gate rapido
  - gate medio
  - gate completo
- documentar no processo que feature com impacto estrutural nao encerra sem:
  - lint
  - build frontend
  - testes afetados
  - schema-check quando aplicavel

Saida esperada:

- queda de regressao por ambiente defasado
- menor divergencia entre "codigo que roda" e "codigo que consegue ser validado"

## Recommended Work Order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5A
6. Phase 5B
7. Phase 5C
8. Phase 5D
9. Phase 6

## Validation Checklist By Phase

### For Phase 1

- `NODE_ENV=test npm run db:schema-check`

### For Phase 2

- `node --test --test-force-exit tests/admin.test.js`
- `node --test --test-force-exit tests/auth.test.js`
- `node --test --test-force-exit tests/catalog.test.js`
- `node --test --test-force-exit tests/billing.test.js`
- `node --test --test-force-exit tests/config.test.js`

### For Phase 3

- `npm test`

### For Phase 4 and structural phases

- `npm run lint`
- `npm --prefix frontend run build`
- `node --test ...` nos testes afetados

### When schema/init changes are involved

- `npm run db:schema-check`
- `NODE_ENV=test npm run db:schema-check`

## Done Definition

Vamos considerar a saude do bot materialmente melhor quando:

- o banco de teste estiver em paridade com o schema atual
- `npm test` voltar a ser confiavel
- testes obsoletos forem removidos ou migrados
- billing e catalog tiverem suites estaveis
- warnings baratos forem reduzidos
- pelo menos um hub grande do frontend for quebrado com seguranca

Meta realista apos essas etapas:

- sair de algo perto de `6/10`
- para algo entre `7.5/10` e `8/10`

## What Not To Do

- nao misturar correcoes de ambiente de teste com feature nova
- nao tentar refatorar todos os hubs no mesmo patch
- nao confiar em resultado verde de runtime se o banco de teste estiver atrasado
- nao usar o numero de testes no repositorio como proxy de confianca
- nao atacar primeiro o bloco quant mais sensivel sem antes estabilizar a base

## Ponto importantes

- O maior problema hoje nao parece ser producao quebrada; parece ser confianca insuficiente para evoluir com seguranca.
- O banco de runtime esta mais saudavel que o banco de teste, e isso mascara regressao ate tarde demais.
- Sem corrigir a base de teste primeiro, qualquer refactor grande vai gerar mais ruido do que valor.
- O frontend controller e os hubs de render continuam sendo o principal custo estrutural de manutencao.
- O objetivo correto nao e "zerar tudo"; e restaurar previsibilidade, depois reduzir complexidade com blocos pequenos.
