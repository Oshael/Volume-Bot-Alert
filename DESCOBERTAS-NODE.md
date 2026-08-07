# Nó próprio da Robinhood Chain — tudo que foi medido

Sessão de 26/jul/2026. Máquina: Ryzen 7 5800X (8c/16t), 32 GB RAM, NVMe.
Tudo aqui foi **medido**, não estimado. Onde houver suposição, está marcado.

---

## 0. TL;DR — as três coisas que importam

1. **O nó funciona e o estado bate com a dRPC.** T1 e T3 passaram; `eth_getLogs`
   devolve conteúdo byte a byte idêntico à dRPC, inclusive abaixo do piso do
   índice de logs. O snapshot da Titan é confiável.

2. **Você provavelmente não precisa de archive.** Preço e volume já vêm dentro
   do log (`sqrtPriceX96` no Swap V3, reservas no Sync V2). Se os buckets saem
   daí, o backfill vira **~2h** em vez de 3–13 dias, e o disco cai de ~4 TB/ano
   para algo pequeno. **Isso ainda depende de uma pergunta em aberto (seção 8).**

3. **O gargalo do projeto mudou de lugar.** Se archive for dispensável, o
   gargalo deixa de ser o nó e passa a ser o `COPY` no Postgres.

---

## 1. Resultados dos testes de aceitação

| Teste | Critério | Resultado |
|---|---|---|
| **T1** identidade | `eth_chainId` = `0x1237` | **PASS** |
| **T2** head | atraso ≤ 100 blocos | **PASS** — 3 blocos |
| **T3** archive | `eth_call` bloco 4.000.000 = valor da dRPC | **PASS** — idêntico |
| **T4** getLogs | funciona na lacuna do backfill | **PASS** — ver 1.1 |
| **T5** latência | p50 ≤ 32ms com concorrência 8 | **PASS** — 4,5ms |
| **T6** disco | ≤ 12 GB/dia | **PASS** — 10,56 GB/dia |

T3 usou o valor `0x…7f6b5dd08b0d0d13b0` no bloco 4.000.000, confirmado de forma
independente contra a dRPC. Isso descarta o pior modo de falha possível: o
snapshot da Titan divergir do consenso silenciosamente.

### 1.1 T4 — a dúvida que quase matou o projeto

O log do Nitro diz `Initialized log indexer firstblock=9,870,945`, mas a lacuna
do backfill começa em **3.871.041** — ~6M blocos abaixo. Parecia que o nó não
cobriria o discovery.

**Testado contra a dRPC e descartado:**

```
faixa (500 blocos)              local     dRPC      resultado
inicio da lacuna 3.871.041       2.373    2.373     IDENTICO
bloco 4.000.000                  7.085    7.085     IDENTICO
bloco 6.000.000                 16.868   16.868     IDENTICO
piso do indice 9.870.945        21.477   21.477     IDENTICO
acima do indice 12.000.000       8.626    8.626     IDENTICO

hash do conteudo (topics+data+txHash+logIndex): IDENTICO
```

O `firstblock` é só o alcance do índice **acelerado**. Abaixo dele o Geth varre
recibos — mais lento, porém completo. **Lição: não inferir cobertura de log de
inicialização.**

---

## 2. A descoberta principal — archive pode ser desnecessário

### 2.1 O que os logs já carregam

Amostra de 143.125 logs em 3 janelas (6M, 12M, 19,7M):

```
                  evento   ocorrencias      %   palavras no data
Transfer(addr,addr,uint)        73.346  51,2%          1  (valor)
                Swap(V3)        14.936  10,4%          5  (amount0, amount1,
                                                           sqrtPriceX96,
                                                           liquidity, tick)
Approval(addr,addr,uint)        10.540   7,4%          1
0x8619026a...                    5.886   4,1%         40  NAO IDENTIFICADO
0x205442d6...                    5.885   4,1%          2  NAO IDENTIFICADO
0x93485dcd...                    3.082   2,2%       1813  NAO IDENTIFICADO
0x40e9cecb...                    2.374   1,7%          6  NAO IDENTIFICADO
                Sync(V2)         2.051   1,4%          2  (reserve0, reserve1)
```

**O preço está dentro do log.** `sqrtPriceX96` no Swap V3, reservas no Sync V2.
Volume também. Para bucket de OHLC/volume, o log é auto-suficiente.

O único dado externo necessário é `decimals()`, que é **imutável** — pode ser
consultado em `latest`, não no bloco histórico. São ~5.333 contratos distintos,
uma vez só, ~16 mil chamadas no total.

### 2.2 O que isso derruba

| | Com archive | Sem archive |
|---|---|---|
| `eth_call` no backfill | 2,1 bilhões | ~16 mil |
| Tempo de RPC no backfill | 3–13 dias | **~2h** |
| Disco na VPS | 235 GB + 10,56 GB/dia (~4 TB/ano) | pequeno e estável |
| Gargalo | `eth_call` no nó | `COPY` no Postgres |

438M logs a 55.000 logs/s (chunk de 1.000 blocos) = ~2,2h.

### 2.3 Holders e saldos: derivados, não consultados

Saldo de carteira é `Transfer` aplicado numa tabela. Você já vai ingerir 51% dos
logs que são exatamente isso. **Não precisa de `balanceOf` nem de archive**, e
não precisa de retenção de 1 semana — a tabela guarda o estado atual e você
reconstrói qualquer data pelo replay.

### 2.4 Supply: derivável em quase tudo, mas NÃO 100%

Testado entre os blocos 19.600.000 e 19.650.000, 5 tokens:

```
token                                        bate?
0x5fc5360d0400a0fd4f2af552add042d716f1d168   SIM (exato)
0xd2af84a7bb68f5bb943a143b8ca3bfd57955801c   SIM (exato)
0x39dbed3a2bd333467115de45665cc57f813c4571   SIM (exato)
0xec9a0f118f9789994ffaa01d6775e765dce0ace4   SIM (exato)
0x0bd7d308f8e1639fab988df18a8011f41eacad73   NAO — 0,743 de 332 (0,22%)
   (WETH)
```

Três hipóteses de erro próprio foram testadas e **descartadas**:
- `0xdead` não reduz `totalSupply` (era erro meu, corrigido — resolveu 1 token)
- esse contrato **não emite** `Deposit`/`Withdrawal`
- não é off-by-one: o bloco inicial tem 0 transfers
- o saldo do `0x0` é zero nos dois blocos, então `Transfer` para `0x0` queima mesmo

Conclusão: o WETH tem caminho de mint/burn **silencioso** (provável bridge do
Orbit). Se os buckets usarem market cap, isso entra como erro de 0,22%.

**Solução barata:** registrar `totalSupply()` por hora daqui pra frente (~5 mil
chamadas/hora, custo desprezível) em vez de comprar archive pra reconstruir o
passado.

---

## 3. Performance medida

### 3.1 `eth_call` — teto real

```
 conc  batch  calls/s  p50/call   cpu%
    1      1      280      3.27    168%
    8      1     1351      4.53    801%
   16      1     1684      7.36   1128%
   32     25     1915     16.46   1196%   <- pico
```

- Pico **~1.900 calls/s** com CPU em ~1.200% de 1600% → **~160 calls/s por core**
- Batch JSON-RPC 25 dá ~1,14x. Batch 50+ não acrescenta.
- Passar de concorrência 32 não ajuda, só infla latência.
- `iostat` sob carga: `%util` 92%, 11k IOPS de 5 KB — disco perto do limite
  também, mas quem trava primeiro é CPU.

### 3.2 Aumentar cache do Nitro NÃO ajuda (resultado negativo)

```
cache default (600/2048/400  = ~3 GB)  : 1915 calls/s
cache alto    (6144/6144/2048 = ~14 GB) : 1916 calls/s
```

Ganho só em concorrência baixa (conc 1: 280→324). **No pico, nada.** Não pague
RAM extra na VPS esperando throughput.

### 3.3 `eth_getLogs` — chunk de 10k blocos é 3,5x mais lento que o ideal

O plano assume 3,23 logs/bloco. Na região densa são **47 logs/bloco**.

```
blocos |    logs |  MB | tempo | logs/s
   250 |    9885 |   7 | 0.17s | 55.800
  1000 |   41687 |  30 | 0.75s | 55.200   <- ponto ideal
  5000 |  208886 | 152 | 6.30s | 33.100
 10000 |  474953 | 338 | 30.0s | 15.800   <- o que o plano recomenda
```

Escalonamento superlinear ao contrário (10k deveria dar 8,5s). É pressão de GC
alocando a resposta gigante.

Custo de RAM de UMA chamada de 10k blocos: nó **+1,7 GiB** (e não devolve),
cliente **4,1x** o tamanho da resposta.

- **Chunk ideal ~1.000 blocos**, ou melhor: alvo por contagem de logs (~40k),
  ajustando a janela. A densidade varia 10x ao longo da lacuna (4,7 → 47).
- Filtrar `topic0` derruba 30s → 4,4s (filtro antes de materializar a resposta).

### 3.4 Sequencial vs aleatório: quase não muda

Hipótese de que o backfill sequencial teria localidade e seria bem mais rápido:
**falsa, só 1,1–1,2x.** Em archive cada bloco tem raiz de estado própria e o
PathDB guarda nós por versão — o reuso entre blocos vizinhos é pequeno.

### 3.5 Concentração de contratos

```
logs amostrados      280.481
contratos distintos    5.333
logs por contrato       52,6
top-10 contratos      47,2% de todos os logs
   (WETH 0x0bd7d3... sozinho = 25,7%)
```

Se o pipeline chamar `symbol()`/`decimals()`/`name()` por log, repete a mesma
chamada ~52 vezes em média. **Cache de metadados por contrato vale 4,8x, contra
2x de dobrar os cores.**

### 3.6 ERRO DE MEDIÇÃO que eu cometi (não confie em números antigos)

Um benchmark intermediário chamava `docker stats` (bloqueia ~2s) **dentro** da
janela cronometrada. Com 1.200 chamadas isso trava tudo em ~599 calls/s, que
apareceu idêntico em conc 8/16/32/64/128 e eu li como "teto do nó".

Sinal de alarme: número **exatamente igual** em vários níveis com CPU baixa e
errática. Os números da seção 3.1 são os corrigidos (`bench3.py`).

Consequência: a conclusão anterior de "disco é o gargalo, CPU é secundária"
estava errada. Disco está a 92% e NVMe local continua obrigatório, mas **quem
trava primeiro é a CPU**.

---

## 4. Armadilhas — onde o plano original erra

Estas quebram o teste **silenciosamente** (o nó "funciona" com dado errado ou
sincroniza do zero parecendo só lento):

1. **Config files: o path do doc devolve HTML.** `docs.robinhood.com/chain/*.json`
   devolve 535 bytes de `text/html` com HTTP 200. Qualquer path inexistente
   devolve 200 nessa docsite. Paths reais:
   ```
   https://docs.robinhood.com/chain-node-configs/robinhood-chain-info.json  (1563 B)
   https://docs.robinhood.com/chain-node-configs/robinhood-genesis.json  (626691 B)
   ```
   Validar com `jq -e .` e conferir `content-type`, não só o código HTTP.

2. **O tarball da Titan tem `data/` na raiz.** Extrair direto cria um nível
   fundo demais e o Nitro começa sync do genesis **sem erro**.
   Correto: `zstd -dc snap.tar.zst | tar -x --strip-components=1 -C $DATADIR`

3. **O container roda como `user`, não `nitro`.** uid 1000, home `/home/user`.
   Não existe `/home/nitro`. Montar em `/home/user/.arbitrum` e `chown -R 1000:1000`.

4. **`--persistent.chain=robinhood` é obrigatório.** O `chain-name` é
   `"Robinhood Chain"` mas o snapshot usa o diretório `robinhood`.

5. **DNS do provedor envenena `*.robinhood.com`** para `127.0.0.1`. `--resolve`
   no curl não resolve o `wss://feed…` dentro do Nitro. Precisa de
   `generateResolvConf=false` + resolv.conf fixo + `--dns` no docker run.

6. **Cloudflare derruba HTTP/2 em transferência longa** (`curl rc=92`, morreu aos
   11 GB de 142,6 GB). Usar `--http1.1` + laço externo com `-C -`.
   **NÃO usar `--retry` do curl junto com `-C -`**: o retry interno reabre o
   arquivo no offset do início da tentativa e regrava por cima. Isso encolheu o
   arquivo de 37,7 GiB para 13,0 GiB numa das tentativas.

7. **Duas flags sem as quais o nó nem sobe:**
   - `--execution.forwarding-target=null` (o doc chama de `--node.forwarding-target`,
     que **não existe** nessa versão)
   - `--execution.caching.state-scheme=path` (o snapshot é PathDB, o default do
     Nitro é `hash`)

8. **PathDB recusa consulta histórica até indexar** — `"state histories haven't
   been fully indexed yet"`. Não é falha de archive, é o indexador rodando.
   Levou ~2min30. Esperar `History indexer is recovered type=state`.

9. **WSL derruba a distro quando a última sessão fecha.** O container morre com
   `shutting down because of sigint` e exit 0 — parece bug do nó, é o systemd
   sendo desligado. Precisa de processo âncora do lado do Windows.

10. **Ratchet de memória.** O RSS sobe com uso e não volta (Go libera pro SO
    preguiçosamente). Foi de 5,1 GiB → 15 GiB. Restart recupera ~10 GB.
    Usar `GOMEMLIMIT`.

---

## 5. Arquitetura recomendada

### Fase de backfill (aqui no PC)

```
   PC                                     VPS do bot
   ┌────────────────────────┐             ┌──────────────┐
   │  no Nitro  :8547       │             │   Postgres   │
   │      ^ localhost       │             │              │
   │      | 0ms             │             │              │
   │  worker                │──────────>  │              │
   └────────────────────────┘  linhas     └──────────────┘
```

Worker **no PC**, colado no nó. Motivo: 837 GB de RPC cru e RTT residencial
dentro do laço mais quente. Escrevendo direto no Postgres do VPS.

- Upload medido: **228 Mbps**. Necessário: ~4 Mbps. Sem problema.
- IP público `<REDIGIDO>` (roteável, fora da faixa CGNAT).
- **Não abrir o 5432 pra internet.** Túnel (Tailscale/WireGuard/SSH).
- **`COPY` em lote, nunca `INSERT` por linha.** 438M round-trips pela internet
  seria inviável. Com lote de 5–10k linhas dá ~50 mil round-trips.
- **Checkpoint pra retomar.** 3 dias contínuos com Windows Update no meio —
  esse é o maior risco de quebrar a execução, não a rede.

### Regime permanente

```
   VPS do NO                        VPS do BOT
   ┌──────────────┐                 ┌────────────────────┐
   │  Nitro :8547 │ <────────────── │  workers + bot     │
   │              │  rede privada   │  Postgres          │
   └──────────────┘  2,8 Mbps       └────────────────────┘
```

Os workers **voltam pra VPS do bot**, como sempre estiveram. A única mudança no
pipeline é `RPC_URL`. Carga em regime:

```
860.557 blocos/dia x 18,7 logs/bloco = 16,1M logs/dia = 186 logs/s
sem cache de metadados : 894 calls/s  (47% da capacidade do no)
com cache de metadados : 186 calls/s  (10%)
trafego RPC            : ~30 GB/dia = 2,8 Mbps
```

- Os dois VPS na **mesma região**, de preferência com rede privada.
- **Manter a dRPC como fallback.** Se o VPS do nó cair, o bot para.

---

## 6. Specs de VPS

**Se archive for necessário:**

```
CPU     16 cores dedicados (nao vCPU compartilhada) — o gargalo real
RAM     32 GB — suficiente; 64 GB NAO compra throughput (medido)
DISCO   NVMe LOCAL, 500 GB p/ backfill, ~4 TB p/ 1 ano
        storage de rede corta 5-10x: sao 11k IOPS aleatorios de 5 KB
```

**Se archive não for necessário (provável):** disco pequeno e estável, sem state
history. Muda a ordem de grandeza do custo mensal.

**A decisão é reversível.** A Titan publica snapshot diário. Se daqui a dois
meses descobrir que precisa de archive, baixa de novo: ~1h de download + 15min
de extração. Não é uma porta que fecha.

---

## 7. Config que funciona

```bash
docker run -d --name rh-nitro --restart unless-stopped \
  --dns 1.1.1.1 --dns 8.8.8.8 \
  -e GOMEMLIMIT=28GiB \
  -v "$DATA":/home/user/.arbitrum \
  -v /data/rh/config:/home/user/config:ro \
  -p 127.0.0.1:8547:8547 -p 127.0.0.1:8548:8548 \
  offchainlabs/nitro-node:v3.11.2-3599aca \
    --chain.id=4663 \
    --chain.info-files=/home/user/config/robinhood-chain-info.json \
    --init.genesis-json-file=/home/user/config/robinhood-genesis.json \
    --persistent.chain=robinhood \
    --parent-chain.connection.url="https://lb.drpc.live/ethereum/$DRPC_KEY" \
    --parent-chain.blob-client.beacon-url="https://lb.drpc.live/eth-beacon-chain/$DRPC_KEY" \
    --execution.caching.archive \
    --execution.caching.state-scheme=path \
    --node.feed.input.url=wss://feed.mainnet.chain.robinhood.com \
    --execution.forwarding-target=null \
    --http.addr=0.0.0.0 --http.port=8547 \
    --http.api=net,web3,eth,arb \
    --http.vhosts='*' --http.corsdomain='*'
```

Caches ficam no default (testado: aumentar não muda nada).
Sem archive, remover `--execution.caching.archive` e limitar
`--execution.caching.state-history`.

**Do lado do cliente:** concorrência 32, batch JSON-RPC de 25, chunk de
`eth_getLogs` de ~1.000 blocos.

**Cuidado com nó podado:** o default guarda ~128 blocos de estado, e a chain faz
~10 blocos/s — isso é **13 segundos**. Se o worker atrasar meio minuto, quebra.
Dimensionar a janela em dias (7 dias ≈ 6M blocos), não em blocos.

---

## 8. O QUE FALTA DECIDIR — perguntas para responder no Mac

Estas decidem se você compra VPS de 4 TB ou de 500 GB.

### 8.1 Qual evento os buckets consomem?

Se for `Swap` (V2 ou V3) ou `Sync`, **tudo está dentro do log** e não precisa de
archive nem pro backfill. Verificar no código do pipeline qual `topic0` ele filtra.

Quatro eventos da amostra não foram identificados e somam ~12% dos logs — um
deles pode ser o que você usa:
```
0x8619026a...  4,1%  (40 palavras no data)
0x205442d6...  4,1%  (2 palavras)
0x93485dcd...  2,2%  (1813 palavras)
0x40e9cecb...  1,7%  (6 palavras)
```

### 8.2 Quais são as ~4,8 `eth_call` por log que o plano menciona?

Se forem `symbol()`/`decimals()`/`name()`, são **imutáveis** e viram cache de
~5.333 entradas. Se houver algo que precise de bloco histórico, aí archive volta
à mesa.

### 8.3 Os buckets precisam de market cap?

Se sim, o supply entra — e com ele os 0,22% de drift do WETH (seção 2.4).

### 8.4 O worker escreve em lote ou linha a linha?

Se for linha a linha, essa é a **única mudança de código realmente obrigatória**
para rodar do PC. Na VPS o banco era local e RTT era ~0; pela internet não é.

### 8.5 O VPS aceita instalar Tailscale?

Se não, dá pra fazer por SSH tunnel sem instalar nada.

---

## 9. Estado atual da máquina

```
container : Up, 0 reinicios
bloco     : 20.122.299 (no head)
datadir   : 235 GB
disco     : 582 GB livres de 1007 GB
RSS       : 12,3 GiB de 23,47 GiB
tarball   : 142,6 GB ainda em disco (pode apagar, recuperavel)
```

Ambiente: distro WSL2 **`rh-node`** (Ubuntu 24.04) com ext4.vhdx em
`F:\wsl\rh-node`, Docker Engine próprio dentro (isolado do Docker Desktop, que
tem os containers de produção `nitter` e `nitter-redis`).

Limpeza total: `wsl --unregister rh-node`.

Precisa do processo âncora do lado do Windows pra distro não cair:
```powershell
Start-Process wsl -ArgumentList "-d","rh-node","-u","root","--","sleep","infinity" -WindowStyle Hidden
```

---

## 10. Scripts (em `F:\wsl\`)

Todos criados no Windows → rodar `sed -i 's/\r$//'` antes de executar.

| Arquivo | O que faz |
|---|---|
| `setup-dns.sh` | wsl.conf + resolv.conf fixo (contorna o DNS envenenado) |
| `setup-docker.sh` | instala Docker CE + zstd, jq, bc |
| `download.sh` | baixa o snapshot com retomada e verifica SHA256 |
| `extract-and-run.sh` | extrai com `--strip-components=1` e chown |
| `run-node.sh` | sobe o container (config da seção 7) |
| `testes-t1-t3.sh` | T1 e T3 com diagnóstico dos 3 modos de falha |
| `suite-noturna.sh` | T2/T4/T5/T6 sem supervisão, gera RELATORIO.md |
| `bench3.py` | benchmark correto de `eth_call` (varredura + batch) |
| `verifica-t4.sh` | cruza contagem e hash de logs contra a dRPC |
| `chunk.sh` | mede tamanho/tempo por chunk de `eth_getLogs` |
| `tokens.py` | razão logs/contrato distinto |
| `eventos.py` | distribuição de eventos por `topic0` |
| `supply.py` | testa se `totalSupply` é derivável dos logs |
| `tune.sh` | sobe o nó com perfis de cache e mede |
| `rede.sh` | upload/download real e checagem de CGNAT |

Nota: `bench.py` e `bench2.py` existem mas **`bench2.py` tem o bug de
instrumentação da seção 3.6** — usar `bench3.py`.

---

## 11. Constantes

```
chain id            4663 = 0x1237     parent chain: Ethereum mainnet (1)
imagem              offchainlabs/nitro-node:v3.11.2-3599aca
snapshot API        https://snapshot.titandeployer.com/api/snapshots
                    https://snapshot.titandeployer.com/api/latest
checksum por arq.   https://dl.titandeployer.com/<arquivo>.sha256
WETH da chain       0x0bd7d308f8e1639fab988df18a8011f41eacad73
piso do log index   9.870.945
inicio da lacuna    3.871.041
head (26/jul)       ~20.122.299
densidade de logs   4,7/bloco em 3,87M ate 47/bloco em 9,87M
snapshot            142,6 GB comprimido -> 235 GB extraido
```

Uma chave dRPC serve os três endpoints:
`lb.drpc.live/{ethereum,eth-beacon-chain,robinhood}/<KEY>`
