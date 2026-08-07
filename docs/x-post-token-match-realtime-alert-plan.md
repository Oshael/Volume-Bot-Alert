# X post to token match realtime alert plan

Documento de decisao e execucao para construir o alerta em tempo real que cruza
posts de contas conhecidas do X contra as moedas ja existentes no catalogo,
usando imagem (hash perceptual) e nome/ticker como chave de match, e emite no
feed a possivel causa de um pump antes ou durante ele.

Este documento e a fonte de verdade para continuar o trabalho sem depender do
contexto da conversa.

Data inicial: 2026-07-29.

## Status

- Nenhum bloco iniciado.
- Nenhuma conta X, proxy ou sessao contratada.
- Nenhum codigo de ingestao X existe no repositorio.
- Ja existe em producao, de trabalho anterior desta mesma sessao: card de perfil
  do X (`src/services/x-profile-card.js`, `src/routes/x-profile.js`,
  `frontend/src/ui/x-profile-card.ts`), que usa `api.fxtwitter.com` sem
  autenticacao. Esse caminho **nao serve** para este plano; ver "Contexto".

## Contexto e decisao

### O comportamento manual que estamos automatizando

Traders acompanham um feed de alta velocidade de contas conhecidas do X (modelo
uxento). Quando uma figura carimbada posta uma imagem ou uma palavra, o trader
corre para o terminal e pesquisa se existe moeda daquela imagem/nome. Se existe,
ele compra antes do resto do mercado perceber.

Caso real observado: `@himgajria` retuitou uma foto de urso; uma moeda de ~20h
de idade que usava **aquela mesma foto** pumpou forte em seguida.

### Direcao da referencia

O erro conceitual a evitar: assumir que o post referencia a moeda. E o contrario.

```
moeda --e sobre--> ENTIDADE <--referencia-- post
```

O autor do post normalmente nao sabe que a moeda existe e nunca cita contrato,
cashtag ou qualquer identificador. A moeda e o post sao dois ponteiros
independentes para a mesma coisa (um meme, uma foto, uma pessoa, uma frase).

Consequencias diretas:

- Buscar no X pelo endereco de contrato e inutil para este caso.
- Nao existe consulta retroativa possivel para o caso puramente visual: nao ha o
  que digitar numa busca. O post precisa ser **gravado quando acontece**.
- O join e feito pela entidade, e a representacao pratica dela e a imagem e o
  nome/ticker da moeda, que ja temos no catalogo.

### O que ja foi validado nesta sessao

- `api.fxtwitter.com` resolve perfil individual sem autenticacao, mas **nao tem
  busca** (`/search?q=` e interpretado como username, 404) e **nao tem
  comunidades** (ID real retorna `{"code":404,"message":"Not found"}`).
- Pagina de comunidade em `x.com` responde 200 porem entrega apenas o shell SPA:
  zero meta tag OpenGraph, zero `<title>`. Com UA `Twitterbot` responde 404.
- Conclusao: qualquer feed de posts em tempo real exige **GraphQL autenticado**.
  Nao ha atalho gratuito. Esta e a feature que justifica pagar esse custo; o card
  de perfil nao justificava.

### Por que o match nao e o problema

Calculo que dispensa indice, vector DB ou aproximacao:

- pHash e um inteiro de 64 bits. Comparacao = um XOR + um popcount.
- CPU moderna faz ~10^9 popcounts por segundo.
- 10 imagens novas por segundo contra 5.000 moedas em memoria = 50.000
  comparacoes por segundo, ~0,005% de um nucleo.

Forca bruta em memoria resolve. Multi-index hashing (dividir o hash em 4 bandas
de 16 bits) so passa a valer acima de centenas de milhares de moedas, tres ordens
de grandeza acima do nosso universo.

O custo real esta em (a) ter o stream de posts e (b) baixar e decodificar cada
imagem. Nao em comparar.

### Medicoes reais (2026-07-29)

Spike executado fora do repositorio, com PIL + numpy (ambos ja disponiveis na
maquina; nenhuma dependencia nova foi necessaria para medir).

Robustez do pHash contra transformacoes sinteticas, imagem real hospedada no X:

| Transformacao | pHash | dHash |
|---|---|---|
| JPEG q90 / q70 / q50 | 0 / 2 / 0 | 0 |
| resize 50% / 25% | 0 | 0 |
| crop 5% / 10% / 20% | 2 / 6 / 14 | 7 / 17 / 36 |
| texto sobreposto | 12 | 7 |
| espelhado | 34 | 7 |
| imagem diferente | 34 | 36 |

Pares reais fornecidos (imagem da moeda no dexscreener x midia original do post,
obtida via `api.fxtwitter.com/{user}/status/{id}` sem autenticacao):

| Par | pHash | dHash | min |
|---|---|---|---|
| WOLVES x @vladtenev | 14 | 18 | 14 |
| FEFER x @paoloardoino | 10 | 17 | 10 |
| stable x @paoloardoino | 18 | 16 | 16 |
| **negativos (cruzando os pares)** | **30-38** | **31-41** | - |

Conclusoes que alteram o plano:

1. **Limiar inicial ~22, nao 6.** O valor conservador que este documento trazia
   antes teria descartado os tres pares reais. Positivos reais chegam a 18;
   negativos aleatorios comecam em 30.
2. **dHash e complementar, nao redundante.** Texto sobreposto: pHash 12, dHash 7.
   Crop 10%: pHash 6, dHash 17. A regra e o **minimo dos dois**, nunca a
   intersecao.
3. **Espelhamento zera o pHash** (34, igual a imagem aleatoria). Guardar tambem o
   hash da versao espelhada da moeda. Custo zero em runtime.
4. **Imagem de moeda nao e recorte, e re-render.** Degrada mais que o teste
   sintetico previa, por isso os positivos ficaram em 10-18 e nao em 0-6.
5. **A distribuicao negativa medida e otimista.** Sao imagens aleatorias. O risco
   real e imagem *parecida*: memecoin e visualmente aglomerado (centenas de sapo,
   cachorro, pepe). O piso de falso positivo so aparece rodando contra o catalogo
   inteiro. E o objetivo do Bloco 0.

## Objetivo

Emitir, no feed de alertas, um evento do tipo:

> Possivel causa: `@himgajria` postou ha 2 min uma imagem que casa com a moeda
> `$BEAR` (distancia de hash 3). Conta com 180K seguidores.

Requisitos:

- Latencia entre o post existir e o alerta sair: alvo abaixo de 10s.
- O alerta e **evidencia**, nunca veredito. O texto precisa dizer "possivel
  causa".
- Falso positivo custa um clique; falso negativo custa a operacao. Calibrar para
  recall, com controle de ruido por limiar e nao por conservadorismo cego.

## Tipos de sinal

Tres sinais independentes, em ordem decrescente de precisao.

### Sinal 1 - Follow (deterministico, precisao maxima)

Quando uma conta monitorada **passa a seguir** uma conta de meme que ja tem o
contrato publicado (bio, post fixado ou nome), a associacao e exata: o CA e uma
string, e a moeda quase certamente ja esta no catalogo.

- Nao envolve match difuso nenhum. E `LIKE` no CA.
- Deteccao: `friends_count` do batch de perfis muda -> buscar `Following`
  daquela conta -> perfis novos -> extrair CA da bio/nome/pinned.
- Alerta: "@toly passou a seguir @burniesender ($SENDER)".
- Volume baixissimo, precisao altissima. **E o primeiro que eu construiria**
  depois do match de imagem, e talvez antes.

### Sinal 2 - Imagem (pHash/dHash)

Coberto pelas medicoes acima. Limiar inicial ~22 sobre o minimo dos dois hashes.

### Sinal 3 - Termo (texto do post x nome/ticker)

O post usa uma palavra que da nome a uma moeda. Caso real: Sam Altman escreveu
*"what if we name the next model goblin"* e a GOBLIN Coin subiu forte.

Este e o sinal mais ruidoso e exige as regras de desempate da secao seguinte.

## Decisoes confirmadas

- Match por **pHash de imagem** como sinal primario; nome/ticker como sinal
  secundario.
- Fingerprint das moedas calculado **uma vez** e persistido; recalculado apenas
  quando `imageUrl` muda.
- Indice de moedas mantido **em memoria** no worker, reconstruido no boot.
- Ingestao via `ListLatestTweetsTimeline` (uma lista privada com as contas
  monitoradas), nao via polling por perfil.
- Alerta comeca **admin-only**. A calibracao de limiar acontece com admin vendo
  match real no feed, nao com tabela silenciosa que ninguem olha.
- **A validacao real do match acontece em producao admin-only, nao em
  experimento previo.** Montar pares historicos (imagem do post + imagem da
  moeda) exigiria lembrar de moedas antigas e caçar os posts correspondentes na
  mao; e trabalho manual que nao vai ser feito. Decisao consciente: assumir o
  custo de infra antes da prova completa, compensando com pool inicial pequeno.
- **Pool inicial deliberadamente pequeno**: 20-40 contas, 1-2 sessoes, uma lista.
  Se a tese nao funcionar com 30 contas, nao funciona com 1000. O numero de
  contas e variavel de calibracao, nao parametro fixo.

## Fora de escopo (decisao registrada, nao esquecimento)

- **Moeda nova (recem-lancada).** Os terminais ja mostram o post de origem
  porque quem cria a moeda linka o post. Nao ha valor a adicionar.
- **Comunidades do X.** Sem fonte publica; exigiria GraphQL so para nome e
  contagem de membros. Nao compensa.
- **Explicacao retroativa e marcacao no chart.** Mesmo motor, produto diferente.
  Fica para depois do tempo real funcionar, reutilizando os posts ja gravados.
- **Embedding visual (CLIP) e LLM multimodal.** So se o Bloco 0 provar que pHash
  nao basta. Muda a conta de custo inteira.
- **Monitorar likes, follows e mudanca de PFP.** Nao serve a este objetivo.
- **Deploy automatico de moeda a partir de post.** Nao e nosso produto.

## Arquitetura

```
[X GraphQL autenticado]
   |  ListLatestTweetsTimeline (1 request por ciclo)
   v
[x-ingestion-worker]  <- pool de sessoes, proxy fixo por sessao, rate limit
   |  normaliza instructions -> posts
   |  resolve retweet -> post original (midia) + retuitador (alcance)
   v
[x_post] + [x_post_media]  (retencao curta, ex. 48h)
   |
   |  fila de imagens
   v
[image-fingerprint-worker]  -> baixa variante small, decodifica, pHash + dHash
   |
   v
[x_post_media_fingerprint]
   |
   |                         [token_image_fingerprint]  <- calculado do catalogo
   |                                    |
   v                                    v
[match-worker]  ---- indice em memoria (BigInt64Array de hashes de moeda) ----
   |  hamming <= limiar  ou  match textual raro
   v
[x_token_match_event]  -> dedupe -> feed de alertas / socket
```

### Componentes

**1. Pool de sessoes X**

Dimensionamento inicial: **20-40 contas monitoradas, 1-2 sessoes, uma lista**.
Nao e limitacao tecnica, e reducao deliberada de risco e custo enquanto o codigo
e novo e a tese nao foi provada. Escala depois, com evidencia.

- Cada sessao = `auth_token` + `ct0` de uma conta real, obtidos por login manual
  no navegador. Automatizar o login (`onboarding/task.json`) nao compensa por
  causa do Arkose captcha.
- Um proxy residencial **fixo por sessao**. Cookie saindo de IPs diferentes mata
  a conta rapido.
- Headers obrigatorios: bearer publico do web client, `x-csrf-token` igual ao
  cookie `ct0`, `x-twitter-auth-type: OAuth2Session`, `x-twitter-active-user`,
  e `x-client-transaction-id` assinado.
- `queryId` e `features` extraidos do bundle `main.{hash}.js` no boot. Hardcodar
  garante quebra em semanas. Erro 400 nomeia a flag faltante.
- Rate limit lido de `x-rate-limit-remaining` / `-reset`, nunca chutado. Token
  bucket por sessao x endpoint.
- 401/403 = quarentena imediata da sessao, nunca retry.

**2. Ingestao e normalizacao**

- Resposta de timeline vem em `data...timeline.instructions[]`, tipo
  `TimelineAddEntries`, com o post em
  `entries[].content.itemContent.tweet_results.result`.
- `result.__typename` pode ser `Tweet` **ou** `TweetWithVisibilityResults`; neste
  segundo caso o post real esta em `.tweet`. Nao desembrulhar = perder
  silenciosamente todo post com aviso de visibilidade.
- **Retweet precisa ser resolvido.** No caso do urso, o sinal foi um retweet: a
  midia vem do post original, mas o alcance relevante e o do retuitador. Gravar
  os dois lados.
- Dedupe por id de post.

**3. Pipeline de imagem**

- Baixar a variante `?name=small`. pHash trabalha com downsample de 32x32, entao
  thumbnail da o mesmo resultado com uma fracao da banda.
- Calcular pHash (DCT) e dHash (gradiente) por imagem. Dois hashes independentes
  reduzem falso positivo sem custo relevante.
- Requer dependencia nova de decodificacao (`sharp` ou equivalente). Hoje o
  repositorio nao tem nenhuma.

**4. Fingerprint das moedas**

- Fonte: `imageUrl` do catalogo, ja populado pela fila de metadados sociais
  existente (`src/services/robinhood-social-metadata-queue.js`).
- Mesmo pipeline de hash das imagens de post.
- Texto: tokens normalizados de nome e simbolo, com peso por raridade. Termo
  comum ("bear", "dog", "moon") nao pode disparar sozinho.
- Recalculo apenas quando `imageUrl` muda.

**5. Matcher**

- Indice em memoria: array de hashes das moedas vivas + mapa para identidade.
- Para cada imagem de post: hamming contra todo o array, coleta candidatos
  abaixo do limiar.
- Para cada texto de post: lookup no indice invertido de tokens raros.
- Reconstroi o indice no boot e incrementalmente quando o catalogo muda.

## Modelo de dados

Esboco, sujeito a revisao no bloco correspondente. Nenhuma tabela existente e
alterada.

```sql
-- contas monitoradas
x_tracked_account(
  id, screen_name, rest_id, followers, tier, enabled,
  added_reason, added_at, last_seen_post_at
)

-- posts observados, retencao curta
x_post(
  post_id PK, author_rest_id, author_screen_name, author_followers,
  text, lang, posted_at, retweet_of_post_id, engagement_snapshot JSONB,
  ingested_at
)

x_post_media(
  post_id, media_index, media_url, PRIMARY KEY (post_id, media_index)
)

x_post_media_fingerprint(
  post_id, media_index, phash BIGINT, dhash BIGINT, computed_at,
  PRIMARY KEY (post_id, media_index)
)

-- fingerprint das moedas
token_image_fingerprint(
  chain, token_address, source_image_url, phash BIGINT, dhash BIGINT,
  computed_at, PRIMARY KEY (chain, token_address)
)

-- resultado
x_token_match_event(
  id, chain, token_address,
  post_id,                      -- null quando match_kind = 'follow'
  match_kind,                   -- 'image' | 'text' | 'follow'
  hamming_distance,             -- so para 'image'
  matched_terms TEXT[],         -- so para 'text'
  followed_screen_name,         -- so para 'follow'
  author_rest_id, author_followers, token_market_cap, mcap_rank,
  matched_at, alerted BOOLEAN DEFAULT FALSE,
  admin_label,                  -- 'good' | 'bad' | null, calibracao do Bloco 5
  UNIQUE NULLS NOT DISTINCT (chain, token_address, post_id, match_kind)
)

-- estado para detectar novos follows por delta
x_account_follow_state(
  rest_id PK, friends_count, checked_at
)
```

Retencao: `x_post`, `x_post_media` e `x_post_media_fingerprint` com TTL curto
(sugestao 48h). `x_token_match_event` permanente, e o historico de aprendizado.

## Controle de ruido

Sem isso a feature morre por desuso. Cortes aplicados desde o primeiro dia:

- **Hamming** para imagem: partir de ~22 sobre o **minimo** de pHash e dHash,
  medido nos pares reais, e apertar com os rotulos acumulados na fase admin-only.
  Limiar apertado cedo demais nunca dispara e nao gera dado.

### Regra de desempate por market cap (sinal de termo)

Uma palavra generica casa com dezenas de moedas. Quando Sam Altman escreveu
"goblin", existiam varias GOBLIN; abaixo de ~20k de mcap sao dezenas de
homonimos sem liquidez.

Regra:

- **Piso de market cap** (sugestao inicial: US$ 20k) abaixo do qual a moeda nao
  entra no ranking de forma alguma.
- Entre as que passam do piso, alertar apenas **a de maior market cap**. Uma
  moeda por match, nao um ranking.
- Ausencia de moeda acima do piso = nenhum alerta.

Justificativa: o mercado concentra o fluxo numa moeda so, a que ja tem liquidez
e visibilidade. Alertar a cauda de homonimos gera ruido e nao e onde o volume
vai. Alertar tres candidatas transfere para o usuario uma decisao que o proprio
mercado ja tomou, e no tempo de resposta que essa feature exige isso e pior que
nao alertar. A mesma regra vale para match de imagem quando a mesma imagem e
usada por varias moedas.

As demais candidatas continuam gravadas em `x_token_match_event` com o
`mcap_rank` correspondente, para auditoria e calibracao, apenas sem gerar
alerta.
- **Alcance minimo da conta** (nao e qualquer conta; e figura carimbada).
- **Moeda viva**: filtrar rugged, sem liquidez, volume morto.
- **Texto so com termo raro**: nome generico nao dispara sozinho.
- **Dedupe** por `(moeda, post)` e por `(moeda, entidade)` numa janela. O mesmo
  urso repostado 40 vezes gera um alerta, nao 40.
- **Exigir concordancia dos dois hashes** (pHash e dHash) para o limiar mais
  frouxo.

## Custo estimado

| Item | Estimativa | Observacao |
|---|---|---|
| Proxies residenciais | US$ 200-500/mes em regime; **US$ 30-60/mes** no pool
  inicial de 1-2 sessoes | custo dominante |
| Contas X | US$ 2-15 por conta, com churn | 1-2 contas no inicio; queimam e
  repoe-se |
| Banda de imagem | baixa | variante `small`, ~10 img/s |
| Compute de match | irrelevante | 0,005% de um nucleo |
| Manutencao de engenharia | o mais caro | X muda `queryId` e a rotina de
  `transaction-id` sem aviso |

Ordem de grandeza em regime: US$ 150-400/mes de infra, mais horas recorrentes de
engenharia. O compute nao aparece na conta.

Ordem de grandeza para provar a tese, com pool inicial pequeno: **US$ 50-80/mes**.
E o valor que se aceita gastar antes de ter prova de que o match funciona.

## Blocos de execucao

Cada bloco respeita o limite de 500 linhas alteradas e termina com lint, testes
aplicaveis, revisao de diff e relatorio. Nenhum bloco comeca sem autorizacao.

### Bloco 0 - Robustez do pHash (GATE, sem infra, sem trabalho manual)

Objetivo: descobrir o **orcamento de distancia** antes de gastar com proxy e
contas.

Nao usa pares historicos. Usa as imagens de moeda que ja estao no catalogo
(`imageUrl`), aplica as transformacoes que acontecem no mundo real e mede quanto
o hash se afasta do original:

| Transformacao | Por que importa |
|---|---|
| Recompressao JPEG (q 90/70/50) | toda imagem passa por isso |
| Resize (varias resolucoes) | variantes do X e do catalogo |
| Recorte 5% / 10% / 20% | quem faz a moeda recorta a foto |
| Texto sobreposto | ticker escrito por cima e comum |
| Espelhamento horizontal | caso conhecido de falha do pHash |

- Script isolado no padrao `scripts/*-probe`, fora do caminho de producao.
- Saida: distribuicao de hamming por tipo de transformacao, para pHash e dHash.
- Criterio: se recompressao e resize ficarem abaixo de ~4 e recorte de 10%
  abaixo de ~10, o limiar e utilizavel e seguimos. Se recorte leve ja estourar,
  **parar** e reavaliar com embedding visual, que muda a conta de custo.

O que este bloco **nao** prova: que um post real de uma conta grande casa com uma
moeda real. Isso so o Bloco 5 prova, em producao admin-only. O que ele prova e o
cenario de falha mais provavel e mais barato de descobrir.

Sem dependencia de X. Sem imagem baixada na mao.

### Bloco 1 - Fingerprint das moedas

- Tabela `token_image_fingerprint` e migracao.
- Worker que consome `imageUrl` do catalogo e calcula pHash/dHash.
- Dependencia nova de decodificacao de imagem.
- Testes: normalizacao do hash, idempotencia, recalculo em troca de imagem.

Independe totalmente do X. Ja deixa o lado das moedas pronto.

### Bloco 2 - Sessao X e probe de list timeline

- Script de probe: autentica com uma sessao, extrai `queryId` do bundle, chama
  `ListLatestTweetsTimeline` de uma lista de teste, imprime rate limits reais.
- Mede o custo verdadeiro antes de comprometer arquitetura.
- Nao integra com nada. Read-only.

### Bloco 3 - Ingestao continua

- Pool de sessoes com bucket por endpoint e quarentena.
- Normalizador de timeline (incluindo `TweetWithVisibilityResults` e retweet).
- Tabelas `x_tracked_account`, `x_post`, `x_post_media`.
- Worker dedicado, desligado por default via env.

### Bloco 4 - Fingerprint de imagens de post

- Fila de download com variante `small`.
- `x_post_media_fingerprint`.
- Reaproveita o codigo de hash do Bloco 1.

### Bloco 4b - Sinal de follow

Independente do pipeline de imagem e pode ser feito antes dele.

- `UsersByRestIds` em batch para as contas monitoradas, detectando delta de
  `friends_count` (tabela `x_account_follow_state`).
- Ao detectar incremento, buscar `Following` daquela conta e diferenciar.
- Para cada perfil novo seguido: extrair CA de nome, bio e post fixado.
- Casar o CA contra o catalogo. Match exato, sem limiar.

Menor volume e maior precisao de todos os sinais. Se o tempo for curto, este
entrega valor antes do match de imagem.

### Bloco 5 - Matcher com feed admin-only

Este e o bloco onde a tese e realmente validada.

- Indice em memoria e busca por hamming.
- Indice invertido de termos raros.
- Grava `x_token_match_event`.
- **Saida visivel apenas para admin**, com o match completo: imagem da moeda,
  imagem do post, distancia, conta, alcance, horario.
- Limiar propositalmente frouxo no comeco. E mais barato apertar depois do que
  descobrir que nunca dispara.
- Admin marca match como bom ou ruim; esse rotulo e o dado de calibracao.

Feed de admin em vez de tabela silenciosa porque tabela ninguem olha. A
calibracao vem de ver match real todo dia.

### Bloco 6 - Liberacao para usuarios

- Aperta o limiar com base nos rotulos acumulados no Bloco 5.
- Liga a emissao para o feed geral e o socket.
- Dedupe e limites de frequencia.
- Texto do alerta como evidencia, com link do post e distancia do match.

### Blocos futuros (sem ordem definida)

- Explicacao retroativa e marcacao no chart, reusando `x_post` gravado.
- Embedding visual para os casos que pHash nao pega.
- Auto-curadoria da lista de contas por taxa de acerto.

## Riscos e questoes abertas

1. **Cobertura de contas e ilimitada por natureza.** Elon a gente grava; a conta
   de 40K seguidores que disparou o pump de ontem a gente nao sabia que
   precisava gravar. Nao ha solucao fechada. Mitigacao parcial: registrar a
   conta de origem sempre que um pump for explicado, deixando a lista se
   auto-curar por evidencia. A metrica de saude da feature e **cobertura**, nao
   precisao.
2. **Match nao e causa.** A moeda pode ter subido por outro motivo e o post ser
   coincidencia. O produto precisa comunicar isso ou vai treinar o usuario a
   confiar em correlacao.
3. **Dependencia externa hostil.** X nao tem contrato, SLA nem versionamento.
   Quebra sem aviso e vira incidente de producao.
4. **Risco operacional e de ToS.** Contas banidas, IPs bloqueados. Uso viola os
   termos do X. Decisao consciente registrada aqui.
5. **Degradacao do pHash** com recorte agressivo, espelhamento, texto sobreposto
   ou "mesmo assunto, outra foto". Bloco 0 mede exatamente isso.
6. **Spam de alerta** se o limiar ficar frouxo. A fase admin-only do Bloco 5
   existe para absorver isso antes de chegar em usuario.
7. **A tese so e provada gastando.** Nao existe experimento previo barato que
   demonstre "post real casa com moeda real": montar pares historicos exigiria
   lembrar de moedas antigas e caçar os posts na mao, trabalho manual que nao vai
   ser feito. O Bloco 0 mata o modo de falha mais provavel (pHash fragil demais),
   mas o resto so aparece com o pipeline rodando. Mitigacao: pool inicial de
   20-40 contas e 1-2 sessoes, US$ 50-80/mes, para que o valor em risco antes da
   prova seja pequeno.

## Pontos importantes

- O Bloco 0 e um **gate real**, nao formalidade, mas e um gate **parcial**. Ele
  custa poucas horas, roda com imagens que ja estao no banco e mata o cenario de
  falha mais provavel: pHash que nao aguenta recorte e recompressao. Se recorte
  de 10% ja estourar o limiar, o caminho barato nao existe e a feature passa a
  depender de embedding visual, com outra ordem de custo. O que ele nao cobre e
  se post real casa com moeda real; isso so o Bloco 5 responde.
- **A validacao final acontece em producao admin-only.** Isso e decisao
  consciente, nao descuido: nao ha experimento previo viavel para essa parte. O
  contrapeso e o pool pequeno, que mantem o valor em risco na casa de dezenas de
  dolares por mes ate haver evidencia.
- Os Blocos 1 e 2 sao **independentes entre si**. O Bloco 1 nao toca no X e pode
  ser feito enquanto a decisao sobre contas e proxies ainda esta aberta.
- O indice de match em memoria e barato ate escala muito maior que a nossa. Nao
  otimizar antes de existir problema medido.
- Nenhum bloco altera ingestao, catalogo ou alertas existentes ate o Bloco 6.
  Ate la, tudo e aditivo e desligavel por env.
- O card de perfil do X ja em producao usa `api.fxtwitter.com` e **nao compartilha
  infraestrutura** com este plano. Sao caminhos independentes; um nao quebra o
  outro.
