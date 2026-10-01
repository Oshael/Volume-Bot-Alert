# Wallet transfers e ranking Robinhood: desenho centrado em custo e escala

## Objetivo

Reduzir o trabalho repetido do wallet transfer, substituir as provas históricas
que ocupam 96,5 GiB e atender ALL/24h/7d/30d com a métrica de posições abertas.
A prioridade é o custo de origem e das janelas, seguida da publicação compacta.
Um piloto de ALL isolado não atende a esse objetivo.

Este é um desenho para validação e execução local. Nenhum código, schema, flag
ou serviço de produção foi alterado. A VPS permanece somente leitura; conversão
com escrita, retirada de payloads e recuperação física exigem autorização própria.

## Observações, hipótese e causa

**Observações de código e diagnóstico anterior:**

- Os 96,5 GiB são principalmente conjuntos históricos de tokens varridos. Não
  são scores de wallets. Foram observados 3.145 ranges inline e 1.589 conjuntos
  por hash, todos referenciados; não há uma limpeza simples de órfãos.
- O formato versionado atual guarda participação por token e referências por
  range. A base observada tinha aproximadamente 103 MiB e 420 mil tokens, mas
  isso não representa toda a história nem estima seu tamanho convertido.
- O LIVE consulta e transporta o conjunto inteiro, calcula hash e o entrega
  à leitura de transfers, de swaps financeiros e à prova de escopo.
- A fonte canônica já busca o tópico Transfer globalmente por faixa de blocos
  no journal; a filtragem pelos tokens permitidos ocorre depois, em JavaScript.
- A posição unificada já atualiza somente pares tocados pelo lote. O ranking
  ainda reconstrói eventos e provas por requisição, e limita o universo a 1.000.

**Hipótese:** reduzir consulta/hash/transporte do conjunto integral e reutilizar
resumos das janelas pode diminuir trabalho. Medir suas fases, bytes, WAL e
lag em simultâneo; a hipótese de lag é enfraquecida se essas fases custarem
pouco ou se o sintoma não melhorar com redução controlada dessa carga.

**Causa confirmada:** a repetição de conjuntos integrais explica o desperdício
histórico de armazenamento. A fase responsável pelo lag não foi isolada.
O operador relatou melhora ao parar transfers; isso não distingue escopo,
classificação, projeção financeira, grafo e commit. Não habilitar o serviço
para um experimento sem autorização operacional.

## 1. Trabalho por contratos do lote, não pelo catálogo inteiro

A proposta é consultar participação somente dos contratos presentes nos logs
do lote e nos swaps da mesma faixa. Incluir swaps é necessário: a projeção
financeira também recebe o conjunto completo hoje, e não pode perder um swap
por ausência de Transfer decodificado no lote.

Para novos ranges canônicos, avaliar uma prova de leitura global com exceções:

- registrar faixa, bloco/hash, versão do leitor/classificador e leitura completa;
- consultar a regra atual de seleção apenas para os contratos encontrados;
- preservar os contratos encontrados que foram omitidos ou ficaram sem prova;
- um contrato com logs omitidos não recebe cobertura de ausência;
- um contrato sem logs tem ausência provada pela leitura global completa, sem
  precisar aparecer numa lista de centenas de milhares de tokens.

Isso muda o tamanho da prova de O(catálogo completo) para O(contratos encontrados
no lote). Não implica classificar e persistir transfers de toda a rede. A regra
atual de participação continua aplicada aos contratos encontrados.

A prova só vale com faixa integral disponível, sem paginação truncada, hashes
canônicos, cursor confirmado e tratamento de logs malformados. Descobrir
endereços antes de decodificar é necessário para preservar a falha estrita
atual em logs malformados de tokens selecionados. Quantidades/bytes de logs e
contratos precisam de limites; um bloco excepcionalmente denso não pode ser
silenciosamente cortado para caber num lote.

Esse formato ainda não existe no reader/writer. Precisa de paridade em shadow,
schema e integração de cobertura antes de substituir o formato atual. Usar
journal global não prova que todo histórico anterior também foi lido assim.
A captura e a política de participação devem ser consultadas com um corte
coerente por lote; mudar a seleção entre a descoberta e a gravação invalida
essa prova. Preservar o fallback de fontes antigas até demonstrar equivalência.

## 2. Converter o histórico de 96,5 GiB preservando a prova

A conversão histórica usa os conjuntos antigos como fonte de verdade:

1. Ordenar ranges por projeção/stream e provar checkpoints, limites e lacunas.
2. Materializar uma base e somente entradas/saídas entre conjuntos sucessivos.
   Uma sequência sem mudanças reutiliza a mesma versão. Saída e reentrada do
   mesmo token precisam de intervalos separados.
3. Auditar hashes, contagens, referências e cobertura por token/faixa contra
   o leitor legado, inclusive gaps, reorgs e transições de representação.
4. Habilitar o leitor compacto histórico antes de retirar qualquer array.
5. Retirar payloads e recuperar espaço físico somente em operação autorizada,
   com orçamento de espaço temporário, WAL, locks e duração.

Não inferir pertencimento antigo pelo conjunto atual. A base atual tem
`baseline_next_block` e o leitor rejeita versões anteriores a ele; preencher
scope_id/version em ranges antigos, sem adaptar esse contrato, é incorreto.
A forma de admitir uma base histórica precisa ser definida com as FKs do head,
sem quebrar o baseline atual ou reescrever a história como se fosse contínua.

O primeiro passo é um auditor retomável de conversão, com leitura limitada e
sem DML de produção. Ele mede alterações reais entre conjuntos e o volume da
representação substituta. Não prometer recuperar todos os 96,5 GiB nem um valor
exato antes dessa medição. Liberação interna de páginas e queda no filesystem
são resultados distintos; nenhuma reescrita massiva está autorizada.

## 3. Um motor para as quatro janelas

ALL continua usando quantidade e custo remanescente da posição unificada.
Para cada janela finita, o replay pode produzir coeficientes independentes de
preço, em vez de ser repetido para cada consulta/alteração de preço:

- Q: quantidade atual aberta;
- Q0: quantidade existente no início da janela;
- S: fator de sobrevivência dessa posição inicial após as saídas;
- C: custo executado das compras na janela que ainda sobrevive;
- quantidades sobreviventes de compras sem custo e transfers recebidos, para
  manter exclusões e qualidade; mais motivos de inconsistência do replay.

Para posições completas, com d casas do token:

`ganho = round36(Q * preçoAtual / 10^d - S * round36(Q0 * preçoInicial / 10^d) - C)`

Compras aumentam Q e C; transfers recebidos aumentam a quantidade sem custo
conhecido. Cada venda/saída escala S, C e essas quantidades pelo mesmo fator
proporcional atual. Fechamento completo elimina a contribuição anterior.
O arredondamento inicial e final mostrado faz parte do contrato vigente.

Ler os eventos necessários até 30 dias uma vez permite derivar os três estados
no mesmo trabalho, respeitando limites, ordem canônica e completude. Alteração
só de preço reutiliza coeficientes; mudança financeira atualiza o par afetado.
Quando um evento atravessa o início de uma janela, o coeficiente dessa janela
vence e precisa ser recalculado. Uma agenda de vencimentos limitada é necessária;
cache por wallet que ignora essa passagem do tempo é incorreto.

A atualização deve ser consequência dos commits já observados, com replay,
idempotência e guarda de reorg. O cache é derivado; não cria outra fonte de
verdade financeira. Cada entrada precisa identificar os inputs/projeção que
originaram o estado e seu intervalo de validade. Consulta/publicação rejeita
uma entrada atrasada, fora da validade ou incompatível com a posição atual.
Isso permite bootstrap por par com CAS/retry sem congelar todas as fontes.

Um protótipo local comparou 5.328 resultados com o scorer atual nas três
janelas, incluindo precisão, vendas, transfers e mudança de preço; 1.686 eram
completos. Também reproduziu 2.772 rejeições por arredondamento do custo inicial
para zero. A maior representação observada foi 622 bytes, para fixtures de
até 60 eventos. Isso é evidência sintética, não orçamento da produção nem
validação de persistence, metadados, agregação, reorg ou expiração.

Coeficientes racionais podem aumentar de tamanho em históricos complexos.
Medir seu tamanho real, impor orçamento por entrada/total e definir a exceção
segura antes de persistir. Campo de contagem constante não significa número
de bytes constante. Não transformar o cache em outro TOAST sem limite.

## 4. Publicação e consistência

Reusar a Stage 260 para guardar somente os resultados compactos das quatro
janelas. Preços, posições e coeficientes válidos são combinados no mesmo
snapshot curto. Não misturar páginas de inputs mutáveis de snapshots diferentes.
A geração inclui cutoff, revisões, qualidade e idade; mais clientes leem o
resultado publicado, sem repetir o replay.

Mudança de preço afeta todos os holders do token. A agregação global ainda
precisa ser medida: coeficientes retiram replay da precificação, mas não tornam
um GROUP BY de milhões de pares gratuito. Coalescer preços e preservar todos
os candidatos; top por token ou união de tops parciais não prova top global.
Se a agregação ultrapassar o orçamento, manter a geração anterior válida com
atraso explícito e dimensionar a atualização incremental dos ganhos por wallet.
Reorg invalidado não admite essa conservação. Falta de universo completo não
publica uma lista parcial como ranking exato.

## Próximo trabalho e critérios de aceite

Começar pelo auditor histórico e pela comparação de seleção por contratos do
lote. Essa evidência dimensiona a conversão e o novo formato de prova antes
de schema ou DML. Implementar a interface de coeficientes somente com testes
de paridade/qualidade/vencimento, aproveitando o motor existente como referência.
Não há contagem fechada de cortes para o sistema inteiro; cada escopo concreto
precisa ser estimado e validado dentro do limite de 500 linhas.

O fan-out previsto tem boundaries distintas: source/tick de transfers e sua
consulta de swaps; proof writer/coverage e conversor histórico; domínio e cache
derivado das três janelas; publicação/API. Antes de implementar, mapear arquivos,
writers, migrations e estimar cada corte. Não adicionar lógica de domínio a
hubs, inventar uma engine de captura genérica ou trocar a métrica para reduzir
código. Qualquer serviço segue `docs/new-worker-service-runbook.md`.

Aceitar somente com: cobertura preservada após conversão; tamanho e crescimento
medidos; quatro janelas iguais à referência no mesmo corte; bootstrap acima
de 1.000 posições; contratos de retry/reorg/expiração; custo e idade observáveis.

**Ponto importante:** este desenho cobre armazenamento, trabalho por lote e
as quatro janelas, mas ainda é uma proposta parcialmente testada. Não houve
redução de lag nem liberação de disco. Comparar o mesmo lag primário e guardrails
antes/depois da futura ativação; sem melhora, reabrir o diagnóstico.
