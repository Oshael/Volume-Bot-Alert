# Comparação da seleção por contratos do lote

Execute manualmente, inicialmente em uma cópia apropriada do banco:

```sh
node src/utils/audit-robinhood-wallet-transfer-selection.js \
  --from-block=INICIO --to-block=FIM --maximum-rows=5000
```

A ferramenta usa a configuração normal do banco e um único snapshot REPEATABLE
READ READ ONLY. Limita a faixa a 1.000 blocos, cada leitura de logs/swaps a 5.000
linhas por padrão (teto 10.000) e a união de candidatos a 10.000 contratos.
O catálogo de referência tem teto de 500.000 tokens. Exceder limites aborta;
não produz paridade com dados truncados. Statements têm timeout de até 3s,
lock timeout de 1s e orçamento total de 15s verificado entre consultas; transferência
e processamento local não têm garantia de prazo rígido. Não executar em paralelo.

Descobre contratos pelos logs Transfer canônicos antes de decodificar, mais os
swaps na faixa e nos limites temporais usados pela posição unificada. Compara
seleção, transfers decodificados/rejeitados e identidade dos swaps selecionados.
Inclui tokens presentes somente em swaps e preserva falhas em logs malformados
de tokens selecionados. Cabeçalhos ausentes e falta de cobertura abortam.

As duas seleções reutilizam a mesma regra de holder states/backfill. A seleção
limitada usa filtro em ambas as partes do UNION, sem trocar a regra de participação.
O relatório contém contagens, hashes, tempos e resumo do EXPLAIN sem ANALYZE.
Os tempos são sequenciais, com efeitos de cache, e não provam ganho de throughput
ou causa de lag. O resultado reflete a participação atual no snapshot, não a
participação histórica no instante dos eventos. `parity=false` encerra a CLI com erro.

**Ponto importante:** o LIVE canônico usa seleção por candidatos e prova global;
o modo RPC mantém o catálogo completo. Esta
ferramenta não muda captura, classificação, persistência, manifesto ou cobertura.
Paridade neste diagnóstico não autoriza usar a lista reduzida como prova de
ausência: o [contrato global](robinhood-wallet-transfer-global-scan-proof.md) exige
leitura completa, validação dos selecionados e commit atômico.
