# Plano — Chart de Holders Count (Robinhood)

Registrado em 2026-08-16 e revisado em 2026-08-17 contra o estado atual do
repositório. Este documento consolida as decisões tomadas na
discussão de design para reproduzir o painel de holders da referência visual
(imagem do token CATE: contador de holders + deltas por janela + chart de barras)
na **Robinhood chain**.

É um plano de trabalho futuro. Nada abaixo está implementado. A implementação é um
**architecture checkpoint** (schema novo + domínio de série temporal) e deve ser
feita em cortes de ≤500 linhas, cada um validado, revisado, commitado e
reautorizado separadamente.

## 1. Objetivo

Reproduzir, para tokens da Robinhood chain, o painel de holders da referência:

- contador atual de holders (já existe);
- deltas por janela: 4h / 12h / 1d / 3d / 7d;
- chart de barras onde cada barra é a **variação de holders** naquele período.

A referência original (CATE) é um token **Solana**. Solana está **fora de escopo**
deste plano — não há fonte nem histórico de contagem de holders para Solana no
repositório. Este plano é **somente Robinhood**.

## 2. Descoberta central (por que isso é barato)

O sinal intradiário **já é observado hoje e é descartado**:

- **blockscout polling** (`src/services/robinhood-holder-summary-worker.js:18`):
  tokens "hot" são refrescados a cada ~5 min (`hotRefreshMs` default 5min); cold a
  cada 6h.
- **ledger_live** (`src/services/robinhood-holder-count-event.js:40`): contagem de
  holders em tempo real derivada do ledger on-chain, com `observedAt` e
  `liveThroughBlock`.

O motivo de não termos histórico sub-diário é que **os dois caminhos de escrita
colapsam em `snapshot_date` (DATE)** — 1 linha por dia UTC, em
`recordSuccess` e `syncLiveDailySnapshots`
(`src/models/robinhood-token-holder-summary.js:181-195, 258-295`). O dado
intradiário é gerado e jogado fora.

Consequência: reproduzir o chart é majoritariamente um problema de
**persistência + leitura + render**, não de construir captura nova.

## 3. Decisões travadas

### 3.1 Semântica das barras

- Cada barra = **variação líquida de holders** no período (quantos o token ganhou
  ou perdeu). Derivada por subtração de contagens: `count(fim) − count(início)`.
- Só a variação líquida é derivável do dado que temos (um único inteiro de
  contagem por observação). **Não** dá para separar "ganhou X / perdeu Y" — isso
  exigiria eventos de entrada/saída de holder (fonte separada e mais pesada), fora
  de escopo.
- Baseline zero central, verde para cima / vermelho para baixo **é a preferência
  de dado**. A apresentação final (uma cor só, tudo para cima como na imagem, etc.)
  é **decisão de frontend** e **não afeta schema nem dado** — pode ser trocada no
  corte de apresentação.
- `0` significa que duas contagens válidas são iguais. Se faltar a contagem-base
  necessária para a comparação, o delta é `null`; nunca se transforma ausência de
  histórico em zero.

### 3.2 Grão e retenção

- Persistir a **última contagem absoluta observada dentro de cada bucket de 1h
  UTC** (`bucket_start` truncado em 00:00, 01:00, 02:00…). A observação não é
  necessariamente feita no último minuto da hora, portanto o bucket não deve ser
  descrito como um fechamento exato.
- `bucket_start` é sempre derivado do `observed_at` da fonte, nunca do horário em
  que o worker executou. Isso evita fabricar buckets sem uma nova observação live.
- Dentro do bucket, aplicar **keep-latest** por `observed_at`. A precedência segue
  o contrato atual: `ledger_live` substitui Blockscout; Blockscout não substitui
  um bucket `ledger_live`; entre observações da mesma precedência vence a mais
  nova.
- Retido **indefinidamente** (histórico de crescimento de longo prazo).
- Guardar a **contagem absoluta** (não só o delta) é proposital:
  - variação de qualquer barra = diferença de fechamentos consecutivos;
  - a curva de crescimento de longo prazo sai direto das contagens absolutas, sem
    acumular deltas (acúmulo quebraria se faltasse uma barra).
- Só se grava um bucket quando há observação. Token hot enche até 24 buckets/dia;
  token cold grava ~4/dia de qualquer forma. Volume real é limitado pela cadência
  de observação, não pelo grão.
- Custo lógico: ~24 linhas/dia/token (teto, só hot) → ~8.760/token/ano. O custo
  físico real inclui heap, índices e overhead do PostgreSQL; retenção indefinida é
  deliberadamente não limitada e precisa de monitoramento de volume. Particionar
  ou introduzir retenção passa a ser uma decisão operacional futura, baseada em
  métricas reais.

Por que 1h e não 5min ou 4h:

- **5 min não precisa ser persistido como série separada.** As observações
  sub-hora atualizam a mesma linha horária. Depois da virada da hora, a leitura
  trata a linha anterior como fechada.
- **1h em vez de 4h** dá piso de zoom mais fino. A barra de 4h da imagem é
  derivada das contagens horárias por subtração entre os extremos, e não pela soma
  das contagens absolutas.

### 3.3 Derivações

- Barra de 4h (imagem) = `última_contagem_do_intervalo − contagem_base_anterior`.
  Somar quatro linhas seria incorreto porque as linhas guardam contagens
  absolutas; só deltas horários já derivados poderiam ser somados.
- Janelas do header (4h/12h/1d/3d/7d) usam a mesma regra:
  `count_agora − count_base_da_janela`.
- A leitura busca uma linha-base adicional. Se não houver sequência suficiente
  para a janela solicitada, retorna `null`/`comparison: unavailable`; não atribui
  a uma janela curta uma variação acumulada durante uma lacuna maior.
- O contrato da API deve devolver timestamps/bounds e distinguir explicitamente
  pontos abertos, completos e indisponíveis.

### 3.4 Realtime

- A **barra do bucket corrente (aberta)** é calculada ao vivo:
  `count_realtime − última_contagem_do_bucket_anterior`, usando o caminho
  `ledger_live` existente.
- A linha do bucket corrente é persistida e atualizada por upsert para sobreviver
  a restart; a API a marca como aberta. Não existe uma escrita especial de
  "finalização": depois da virada UTC, a mesma linha passa a ser lida como fechada.
- `holder:count` atualiza a barra aberta de forma sequenciada. Um
  `holder:invalidate` força recuperação por REST antes de aceitar nova comparação.
- Buckets fechados não são reescritos automaticamente por um reorg profundo que
  só seja descoberto depois da hora. Essa limitação deve permanecer observável e
  documentada; correção histórica de reorg fica fora deste escopo.

## 4. Limitações inerentes (registrar honestamente)

- **Nasce vazio.** Não existe backfill: nunca gravamos sub-diário, então não dá
  para reconstruir buckets de 1h do passado a partir das linhas diárias. O chart
  começa no primeiro bucket coletado, cresce indefinidamente e nunca é truncado
  para uma janela fixa.
- **Piso de zoom = 1h.** Não dá para exibir barra mais fina que 1h (a imagem
  também não mostra nada mais fino que 4h).
- **Só chain robinhood.**
- **Só variação líquida** (ver 3.1).
- Tokens sem observação em horas consecutivas exibem lacunas; a aplicação não
  interpola nem distribui uma variação acumulada entre buckets ausentes.

## 5. Fan-out e cortes

Architecture checkpoint. Próximo Stage livre confirmado em 2026-08-17: **140**
(arquivos e `runtime-schema.js` já usam os Stages 135–139).

### Corte 1 — schema + escrita (~350–470 linhas)

- `src/utils/db-init-stage140.js` (novo): tabela
  `robinhood_token_holder_buckets (chain, token_address, bucket_start
  timestamptz[1h UTC], holder_count bigint, source, observed_at, updated_at)`,
  PK `(chain, token_address, bucket_start)` e constraints de chain, endereço,
  contagem não negativa, source e alinhamento horário. Não criar um segundo índice
  idêntico ao PK apenas para declarar `DESC`: o B-tree pode ser percorrido ao
  contrário para essa consulta.
- `src/utils/runtime-schema.js`: registrar Stage 140.
- `src/models/robinhood-token-holder-summary.js`: upsert do bucket de 1h
  dentro da mesma instrução atômica de `recordSuccess` e
  `syncLiveDailySnapshots`. O caminho live deve selecionar e persistir o
  `published.observed_at`; `asOf` continua sendo apenas limite/horário do worker.
- Testes: schema/unit para constraints e SQL; integração para bucket UTC,
  persistência, idempotência, observação fora de ordem e precedência entre fontes;
  executar `npm run lint`, o teste afetado e `npm run db:schema-check`.
- **Não** inclui rota, worker novo ou frontend.

### Corte 2 — read model + API (~350–470 linhas)

- Read model isolado para baseline, gaps, agregação e estado
  `open`/`complete`/`unavailable`.
- Endpoint separado da lista paginada de holders, devolvendo séries de barras
  selecionáveis em 1h/4h/12h/24h, bounds, contagem atual e deltas de
  4h/12h/1d/3d/7d. Todas as granularidades são derivadas da persistência de 1h;
  não se gravam agregados duplicados nem se limita a leitura aos últimos 7 dias.
- Bootstrap da barra corrente pela publicação live-first já existente.
- Isolamento de falha: não pode derrubar a lista básica de holders.
- Testes unitários das derivações e testes de rota para série, gaps, `null` vs
  zero, bounds, validação e falha isolada.

### Corte 3 — frontend REST + apresentação (~350–480 linhas)

- `frontend/src/ui/robinhood-expanded-holders.ts` +
  `frontend/src/services/api/robinhood-holders.ts` + estilos: bootstrap REST,
  chart de barras, seletor `1H / 4H / 12H / 24H`, estados vazio/parcial/erro e
  deltas do header. O frontend renderiza no máximo os últimos 30 dias, sem alterar
  a retenção indefinida da tabela.
- Apresentação (cor única / tudo para cima / verde-vermelho) definida aqui.
- Validação: `npm run lint`, `npm --prefix frontend run build` e o menor teste de
  componente aplicável. O frontend ainda funciona por REST sem realtime.

### Corte 4 — realtime frontend + recuperação (~300–450 linhas)

- Normalização e order gate para `holder:count`/`holder:invalidate` no domínio de
  socket, sem colocar regra de negócio no cliente central.
- Assinatura por token usando as rooms de mercado existentes, atualização da
  barra aberta e recuperação REST após invalidação/reconexão.
- Limpeza da assinatura ao trocar/fechar token e preservação da hidratação REST
  como source de bootstrap/recovery.
- Validação: `npm run lint`, `npm --prefix frontend run build`, testes do domínio
  de eventos e smoke do expanded holders.

## 6. Invariantes / o que NÃO tocar

- Não alterar o cálculo de `Remaining`.
- Não alterar a tabela diária existente (`robinhood_token_holder_daily_snapshots`)
  nem sua retenção/propósito; a nova tabela de 1h é paralela.
- A tabela de 1h com contagem absoluta cobre também o crescimento de longo prazo;
  não é necessária uma segunda tabela "diária para growth".
- Realtime cobre só a barra corrente; todo o histórico depende do bucket gravado.
- Não alterar o protocolo/room de mercado para criar uma assinatura paralela de
  holders; reutilizar a room por token já usada pelo backend.

## 7. Ponto importante

O sinal intradiário de holders já existe e é descartado ao colapsar em `DATE`.
Reproduzir o chart é adicionar uma tabela de série temporal **paralela** (grão de
1h, contagem absoluta, retida para sempre) e passar a gravar o que já observamos —
não é um pipeline de captura novo. Mas há um custo temporal inescapável: como
nunca guardamos sub-diário, o chart **nasce vazio e acumula histórico somente a
partir do deploy**. Prometer histórico anterior ao deploy seria falso.

Além do Stage 140, o deploy precisa manter ao menos um caminho de coleta ativo.
`ROBINHOOD_HOLDER_SNAPSHOT_ENABLED` e `ROBINHOOD_HOLDER_SUMMARY_ENABLED` são
opt-in; schema e API sozinhos não produzem histórico. A ordem operacional é:
aplicar Stage 140, subir o writer com coleta habilitada, confirmar crescimento dos
buckets e só então expor o chart. `docs/bot-reference.md` deve ser atualizado no
corte que introduzir esse contrato operacional.
