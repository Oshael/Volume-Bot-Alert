# Radar: ranking de wallets, tokens e exploração de posições

Status: consulta unificada disponível no reader e na API; interface ainda pendente.
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

UPNL = valor atual da quantidade remanescente − custo atribuído a essa quantidade.
Não é saldo da wallet e não inclui lucro já realizado. Venda parcial retira
apenas a parcela vendida. Wallet sem posições elegíveis sai do ranking.

Mostrar rank, wallet, avatar/nome/perfil quando disponível, plataforma de origem
e UPNL em USD, ordenado do maior para o menor, com desempate determinístico.
Selecionar 24h, 7d, 30d ou ALL. A agregação é por wallet, não por perfil; não
somar automaticamente todas as wallets vinculadas a uma pessoa.

### Definição temporal proposta — confirmar antes do cálculo

A recomendação discutida foi considerar o UPNL atual das parcelas de compras
feitas dentro da janela selecionada e que continuam abertas. ALL cobre todo o
histórico disponível, não uma garantia de histórico completo desde a criação.
Essa semântica ainda precisa de confirmação: o usuário confirmou a saída do
lucro após vender, mas não escolheu explicitamente a atribuição por janela.

Não implementar o filtro apenas por `last_activity_at`: isso atribuiria à janela
uma posição antiga inteira após uma compra ou venda pequena. Antes da etapa de
ranking, definir a atribuição de custo e quantidade entre compras de janelas
diferentes, vendas parciais, reaberturas e transferências. Reutilizar a política
contábil existente quando compatível; não introduzir FIFO ou custo médio novo
sem explicar a diferença e fechar o contrato.

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

Pendência de produto: um token com menos de 24h normalmente não tem preço de
24h atrás. Recomenda-se variação desde o primeiro preço confiável, rotulada
“desde o lançamento” (ou “desde o primeiro preço”, quando essa for a evidência).
Não chamar esse cálculo de variação 24h. Confirmar essa opção antes da etapa;
se a definição exigir estritamente 24h, dados ausentes permanecem indisponíveis
e podem deixar esse ranking vazio. Nunca inventar preço-base ou zero percentual.

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
| `src/models/robinhood-wallet-swap-read.js` | Feed por token; falta consulta paginada por wallet |
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

Continuação implementada no corte 1B abaixo; falta conectar a tabela única.
O frontend e `history-bootstrap` ainda exibem/retornam os dois grupos antigos.
As decisões da etapa 0 sobre UPNL, altas e contrapartes continuam pendentes para
suas respectivas etapas e não bloqueiam o contrato unificado de tokens.

### Dimensionamento e sequência

Corte 1B: `POST /api/dashboard/radar-bootstrap` registrado no dashboard com
handler/validação em `src/services/dashboard-radar-bootstrap.js`. O endpoint é
autenticado, respeita visibilidade RH, limita o rollout à RH e reutiliza o
reader, bloqueios do usuário, pins e serialização existentes. Validação HTTP
em `tests/dashboard.test.js`; SQL real com tabelas temporárias em
`tests/dashboard-radar-sql.integration.test.js`, sem migrações ou dados de
produção. O teste SQL cobre seleção/paginação e filtros; não mede desempenho
do catálogo de produção. Próximo corte: frontend da tabela única e preferências.

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
