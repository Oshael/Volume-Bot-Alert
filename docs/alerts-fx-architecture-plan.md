# Alerts FX Architecture Plan

## Goal

Permitir efeitos visuais mais trabalhados nos cards de alertas sem reabrir o bug de flicker que apareceu no arrival animation.

Este plano e isolado para a lista de alerts.

Nao e um refactor do app shell inteiro.

## Current Reality

Hoje a lista de alerts funciona bem para renderizacao normal, mas nao e uma base confiavel para animacao rica de card.

O que o debug mostrou:

- quando qualquer animacao de arrival era aplicada no card, o alerta piscava
- quando o arrival foi totalmente desligado, o flicker sumiu
- o problema nao ficou caracterizado como logica de alerta quebrada
- o problema ficou caracterizado como incompatibilidade entre `render atual da lista` e `animacao no row`

Arquivos centrais hoje:

- lista/render dos alerts em:
  - [frontend/src/ui/sections/alerts-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/alerts-section.ts)
- render slot do app shell em:
  - [frontend/src/ui/app-shell.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/app-shell.ts)
- estilos dos alerts em:
  - [frontend/src/styles/app.css](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/styles/app.css)
- classificacao visual/tier em:
  - [frontend/src/services/alerts/impact-tier.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/services/alerts/impact-tier.ts)

## Non-Goals

Este plano nao deve:

- alterar drag, resize ou reorder do live workspace
- refatorar `monitored`, `pumpfun`, `recent` ou `old-week`
- transformar os alerts em um mini framework generico de lista
- adicionar efeitos ainda nesta fase

## Important Constraint

Se quisermos efeitos ricos de verdade, nao podemos continuar dependendo de:

- classe CSS reaplicada no `.alert-row` inteiro
- deteccao de "chegou agora" baseada so no render atual
- reconstrucao burra dos rows em cada refresh da secao

Enquanto isso continuar, qualquer animacao mais forte no card tende a reabrir flicker.

## Target Architecture

### 1. Keyed incremental alerts list

A lista de alerts deve passar a operar por `alert.id`.

Objetivo:

- manter cada row estavel no DOM
- inserir apenas novos alerts
- remover apenas alerts removidos
- atualizar apenas o conteudo dos alerts que realmente mudaram

Resultado esperado:

- o card novo entra uma vez no DOM
- o browser nao trata o mesmo alert como "novo elemento" varias vezes

### 2. FX lifecycle separado do render

Precisamos de um estado efemero so para efeitos.

Exemplo de shape:

```ts
type AlertFxState = {
  enteredAt: number;
  tier: 'normal' | 'critical' | 'mega' | 'special';
  phase: 'entering' | 'settled';
};
```

Chaveado por `alert.id`.

Objetivo:

- o efeito depende do ciclo de vida real do alert
- o efeito nao depende do fato de a secao ter rerenderizado

### 3. FX layer separado do card shell

Nao animar o `.alert-row` principal.

Em vez disso:

- `card shell` continua estavel
- `content layer` continua estavel
- `fx layer` fica isolada dentro do row

Exemplos de `fx layer`:

- brilho lateral
- flash controlado
- sweep overlay
- glow temporario

Objetivo:

- permitir efeito rico sem mexer no box principal do card

### 4. Imperative animation trigger

Para efeitos mais fortes, a entrada deve ser disparada no momento da insercao do node.

Opcao preferida:

- Web Animations API (`element.animate(...)`)

Opcao secundaria:

- classe CSS aplicada uma unica vez no node ja estabilizado

Regra:

- a animacao deve nascer de `node inserted`
- nao de `section rerendered`

### 5. Controlled FX budget

Mesmo com arquitetura melhor, nao devemos animar tudo sem limite.

Precisamos de regras como:

- limitar numero de enters simultaneos
- reduzir intensidade quando entram muitos alerts juntos
- degradar para efeito mais simples em burst

Isso evita ruido e reduz risco de regressao visual.

## Proposed Execution Phases

## Phase 1: Refactor alerts list to incremental DOM

Objetivo:

- parar de tratar a lista como render descartavel

Escopo:

- criar reconciliacao por `alert.id`
- manter map de rows montados
- inserir/remover/update por diff

Arquivos principais:

- [frontend/src/ui/sections/alerts-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/alerts-section.ts)

Risco:

- medio

Criterio de saida:

- alert novo entra sem recriar toda a lista
- remove/dismiss continua funcionando
- search continua funcionando
- star/copy/trade actions continuam funcionando

## Phase 2: Add isolated FX state

Objetivo:

- separar efeitos do render de dados

Escopo:

- criar store efemera por `alert.id`
- registrar `enteredAt` na primeira insercao
- limpar estado quando alert sair da lista

Arquivos principais:

- [frontend/src/ui/sections/alerts-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/alerts-section.ts)

Risco:

- baixo a medio

Criterio de saida:

- cada alert entra uma vez no ciclo `entering -> settled`
- rerender da secao nao reinicia esse ciclo

## Phase 3: Introduce FX layer inside alert row

Objetivo:

- dar um lugar seguro para animacao rica

Escopo:

- adicionar sub-elemento dedicado a FX no row
- manter o shell principal estavel
- mover futuros efeitos para essa camada

Arquivos principais:

- [frontend/src/ui/sections/alerts-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/alerts-section.ts)
- [frontend/src/styles/app.css](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/styles/app.css)

Risco:

- medio

Criterio de saida:

- o row continua utilizavel e legivel
- a camada de FX nao interfere em clique, hover, copy, star ou trade menu

## Phase 4: Reintroduce one safe animated effect

Objetivo:

- validar a nova arquitetura com um unico efeito controlado

Escopo:

- escolher um efeito so:
  - glow lateral
  - sweep fino
  - flash interno suave
- disparar apenas no insert do alert
- nao animar o card inteiro

Arquivos principais:

- [frontend/src/ui/sections/alerts-section.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/alerts-section.ts)
- [frontend/src/styles/app.css](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/styles/app.css)

Risco:

- medio

Criterio de saida:

- o efeito aparece uma vez
- nao ha flicker
- burst com varios alerts continua legivel

## Phase 5: Add richer tiers gradually

Objetivo:

- so depois do efeito unico estar comprovadamente estavel

Escopo:

- expandir por tier:
  - `normal`
  - `critical`
  - `mega`
  - `special`
- controlar degradacao em burst

Risco:

- medio a alto

Criterio de saida:

- tiers diferentes se comportam de forma previsivel
- efeitos nao reabrem flicker

## Interaction Safety

O plano deve preservar:

- dismiss button
- starred toggle
- copy action
- trade terminal menu
- compact search
- hover styling atual

Qualquer fase que quebrar isso deve parar antes de reintroduzir animacao.

## Relationship With Live Workspace Drag

Este plano deve ficar contido dentro da secao de alerts.

Nao deve tocar:

- pipeline de drag do live workspace em:
  - [frontend/src/ui/app-shell.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/app-shell.ts)
- layout persistence em:
  - [frontend/src/state/app-controller.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/state/app-controller.ts)
  - [src/models/user-ui-pref.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/models/user-ui-pref.js)

Se isso for respeitado, drag/resize/reorder nao devem ser afetados.

## Recommended First Cut

Nao voltar com efeito nenhum ainda.

A ordem correta e:

1. refatorar a lista
2. introduzir lifecycle de FX
3. validar estabilidade
4. so entao reintroduzir um unico efeito simples

## Validation Checklist

- `npm run lint`
- `npm --prefix frontend run build`
- teste manual com:
  - 1 alert novo
  - 3 alerts chegando juntos
  - dismiss de alert durante fase de entrada
  - drag/resize/reorder do painel de alerts ainda funcionando
  - compact search ainda funcionando

## Success Definition

Este trabalho so deve ser considerado bem sucedido quando:

- um alert novo entra com efeito
- o efeito roda uma unica vez
- o mesmo alert nao pisca
- bursts nao deixam a lista instavel
- o painel continua compativel com o live workspace customizavel
