# Radar: ranking de wallets, tokens e exploração de posições

Status: tabela unificada Robinhood disponível; feed de swaps por wallet na API e
rota direta de compras/vendas disponíveis; rankings e demais detalhes pendentes.
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

## 4. Maiores altas entre tokens novos

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

Substituir Old Tokens e Recent Tokens por uma única tabela paginada no servidor.
Preservar busca, favoritos, filtros de idade/valuation, ordenações existentes,
quantidade por página, ações e expansão de token aplicáveis ao Radar.

Ticker verde para idade até 7 dias inclusive; laranja acima de 7 dias. Idade
desconhecida deve ter apresentação neutra, sem classificação presumida.
Preservar a distinção MC/FDV e as indicações de dados parciais/desatualizados.
Não concatenar duas páginas independentes: contagem, ordem e paginação devem
ser globais. Definir migração das preferências Recent/Old sem descartar favoritos.

## 6. Detalhe da wallet

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

Inspeção inicial identificou bases reutilizáveis, não prova de cobertura em produção:

| Base existente | Uso / lacuna a verificar |
| --- | --- |
| `src/services/dashboard-radar-query.js` | Idade hoje limitada a Recent/Old; precisa contrato unificado |
| `src/services/dashboard-radar-reader.js` | Composição multichain e paginação exata |
| `src/services/robinhood-workspace-radar-reader.js` | Métricas, ordenação, idade e qualidade RH |
| `src/models/callout-wallet-profile-read.js` | Associação EVM a Fomo/Pump; política de múltiplos vínculos |
| `src/services/robinhood-wallet-position-domain.js` | Custo e UPNL por posição; não é ranking temporal |
| `src/models/robinhood-wallet-position.js` | Projeções atuais; verificar reconstrução histórica necessária |
| `src/models/robinhood-wallet-swap-read.js` e `robinhood-wallet-trade-read.js` | Feeds paginados por token e wallet; falta integrar posições e transfers |
| Modelos `robinhood-wallet-transfer-*` | Evidência/classificação; verificar retenção e consulta por wallet |
| `src/models/callout-event-read.js` e `callout_thesis_archive` | Teses existentes; leitura por autor + ativo |
| `frontend/src/services/charts/chart-wallet-buys.ts` | Investigar reaproveitamento; vendas precisam cobertura explícita |
| `frontend/src/ui/sections/routed-sections.ts` e `ui/app-shell.ts` | Composição atual de duas tabelas |

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

## 9. Etapas de execução e aprovação

### Corte 1A — contrato interno de consulta unificada

Implementado `bucket: 'all'` no normalizador compartilhado, reutilizando a
consulta por chain e a composição paginada existentes. Aceita faixas que cruzam
7 dias; sem máximo informado, abrange todas as idades conhecidas. Preserva os
modos Recent/Old e não muda as chains selecionadas pelos consumidores atuais.

Cobertura: limites 24h/7d, intervalo inválido, teto de paginação e composição do
reader real com o adapter RH (I/O simulado), incluindo páginas com idades
misturadas, contagem, ordem, identidade, filtros e isolamento de Solana. O adapter
Solana também conserva compatibilidade com o contrato multichain. Essa validação
não comprova plano de execução ou desempenho em PostgreSQL com dados reais.

Continuação implementada no corte 1B abaixo; a tabela única já foi conectada.
`history-bootstrap` continua restrito ao fluxo Solana.
O corte de contrapartes continua pendente para sua etapa e não bloqueia o
contrato unificado de tokens.

### Dimensionamento e sequência

Corte 1B: `POST /api/dashboard/radar-bootstrap` registrado no dashboard com
handler/validação em `src/services/dashboard-radar-bootstrap.js`. O endpoint é
autenticado, respeita visibilidade RH, limita o rollout à RH e reutiliza o
reader, bloqueios do usuário, pins e serialização existentes. Validação HTTP
em `tests/dashboard.test.js`; SQL real com tabelas temporárias em
`tests/dashboard-radar-sql.integration.test.js`, sem migrações ou dados de
produção. O teste SQL cobre seleção/paginação e filtros; não mede desempenho
do catálogo de produção. O corte 2A adiciona o contrato tipado do cliente e o
estado isolado da consulta única, com limites de paginação e identidades RH.
O corte 2B conecta a consulta à tela: uma tabela RH usa página, contagem, busca,
favoritos e filtros globais, com ticker verde até 7 dias e laranja acima.
As preferências da tabela única agora são persistidas separadamente. Na primeira
leitura de preferências antigas, favoritos ativos em Recent ou Old viram o filtro
de favoritos único; paginação e ordem vêm de Recent, limitadas pelo contrato do
Radar. A lista de favoritos permanece compartilhada. O frontend consulta
`history-bootstrap` apenas para Solana, quando selecionada e pronta; no Radar
Robinhood usa somente `radar-bootstrap`. Sem disponibilidade Robinhood, a tabela
indica indisponibilidade. O fluxo visual foi coberto em smoke com seleção mista,
Robinhood isolada e Robinhood indisponível. As outras áreas do plano permanecem
pendentes.

O escopo ampliado inclui Radar, consultas de wallet, contabilidade temporal,
transfers, gráficos e conteúdo social. Estimativa preliminar: 3.500–5.500 linhas
de código/testes, 18–28 arquivos de produção e cerca de 10–14 slices. Não é um
orçamento fechado: o desenho contábil e a retenção histórica podem alterá-lo.
A estimativa anterior de 1.800–2.400 linhas cobria apenas o Radar inicial.

Há checkpoint de arquitetura por ultrapassar 12 arquivos de produção. Antes
de editar código, listar arquivos concretos, fronteiras, estimativa por slice e
validação. Cada slice tem no máximo 500 linhas adicionadas + removidas; dividir
uma etapa funcional quando necessário, sem esconder trabalho parcial.

| Ordem | Entrega | Validação principal |
| --- | --- | --- |
| 0 | Fechar semântica temporal, preço-base das altas, corte de interação e cobertura dos dados | Exemplos contábeis, inspeção de schemas/índices e contratos |
| 1 | Consulta unificada de tokens e filtros | Unidade de limites 24h/7d; integração de ordem/paginação |
| 2 | Tabela única e escopo RH | Testes afetados, build e fluxo visual |
| 3 | Tabela de altas e layout 50/50 | Seleção global, preço ausente, ações e responsividade |
| 4 | Domínio/consulta do ranking e perfis | Cálculos, cobertura, desempates e integração |
| 5 | Interface Top Wallets e seletor temporal | Filtros, estados e navegação |
| 6 | Leituras da wallet: posições e swaps | Paginação, autorização existente e histórico incompleto |
| 7 | Transfers e contrapartes | Corte USD, classificação, deduplicação e evidência |
| 8 | Tela da wallet | Abertas/fechadas, feeds e retorno ao Radar |
| 9 | Detalhe do token, buys/sells e teses | Consistência chart/feed, autoria e identidade multichain |
| 10 | Integração final e referência operacional | Fluxo completo, regressões e revisão de diff |

No corte 4, o domínio temporal, a leitura limitada de preços de referência e a
agregação por wallet já estão implementados. A agregação exige confirmação de
universo completo antes de produzir uma ordem global; wallets com cobertura
parcial não entram na soma exata. A seleção global tem travessia limitada,
descrita abaixo. Ainda faltam o fechamento da cobertura dos eventos, a composição
global dos dados e a consulta pública do ranking.
Há leitura paginada de posições abertas por lote explícito de tokens e versão
da projeção; páginas independentes não constituem um snapshot consistente nem
provam que o universo global foi percorrido.
O cálculo temporal também aceita posição corrente mais eventos completos da
janela, sem exigir todo o histórico de compras da wallet; ALL usa o custo
remanescente da projeção. Cobertura dos eventos e alinhamento da projeção
continuam sendo pré-requisitos para publicar ganho exato.
O leitor de eventos de janela consulta swaps e `wallet_transfer` classificados
em lote limitado por par `(wallet, token)`. Ele informa truncamento e lacunas
de ordenação; a cobertura da fonte continua não verificada até auditoria de
partições, classificação e cursores.
Uma auditoria limitada por janela verifica a presença, anexação, limites diários
e marcação de descarte das partições brutas de transfers. Ausência de lacuna nessa
auditoria ainda não comprova classificação, avanço dos cursores nem cobertura dos
swaps; portanto não libera ganhos exatos.
Uma segunda auditoria lê os cursores seed/live de swaps e transfers, verifica
continuidade, avanço além do `asOf` e checkpoint canônico. Mesmo com essas
condições satisfeitas, classificação, completude por token e alinhamento com a
projeção ainda precisam ser demonstrados antes de publicar o ranking exato.
Uma leitura limitada por pares `(wallet, token)` identifica transfers brutos da
janela que continuam `unknown`/`unclassified` ou têm versão de classificação
divergente. Ausência desses casos vale apenas para as linhas brutas disponíveis;
não prova captura completa nem resolve retenção ou alinhamento da projeção.
O serviço de composição reúne eventos e essas auditorias por par, separando
falhas globais das falhas da wallet/token. Mesmo com pré-condições satisfeitas,
`eventsComplete` permanece falso até existir prova da cobertura por token.
Eventos e auditorias agora leem no mesmo snapshot PostgreSQL `REPEATABLE READ`
somente leitura. Uma leitura de candidatos por conjunto explícito de tokens
reúne até 20 posições abertas, preços e eventos nesse mesmo snapshot. Ela não
prova universo global; o alinhamento temporal das posições é auditado abaixo,
mas ainda não publica ranking ou ganho exato nesse estágio.
O leitor de posições também oferece página global por `(token, wallet)` e versão
da projeção, limitada e estável. Páginas chamadas separadamente continuam sem
snapshot comum; só a travessia inteira sob uma leitura consistente poderá provar
que o universo de candidatos foi esgotado.
Uma travessia em snapshot somente leitura percorre até 10 páginas globais de 100
posições abertas. Ela confirma esgotamento apenas quando a última página não tem
continuação; ao atingir 1.000 posições com mais dados, retorna cursor e cobertura
incompleta. Isso não comprova a cobertura histórica da projeção nem libera o
ranking público.
O snapshot limitado por tokens agora audita, na mesma transação, os cursores
seed/live da projeção de posições: seed completo, continuidade, checkpoint
canônico e horário do frontier igual ao `asOf`. Cada posição só recebe
`projectionAligned` quando seu `through_block` não ultrapassa esse frontier.
A auditoria não comprova cobertura de eventos, preços nem universo global;
`rankingReady` continua falso.

### Cortes restantes do ranking de wallets

Estimativa de cinco cortes de até 500 linhas cada, incluindo código, testes e
documentação. Cada corte exige autorização própria após o anterior; mudança de
schema, novo subsistema ou aumento material de escopo exige redimensionamento.

| Corte | Entrega e fronteira | Validação principal |
| --- | --- | --- |
| R1 | Auditar o frontier da projeção também na travessia global, no mesmo snapshot; manter posições além do frontier como não alinhadas | Unidade de paginação/alinhamento e integração já existente do cursor |
| R2 | Demonstrar cobertura de eventos por token e janela a partir de fontes duráveis; onde a prova faltar, manter `eventsComplete=false` e explicitar o motivo | Integração de lacuna, classificação, retenção e reorg; sem presumir cobertura a partir de ausência de eventos |
| R3 | Compor posições globais, preços e eventos em lotes no mesmo snapshot e agregar por wallet; quando o limite de candidatos for atingido, manter ranking parcial | Unidade contábil e integração de universo completo/incompleto, limites e desempates; medir plano de consultas antes de ampliar o limite |
| R4 | Expor consulta autenticada do ranking e enriquecimento opcional de perfis RH, com `asOf`, cobertura, exclusões e paginação determinística | Integração HTTP de autenticação, isolamento RH, resposta parcial e ordenação |
| R5 | Interface Top Wallets 24h/7d/30d/ALL, identidade, estados de cobertura e navegação para wallet, sem apresentar parcial como exato | Teste afetado, build frontend e smoke do fluxo visível |

R1 fica restrito a `robinhood-wallet-ranking-global-candidates`, ao auditor de
`position-frontier` e ao compartilhamento da regra com `candidate-snapshot`.
R1 foi implementado: a travessia global exige `asOf` e devolve o frontier e o
alinhamento de cada posição, sem mudar a regra de universo completo.
R2 e R3 concentram leitura/contabilidade nos módulos de ranking; R4 conecta rota
e perfis; R5 conecta API e UI. Não há novo worker, polling ou migração previstos.
Estimar novamente antes de cada corte; testes com dados reais e desempenho em
escala continuam necessários antes de publicar ganhos exatos.

Implementar somente slices autorizados. Commitar cada slice completo por escopo,
preservando mudanças preexistentes. Este documento não autoriza modificar os
arquivos de repair de transfers que já estavam alterados durante a inspeção.

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
