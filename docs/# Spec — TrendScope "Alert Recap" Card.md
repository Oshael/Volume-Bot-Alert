# Spec — TrendScope "Alert Recap" Card (PNL de multiplicador)

Documento de replicação exata. Entregue este arquivo à IA que vai reproduzir o card.

## Conceito
Card horizontal 960×620px (proporção ~1.55:1, pensado pra Telegram/Twitter) que mostra **quantos X uma meme coin fez desde que o bot TrendScope alertou** — no lugar de lucro em SOL, o herói é o multiplicador (ex: 23.4×). Estética dark + neon ciano, original (não copia Axiom).

## Fontes
- **Space Grotesk** (400/500/600/700) — títulos, ticker, número gigante, handle.
- **JetBrains Mono** (400/500/700) — todos os dados numéricos, labels, CA, badges.
- Import: Google Fonts.

## Paleta
- `--accent: #34f0dd` (ciano neon — cor do X, badges, glows)
- `--accent2: #1aa3ff` (azul — segunda cor dos gradientes)
- `--accentSoft: rgba(52,240,221,.42)` (usada em text-shadow/box-shadow de glow)
- Texto principal: `#eaf2f3` · texto secundário/labels: `#7c8a93` · sub-caption: `#9fb0b6` · CA: `#5a6770`
- Texto sobre superfícies accent (avatar da moeda): `#04110f`

## Container do card
- 960×620px, `border-radius: 22px`, `overflow: hidden`
- Fundo: `radial-gradient(120% 120% at 50% 40%, #0d1c26 0%, #070b11 60%, #05080c 100%)`
- Borda: `1px solid rgba(255,255,255,.08)`
- Sombra externa: `0 40px 90px -30px rgba(0,0,0,.85)`

### Efeito de fundo — "light shards" (4 feixes de luz diagonais)
Divs absolutas, mais altas que o card, gradiente vertical da cor pro transparente:
1. `top:-120px; left:140px; width:90px; height:840px; background:linear-gradient(#34f0dd, transparent); opacity:.10; rotate(24deg); blur(1px)`
2. `top:-120px; left:300px; width:40px; height:840px;` mesmo gradiente; `opacity:.08; rotate(24deg)` (sem blur)
3. `top:-160px; right:120px; width:120px; height:900px; background:linear-gradient(#1aa3ff, transparent); opacity:.09; rotate(-20deg); blur(1px)`
4. `top:-160px; right:280px; width:36px;` mesmo gradiente; `opacity:.07; rotate(-20deg)`

## Layout interno
Coluna flex, conteúdo central alinhado ao centro. Padding: `38px 50px 30px`.

### 1. Header (linha topo, largura total, space-between)
- Esquerda: logo do bot = círculo 30px com borda 2px `#34f0dd` e ponto central 8px ciano + texto "TrendScope" (Space Grotesk 700, 20px, branco)
- Direita: "ALERT CALLED IT" (JetBrains Mono 500, 12px, `#7c8a93`, letter-spacing 1.5px, uppercase)

### 2. Identidade da moeda (centralizada, 24px abaixo do header)
- Avatar circular 38px, gradiente `135deg #1aa3ff → #34f0dd`, letra do ticker (700, 17px, `#04110f`)
- Ticker "WEN" (Space Grotesk 700, 28px, branco) + nome "Wendy's Co" (500, 16px, `#7c8a93`)
- Gap 11px entre itens

### 3. Herói — o multiplicador (bloco central, empurrado por margin-top:auto)
- Badge pill acima: "▲ +2,240% · 6h 12m" — JetBrains Mono 600 13px ciano, borda 1px ciano, `border-radius:999px`, padding `7px 16px`, glow `box-shadow: 0 0 24px rgba(52,240,221,.42)`, `white-space:nowrap`
- **Número gigante: "23.4×"** — Space Grotesk 700, **200px** (o "×" em 104px), `line-height:.82`, `letter-spacing:-7px`, cor `#34f0dd`, glow `text-shadow: 0 0 70px rgba(52,240,221,.42)`
- Caption abaixo: "SINCE TRENDSCOPE ALERTED" — JetBrains Mono 600, 16px, `#9fb0b6`, letter-spacing 5px, uppercase

### 4. Faixa de stats (3 colunas iguais, empurrada pro fundo com margin-top:auto)
- Separada por `border-top: 1px solid rgba(255,255,255,.08)`, padding-top 16px
- Colunas divididas por linhas verticais `1px × 34px rgba(255,255,255,.1)`
- Cada coluna: label em cima (JetBrains Mono 500, 11px, `#7c8a93`, letter-spacing 1px) + valor embaixo (JetBrains Mono 600, 19px)
  - "MCAP @ALERT" → `$156K` (branco)
  - "MCAP NOW" → `$3.65M` (**ciano** `#34f0dd`)
  - "PEAK ATH" → `28.1×` (branco)

### 5. Rodapé (16px abaixo, com border-top `rgba(255,255,255,.07)`, padding-top 16px)
Linha flex, gap 11px:
- Logo do X (Twitter) em SVG, 18×18px, fill `#eaf2f3` (path oficial do 𝕏, viewBox 0 0 24 24)
- "@TrendScope_pro" — Space Grotesk 600, 16px, branco
- À direita (margin-left:auto): "CA 7xKW…9fGp" — JetBrains Mono 500, 12px, `#5a6770` (contrato abreviado: 4 primeiros + … + 4 últimos)

## Campos dinâmicos (variam por alerta)
`ticker`, `nome da moeda`, `letra do avatar`, `% de ganho`, `tempo desde o alerta`, `multiplicador X` (herói), `mcap no alerta`, `mcap atual`, `peak/ATH em X`, `CA abreviado`.

## Regras de estilo
- Tudo que é número/dado → JetBrains Mono; tudo que é identidade/título → Space Grotesk.
- Glow ciano só no herói, no badge e nos valores destacados — nunca em labels.
- Uma única cor de destaque (ciano); azul aparece apenas dentro de gradientes.
- Labels sempre uppercase, pequenas, cinza `#7c8a93`, com letter-spacing.
