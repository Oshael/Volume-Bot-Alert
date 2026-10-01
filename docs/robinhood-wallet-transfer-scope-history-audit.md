# Auditor histórico de escopos de wallet transfer

Ferramenta manual de diagnóstico. Não inicia serviço nem altera o bot. Executa
uma transação REPEATABLE READ READ ONLY, com timeout por statement de até 3s,
lock timeout de 1s e orçamento por chamada de até 30s. Carrega no máximo dois
conjuntos de tokens de cada vez; padrão 450.000 tokens por conjunto, teto 500.000.
O orçamento inclui processamento local e não garante duração rígida durante
transferência de resultados. Não executar simultaneamente várias instâncias.

Usa a configuração de banco normal do repositório. Execute inicialmente numa
cópia apropriada dos dados; produção continua autorizada apenas para leitura.
Não copie arquivos de credenciais para montar o comando.

```sh
node src/utils/audit-robinhood-wallet-transfer-scope-history.js \
  --projection-version=VERSAO --stream=live --max-ranges=1 > /tmp/scope-audit-01.json

node src/utils/audit-robinhood-wallet-transfer-scope-history.js \
  --projection-version=VERSAO --stream=live --max-ranges=1 \
  --resume=/tmp/scope-audit-01.json > /tmp/scope-audit-02.json
```

Use arquivos de saída diferentes: redirecionar sobre o arquivo de resume o
trunca antes de sua leitura. O relatório não inclui os endereços dos tokens.
Uma falha não gera checkpoint novo; retome pelo último relatório bem-sucedido.
`--budget-ms` tem padrão 10000, `--max-ranges` padrão 5 e teto 100. Limites de
tokens ou hashes inválidos abortam, sem devolver auditoria parcial como válida.

O cursor fixa o maior ID existente na primeira chamada, e ordena por bloco
final/inicial/ID. Revalida o último range, payload e hash ao retomar. Novos IDs
ficam fora da sessão. Alterações em ranges mais antigos já medidos não são
revalidadas; o relatório não certifica um histórico mutável para migração.

`totals` acumula ranges, bases, versões, reutilizações, gaps, ocorrências de
tokens, linhas de participação necessárias e entradas/saídas. Gaps iniciam
uma base separada; sobreposição aborta. `cohort-end` termina o conjunto fixado;
`versioned-boundary` interrompe antes do primeiro range já versionado, podendo
haver legado posterior ainda não auditado. `range-limit` exige retomada;
`time-budget` só devolve medições completas, enquanto timeout SQL aborta a chamada.

**Ponto importante:** contagens são lógicas. Não representam bytes físicos,
espaço recuperável, prova de hashes contra a cadeia nem autorização de conversão.
O auditor requer schemas de escopo até Stage 259, sem instalá-los. A segurança
da futura conversão exige ainda validar cobertura, referências, baseline e reorg.
