# Radar: ranking de wallets, tokens e exploração de posições

Status conferido no checkout em 06/10/2026: Old/Recent unificados na tabela
Robinhood; Top Wallets, API e atualização por WebSocket implementados; feed
de compras/vendas por wallet e maiores altas com API, tabela e live disponíveis.
Faltam ativação/validação das altas em produção, detalhe completo
da wallet/posição e conclusão do trabalho de custo, escala e consistência do
Top Wallets descrito na seção 9. Implementação no repositório não comprova
ativação, cobertura histórica ou desempenho em produção.
Escopo solicitado em 16/09/2026. Este documento orienta a implementação futura;
sua criação não autoriza deploy, migrações ou execução de todas as etapas.

## 1. Objetivo e navegação

Reorganizar o Radar e permitir navegar do ranking até uma wallet e uma posição.
Manter o visual escuro e a linguagem visual atual do TrendScope. As imagens
fornecidas são referências de disposição e interação, não contratos de dados
nem pedidos para reproduzir todos os botões das plataformas de referência.

Layout desktop:

```text
Radar
├── Top Wallets — 50%             Maiores altas / tokens novos — 50%
│   UPNL: 24h / 7d / 30d / ALL    Idade até 24h; sem sparkline
└── Tokens — tabela única, largura inteira, filtros existentes

Clique na wallet → detalhe da wallet
                     ├── posições abertas / fechadas
                     ├── compras / vendas
                     ├── transfers / contrapartes
                     └── clique no token → detalhe wallet + token
                                           ├── mini chart com buys/sells
                                           ├── posição e transações
                                           └── teses do perfil sobre o token
```

Em telas estreitas, empilhar as duas tabelas superiores e preservar acesso às
ações, filtros e navegação de retorno. Voltar deve restaurar filtros, período,
paginação e contexto do Radar. Links diretos devem conter rede e endereço.

## 2. Rede e identidade

- Exibir somente dados Robinhood no escopo destas telas. Não preencher lacunas
  com dados Solana nem alterar silenciosamente outros workspaces.
- Preservar fronteiras multichain: identidade de token e wallet inclui rede;
  consultas e capacidades devem ficar atrás de adapters.
- O cliente e a API devem respeitar a disponibilidade da rede, inclusive quando
  houver preferências antigas do usuário selecionando Solana.
- Perfil Fomo/Pump é enriquecimento opcional. Sem vínculo, mostrar endereço
  abreviado, botão de copiar e acesso ao explorer.
- Não inferir identidade pessoal, titularidade comum ou vínculo social apenas
  porque duas wallets interagiram.

## 3. Top Wallets e significado de UPNL

Requisito confirmado: lucro das posições ainda abertas; quando a wallet vende
integralmente uma posição, essa posição deixa de contribuir para o ranking.

Em ALL, UPNL = valor atual da quantidade remanescente − custo atribuído a essa
quantidade. Nas janelas, o ganho usa a referência temporal definida abaixo.
Nenhum modo é saldo da wallet ou inclui lucro já realizado. Venda parcial retira
apenas a parcela vendida. Wallet sem posições elegíveis sai do ranking.

Mostrar rank, wallet, avatar/nome/perfil quando disponível, plataforma de origem
e ganho em USD, ordenado do maior para o menor, com desempate determinístico.
Selecionar 24h, 7d, 30d ou ALL. A agregação é por wallet, não por perfil; não
somar automaticamente todas as wallets vinculadas a uma pessoa.

### Definição temporal confirmada

Há quatro filtros: 24h, 7d, 30d e ALL. “Overall” foi apenas outro nome para ALL;
não há quinto ranking. As janelas ordenam pelo ganho não realizado em USD das
quantidades ainda abertas durante cada período, independentemente de quando a
wallet comprou. Para uma compra anterior à janela, usar a variação entre o preço
confiável no início da janela e o preço atual. Para uma compra feita dentro da
janela, contar somente desde seu custo de execução. ALL usa o lucro não
realizado acumulado das posições abertas pelo custo de compra remanescente.
Venda integral tira a posição do ranking; venda parcial reduz sua contribuição
proporcionalmente, acompanhando a política contábil da projeção existente.

Não implementar o filtro apenas por `last_activity_at`: uma posição antiga
pode subir de preço sem nova atividade da wallet. Histórico e preço de referência
incompletos devem ser marcados como cobertura parcial, sem ganho exato presumido.
ALL cobre o histórico disponível, não uma garantia de cobertura desde a criação.
Transferência recebida sem custo conhecido não é compra gratuita.

Valores sem custo ou preço confiável não viram zero nem ganho presumido. A API
deve informar cobertura, instante de referência e exclusões relevantes. Ranking
parcial deve ser identificado como parcial; não apresentar soma incompleta como
UPNL total exato. Transferência recebida sem custo conhecido não é compra gratuita.

### Atualização em tempo real do ranking

Requisito confirmado: Top Wallets deve atualizar automaticamente via WebSocket
conforme novos dados relevantes chegam. O painel não pode depender de refresh
manual para acompanhar o ranking enquanto estiver aberto. A seleção
24h/7d/30d/ALL permanece a mesma durante as atualizações.

Usar um sinal de invalidação/versionamento do ranking após o commit durável das
fontes que alteram posições, preços ou cobertura; o cliente reconsulta o endpoint
autenticado para obter ordem, ganhos e `asOf` consistentes. Não somar ganhos a
partir de eventos soltos no navegador. O `market:bucket` atual é assinado por
token e não constitui, sozinho, uma assinatura do ranking global. Esse contrato
já está conectado: revisões duráveis por fonte, notificação PostgreSQL após
commit e sinal `wallet-ranking:invalidate` para reconsultar a API.

Coalescer eventos e limitar recomputações/consultas para que alta frequência de
preços não sobrecarregue a API. Ignorar sinais duplicados ou antigos, recuperar
um snapshot atualizado após reconexão e tratar reorg/invalidação de cobertura.
Durante paginação, preservar a consistência do snapshot e tratar cursor obsoleto
sem misturar páginas de versões diferentes ou duplicar wallets. Exibir estado de
conexão/desatualização quando a atualização ao vivo estiver indisponível. Não
introduzir polling periódico no caminho live; a consulta inicial e a recuperação
após reconexão usam HTTP.

## 4. Maiores altas entre tokens novos

Status: ranking, métricas, API protegida, tabela 50/50 e live conectados no Radar;
API opt-in ativada na VPS1 em 07/10/2026; índice e preenchimento de criação
conferidos. Otimização em lote da seleção já publicada. Correção realtime com
cutoff exato, intervalo de 500 ms e métricas live preparada localmente; faltam
deploy, validação HTTP/live e custo com mais candidatos/usuários.

O primeiro corte usa `createRobinhoodRadarGainersReadRepository().getGainers`
em `robinhood-radar-gainers-read`: uma consulta SQL com timeout de 5 s,
até 20 resultados (15 por padrão) e exclusões limitadas
a 5.000 endereços. O `asOf` histórico interno é alinhado ao início do minuto;
na API live é o horário exato da leitura, incluindo milissegundos, retornado
ao chamador. Preços aceitos no minuto atual entram sem aguardar sua virada.
Seleciona todo o universo
elegível antes do top, sem receber tokens da página principal. É chamado pela
API somente sob o gate. A projeção de idade usa o lote de catálogo existente,
sem RPC, backfill ou polling novos.

Elegibilidade exige timestamp de criação conhecido, positivo e idade entre
zero e 24h inclusive; `first_seen_at` sozinho não prova criação recente. O campo
de catálogo precisa coincidir com o timestamp do bloco canônico da atribuição
verificada (`rpc_direct`, `rpc_trace`, `blockscout_internal`, `launchpad_event`),
com transação correspondente e receipt bem-sucedido. Para deployment direto,
o receipt deve criar exatamente esse contrato. Hint Blockscout, transição de
código sem deployment exato, pool discovery e âncora órfã/ausente não bastam.
Exclui bloqueios globais, endereços fornecidos pelo chamador e FDV conhecido a partir do teto
vigente do catálogo. A API fornece os bloqueios atuais do usuário e descartes.
Apenas valorização positiva entra em maiores altas; perdas e preço constante
não são altas. Contagens distinguem candidatos, altas e preços não comparáveis.

A base é o primeiro `open_price_usd` positivo disponível nos buckets aceitos de
1 minuto desde a criação. O preço atual vem do mercado de valuation já escolhido
no agregado de 5 minutos, com observação de no máximo 15 minutos. Os dois preços
precisam pertencer ao mesmo mercado; mudança de mercado torna a comparação
indisponível em vez de fabricar ganho. Não busca outra base para contornar isso.
Timestamps e mercado acompanham a base, com `coverage: 'available-history'`:
isso não garante primeiro trade desde o lançamento nem completude histórica.
Um único preço válido produz variação zero por comparação consigo mesmo, não
uma alta presumida. Buckets com observações posteriores ao corte não entram.

`createRobinhoodRadarGainersService().getGainers` compõe volume 24h/coverage e
LP pelos leitores do workspace, e holders pelo resumo publicado, somente para
os até 20 vencedores. Faz uma chamada em lote por fonte; lista vazia não hidrata.
Preserva ordem, valores decimais, base e preço do ranking. Cada statement tem
timeout de 5 s; isso não é orçamento total nem coalescência de requisições.
Ausência/falha de fonte não fabrica zero. O volume conserva buckets completos
e informa seu corte próprio em `volumeAsOf`. No live, holder/LP usam as últimas
projeções publicadas, com timestamps próprios; freshness de holders é avaliada
na composição. No modo histórico, projeções posteriores ao `asOf` permanecem
indisponíveis, sem buscar snapshots antigos. As fontes não formam snapshot
transacional conjunto.
Volume 24h conserva cobertura parcial para histórico curto; sua comparação
percentual fica indisponível, pois não há base comparável comprovada.

`applyLiveSnapshots` deriva a criação na mesma escrita do lote já existente,
limitado a 100 contratos tocados; `projectDashboardSnapshot` usa a mesma prova
e deixa de gravar descoberta do pool como criação. Consultas por identidade
usam os índices de atribuição/bloco/transação existentes. O layout de transações
é detectado uma vez por runner; no particionado, altura do deployment restringe
as partições. Reiniciar consumidores após cutover/rollback de layout. Evidência
ausente não apaga um campo antigo, mas o ranking só aceita sua coincidência com a prova
canônica atual. Eventos duplicados ou atrasados não substituem nascimento por
first-seen. A atribuição precisa estar comprometida antes da escrita do catálogo;
se chegar depois, o próximo preço/repair frio preenche. O reorg do ranking já
limpa gerações; a validação por bloco e tx impede reutilizar altura com hash órfão.

Não requer migration nova nem backfill. Novos tokens entram conforme houver
prova e preço; não é necessário aguardar 24h para o primeiro resultado. Após
publicar, reiniciar web e `trendscope-worker@robinhood-derived.service`, que
hospeda o sink de catálogo e reparo frio, e medir preenchimento/custo real.
Não ativar a API apenas por esperar o relógio: timestamps e preços são necessários.

A Stage 268 prepara índice parcial de criação conhecida RH no catálogo, com
build concorrente, lock timeout de 1 s e limite de 120 s. O schema check runtime
verifica sua definição; a migration recusa índice inválido deixado por tentativa
anterior. Aplicação e plano indexado foram conferidos na VPS em 06/10/2026.
Índice inválido exige inspeção/recuperação explícita; `IF NOT EXISTS` sozinho
não repara build interrompido.
Limites de idade na consulta são `bigint`, como a coluna: o cast implícito da
coluna para `numeric` no leitor anterior impedia o uso desse índice.

Diagnóstico de custo em 07/10/2026, 04:18:50–04:19:00 UTC, banco `volume_alert`:
comparação read-only do código anterior e otimizado no mesmo snapshot
`REPEATABLE READ`, cutoff 04:18 UTC, ordem anterior/novo/novo/anterior. Os quatro
resultados foram idênticos: 518 candidatos, 450 não comparáveis, 56 altas e 20
vencedores. **Observações:** seleção anterior 4.469 ms na primeira leitura e
1.655 ms na repetição; nova 376/342 ms. A primeira leitura teve espera de disco,
portanto não atribuir sua diferença inteira à consulta. Comparação aquecida
reduziu a seleção em aproximadamente 77–79%; composição nova com volume/LP e
holders levou 474 ms. São poucas amostras, sem garantia para mais usuários ou
candidatos.

**Causa confirmada do custo evitável:** o `LATERAL ... LIMIT 1` de valuation
escolhia o índice global de tempo e repetia a busca para cada candidato.
Planos reais com `TIMING OFF`, ambos sem shared reads, mostraram 518 varreduras
de agregados antes e uma depois; acessos totais a páginas caíram de 1.297.183
para 18.339, com execução de 2.200 para 354 ms. A consulta passa a resolver
valuation em conjunto materializado, mantendo apenas o agregado válido mais
recente por contrato e as mesmas regras de frescura/cutoff/mercado. Usa índices
existentes; sem schema, RPC, novo worker ou alteração de projeções. O teste
local reproduziu 1.510.000 linhas examinadas para 100 candidatos antes da
correção e limita esse trabalho sem depender da escolha do índice por token.

**Guardrails:** captura avançou 98 blocos na janela, idade 0,791→0,859 s;
zero novos deadlocks, nenhum bloqueio do backend observado e zero aumento de
temporários no banco. Isso não prova melhora de latência do bot inteiro. A causa
do timeout isolado anterior de 5 s não foi completamente determinada; cache,
I/O concorrente e compilação JIT ainda podem contribuir para variação.
Essa otimização foi conferida no código publicado na VPS1. Seguem pendentes
validação HTTP/live e custo com crescimento de cobertura após a correção realtime.

**Observações de JIT:** comparação read-only em 07/10/2026, 04:34:01–04:34:04
UTC, no mesmo snapshot e cutoff 04:34 UTC, com 539 candidatos e 20 vencedores.
Ordem JIT on/off/off/on: 1.517/80/57/362 ms, resultados idênticos. A primeira
leitura teve I/O e não é baseline aquecida. Planos aquecidos `TIMING OFF`, sem
shared reads: on 338 ms com 432 funções JIT, off 50 ms e cerca de 18,5 mil shared hits em ambos.
**Causa confirmada desse custo de seleção:** a comparação controlada confirma
custo evitável de compilação JIT para essa cardinalidade. A seleção live passa
a usar `SET LOCAL jit=off` em transação read-only própria com timeout de 5 s e
rollback/release; não altera configurações globais nem writers. Composição sem
JIT levou 147 ms. **Guardrails:** captura avançou 31 blocos e não houve novo
deadlock na janela. Isso não determina a causa do timeout anterior nem garante
custo sob realtime contínuo; medir após deploy com candidatos/usuários reais.

Medição read-only em `volume_alert`, 06/10/2026 às 21:00 UTC: 504.499 tokens RH,
zero candidatos no corte 21:00 UTC, execução 691 ms, 144.651 shared hits e zero
shared reads. Às 21:05 UTC, corte histórico 02/10/2026 19:19 UTC com 63 candidatos:
573 ms, 145.284 shared hits e 526 shared reads. Ambos os planos varreram catálogo;
as buscas de preços do segundo usaram índices. São amostras individuais anteriores
ao índice, sem prova de causa de lag ou de melhora em produção. Só 6.102 tokens RH
tinham criação positiva conhecida; o timestamp mais recente era 02/10/2026 19:18:44
UTC. First-seen não substitui essa lacuna de cobertura.

Na mesma janela histórica, leituras adicionais limitadas aos 15 vencedores
retornaram 15 linhas por fonte: seleção 871 ms, volume/LP 454 ms e holders 20 ms
(tempo de chamada observado na VPS web, incluindo acesso ao banco). Não são
medidas de concorrência nem evidência de baixo custo por todos os clientes.
Fixture PostgreSQL local: 500.100 registros de catálogo, 100 candidatos e 72.200
buckets de minuto. Antes/depois do índice com limites tipados: 214,0/5,0 ms,
resultados idênticos; acesso ao catálogo passou de seq scan de 6.175 páginas
locais para index scan de 7 páginas. Cache/ambiente são locais; essa redução
de páginas não estabelece ganho de desempenho no bot em produção.

`node src/utils/explain-robinhood-radar-gainers.js plan [asOf]` gera plano compacto;
`analyze` executa o SELECT em `REPEATABLE READ READ ONLY`, com statement timeout
5 s e lock timeout 500 ms. O relatório inclui horário, cardinalidade, loops,
índices, hits, reads e spill. A contagem de catálogo é uma consulta separada;
seu custo não entra no tempo de execução informado do ranking. `young_tokens`
conta datas armazenadas nessa janela, antes da prova canônica; não comprova,
sozinho, candidatos elegíveis ou completude de criação.

`POST /api/robinhood/radar-gainers` exige autenticação, origem confiável,
visibilidade RH e `ROBINHOOD_RADAR_GAINERS_ENABLED=true` (default false).
Aceita apenas `limit` numérico de 1–20 (default 15) e `dismissedIdentities`
canônicas RH. Não aceita cutoff histórico, usuário, filtros da tabela principal
ou query params. Lê bloqueios do usuário com timeout 1 s e limite 5.001 para
detectar excesso; a união com descartes não pode superar 5.000 exclusões.
Ranking e hidratação calculam até 20; o limite solicitado só recorta a resposta.

O servidor compartilha cálculo/cache por revisão de preço/reorg e conjunto normalizado de
exclusões, nunca filtra um top global já truncado para obter o top do usuário.
Por processo: um cálculo ativo, até 32 pedidos aguardando esse mesmo cálculo,
sem fila para outros conjuntos, intervalo mínimo de 500 ms entre inícios, cache
de 5 s após conclusão com até 32 entradas e backoff de 10 s após falha de fonte.
Saturação retorna 503 `GAINERS_BUSY` com `Retry-After`, sem consultas adicionais
de ranking. Bloqueios do usuário são relidos a cada pedido; bloqueios globais
participam do SQL; o cache acrescenta até 5 s à latência dessas mudanças. A resposta
traz `asOf`, `volumeAsOf` quando hidratada, `generatedAt`, `cacheAgeMs`, contagens e coverage dos campos.
Falha não publica/cacheia lista vazia. Não há timer, RPC ou polling adicional.
Esses limites são locais ao processo; múltiplas réplicas multiplicam a carga.
A rota usa orçamento exclusivo por sessão/IP de 180 pedidos/min por padrão
(`ROBINHOOD_RADAR_GAINERS_RATE_LIMIT_MAX_REQUESTS`, 1–3.600), preservando o
orçamento geral da API. Pedidos compartilhados não multiplicam os cálculos.

O painel mostra até 15 altas na ordem do servidor, ao lado de Top Wallets em
desktop; em mobile os painéis são empilhados, acima da tabela única. Carrega na
abertura e após mudança de sessão/disponibilidade/exclusões, com refresh manual.
Filtros/página da tabela principal não refazem o top. Mudanças de contexto
cancelam e descartam respostas antigas; dados anteriores deixam de aparecer.
Respeita intervalo mínimo local de 500 ms e `Retry-After`; mudanças durante o
cooldown ficam pendentes para o painel visível.
Refresh de preço conserva as linhas e mostra atualização em andamento; mudança
de contexto/reorg descarta a página anterior. Erro continua visível com o snapshot.
Volume/LP parciais levam `~`; ausência usa `-`, holders zero são preservados.
Usa cópia de contrato, explorer e terminais RH existentes; não pede sparklines.

O live reutiliza `prices`/`reorg` do `wallet-ranking:invalidate`, publicados após
commit dos buckets/agregados e recuperação canônica. Não depende de assinatura
dos tokens da página. Watermarks por fonte ignoram duplicatas/replay antigo;
eventos exclusivos de wallets não recalculam altas. Rajadas de preços mantêm
uma consulta pendente que reage dentro do mesmo minuto sob cooldown. Revisões
de preço avançam a geração do cache após commit. Preço que chega durante uma
consulta deixa um refresh pendente, sem impedir a publicação do `asOf` original.
Reorg limpa e
cancela a geração anterior imediatamente; cache e cálculo da API usam a revisão
de reorg observada pelo listener, inclusive na reconciliação de sua conexão.
Uma geração que atravessa essa revisão retorna busy, sem publicação/cache.

Consultas live requerem painel conectado ao DOM e aba visível. Reconexão e
retorno ao painel/aba recuperam dados, com uma única tentativa adicional após
falha e respeitando cooldown/backoff; depois exigem novo evento ou refresh manual.
Há um timer de coalescência e um deadline de freshness de 2 min que só sinaliza
snapshot antigo, sem HTTP. Não há consulta periódica para descobrir mudanças.
Conexão/desatualização e `asOf` aparecem na tela. Idade e elegibilidade continuam
relativas ao cutoff; sem eventos, o snapshot pode envelhecer. Mudanças isoladas
de catálogo, LP ou holders entram no próximo refresh de preço/manual/recuperação;
não há evento global próprio para todas essas fontes neste fluxo.

Faltam publicar backend e assets frontend deste corte e reiniciar o web na VPS1;
nenhum worker precisa reiniciar para essa correção. Validar HTTP/live, custo e
lag sob fluxo contínuo. Fixtures locais não comprovam custo em produção.

- Apenas tokens RH com idade conhecida de até 24h.
- Colunas compactas: imagem/ticker, volume 24h com variação abaixo, holders, LP
  e ações básicas: copiar contrato, abrir token e plataformas compatíveis.
- Sem sparkline. Ordenação decrescente por valorização válida; resultados devem
  vir do universo elegível no servidor, não da página atual da tabela principal.
- Reaproveitar política de bloqueio, qualidade, identidade e links por rede.

Decisão confirmada: para tokens com menos de 24h, usar variação desde o primeiro
preço confiável, rotulada “desde o primeiro preço” (ou “desde o lançamento”
somente quando a evidência coincidir com o lançamento). Não chamar esse cálculo
de variação 24h. Sem preço-base confiável, a variação permanece indisponível;
nunca inventar preço-base ou zero percentual.

## 5. Tabela única de tokens

Status: implementada para Robinhood, incluindo preferências e filtros unificados.

Substituir Old Tokens e Recent Tokens por uma única tabela paginada no servidor.
Preservar busca, favoritos, filtros de idade/valuation, ordenações existentes,
quantidade por página, ações e expansão de token aplicáveis ao Radar.

Ticker verde para idade até 7 dias inclusive; laranja acima de 7 dias. Idade
desconhecida deve ter apresentação neutra, sem classificação presumida.
Preservar a distinção MC/FDV e as indicações de dados parciais/desatualizados.
Não concatenar duas páginas independentes: contagem, ordem e paginação devem
ser globais. Definir migração das preferências Recent/Old sem descartar favoritos.

## 6. Detalhe da wallet

Status: parcial. `/radar/wallet/robinhood/:address` já apresenta compras/vendas
da API `/api/robinhood/wallet-trades`, com All/Buy/Sell, paginação e retorno ao
Radar preservando filtros em memória. Perfil, resumo, posições abertas/fechadas,
transfers e contrapartes ainda não estão integrados nessa tela.

Abrir área dedicada ao clicar na wallet do ranking. Mostrar identidade/perfil,
rede e resumo das posições conhecidas, com cobertura e horário de atualização.
Não rotular a soma de tokens monitorados como patrimônio total da wallet.

Seções:

- Posições abertas: token, quantidade, valor atual, custo remanescente e UPNL.
- Posições fechadas: histórico de encerramentos, compras, vendas e PnL realizado
  quando calculável. Reabertura não deve apagar o histórico de um encerramento.
- Compras/vendas: feed paginado com filtros All/Buy/Sell, quantidade, USD,
  horário e link da transação; indicação de valuation ausente.
- Transfers: entradas/saídas, token, quantidade, contraparte, USD quando
  disponível, horário e transação. Transferência não deve aparecer como swap.
- Contrapartes: wallets com interação relevante comprovada, com direção,
  quantidade de interações, datas e evidência acessível.

### Corte de dust nas contrapartes

Proposta inicial: somente transferência direta com valor **maior que US$ 100
por evento**, valorada no instante da transferência. O limiar é configurável.
US$ 100 exatos não entram; várias transferências menores não entram por soma.
Esse detalhe operacional é uma proposta a validar antes da implementação.

Sem preço histórico confiável, não assumir que passou o corte. Identificar
contratos, pools, routers e infraestrutura usando as classificações existentes,
sem apresentá-los como supostas wallets pessoais vinculadas. O corte controla
a lista de contrapartes; não apaga transfers do histórico nem altera posições.
Interações indiretas e grafos de vários saltos ficam fora da primeira versão.

## 7. Detalhe da posição wallet + token

Status: pendente neste fluxo; componentes existentes de chart e conteúdo social
não constituem a tela de posição descrita abaixo.

Disponível ao clicar em token aberto ou fechado. Mostrar:

- Identidade do perfil/wallet, token, rede, contrato e estado da posição.
- Mini chart com marcadores de compras e vendas da wallet selecionada, vinculados
  à transação e ao instante real; não misturar trades de outras wallets do perfil.
- Quantidade, valor atual, custo remanescente, total comprado/vendido, entrada
  média, UPNL e PnL realizado em campos distintos, quando os dados suportarem.
- Transações paginadas e filtros de lado/período. Marcadores e listagem devem
  usar os mesmos eventos canônicos e informar limites/cobertura do gráfico.
- Teses escritas pelo perfil associado sobre esse token, com plataforma, autor,
  data e link de origem quando disponível. Exibir texto original com segurança.

Usar rede + contrato para selecionar teses, não apenas ticker. A atribuição da
tese é ao perfil autor, não prova de que uma wallet específica escreveu o texto.
Não inventar tese, resumo ou associação quando não houver evidência. Prever
estados sem perfil, sem tese, sem candles e histórico incompleto.

As imagens não autorizam implementar negociação, Follow, Share, publicação de
teses ou importação nova de contas. Gráfico de patrimônio e “total cash” da
wallet também não são requisito inicial sem uma fonte completa demonstrada.

## 8. Evidência no repositório e fronteiras

Bases conferidas no código; sua existência não prova cobertura em produção:

| Base existente | Uso / lacuna a verificar |
| --- | --- |
| `src/services/dashboard-radar-query.js` | Contrato unificado `bucket: 'all'` implementado; preserva Recent/Old para consumidores legados |
| `src/services/dashboard-radar-reader.js` | Composição multichain e paginação exata |
| `src/services/robinhood-workspace-radar-reader.js` | Métricas, ordenação, idade e qualidade RH |
| `src/models/callout-wallet-profile-read.js` | Associação EVM a Fomo/Pump; política de múltiplos vínculos |
| `src/services/robinhood-wallet-position-domain.js` | Custo e UPNL por posição; não é ranking temporal |
| `src/services/robinhood-wallet-ranking-*` | Domínio temporal, cobertura, composição global, API e relay implementados; limites e pendências na seção 9 |
| `src/models/robinhood-wallet-position.js` | Projeções atuais; verificar reconstrução histórica necessária |
| `src/models/robinhood-wallet-swap-read.js` e `robinhood-wallet-trade-read.js` | Feeds paginados por token e wallet; falta integrar posições e transfers |
| Modelos `robinhood-wallet-transfer-*` | Evidência/classificação; verificar retenção e consulta por wallet |
| `src/models/robinhood-wallet-ranking-publication.js` | Publicação compacta com revisão, checkpoint e geração; ainda não consumida pela API |
| `src/models/callout-event-read.js` e `callout_thesis_archive` | Teses existentes; leitura por autor + ativo |
| `frontend/src/services/charts/chart-wallet-buys.ts` | Investigar reaproveitamento; vendas precisam cobertura explícita |
| `frontend/src/ui/app-shell.ts` e seções do Radar | Tabela única, Top Wallets, altas 50/50 com live e feed por wallet conectados; falta exploração completa de posições |

Criar módulos separados para ranking, detalhe da wallet e detalhe da posição.
Os hubs de rota/controller/shell devem receber wiring; regras contábeis, filtros
e atribuição de eventos ficam em interfaces testáveis. Evitar branches de rede
espalhados. Payloads devem transportar identidade, cobertura e versão/asOf.

Paginação deve ser limitada e estável, sem queries por linha. Validar índices e
custo das consultas antes de abrir rankings globais. Não disparar backfill/RPC
extenso no carregamento de uma tela. Se for necessária persistência nova,
dimensionar e aprovar migração explicitamente antes de editar schema.

Atualização live deve consumir eventos existentes após commit, tolerando
duplicação, replay, ordem invertida e reorg. Reutilizar eventos e reconciliação
existentes; não criar polling contínuo por wallet/token para descobrir mudanças.
Qualquer exceção precisa dos limites e garantias exigidos no AGENTS.md. Nenhum
serviço VPS novo está aprovado; se necessário, ler o runbook de serviços antes.

## 9. Estado das entregas, pendências e execução segura

### Estado conferido

A coluna de estado descreve código conectado no checkout, não deploy ou prova
completa dos dados. A sequência original é preservada para localizar as entregas.

| Etapa | Estado | Entrega / pendência |
| --- | --- | --- |
| 0 | Parcial | Semântica temporal e preço-base das altas definidos; corte de contrapartes ainda é proposta e cobertura real exige auditoria |
| 1A / 1B | Implementada | Consulta `bucket: 'all'` e `POST /api/dashboard/radar-bootstrap`, autenticado e restrito à RH |
| 2A / 2B | Implementada | Tabela única Old/Recent, filtros, favoritos, preferências, paginação global e cores por idade |
| 3 | Parcial | Ranking/métricas, API e tabela 50/50 ativos, idade canônica e seleção em lote publicadas; realtime dentro do minuto preparado localmente, faltam deploy e validação HTTP/live/custo sob carga |
| 4 / R1–R3 | Implementada com limites | Scorers, frontier, fontes, provas de eventos e composição global; universo limitado a 1.000 posições |
| R4 | Implementada | API autenticada Top Wallets, perfis RH opcionais, cobertura e cursores |
| 5 / R5 | Implementada | Painel 24h/7d/30d/ALL, identidade, paginação e link para wallet |
| R5a.1a / R5a.1b / R5a.2 / R5a.3 | Implementada com ressalvas | Fontes duráveis, relay e atualização do painel; custo compartilhado, escala e freshness continuam pendentes abaixo |
| 6 / 8 | Parcial | API e tela de compras/vendas por wallet; faltam perfil, resumo e posições abertas/fechadas |
| 7 | Pendente neste fluxo | Transfers por wallet e contrapartes com classificação, valoração histórica e corte por evento |
| 9 | Pendente neste fluxo | Detalhe wallet + token, mini chart buy/sell, métricas, transações e teses |
| 10 | Parcial | Referência operacional descreve o que existe; fluxo completo depende das telas e critérios restantes |

A tabela única usa somente `radar-bootstrap` para RH. `history-bootstrap`
continua alimentando consumidores Solana quando selecionada e pronta, sem
preencher o Radar RH com essa rede. A migração de preferências herda favoritos
ativos de Recent ou Old e tamanho de página/ordem de Recent; favoritos continuam
compartilhados, e preferências do Radar ficam separadas. Busca e página são
transitórias. Limites e estados de indisponibilidade permanecem no contrato.

### Top Wallets: o que já foi entregue

- **Contabilidade:** ALL usa quantidade/custo remanescentes; 24h/7d/30d usam
  preço no início da janela para posições antigas e custo executado para compras
  novas. Venda total elimina a contribuição; parcial escala a parcela restante.
  Quantidade sem custo, preço ausente e cobertura incompleta não viram ganho exato.
- **Cobertura:** R1, R2a/R2b e R2c.1–3 auditam alinhamento da projeção, seed/live,
  partições, classificação, hashes e ranges por token. `eventsComplete=true`
  exige todas as provas no mesmo snapshot. Seed não prova raw integral; ranges
  antigos não ganham cobertura retroativa pela existência de uma migration.
- **Frontier inclusivo:** posições e transfers podem alcançar o mesmo `asOf`
  comprovado. Timestamp declarado precisa coincidir com o checkpoint canônico;
  o header adjacente prova o fim inclusivo somente com timestamp posterior a
  `asOf`, sem exigir projetar eventos futuros. Header ausente, órfão ou ainda
  com timestamp igual mantém a cobertura incompleta.
- **Leitura global:** R3 usa `REPEATABLE READ READ ONLY`, até 10 páginas de 100
  posições, preços/decimais em lotes de 100 tokens e eventos em lotes de 20 pares.
  Ao atingir o teto com mais candidatos, retorna incompletude sem ranking global.
  O timeout de 5 s é por statement; não é orçamento total da transação/rota.
- **Agregação:** `createOpenWalletRankingAccumulator` aceita lotes de até 100
  posições ordenadas por wallet/token, mantém a wallet corrente e até 100 melhores
  wallets concluídas. Wallet com qualquer posição parcial é excluída por inteiro.
  Essa interface não remove o limite nem transforma o reader atual em streaming:
  o caminho da API ainda reúne listas e chama o agregador compatível de listas.
- **API/UI:** R4/R5 expõem `/api/robinhood/top-wallets` e painel com páginas de
  25 (API aceita até 50), top 100, perfis RH opcionais, exclusões e `asOf`.
  Cada página recompõe o ranking; fingerprint divergente retorna 409. O link
  da wallet abre hoje o feed de compras/vendas, não todo o detalhe planejado.
- **WebSocket:** R5a completo no código. Posições, transfers, cursores de swaps,
  preços de 1 minuto, agregado de 5 minutos e reorg publicam revisões na mesma
  transação das fontes, inclusive avanço vazio. Rollback não entrega notificação.
  O relay web coalesce por fonte em 25 ms; o painel preserva período, descarta
  cursores/respostas obsoletos, deduplica revisões e recupera após reconexão.
  O mínimo de 250 ms entre consultas é por painel, não um limite global do banco.
- **Publicação compacta:** Stage 260/repositório já persistem a geração atual
  por projeção/janela, checkpoint, revisões e até 100 wallets, com payload de até
  64 KiB. Há guarda de geração, retry, regressão e reorg. Não existe produtor
  automático conectado; a API ainda não lê essa publicação. `isFresh=false`
  distingue revisão avançada, e reorg/checkpoint órfão impedem ler a geração.

### Correções anteriores que a continuação deve preservar

O histórico precisa ser lido pelos diffs, não apenas pelos títulos. Estas mudanças
explicam as fronteiras atuais e impedem tratar o ranking como feature isolada:

| Commit | Correção / capacidade a preservar |
| --- | --- |
| `a194ba7e` | Reutiliza conjuntos de tokens por hash em vez de copiar o array inteiro a cada range |
| `8049e7e8` | Persiste participação versionada por deltas e reutiliza a versão quando o conjunto não muda |
| `05cd3969` | Aceita frontier igual a `asOf` com prova canônica/adjacente, sem esperar artificialmente uma fonte futura |
| `202d048d` | Cria armazenamento de publicação compacta com guardas; não substitui sozinho a recomposição HTTP |
| `ce630057` | Acrescenta acumulador de lotes ordenados com top limitado; não amplia sozinho o universo lido |
| `25b12747` / `81f85667` | Prova global compacta e seleção pelos contratos do lote no LIVE canônico; conserva o caminho legado onde necessário |
| `e584c5e9` / `9893e573` / `ee25a497` | Leitura, publicação e substituição auditada de escopos históricos por bitmaps, sem inferir pertencimento antigo pela lista atual |

**Observações:** os diffs mostram cópia de escopo integral por range no formato
original e as substituições acima. O caminho HTTP atual ainda repete leitura,
auditorias e cálculo por requisição/página. O operador relatou que precisou de
correções para tornar o fluxo usável e proteger o bot; esta revisão local não
mediu uma janela de incidente nem confirmou configuração/rollout na VPS.

**Hipóteses:** replay/auditorias repetidos por cliente, transporte de escopos e
trabalho nas fontes podem disputar recursos com captura e demais workers.
Comparar suas fases com waits, locks, CPU/I/O e WAL no mesmo intervalo; custo
baixo nessas fases ou ausência de melhora do lag com redução controlada enfraquece
cada hipótese. Não escolher uma arquitetura apenas a partir desse relato.

**Causas confirmadas:** o diff demonstra a origem da repetição dos conjuntos
históricos: o writer antigo inseria o array integral por range. Isso explica
armazenamento redundante, mas não isola a causa de lag do bot. Nenhuma causa de
incidente ou melhora de produção é confirmada por esta atualização documental.

### Top Wallets: o que ainda falta

1. **Medir o custo antes de ampliar o caminho.** Comparar ALL/24h/7d/30d no
   corte canônico, com cardinalidade representativa e concorrência de clientes.
   Separar seleção, preços, eventos, provas, agregação e HTTP; medir planos,
   buffers/linhas, duração total do snapshot, memória, conexões ocupadas/esperando
   e taxa de recomputações. Registrar lag/taxa de captura, swaps e transfers,
   waits/locks, CPU/I/O e WAL por segundo em janelas comparáveis. Definir orçamento
   e critério de parada a partir da baseline; testes sintéticos não provam escala.
2. **Compartilhar resultado sem repetir replay por página/cliente.** Dimensionar
   a composição das quatro janelas e sua ligação à publicação/API existentes.
   Invalidações precisam coalescência e concorrência limitada também no servidor;
   o throttle de cada navegador não protege o banco com várias sessões. Definir
   geração, cutoff, revisões, expiração, cursores e retomada antes do wiring.
   Não executar cálculo global dentro do commit financeiro nem manter os writers
   bloqueados até a tela atualizar. A Stage 260 é uma base, não entrega pronta.
3. **Ultrapassar 1.000 posições com consistência e custo comprovados.** Validar
   leitura do universo completo em lotes, ordem exigida pelo acumulador e um
   corte coerente de posições, preços e provas. Não basta aumentar `MAX_PAGES`,
   abrir snapshots independentes ou unir tops por token. SQL/índices, tempo de
   transação, retenção de versões e memória precisam caber no orçamento definido.
4. **Evitar reconstruir as três janelas para cada alteração de preço.** O
   [desenho de custo e escala](robinhood-wallet-ranking-consistent-generation-plan.md)
   propõe coeficientes por par derivados do replay; isso ainda não está conectado
   ao ranking. Avaliar somente com paridade de arredondamento, transfer sem custo,
   fechamento/reabertura, vencimento da janela, retry/reorg e limites de bytes.
   O desenho contém propostas e evidência sintética; suas etapas de provas/escopos
   já evoluíram nos commits acima. Não tratá-lo integralmente como pendente nem
   tratar coeficientes como solução de lag confirmada. Preferir a menor mudança
   cujo ganho de custo e contrato sejam demonstrados.
5. **Fechar freshness e dependência de preço/frontier.** A API fixa `asOf` pelo
   cursor de posições. Revisão de preço posterior pode disparar HTTP e ainda
   devolver o mesmo corte. Medir commit da fonte até snapshot aplicado, definir
   o alinhamento entre fontes e explicitar atraso sem misturar cortes. Não prometer
   latência de milissegundos só porque o WebSocket entregou a invalidação.
6. **Completar estados e validação de ponta a ponta.** O painel mostra cobertura
   e `asOf`, mas não tem estado próprio explícito de conexão/desatualização.
   Validar com fontes SQL reais publicação/API/UI, reconexão, reorg, rajadas,
   mudança de período e paginação, além do custo com o bot concorrente. Migrações,
   flags, cobertura histórica e ativação na VPS precisam de evidência específica;
   código ou testes locais não bastam para marcar produção como concluída.

### Guardrails para qualquer entrega restante do Radar

- Preservar o trabalho incremental e os formatos compactos já implementados.
  Não voltar a carregar, transportar, hashear ou gravar o catálogo inteiro por
  lote quando a fronteira por contratos tocados atende ao mesmo contrato.
  Manter compatibilidade histórica/fallback e hashes, seleção e cobertura.
- Consultas por wallet/token precisam de índices e paginação limitada, com
  enriquecimento em lote. Evitar queries por linha, replay de histórico inteiro,
  payloads integrais e backfill/RPC no carregamento de uma tela. A tabela de altas
  consulta o universo elegível no servidor, com custo medido, não a página atual.
- Novas telas consomem projeções/fontes existentes; perfil e teses são opcionais.
  Não acrescentar trabalho social/gráfico aos commits financeiros. Separar UPNL,
  lucro realizado e valor; preservar encerramentos e qualidade sem inventar custo.
- Reagir após commits duráveis. Sem polling contínuo para descobrir mudanças.
  Exceções de reconciliação/backfill exigem cursor, limites, retry, idempotência,
  telemetria de freshness e precedência do live conforme AGENTS.md.
- Sob carga, limitar fila, concorrência e trabalho por geração. Uma geração antiga
  só pode continuar visível com atraso explícito e validade comprovada; reorg
  invalidado ou fonte incompatível impedem seu uso. Não trocar cobertura por velocidade.
- Aceitar uma otimização somente comparando a métrica primária e os guardrails
  contra a baseline. Se o lag não melhorar, reabrir o diagnóstico. Redução de
  tamanho, memória ou um timing intermediário não comprova melhora do bot inteiro.

### Cortes e autorização

Redimensionar cada entrega pendente a partir do código atual, sem reutilizar as
estimativas antigas de R5a como orçamento de trabalho novo. Listar arquivos,
fronteiras, linhas estimadas, risco concreto e menor validação adequada. Aplicar
limite de 500 linhas por slice e checkpoint de arquitetura conforme AGENTS.md;
a exceção de documentação operacional não autoriza ampliar código/schema.

Este documento não autoriza todos os próximos cortes, migration, deploy, retirada
de provas, conversão com escrita, start/restart ou novo serviço VPS. Operações
sobre escopos existentes seguem o [rollout de transfers](robinhood-wallet-transfer-global-rollout.md)
e os runbooks de conversão/publicação; serviços seguem `docs/new-worker-service-runbook.md`.
Preservar mudanças preexistentes, inclusive repair de transfers. Atualizar a
referência operacional somente quando houver comportamento implementado novo.

## 10. Critérios de aceite e validação

- Nenhum dado Solana aparece nas novas telas do Radar.
- Tabela única sem duplicação, com filtros e paginação globais corretos.
- Verde até 7 dias inclusive; laranja acima disso; neutro quando desconhecido.
- Altas somente de tokens elegíveis, com base de preço explicitamente rotulada.
- Venda total remove a contribuição no UPNL; venda parcial preserva somente
  quantidade/custo remanescentes; posições fechadas continuam consultáveis.
- Testes de compras em janelas diferentes, fronteiras temporais, reabertura,
  transferências sem custo, preço ausente/stale, perdas e cobertura parcial.
- Contrapartes acima do corte com evidência; interação não implica mesmo dono.
- Chart, transações e teses respeitam wallet/perfil, token e rede selecionados.
- Navegação de ida/volta preserva contexto; loading, erro e vazio distinguíveis.
- Leituras protegidas pelo modelo de autenticação/autorização existente.
- Eventos duplicados, fora de ordem ou revertidos não duplicam trades nem lucro.

Por slice com código: `npm run lint` e menor teste relevante. Frontend também
exige `npm --prefix frontend run build`; smoke para o fluxo visual montado quando
necessário. Schema exige `npm run db:schema-check` e integração afetada. Preferir
testes unitários para cálculos e limites; integração para consultas, persistência,
paginação e autorização. Não repetir validações aprovadas sem mudanças relevantes.

Revisar diff completo antes de cada commit. Atualizar `docs/bot-reference.md`
somente quando o comportamento operacional implementado mudar; este plano não
descreve o estado atual do bot. Documentação isolada exige revisão de texto e
diff, sem lint/build/testes de runtime.

**Ponto importante:** separar UPNL, lucro realizado e valor da posição é parte
do contrato do produto. Qualidade incompleta, histórico ausente ou interação
entre wallets nunca podem virar números exatos ou vínculos pessoais presumidos.
