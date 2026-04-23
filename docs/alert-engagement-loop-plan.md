# Alert Engagement Loop Plan

## Purpose

Este documento transforma as ideias de "elementos de casino" em um plano de produto mais seguro e mais coerente com a arquitetura atual do bot.

O objetivo nao e poluir a interface com animacao.

O objetivo e:

- aumentar saliencia dos eventos importantes
- criar antecipacao controlada
- reforcar sensacao de acerto do usuario
- aumentar retencao sem piorar leitura e operacao

## Current Code Reality

Hoje o bot ja tem uma base util para esse tipo de trabalho:

- sons por tipo de alerta em:
  - [frontend/src/services/alerts/sound.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/services/alerts/sound.ts)
- feed visual de alertas em:
  - [frontend/src/ui/sections/alerts-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/alerts-section.ts)
- toasts PumpFun foram removidos quando o fluxo passou a ser backend-only para migrações
- persistencia de som por usuario/escopo em:
  - [frontend/src/utils/sound-storage.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/utils/sound-storage.ts)

Isso significa que os primeiros blocos podem ser majoritariamente `frontend-only`.

## Guiding Rules

Regras para evitar degradacao do produto:

- nao tremer todo alerta
- nao criar animacao continua piscando
- nao transformar tudo em "evento raro"
- preservar leitura rapida do card
- usar raridade e timing como reforco, nao ruido permanente
- qualquer efeito mais agressivo deve existir apenas para alertas de maior peso

## Recommended Execution Order

1. Block 1: arrival animation por severidade
2. Block 2: tiers visuais de raridade
3. Block 3: pulse no header/contador
4. Block 4: reforco de acerto pessoal
5. Block 5: session heat
6. Block 6: near-miss / arming states

Motivo dessa ordem:

- os tres primeiros blocos sao baratos e quase todos `frontend-only`
- o quarto bloco aumenta retencao sem depender de gimmick visual barato
- os dois ultimos blocos tem mais risco de ruido e mais chance de exigir mudanca de logica

## Block 1: Arrival Animation By Severity

Objetivo:

- fazer novos alertas parecerem "chegados agora" sem distrair o operador

Escopo:

- `normal`:
  - fade/slide curto
- `critical`:
  - pulse breve de glow/borda
- `mega`:
  - pulse mais forte e opcional micro-shake curto
- `dump/high-cap/hvnc`:
  - tratamento proprio, sem reciclar efeito padrao

Arquivos principais:

- [frontend/src/ui/sections/alerts-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/alerts-section.ts)
- [frontend/src/styles/app.css](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/styles/app.css)

Ownership:

- frontend

Risco:

- baixo

Criterio de saida:

- novos alertas entram com animacao curta
- cards antigos nao ficam animando
- leitura do card nao piora

## Block 2: Visual Rarity Tiers

Objetivo:

- aumentar sensacao de raridade e hierarquia entre alertas

Escopo:

- mapear os alertas para tiers visuais consistentes:
  - `normal`
  - `critical`
  - `mega`
  - `special`
- melhorar badge, borda, glow e contrastes por tier
- manter dump/high-cap como classe especial propria

Arquivos principais:

- [frontend/src/ui/sections/alerts-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/alerts-section.ts)
- [frontend/src/styles/app.css](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/styles/app.css)

Ownership:

- frontend

Risco:

- baixo

Criterio de saida:

- o usuario bate o olho e entende qual alerta e comum e qual e raro
- nao existe inconsistencia entre som, badge e tom visual

## Block 3: Header / Counter Pulse

Objetivo:

- reforcar que "algo novo chegou" mesmo quando o usuario nao esta olhando o card exato

Escopo:

- pulse curto no contador do painel de alertas
- pulse curto no header da secao
- opcionalmente diferenciar quando chegar `mega` ou `special`

Arquivos principais:

- [frontend/src/ui/sections/alerts-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/alerts-section.ts)
- [frontend/src/styles/app.css](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/styles/app.css)

Ownership:

- frontend

Risco:

- baixo

Criterio de saida:

- o reforco visual aparece apenas na chegada de eventos novos
- nao fica reanimando em todo rerender

## Block 4: Personal Win Loop

Objetivo:

- reforcar a sensacao de "eu peguei esse token" quando o alerta envolve algo que o usuario estava monitorando de forma mais intencional

Escopo:

- adicionar marcacoes como:
  - `Your watchlist caught this`
  - `Starred token triggered`
  - `Manual token triggered`
- opcionalmente destacar um pequeno selo no card e/ou no header do alerta

Dependencias:

- usar dados ja presentes no frontend:
  - starred tokens
  - manual tokens

Arquivos principais:

- [frontend/src/ui/sections/alerts-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/alerts-section.ts)
- [frontend/src/state/app-controller.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/state/app-controller.ts)

Ownership:

- frontend

Risco:

- baixo a medio

Criterio de saida:

- alertas ligados a decisao explicita do usuario ganham reforco proprio
- o destaque nao aparece em eventos genericos sem contexto pessoal

## Block 5: Session Heat

Objetivo:

- criar senso de "sessao quente" sem inventar alerta falso

Escopo:

- calcular um estado agregado recente:
  - `quiet`
  - `warm`
  - `hot`
  - `chaotic`
- exibir esse estado em algum ponto leve do shell
- basear a classificacao em densidade e peso recente dos alertas

Arquivos principais:

- [frontend/src/state/app-controller.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/state/app-controller.ts)
- [frontend/src/ui/app-shell.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/app-shell.ts)
- [frontend/src/styles/app.css](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/styles/app.css)

Ownership:

- frontend inicialmente

Possivel evolucao:

- backend se no futuro quisermos "heat" mais confiavel e compartilhado entre tabs/sessoes

Risco:

- medio

Criterio de saida:

- o estado de sessao faz sentido para o operador
- nao vira indicador aleatorio nem contradiz o fluxo real de alertas

## Block 6: Near-Miss / Arming States

Objetivo:

- gerar antecipacao antes do alerta completo

Escopo:

- mostrar tokens ou estados como:
  - `building`
  - `close to trigger`
  - `support holding`
  - `compression forming`
- limitar isso a poucas superficies e poucos itens
- evitar transformar a tela em mais uma lista ruidosa

Ownership:

- hibrido

Motivo:

- alguns sinais podem ser derivados no frontend
- mas os melhores estados de "arming" tendem a depender de logica que hoje esta distribuida entre frontend e backend

Arquivos potencialmente tocados:

- [frontend/src/state/app-controller.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/state/app-controller.ts)
- [frontend/src/ui/sections/alerts-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/alerts-section.ts)
- [src/routes/catalog.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/routes/catalog.js)
- [src/models/token-market-bucket-1m.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/models/token-market-bucket-1m.js)

Risco:

- alto

Criterio de saida:

- a antecipacao melhora sem gerar falso positivo visual demais
- o operador nao perde clareza sobre o que ja e alerta e o que ainda e apenas aproximacao

## Validation Plan

Para cada bloco:

- validar comportamento visual com operador humano
- checar se o alerta continua legivel em desktop e mobile
- garantir que o efeito ocorre uma vez por chegada de evento, nao a cada rerender
- confirmar que nao piora scroll, busca, remocao e acao rapida dos cards

Para blocos 1 a 4:

- `npm run lint`
- `npm --prefix frontend run build`

Para blocos 5 e 6:

- `npm run lint`
- `npm --prefix frontend run build`
- testes afetados se houver mudanca de comportamento

## Recommended First Cut

Se a ideia for buscar retorno rapido sem entrar em risco estrutural, a melhor primeira entrega e:

- Block 1
- Block 2
- Block 3

Esse pacote:

- melhora o impacto percebido
- quase nao toca logica de negocio
- nao depende de backend novo
- da um bom sinal de produto sem abrir uma frente estrutural grande

## Ponto importantes

- o melhor caminho aqui e `raridade + timing + reforco pessoal`, nao tremedeira geral
- se tudo virar evento especial, o efeito psicologico morre rapido
- os blocos 1 a 4 cabem bem no frontend atual
- os blocos 5 e 6 ja encostam em modelagem de comportamento e devem ser tratados com mais cuidado
- o bloco 6 e o mais sedutor no papel, mas tambem o mais facil de piorar ruido e falsa expectativa
