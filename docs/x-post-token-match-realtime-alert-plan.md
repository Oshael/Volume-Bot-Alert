# X post to token match realtime alert plan

Documento de decisao e execucao para construir o alerta em tempo real que cruza
posts de contas conhecidas do X contra as moedas ja existentes no catalogo,
usando imagem (hash perceptual), nome/ticker (texto do post e OCR da imagem) e
**convergencia de tema entre varias contas** como chave de match, e emite no feed
a possivel causa de um pump antes ou durante ele. Alpha 100% deterministico, sem
IA.

Este documento e a fonte de verdade para continuar o trabalho sem depender do
contexto da conversa.

Data inicial: 2026-07-29.

Requisito de escala revisado em 2026-08-14: **500+ contas monitoradas ao mesmo
tempo**, com uma consulta global da timeline agregada iniciada a cada **200ms**.
Nao usar X API paga nem comprar o feed de outro provedor que faça scraping.

## Status

- Revisao 2026-08-13: taxonomia de sinais expandida (tiers de perfil, Sinal 3b de
  OCR, Sinal 4 de tendencia); alpha fixado como **deterministico, sem IA**.
- Implementacao 2026-08-13: **Blocos 0 e 1 concluidos** no repo do bot (branch
  `Robinhood-Implementation`). Ver "Blocos de execucao" para o estado de cada um.
  - Bloco 0 (gate) rodou contra o catalogo real: gate **passa** com as ressalvas
    de crop agressivo e espelhamento (ambas ja previstas). Modulo de hash duravel
    em `src/utils/image-fingerprint.js`.
  - Bloco 1: tabela `token_image_fingerprint` (stage123), worker isolado no grupo
    `x-match` **desligado por default**; nada roda em producao ate ligar o flag e
    aplicar a migracao.
  - Bloco 2 (probe read-only, `src/utils/x-timeline-probe.js`): **viabilidade da
    camada X fechada contra dados reais**, com 1 conta descartavel + IP de casa,
    sem proxy. Verificado ao vivo:
    - **Cookies de sessao bastam** (`auth_token` + `ct0` + bearer publico + csrf):
      `ListLatestTweetsTimeline` responde 200. **`x-client-transaction-id` NAO e
      exigido** para leitura hoje -- o principal risco tecnico caiu.
    - Rate-limit real medido: **500 req / 15 min** por sessao nesse endpoint.
    - Realtime = **polling de lista por um pool de sessoes**, nao stream. O
      endpoint agrega os membros: monitorar 500 contas numa lista nao produz 500
      requests. A carga escala com a frequencia global de poll e com o numero de
      listas, nao com o numero de membros dentro da lista.
    - Cadencia operacional requerida: **1 request global a cada 200ms = 5 req/s
      = 4.500 req/15min**. Com 15 sessoes, a distribuicao uniforme consome 300
      requests/sessao/janela (60% do limite medido). Dez sessoes consumiriam 450
      (90%) e nao sao capacidade de producao confortavel.
    - Estrutura do feed: ~41% retweets (resolucao obrigatoria), ~22% com foto
      (feed do Bloco 4), **replies filtradas** pelo endpoint de lista (gap de
      cobertura consciente).
    - **Following vem newest-first** (confirmado com 4 follows controlados) ->
      Bloco 4b barato (le pagina 1, follows novos no topo; sem diff completo).
- Implementacao 2026-08-14: Bloco 3 chegou ao endpoint de re-seed (3.5a), mas
  **3.3 e 3.4 foram reabertos** depois de auditoria contra o plano:
  - 3.3 agora desabilita 401/403 ate re-seed e impede que `proxy_url` configurada
    caia silenciosamente em conexao direta. A recuperacao automatica de
    `queryId` foi concluida em corte corretivo: le o manifesto autenticado,
    resolve `bundle.LoggedInMain`, extrai a operacao sem executar bundle,
    persiste em `x_list` e tenta uma vez de novo em 400/404. O transporte real
    de proxy continua pendente.
  - 3.4 agora polla a cada 5s por default, isola erro por lista e aplica backoff
    de 60s, mas esse desenho **nao atende 200ms**: tem piso de 1s, recarrega pool
    e listas em cada ciclo, persiste dentro do hot path e descarta ticks enquanto
    `draining`. A refatoracao obrigatoria foi dividida em 3.4a-3.4d.
  - 3.5a ganhou unicidade concorrente por `x_session.label` (stage125). A
    extensao de browser continua pendente.
- 1 conta X descartavel em uso para os probes (home IP, sem proxy). Nenhum proxy
  contratado ainda.
- Experimento push 2026-08-23: `src/utils/x-push-latency-probe.js` instrumenta
  dois perfis Chrome descartaveis via CDP, sem publicar nem consultar o X. Mede
  `inicio CreateTweet -> Push Messaging/Notification` com gate default de 200ms
  (registrando tambem o delta contra o ACK) e
  denuncia qualquer timeline polling observado. Resultado real ainda pendente.
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

- **Cadencia de aquisicao:** iniciar uma consulta global da lista a cada 200ms
  enquanto o worker e a fonte estiverem saudaveis. Isto e cadencia de polling,
  nao promessa de que o X exponha ou entregue cada post em ate 200ms.
- **Latencia ponta a ponta:** manter o alvo inicial abaixo de 10s e medir
  separadamente `created_at -> primeira observacao -> fingerprint -> alerta`.
  A cadencia de 200ms reduz apenas a parcela de espera do coletor.
- **Escala inicial de producao:** 500+ contas publicas na mesma lista agregada.
  Adicionar membros ate a capacidade da lista nao pode multiplicar requests.
- **Fonte:** GraphQL web autenticado. X API paga e feeds comerciais de terceiros
  ficam explicitamente fora da solucao.
- O alerta e **evidencia**, nunca veredito. O texto precisa dizer "possivel
  causa".
- Falso positivo custa um clique; falso negativo custa a operacao. Calibrar para
  recall, com controle de ruido por limiar e nao por conservadorismo cego.

## Tipos de sinal

Os sinais se organizam em dois eixos: **pontual** (um post basta) vs **agregado**
(a forca vem da convergencia de varios posts), e **por tier de perfil** (nem todo
perfil tem direito a disparar sozinho). Nenhum sinal abaixo precisa de IA: todos
sao deterministicos (string, hash, contagem). A convergencia *abstrata* -- varios
posts apontando pra mesma entidade sem compartilhar termo nem imagem -- seria a
unica que exigiria multimodal, e esta fora de escopo por ora (ver "Fora de
escopo").

### Tiers de perfil

A mesma lista de perfis tem dois usos simultaneos sobre o mesmo fluxo:

- **Tier carimbado -> direito a alerta single-post.** Para essas contas, um unico
  post basta: se o cara posta sobre uma moeda (follow, imagem, ou ticker na
  legenda), a probabilidade condicional de mover o mercado ja e alta o bastante
  pra alertar. Marcado no campo `tier` de `x_tracked_account`.
- **Todos os perfis (inclusive os carimbados) -> alimentam o alerta de
  tendencia.** Uma conta ruidosa demais pra disparar sozinha ainda *conta* pra
  medir convergencia de tema. O mesmo `x_post` alimenta os dois consumidores.

### Sinal 1 - Follow (deterministico, precisao maxima, single-post)

Quando uma conta monitorada **passa a seguir** uma conta de meme que ja tem o
contrato publicado (bio, post fixado ou nome), a associacao e exata: o CA e uma
string, e a moeda quase certamente ja esta no catalogo.

- Nao envolve match difuso nenhum. E `LIKE` no CA.
- Deteccao: `friends_count` do batch de perfis muda -> buscar `Following`
  daquela conta -> perfis novos -> extrair CA da bio/nome/pinned.
- Alerta: "@toly passou a seguir @burniesender ($SENDER)".
- Volume baixissimo, precisao altissima.

### Sinal 2 - Imagem (pHash/dHash, single-post)

Coberto pelas medicoes acima. Limiar inicial ~22 sobre o minimo dos dois hashes.
Dispara sozinho apenas para o tier carimbado; para os demais, contribui pra
tendencia.

### Sinal 3 - Termo (single-post ou tendencia)

O post usa uma palavra que da nome/ticker a uma moeda. Duas origens do termo, com
o mesmo tratamento a jusante (normalizacao + gate de raridade + desempate por
mcap):

- **3a - texto do post** (legenda, ticker escrito). Caso real: Sam Altman escreveu
  *"what if we name the next model goblin"* e a GOBLIN Coin subiu forte.
- **3b - texto embutido na imagem (OCR + stemming).** O termo decisivo as vezes
  mora *dentro* da imagem, nao na legenda -- o normalizador de timeline nunca ve
  essa string sem OCR. Caso real: a $Plumber (@PlumberORG) subiu ~400% num swarm
  sobre "plumbing"; o elo legivel era o letreiro "Plumbing School" no meme. Exige
  **stemming**, nao match exato: "plumbing", "plumber" e o token `Plumber` so se
  encontram no radical `plumb`. O OCR e utilitario barato (CPU, self-hosted), nao
  a IA cara.

Termo comum ("bear", "dog", "moon") nunca dispara sozinho -- ver gate de raridade
no "Controle de ruido".

### Sinal 4 - Alerta de tendencia (agregado, deterministico enquanto lexical)

Nenhum post isolado e a causa; a causa e a **convergencia** -- varias contas
monitoradas tocando no mesmo termo numa janela curta (sugestao inicial: 5h). Foi
o que de fato explicou a $Plumber: dezenas de perfis grandes comentando o tema ao
mesmo tempo, nao um post unico.

- Generaliza o modelo de entidade do doc: em vez de um ponteiro pra entidade, sao
  *muitos*, e a contagem/velocidade e a forca do sinal.
- Fluxo: extrai termo por post (texto + OCR) -> agrega por **contas distintas** na
  janela -> dispara por **aceleracao** de um termo (nao contagem absoluta) ->
  resolve termo -> moeda -> alerta.
- Antecede o pump: o swarm de atencao vem antes do retail e do preco. Detectado
  enquanto se forma, fica a frente do movimento.
- Deterministico **enquanto a convergencia for lexical** (um termo compartilhado,
  de texto ou OCR). Convergencia sem termo comum exigiria embedding/multimodal e
  esta fora de escopo.

## Decisoes confirmadas

- Match por **pHash de imagem** como sinal primario; nome/ticker como sinal
  secundario.
- **Alpha 100% deterministico, sem IA.** Single-post + alerta de tendencia se
  resolvem com string, hash, OCR (utilitario barato) e contagem. Multimodal/LLM
  nao e requisito do produto; fica adiado e, se um dia entrar, e gatilhado por
  evento (nao por post) -- ver "Fora de escopo".
- **Direito a single-post e por tier de perfil.** So o tier carimbado dispara com
  um post so; os demais perfis contribuem apenas pro alerta de tendencia. Campo
  `tier` em `x_tracked_account`.
- **Sinal de termo tem duas origens** -- texto do post e texto embutido na imagem
  (OCR) -- convergindo no mesmo indice de termos raros, com stemming.
- **Alerta de tendencia e sinal de primeira classe**, deterministico enquanto
  lexical: convergencia de um termo entre contas distintas numa janela, medida por
  aceleracao.
- Fingerprint das moedas calculado **uma vez** e persistido; recalculado apenas
  quando `imageUrl` muda.
- Indice de moedas mantido **em memoria** no worker, reconstruido no boot.
- Ingestao via `ListLatestTweetsTimeline` (uma lista privada com as contas
  monitoradas), nao via polling por perfil.
- **Uma requisicao global por tick.** Sessoes se revezam para executar a mesma
  timeline; nao existe um poll simultaneo por conta monitorada nem por sessao.
- **Sem X API paga e sem revendedor de feed.** O custo cresce com contas e posts
  justamente nos modelos recusados; o produto assume conscientemente o custo de
  manutencao e o risco operacional do scraping proprio.
- Alerta comeca **admin-only**. A calibracao de limiar acontece com admin vendo
  match real no feed, nao com tabela silenciosa que ninguem olha.
- **A validacao real do match acontece em producao admin-only, nao em
  experimento previo.** Montar pares historicos (imagem do post + imagem da
  moeda) exigiria lembrar de moedas antigas e caçar os posts correspondentes na
  mao; e trabalho manual que nao vai ser feito. Decisao consciente: assumir o
  custo de infra antes da prova completa, mas separar o bootstrap funcional do
  ensaio operacional com o pool completo.
- **Cobertura operacional inicial:** 500+ contas em uma lista. O bootstrap de
  codigo pode usar 1-2 sessoes em cadencia lenta para provar corretude, mas nao
  valida nem representa a capacidade de producao de 200ms.

## Fora de escopo (decisao registrada, nao esquecimento)

- **Moeda nova (recem-lancada).** Os terminais ja mostram o post de origem
  porque quem cria a moeda linka o post. Nao ha valor a adicionar.
- **Comunidades do X.** Sem fonte publica; exigiria GraphQL so para nome e
  contagem de membros. Nao compensa.
- **Convergencia abstrata (embedding/CLIP/LLM multimodal).** So seria necessaria
  pra pegar swarm/tema *sem* termo compartilhado (varios posts apontando pra mesma
  entidade sem palavra nem imagem em comum). Nao entra no alpha deterministico. Se
  um dia entrar, e **gatilhada por evento** (pico de tendencia ou anomalia de
  mercado), nunca rodada por post -- rodar multimodal no firehose e economicamente
  inviavel. O caso $Plumber nao precisa disso: tinha o termo legivel.
- **Explicacao retroativa e marcacao no chart.** Mesmo motor, produto diferente.
  Fica para depois do tempo real funcionar, reutilizando os posts ja gravados. E
  tambem o **caminho de gatilho** de qualquer sinal conceitual futuro: partir do
  pump/tendencia detectada e olhar pra tras, em vez de tentar explicar todo post.
- **Monitorar likes, follows e mudanca de PFP.** Nao serve a este objetivo.
- **Deploy automatico de moeda a partir de post.** Nao e nosso produto.

## Arquitetura

```
[X GraphQL autenticado]
   |  ListLatestTweetsTimeline (1 request global iniciado a cada 200ms)
   v
[head-poll producer]  <- pool de sessoes, proxy fixo, budget e concorrencia limitada
   |  resposta bruta; hot path nao toca no banco
   v
[dedupe + ingestion queue]  <- seen-set em memoria, backpressure e recovery lane
   |  normaliza instructions -> somente posts novos
   |  resolve retweet -> post original (midia) + retuitador (alcance)
   v
[x_post] + [x_post_media]  (retencao curta, ex. 48h)
   |
   |  fila de imagens
   v
[image-fingerprint-worker]  -> baixa variante small, decodifica, pHash + dHash + OCR
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

O mesmo fluxo de posts alimenta um **segundo consumidor** em paralelo ao
match-worker: um **agregador de tendencia**. Ele coleta os termos extraidos por
post (texto + OCR), conta por contas distintas numa janela deslizante (~5h) e
dispara quando a *aceleracao* de um termo cruza o limiar; ai resolve termo ->
moeda pelo mesmo indice. Single-post (match-worker) e tendencia (agregador) sao
dois consumidores do mesmo `x_post`/`x_post_media`, com tiers de perfil diferentes
(ver "Tipos de sinal").

### Componentes

**1. Pool de sessoes X**

Dimensionamento operacional: **500+ contas monitoradas, uma lista e 15 sessoes
ativas**, com sessoes adicionais apenas como reposicao de falha. A lista agrega
os perfis; aumentar de 500 membros nao altera a frequencia de request enquanto
couber na mesma lista.

Capacidade medida para a timeline:

- 200ms = 5 req/s = 4.500 requests por janela de 15 minutos.
- 15 sessoes = 300 requests por sessao (60% de 500).
- O scheduler reserva inicialmente 20% de cada bucket (100 requests). Com 400
  requests utilizaveis por sessao, **12 sessoes saudaveis sao o minimo
  matematico** para sustentar 200ms; 15 e o alvo operacional.
- Abaixo de 12 sessoes saudaveis, o worker aumenta o intervalo (reduz a
  frequencia) automaticamente conforme `remaining/reset`; nunca consome a
  reserva para fingir que o SLA esta saudavel. A degradacao precisa gerar alerta
  operacional.
- O limite e capacidade tecnica, nao garantia contra enforcement. Varias sessoes
  consultando continuamente a mesma lista continuam sendo um padrao correlacionavel.

- Cada sessao = `auth_token` + `ct0` de uma conta real, obtidos por login manual
  no navegador. Automatizar o login (`onboarding/task.json`) nao compensa por
  causa do Arkose captcha.
- **Sessoes vivem em `x_session` (tabela), nao em env.** Escalar = inserir linha.
  Env foi so do probe.
- **Rotacao de credencial e auto-curada, nao manual:**
  - `ct0` o X rotaciona sozinho e devolve o novo no header `Set-Cookie`. O worker
    le o `Set-Cookie`, atualiza `x_session.ct0` e o `x-csrf-token`. Headless na
    VPS, sem intervencao. Esse e o "sessao troca de tempos em tempos" -- resolvido.
  - `auth_token` NAO rotaciona no relogio; so morre quando a conta e flagada/
    deslogada (raro, semanas). Morte -> 401/403 -> sessao desabilitada; o pool
    segue nas outras. Reacquirir exige login e re-seed (manual, sem bot).
  - `queryId` e extraido do bootstrap web autenticado quando falta e re-extraido
    uma vez em 400/404; valor novo e persistido em `x_list.query_id`. O parser
    nao executa JavaScript externo: le o manifesto de chunks e o descritor da
    operacao em `bundle.LoggedInMain`. `features` continuam no conjunto medido;
    400 com o mesmo `queryId` permanece erro visivel para ajuste do conjunto.
- **Proxy fixo por sessao = ancora de identidade.** O IP de nascimento (login) e
  o IP de uso (scraping) tem que ser o mesmo, senao o X mata a conta. Logo:
  - **Loga-se JA atraves do proxy da conta** (anti-detect browser -- Multilogin/
    GoLogin/AdsPower/Dolphin -- 1 perfil por conta com proxy+fingerprint proprios).
    O IP de casa nunca toca a conta.
  - Login roda **na maquina do operador** (unico lugar com browser); scraping roda
    **headless na VPS**, os dois saindo pelo **mesmo proxy**. A costura e o DB.
  - `auth_token` e `httpOnly` (JS de pagina nao le) -> re-seed via **extensao de
    browser** (permissao `cookies`) que colhe `auth_token`+`ct0` do perfil e faz
    POST num endpoint admin -> insere linha em `x_session`. Um clique, nao editar
    env. (Bloco 3.5.)
  - **Estado do bootstrap:** o transporte de proxy ainda nao foi validado contra
    um proxy contratado. Ate isso acontecer, qualquer sessao com `proxy_url`
    falha fechada; nunca sai direto pelo IP do worker por fallback silencioso.
- Modelo de proxy: **estatico/ISP por-IP fixo**, nao rotativo por-GB (polling de
  alta frequencia queima GB). Ver "Custo estimado".
- Headers necessarios (medido no Bloco 2): bearer publico do web client,
  `x-csrf-token` igual ao cookie `ct0`, `x-twitter-auth-type: OAuth2Session`,
  `x-twitter-active-user`. O **`x-client-transaction-id` NAO foi exigido** para
  ler `ListLatestTweetsTimeline` (2026-08-13) -- tratar como opcional ate um 404
  provar o contrario, nao construir o gerador especulativamente.
- Rate limit lido de `x-rate-limit-remaining` / `-reset`, nunca chutado. Token
  bucket por sessao x endpoint, com reserva operacional configuravel.
- 401/403 = desabilita a sessao ate re-seed, nunca retry por relogio.

**2. Ingestao e normalizacao**

- **Hot path e produtor, nao pipeline inteiro.** O tick de 200ms apenas escolhe
  sessao/lista, inicia o request e entrega a resposta a uma fila limitada.
  Normalizacao, dedupe persistente e escrita no banco rodam em consumidores
  separados e nao seguram o relogio do coletor.
- Scheduler usa relogio monotonicamente corrigido, nao `setInterval` com guard
  `draining`. Inicia no maximo um request por tick global e aceita concorrencia
  em voo limitada (default inicial 3) para que RTT acima de 200ms nao derrube a
  cadencia. Fila cheia ou fonte lenta causa degradacao controlada, nunca memoria
  sem limite.
- Pool, lista ativa e `queryId` ficam em cache no hot path. Refresh de banco roda
  fora do tick (periodico e sob invalidacao por erro), sem `listActive()` a cada
  200ms.
- Head poll usa pagina pequena (alvo inicial `count=5-10`) e seen-set/LRU de
  `post_id` antes do banco. Respostas repetidas nao geram 25-50 upserts/s sem
  post novo.
- Recovery lane e separada: depois de downtime, saturacao da pagina ou cursor
  ausente, pagina com lote maior ate reencontrar o ultimo ID conhecido. Recovery
  nao altera silenciosamente a cadencia nem compartilha o budget sem limite.
- Erros sao classificados pelo dono: 401/403 remove a sessao e tenta outro tick;
  429 esgota apenas o bucket da sessao ate `reset`; 400/404 pode atualizar
  `queryId` uma vez; 5xx/rede aplica backoff do request/fonte. Um erro de sessao
  nao congela a lista inteira por 60s.
- Telemetria minima: ticks planejados/iniciados/perdidos, intervalo real, RTT,
  requests em voo, profundidade/idade da fila, posts vistos/novos/repetidos,
  budget por sessao, sessoes saudaveis e duracao de recovery.

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
- Decodificacao ja disponivel: `sharp` **ja e dependencia do repositorio**
  (confirmado 2026-08-13). Nao ha dependencia nova de decodificacao. O pHash/dHash
  vivem em `src/utils/image-fingerprint.js`. A unica dependencia nova real do plano
  e o **OCR** (Bloco 4).

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

### Fronteira de deploy e isolamento

Decisao (2026-08-13): **tudo no mesmo repo do bot (monorepo), sem repo/servico
separado.** O acoplamento e bidirecional -- o tracker le o catalogo (imageUrl,
nome/ticker, mcap, liquidez) e escreve no feed/socket -- entao um repo separado so
trocaria queries internas por um contrato a manter, alem de duplicar DB,
migrations, `db:schema-check`, config, deploy e governanca. Reusa-se tudo isso.

Isolamento vem do **processo**, nao do repo:

- A camada hostil (Bloco 2/3: sessoes, proxies, GraphQL, timeline) roda como
  **worker/systemd proprio**, desligavel por env. Se o X quebra ou o scraper
  crasha, ingestao e alertas do bot seguem vivos.
- A **costura** entre scraper e o resto e `x_post`/`x_post_media`: o scraper
  escreve posts crus; os consumidores (fingerprint, OCR, tendencia, matcher, feed)
  leem dali. Bloco 2/3 = produtor isolavel; Blocos 1/4/4b/4c/5/6 = consumidores que
  vivem com o bot porque ja precisam do catalogo e do feed.
- Promover pra infra fisica separada (VPS propria por IP/ToS) ou trocar a costura
  por uma fila fica pra quando houver motivo concreto -- move-se **um processo**,
  sem reescrever o resto.

## Modelo de dados

Esboco, sujeito a revisao no bloco correspondente. Nenhuma tabela existente e
alterada.

```sql
-- contas monitoradas (quem voce observa)
x_tracked_account(
  id, screen_name, rest_id, followers, tier, enabled,
  added_reason, added_at, last_seen_post_at
)

-- sessoes de scraping (identidades proprias, quem observa) + proxy fixo.
-- escalar = inserir linha; nao confundir com x_tracked_account
x_session(
  id, label, auth_token, ct0, proxy_url, enabled,
  quarantined_until, last_used_at
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
  post_id, media_index, phash BIGINT, dhash BIGINT,
  ocr_text TEXT, ocr_tokens TEXT[],   -- termos normalizados extraidos da imagem
  computed_at,
  PRIMARY KEY (post_id, media_index)
)

-- fingerprint das moedas (implementado: stage123)
token_image_fingerprint(
  chain, token_address, source_image_url,
  phash BIGINT, dhash BIGINT,
  phash_mirror BIGINT, dhash_mirror BIGINT,  -- hash da versao espelhada
  ok BOOLEAN DEFAULT TRUE,                    -- false = falha de download/decode
  computed_at, PRIMARY KEY (chain, token_address)
)

-- resultado
x_token_match_event(
  id, chain, token_address,
  post_id,                      -- null quando match_kind e 'follow' ou 'trend'
  match_kind,                   -- 'image' | 'text' | 'follow' | 'trend'
  hamming_distance,             -- so para 'image'
  matched_terms TEXT[],         -- so para 'text' e 'trend'
  followed_screen_name,         -- so para 'follow'
  trend_accounts INT,           -- so para 'trend': contas distintas na janela
  author_rest_id, author_followers, token_market_cap, mcap_rank,
  matched_at, alerted BOOLEAN DEFAULT FALSE,
  admin_label,                  -- 'good' | 'bad' | null, calibracao do Bloco 5
  UNIQUE NULLS NOT DISTINCT (chain, token_address, post_id, match_kind)
)

-- estado para detectar novos follows por delta
x_account_follow_state(
  rest_id PK, friends_count, checked_at
)

-- observacoes de termo por post, alimenta o alerta de tendencia
x_post_term(
  post_id, term, source,          -- source: 'text' | 'ocr'
  author_rest_id, observed_at,
  PRIMARY KEY (post_id, term, source)
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
- **Gate de raridade vale tambem pro termo de OCR.** Meme e cheio de texto ("gm",
  "wagmi", "100x", "boyz"); so termo raro (radical incomum) conta. "plumb" passa;
  "school", "today" morrem no gate.

### Controle de ruido do alerta de tendencia

- **Aceleracao, nao contagem absoluta.** Crypto twitter sempre tem tema morno de
  fundo; o gatilho e a *derivada* -- convergencia subita -- nao um piso fixo de
  mencoes.
- **Amplificacao != convergencia.** 15 contas retuitando o mesmo post = 1 ponteiro,
  nao 15. Contar **expressao independente por conta distinta**; reusar a resolucao
  de retweet ja prevista na ingestao. Sem isso, um unico viral vira falso swarm.
- **Segundo portao: a maioria dos temas nao tem moeda.** "Todo mundo falando do
  FOMC" e burst real, zero moeda. A resolucao termo->moeda filtra isso depois do
  gatilho (mais raro) do burst.
- **Janela e limiar sao calibracao** (sugestao 5h), nao constante -- apertar com os
  rotulos da fase admin-only.

## Custo estimado

| Item | Estimativa | Observacao |
|---|---|---|
| Proxies **estaticos/ISP** (por-IP fixo) | ~$1,5-3/IP/mes budget; ~$3-6/IP/mes
  mid | **15 sessoes ativas = ~$22,5-90/mes**, fora reposicoes. 1 IP dedicado por
  conta, sem compartilhar |
| ~~Proxies rotativos por-GB~~ | evitar | polling de alta freq. queima GB;
  worst-case $500-1500/mes. O "$200-500" antigo assumia esse modelo errado |
| Contas X | US$ 2-15 por conta, com churn | mais custo de setup que recorrente;
  queimam e repoe-se |
| Banda de imagem | baixa | variante `small`, ~10 img/s |
| Compute de match | irrelevante | 0,005% de um nucleo |
| Manutencao de engenharia | o mais caro | X muda `queryId` e a rotina de
  `transaction-id` sem aviso |

Ordem de grandeza em regime (15 contas, proxies ISP por-IP): **~$50-150/mes**
de infra (proxies + reposicao de conta), mais horas recorrentes de engenharia. O
compute nao aparece na conta. (O "$150-400" anterior assumia proxy por-GB.)

Nao entram nesta estimativa X API paga nem assinatura de fornecedor de feed;
ambos foram recusados como modelo de custo.

## Modo bootstrap (corretude sem capacidade operacional)

Objetivo desta fase: montar e testar **corretude funcional** com 1-2 sessoes
proprias em cadencia lenta. Esse bootstrap nao valida 200ms. A validacao de carga
e uma etapa separada com o scheduler novo, respostas controladas e, por fim, o
pool operacional.

**Duravel vs. perecivel.**

- **Duravel (constroi agora, nao apodrece):** normalizacao, pHash/dHash, OCR,
  extracao de termo, indice de match, agregador de tendencia, dedup, schema, feed
  admin-only, fingerprint das moedas. Independe do X e da escala.
- **Perecivel (a camada que fala com o X):** `queryId`/`features` do bundle, o
  shape do GraphQL, e -- **se/quando o X passar a exigir** -- a assinatura do
  `x-client-transaction-id` (hoje nao e gate de leitura, ver Bloco 2). Quebra
  sozinha em semanas -- nao da pra "congelar e esperar". Constroi-se com extracao
  automatica no boot e **valida-se junto com o uso**, nao antes.

**Bootstrap funcional = 1-2 sessoes; cobertura do produto = 500+ perfis.** Uma
lista com os 500 perfis pode ser usada desde o bootstrap porque membros nao
multiplicam requests. Com 1-2 sessoes a cadencia precisa respeitar o budget e sera
mais lenta; ela testa parsing, dedupe e match, nao a latencia de producao.

**Regra que torna a escala trivial.** Sessoes e proxies sao **linhas numa tabela**
(`x_session`: `auth_token`, `ct0`, `proxy_url`, `enabled` por sessao), lidas em
runtime. O pool itera sobre as linhas -- escalar = inserir linhas, zero deploy.
Entra no Bloco 3.

**Cuidados.**

- **Nao use a conta que voce preza** -- scraping viola ToS e queima contas; use
  descartaveis.
- **Do IP de casa voce amarra teu IP a atividade.** Um proxy residencial baratinho
  ($30-60/mes) ja remove isso e ainda testa o binding proxy-por-sessao de verdade.
- **No alpha (sessao nascida no IP de casa, sem proxy), rode o worker LOCAL** (mesma
  rede do login). **Nao suba essa sessao pra VPS pelada** -- o pulo IP-de-casa ->
  IP-de-datacenter e gatilho de ban. A migracao pra VPS vem junto com o proxy: reloga
  a conta *atraves do proxy* (nasce no proxy) e a VPS usa o mesmo proxy.
- **Nao confundir corretude com capacidade.** O mesmo codigo precisa rodar limpo
  com 1-2 sessoes em cadencia degradada e sustentar 200ms com 15; nao manter dois
  workers ou dois caminhos de ingestao.

## Blocos de execucao

Cada bloco respeita o limite de 500 linhas alteradas e termina com lint, testes
aplicaveis, revisao de diff e relatorio. Nenhum bloco comeca sem autorizacao.

Escopo do modo bootstrap -- o que da pra testar so com contas proprias:

| Bloco | O que | Testavel agora? |
|---|---|---|
| 0 | robustez do pHash (probe) | sim, sem infra |
| 1 | fingerprint das moedas | sim, independe do X |
| 2 | sessao X + probe do timeline | sim, 1 conta (home IP ou 1 proxy) |
| 3 | ingestao continua (config-driven) | corretude com 1-2; carga com fakes;
  200ms real requer pool operacional |
| 4 / 4b / 4c | imagem+OCR / follow / tendencia | sim |
| 5 | matcher + feed admin-only | sim -- aqui voce ve se "monitora legal" |
| 6 | liberacao pra usuarios | nao -- precisa de escala + rotulos do Bloco 5 |

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

- Script isolado no padrao `src/utils/*-probe.js` (o repo nao tem `scripts/`;
  ha varios `*-probe` nesse diretorio), fora do caminho de producao.
- Saida: distribuicao de hamming por tipo de transformacao, para pHash e dHash.
- Criterio: se recompressao e resize ficarem abaixo de ~4 e recorte de 10%
  abaixo de ~10, o limiar e utilizavel e seguimos. Se recorte leve ja estourar,
  **parar** e reavaliar com embedding visual, que muda a conta de custo.

**Resultado (2026-08-13, `src/utils/token-image-phash-probe.js`, 12 imagens do
catalogo real).** Gate **PASSA** na metrica `min(pHash,dHash)`:

- recompressao JPEG q90/70/50: mediana 0, p90 <= 1;
- resize 50%/25%: mediana 0, p90 <= 2;
- crop 10%: mediana 8 (dentro do orcamento ~10); crop 20%: mediana 20 (invade a
  faixa de negativos -- recorte agressivo continua fora do alcance do hash);
- texto sobreposto: mediana 4;
- piso de negativos (cross-token) comeca em **22**.

Separacao limpa: transforms realistas ficam <= 12, negativos comecam em 22 -- um
limiar ~16-18 sobre o minimo dos dois hashes separa bem. Ressalva confirmada: o
**espelhamento** zera o pHash (18-32, igual a negativo), por isso o Bloco 1 guarda
tambem o hash da versao espelhada da moeda. Amostra de 12 imagens: rodar com
`--limit` alto (500-1000) onde o catalogo e grande para ver o piso real de falso
positivo antes de investir em proxies/contas.

O que este bloco **nao** prova: que um post real de uma conta grande casa com uma
moeda real. Isso so o Bloco 5 prova, em producao admin-only. O que ele prova e o
cenario de falha mais provavel e mais barato de descobrir.

Sem dependencia de X. Sem imagem baixada na mao.

### Bloco 1 - Fingerprint das moedas [CONCLUIDO 2026-08-13]

- Tabela `token_image_fingerprint` via `src/utils/db-init-stage123.js` +
  declaracao em `runtime-schema.js`. Alem do esboco do "Modelo de dados", ganhou
  colunas `phash_mirror`/`dhash_mirror` (hash da versao espelhada, calculado com
  `sharp.flop()` sem 2o download) e flag `ok` para marcar falha de download/decode
  e nao re-tentar URL morta a cada ciclo.
- Model `src/models/token-image-fingerprint.js`: `selectCandidates` (recompute so
  quando `last_image_url` muda -- `IS DISTINCT FROM` -- ou apos backoff de falha),
  `upsertFingerprint`, e round-trip do hash de 64 bits por `BIGINT` assinado
  (`BigInt.asIntN/asUintN`; Hamming e sempre em memoria, nunca em SQL).
- Worker `src/services/token-image-fingerprint-worker.js`: grupo isolado
  `x-match`, **desligado por default** (`X_MATCH_FINGERPRINT_ENABLED=false`).
  Script `npm run start:worker:x-match`.
- Sem dependencia nova (`sharp` ja existia); reusa o modulo de hash do Bloco 0.
- Testes: unit da orquestracao do worker (dupla orientacao, marcacao de falha,
  iteracao de batch) + integracao do `selectCandidates` (recompute-on-change e
  backoff).

Independe totalmente do X. Ja deixa o lado das moedas pronto. Para ativar em
producao: aplicar a stage123 no DB e subir o worker no grupo `x-match`.

### Bloco 2 - Sessao X e probe de list timeline [CONCLUIDO 2026-08-13]

- `src/utils/x-timeline-probe.js`: read-only, env-driven (credenciais no `.env`,
  nunca commitadas), 3 camadas -- auth de sessao, `ListLatestTweetsTimeline`
  (com analise de estrutura do feed) e `Following` (ordem). Nao integra com nada.
- Veredictos (ver "Status" para o detalhe): cookies bastam, transaction-id nao e
  gate de leitura, rate-limit 500/15min, realtime = pool, retweets ~41%, foto
  ~22%, replies filtradas, Following newest-first.
- O `queryId` foi obtido do Network tab (o scrape do bundle no probe e best-effort
  e falhou; a extracao robusta foi concluida no corte corretivo 3.3 de
  2026-08-14). `features` default aceitas sem 400.

### Experimento paralelo - Web Push sem API [PROBE PRONTO 2026-08-23]

`src/utils/x-push-latency-probe.js` nao publica e nao consulta o X. Ele conecta
via CDP a dois Chromes ja abertos, mede no mesmo relogio monotonicamente
`inicio do CreateTweet -> primeiro Push Messaging/Notification` e registra
separadamente o delta contra o ACK. O gate default e p95 <= 200ms, sem perda.

Preparacao manual, sempre com contas descartaveis:

1. Iniciar dois Chromes com `--remote-debugging-address=127.0.0.1`, portas
   distintas (ex. 9222/9223) e `--user-data-dir` nao-default distintos.
2. Logar a conta publicadora no primeiro perfil. No segundo, logar a observadora,
   seguir a primeira, ativar `All posts` e permitir notificacoes do browser.
3. Manter uma aba `x.com` aberta em cada perfil e executar:

   ```bash
   X_PUSH_PUBLISHER_CDP=http://127.0.0.1:9222 \
   X_PUSH_OBSERVER_CDP=http://127.0.0.1:9223 \
   X_PUSH_OUTPUT=/tmp/x-push-probe.jsonl \
   npm run x:push-probe
   ```

4. Esperar `armed`, publicar manualmente um post e aguardar `push_match` antes
   do seguinte. `Ctrl+C` emite o resumo. `observer_poll_detected` prova consulta
   de timeline concorrente; os metadados do push mostram se o evento identifica
   o post ou e apenas um tickle que exige hidratacao.

CDP da controle integral do perfil: bind somente em localhost e nunca usar conta
valiosa. O probe nao prova escala de 500 contas; primeiro decide existencia,
conteudo e latencia do canal. O recorder remove endpoints/tokens de registro do
push antes de escrever no terminal ou JSONL, abre o arquivo sem seguir symlink e
forca permissao `0600`. No worker continuo, preferir que o Playwright inicie um
perfil dedicado com `launchPersistentContext`, sem expor porta CDP TCP.

### Bloco 3 - Ingestao continua

Bloco grande -> fatiado (cada slice <=500 linhas, commit proprio):

- **3.1 [CONCLUIDO 2026-08-13] Data layer.** stage124 (`x_session`, `x_list`,
  `x_tracked_account`, `x_post`, `x_post_media`) + schema-check. `x-post.savePost`
  transacional e idempotente por `post_id`; `x-session.listActive` filtra
  desabilitada/quarentena. Aditivo e inerte. Teste de integracao (dedupe + filtro).
- **3.2 [CONCLUIDO 2026-08-13] Normalizer (puro).** `instructions` -> posts: unwrap
  `TweetWithVisibilityResults`, resolve retweet (midia do original + alcance do
  retuitador), extrai midia, dedupe. Nucleo duravel, teste unit com fixtures reais.
- **3.3 [REABERTO] Pool + client.** Pool, token bucket e `ct0` self-heal estao
  implementados. Correcao de 2026-08-14: 401/403 desabilita ate re-seed e proxy
  configurado falha fechada; `queryId` tem auto-extract, persistencia e retry
  unico em 400/404, validado contra o bundle real. Pendente: transporte real via
  `ProxyAgent`.
- **3.4 [REABERTO] Worker + wiring.** Loop, persistencia e grupo isolado
  `x-ingest` estao implementados e desligados por default. Correcao de
  2026-08-14: default de 5s, erro isolado por lista e backoff de 60s. A auditoria
  para o requisito de 200ms mostrou que baixar `intervalMs` nao basta: o codigo
  atual tem piso de 1s, `setInterval` + `draining`, refresh de pool/lista por
  ciclo, persistencia sequencial dos mesmos 20 posts e backoff que pode congelar
  a lista por erro de uma sessao. Refatoracao dividida para manter cada corte
  <=500 linhas:
  - **3.4a [PENDENTE] Scheduler e hot path.** Relogio monotonicamente corrigido
    de 200ms, um start global por tick, concorrencia em voo limitada, cache de
    lista/pool/`queryId` e refresh fora do tick. Se houver mais de uma lista, o
    scheduler distribui a cadencia global; nunca cria 5 req/s por lista sem
    decisao explicita. Testes unitarios com relogio e chamadas lentas protegem
    cadencia, limite de concorrencia e degradacao.
  - **3.4b [PENDENTE] Fila e dedupe antes do banco.** Separar produtor de
    consumidores, seen-set/LRU por `post_id`, persistir somente itens novos,
    backpressure limitada e shutdown com drain. Estender
    `tests/x-ingestion-worker.test.js`; integracao existente continua protegendo
    idempotencia persistente.
  - **3.4c [PENDENTE] Head leve + recovery.** `count` pequeno no fluxo de 200ms;
    catch-up paginado com lote maior apos downtime, pagina cheia ou gap, sem
    bloquear o head poll. Testar que nao perde posts nem duplica efeitos na
    transicao recovery -> head.
  - **3.4d [PENDENTE] Budget, falhas e observabilidade.** Reserva inicial de 20%
    por sessao, cadencia automatica conforme sessoes saudaveis, 401/403/429/5xx
    classificados sem backoff indevido da lista, metricas de tick/RTT/fila/budget
    e ensaio sustentado com 15 sessoes fake. Criterio: aproximar 5 starts/s mesmo
    com RTT >200ms, respeitar o limite em voo e nunca ultrapassar budget.
- **3.5 [PARCIAL] Re-seed de sessao.** Endpoint admin implementado (3.5a), com
  unicidade de `label` via stage125 e upsert seguro sob concorrencia. Pendente:
  extensao de browser e seu contrato de autenticacao.

### Bloco 4 - Fingerprint de imagens de post

- Fila de download com variante `small`.
- `x_post_media_fingerprint` (phash/dhash **e** OCR: texto + termos normalizados).
- Reaproveita o codigo de hash do Bloco 1.
- OCR self-hosted (Tesseract/PaddleOCR ou equivalente); dependencia nova, roda em
  CPU sobre a imagem ja decodificada. Nao e a IA cara.

### Bloco 4b - Sinal de follow

Independente do pipeline de imagem e pode ser feito antes dele.

- **`Following` vem newest-first** (confirmado no Bloco 2 com 4 follows
  controlados): follows novos aparecem no topo da pagina 1. Deteccao barata --
  guardar o topo conhecido por conta e ler so a pagina 1; o que esta acima do
  ultimo topo sao os follows novos. Sem paginar nem diffar a lista inteira. Em
  producao, diffar um top-N pequeno contra cache (cobre follow multiplo/unfollow).
- Gatilho de `friends_count` via `UsersByRestIds` em batch (tabela
  `x_account_follow_state`) e **requisito para 500+ perfis**, nao mera
  otimizacao. Os perfis sao verificados em cohorts/batches; `Following` pagina 1
  so e consultado para a conta cujo contador mudou. Esse scheduler tem budget e
  fila proprios e nunca entra no hot path de 200ms dos posts.
- Para cada perfil novo seguido: extrair CA de nome, bio e post fixado.
- Casar o CA contra o catalogo. Match exato, sem limiar.

Menor volume e maior precisao de todos os sinais. Se o tempo for curto, este
entrega valor antes do match de imagem.

### Bloco 4c - Alerta de tendencia (agregador de termos)

Deterministico, independente do sinal de follow; consome o que os Blocos 3 e 4
extraem.

- Grava `x_post_term` (termos de texto + OCR por post).
- Janela deslizante (~5h) contando contas distintas por termo; dispara por
  **aceleracao**, nao contagem absoluta.
- Dedup de amplificacao: reusa a resolucao de retweet pra nao contar 15
  repostagens como 15 ponteiros.
- Resolve termo -> moeda pelo indice de termos raros; desempate por mcap.
- Nenhuma dependencia de IA.

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
   termos do X. Estar abaixo de 500 requests/15min evita apenas o 429 daquele
   bucket; nao torna inofensivo o padrao correlacionado de varias sessoes
   consultando a mesma lista. Decisao consciente registrada aqui.
5. **Degradacao do pHash** com recorte agressivo, espelhamento, texto sobreposto
   ou "mesmo assunto, outra foto". Bloco 0 mede exatamente isso.
6. **Spam de alerta** se o limiar ficar frouxo. A fase admin-only do Bloco 5
   existe para absorver isso antes de chegar em usuario.
7. **A tese so e provada rodando.** Nao existe experimento previo barato que
   demonstre "post real casa com moeda real": montar pares historicos exigiria
   lembrar de moedas antigas e caçar os posts na mao, trabalho manual que nao vai
   ser feito. O Bloco 0 mata o modo de falha mais provavel (pHash fragil demais),
   mas o resto so aparece com o pipeline rodando. Mitigacao: validar corretude
   com 1-2 sessoes em cadencia lenta e validar 200ms primeiro com carga simulada;
   ampliar para 15 sessoes so quando esses dois gates passarem.
8. **200ms pode nao produzir observacao em 200ms.** Cache e replicacao internos
   do X, RTT e processamento de midia fazem parte da latencia. Instrumentar as
   etapas e comparar cadencias antes de atribuir ganho ao aumento de requests.

## Pontos importantes

- O Bloco 0 e um **gate real**, nao formalidade, mas e um gate **parcial**. Ele
  custa poucas horas, roda com imagens que ja estao no banco e mata o cenario de
  falha mais provavel: pHash que nao aguenta recorte e recompressao. Se recorte
  de 10% ja estourar o limiar, o caminho barato nao existe e a feature passa a
  depender de embedding visual, com outra ordem de custo. O que ele nao cobre e
  se post real casa com moeda real; isso so o Bloco 5 responde.
- **A validacao final acontece em producao admin-only.** Isso e decisao
  consciente, nao descuido: nao ha experimento previo viavel para essa parte. O
  contrapeso e separar o bootstrap funcional de 1-2 sessoes do ensaio operacional
  de 15, sem reduzir a cobertura pretendida de 500 perfis.
- **A lista agregada e a unidade de eficiencia.** Quinhentos perfis nao geram
  quinhentos polls; um unico head poll cobre todos. Polling por perfil, browser
  headless, varias listas equivalentes ou busca paralela aumentariam custo sem
  fonte comprovadamente mais rapida.
- **O worker atual de 5s nao vira um worker de 200ms trocando uma constante.** A
  separacao produtor/consumidor, dedupe antes do banco, concorrencia limitada,
  recovery e budget com reserva sao pre-condicoes de operacao.
- Os Blocos 1 e 2 sao **independentes entre si**. O Bloco 1 nao toca no X e pode
  ser feito enquanto a decisao sobre contas e proxies ainda esta aberta.
- O indice de match em memoria e barato ate escala muito maior que a nossa. Nao
  otimizar antes de existir problema medido.
- Nenhum bloco altera ingestao, catalogo ou alertas existentes ate o Bloco 6.
  Ate la, tudo e aditivo e desligavel por env.
- O card de perfil do X ja em producao usa `api.fxtwitter.com` e **nao compartilha
  infraestrutura** com este plano. Sao caminhos independentes; um nao quebra o
  outro.
