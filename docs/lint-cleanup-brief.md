# Lint Cleanup Brief

## Context

O repo agora tem ESLint configurado em [eslint.config.mjs](/Users/ezequielmarinho/Volume-Bot-Alert/eslint.config.mjs) e CI rodando `lint`, `frontend build` e `smoke tests`.

Estado atual do lint:

- `0 errors`
- `98 warnings`

Esses warnings nao significam que o bot esta quebrado. Eles indicam principalmente:

1. funcoes com logica demais concentrada em um lugar so
2. imports, variaveis e helpers mortos ou sobras de refactor

## O que os warnings significam

### 1. Complexidade ciclomática alta

O ESLint esta com `complexity: ['warn', 18]`.

Quando aparece algo como:

- `app-controller.ts ... 169`
- `layout-sections.ts ... 40`
- `config/index.js ... 49`

isso nao significa linhas de codigo nem quantidade de bugs. Significa quantidade de caminhos logicos dentro de uma funcao.

Quanto maior esse numero, maior tende a ser o risco de:

- regressao ao mexer
- dificuldade de entender
- dificuldade de testar
- funcao virar um hub de regra demais

### 2. Unused vars / imports / helpers

Esses warnings normalmente indicam:

- import que sobrou depois de refactor
- variavel atribuida e nunca lida
- helper definido mas sem uso

Eles sao mais baratos de limpar e reduzem bastante ruido mental.

## Conclusoes tiradas do lint

### Conclusao 1

O maior problema estrutural atual nao e estilo. E concentracao excessiva de regra em poucos arquivos centrais.

Hotspots principais:

- [frontend/src/state/app-controller.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/state/app-controller.ts)
- [frontend/src/ui/sections/layout-sections.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/layout-sections.ts)
- [frontend/src/ui/app-shell.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/app-shell.ts)

### Conclusao 2

Ha uma quantidade razoavel de limpeza obvia que pode ser feita antes de qualquer refactor maior:

- imports nao usados
- variaveis nao usadas
- helpers mortos

Isso e o melhor primeiro passo porque:

- reduz ruido
- melhora leitura
- quase nao altera comportamento

### Conclusao 3

Nao faz sentido tentar zerar todos os warnings agora.

Isso seria caro, arriscado e misturaria:

- limpeza simples
- refactor estrutural
- codigo sensivel de dominio

### Conclusao 4

O lint atual esta no ponto certo para o momento:

- mostra a divida tecnica real
- ainda nao trava o time com `max-warnings=0`

Entao a estrategia correta agora e usar os warnings como mapa de prioridade, nao como meta de zerar tudo imediatamente.

## O que limpar primeiro

### Bloco 1. Limpeza obvia e barata

Objetivo:

- remover warning facil sem mudar comportamento

Alvos iniciais:

- [frontend/src/state/app-controller.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/state/app-controller.ts)
- [frontend/src/ui/sections/layout-sections.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/layout-sections.ts)
- [frontend/src/ui/app-shell.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/app-shell.ts)
- [src/routes/auth.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/routes/auth.js)
- [src/routes/social-auth.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/routes/social-auth.js)

Tipos de limpeza esperada:

- import nao usado
- tipo nao usado
- helper nao usado
- variavel local nao usada

Esse e o melhor primeiro bloco para o proximo chat.

### Bloco 2. Quebrar os hubs grotescos do frontend

Depois da limpeza barata, atacar:

- [frontend/src/state/app-controller.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/state/app-controller.ts)
- [frontend/src/ui/sections/layout-sections.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/sections/layout-sections.ts)
- [frontend/src/ui/app-shell.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/app-shell.ts)

Direcao sugerida:

- extrair helpers por responsabilidade
- isolar social auth / popup sync
- isolar pre-access / billing
- isolar route sync
- isolar render builders grandes

Meta:

- reduzir complexidade sem mudar UX ou contratos do app

### Bloco 3. Backend de auth/billing

Depois:

- [src/routes/social-auth.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/routes/social-auth.js)
- [src/routes/account-security.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/routes/account-security.js)
- [src/services/moonpay-commerce.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/services/moonpay-commerce.js)
- [config/index.js](/Users/ezequielmarinho/Volume-Bot-Alert/config/index.js)

Foco:

- extrair normalizers
- extrair builders
- extrair HTML/response helpers
- reduzir branching em handlers grandes

## O que NAO atacar agora

Nao comecar por:

- [src/models/token-market-bucket-1m.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/models/token-market-bucket-1m.js)

Motivo:

- parece infraestrutura mais sensivel
- nao e o bloco que acabou de ser estabilizado
- provavelmente pede uma rodada dedicada

## Ordem recomendada para o proximo chat

1. limpar unused imports / vars / helpers mortos
2. rodar lint de novo
3. escolher 1 hotspot grande do frontend
4. quebrar esse hotspot em subfuncoes menores
5. rodar build + lint + smoke tests

## Regra de processo recomendada

No proximo chat, manter este criterio:

- blocos pequenos
- sem misturar limpeza barata com refactor profundo no mesmo patch
- sem mudar comportamento funcional enquanto estivermos no bloco de lint cleanup

## Ponto importantes

- O repo esta funcional. Os warnings hoje sao mais sobre manutencao e risco futuro do que bug aberto.
- O warning mais serio e concentracao de logica demais em poucos hubs, especialmente no frontend.
- O maior ganho imediato vem da limpeza barata, nao de atacar tudo de uma vez.
- Nao endurecer o CI para `--max-warnings=0` antes de reduzir os warnings mais obvios.
- O melhor uso do proximo chat e: baixar ruido primeiro, depois refatorar um hotspot por vez.
