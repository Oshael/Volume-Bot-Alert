# Manual token folders plan

## Objetivo

Adicionar organizacao por pastas para `Manual Tokens`, por usuario. O filtro de pastas nao muda o conjunto real de tokens manuais monitorados; delete de pasta muda, porque remove os tokens contidos de `user_tokens`.

As pastas sao uma camada de UI/organizacao. Tokens escondidos por filtro de pasta continuam:

- persistidos no backend como manual tokens
- monitorados
- elegiveis a alertas
- protegidos pelas regras atuais de `_userManual`

## Decisoes fechadas

- A feature e visual/organizacional, nao uma pausa de monitoramento.
- O token pode existir em mais de uma pasta, desde que isso use o mesmo token base e nao duplique o registro em `user_tokens`.
- Novos tokens manuais sem pasta aparecem apenas na exibicao padrao `All`.
- O MVP nao tera subpastas; a estrutura fica plana.
- Deletar uma pasta remove a pasta e tambem remove do backend os manual tokens contidos nela.
- Deletar um token pelo `X` da pasta/manual UI segue o comportamento destrutivo atual: remove o token de `user_tokens` para aquele usuario.

## Conflito com o comportamento atual

Hoje o bot nao tem uma acao separada de "remover da UI". O `X` atual em Manual Tokens chama a remocao do manual token e apaga o registro de `user_tokens` no backend.

Arquivos envolvidos no comportamento atual:

- `src/models/user-token.js`
- `src/routes/config.js`
- `frontend/src/state/app-controller.ts`
- `frontend/src/ui/sections/manual-section.ts`

Para a feature de pastas, nao vamos separar a acao principal de delete no MVP:

- remover pelo `X`: remove manual token do backend para aquele usuario
- deletar pasta: remove os tokens contidos da pasta e tambem de `user_tokens`

Isso preserva o comportamento atual do `X`, mas torna delete de pasta uma acao destrutiva. A UI precisa deixar isso claro antes de executar.

## Modelo recomendado

Manter `user_tokens` como fonte canonica dos manual tokens.

Adicionar tabelas novas:

```sql
user_token_folders (
  id,
  user_id,
  parent_folder_id, -- mantido nulo/no-op neste MVP; subpastas nao sao expostas
  name,
  sort_order,
  created_at,
  updated_at
)

user_token_folder_items (
  user_id,
  folder_id,
  address,
  sort_order,
  added_at
)
```

Regras:

- `user_token_folder_items.address` referencia o address existente em `user_tokens` para o mesmo user.
- O mesmo address pode aparecer em varias pastas.
- Nao ha subpastas no MVP; `parent_folder_id` deve permanecer nulo e rotas devem rejeitar `parentFolderId`.
- Ao deletar pasta, deletar vinculos visuais e os `user_tokens` associados aos tokens contidos nela.
- Ao remover de `user_tokens`, tambem executar a democao atual do catalogo quando aplicavel (`demoteFormerManualAddress`).
- Se o mesmo token estiver em varias pastas, remover o token do backend remove esse token da UI inteira daquele usuario, nao apenas da pasta deletada.

## Preferencias de UI

Usar `user_ui_prefs` para preferencias de exibicao:

- pastas visiveis selecionadas
- pasta ativa no formulario de adicionar token, se decidirmos isso depois
- estado expandido/colapsado da arvore de pastas, se necessario

Nao usar `user_ui_prefs` como fonte canonica da arvore de pastas, porque rename, move, delete e vinculos token-pasta precisam de integridade melhor do que JSON livre.

## Fluxo MVP

1. User adiciona manual token.
2. Token entra em `user_tokens` como hoje.
3. Se nenhuma pasta for escolhida, token aparece em `All`.
4. User pode criar pasta.
5. User pode adicionar o mesmo token em uma ou mais pastas.
6. User escolhe quais pastas aparecem no Manual Tokens.
7. Tokens fora das pastas visiveis somem da UI filtrada, mas continuam monitorados e alertando.
8. Se o user deletar uma pasta, os manual tokens dentro dela sao removidos de `user_tokens` e deixam de ser manual tokens daquele user.

## Blocos de implementacao

### Bloco 1 - Schema e model

Escopo estimado: pequeno/medio.

- Criar stage novo de DB para `user_token_folders` e `user_token_folder_items`.
- Atualizar `runtime-schema`.
- Criar model dedicado, por exemplo `src/models/user-token-folder.js`.
- Rejeitar tentativa de criar subpasta.
- Testes unitarios/model para criar pasta, vincular token, duplicidade e delete destrutivo de pasta removendo `user_tokens`.

Validacao esperada:

```bash
npm run lint
node --test tests/user-token-folder.test.js
npm run db:schema-check
```

### Bloco 2 - Rotas backend

Escopo estimado: pequeno/medio.

- Adicionar endpoints autenticados em `src/routes/config.js` ou rota dedicada.
- Listar pastas com itens.
- Criar/renomear/deletar pasta.
- Adicionar/remover token de pasta.
- Garantir que usuario so acessa suas proprias pastas.

Contratos a proteger:

- Deletar pasta remove os `user_tokens` contidos nela para aquele usuario.
- Remover token pelo `X` continua chamando a remocao backend atual e pode chamar `tokenCatalog.demoteFormerManualAddress`.
- Token so pode ser vinculado se existir em `user_tokens` do usuario.

Validacao esperada:

```bash
npm run lint
node --test tests/config.test.js
npm run db:schema-check
```

### Bloco 3 - Estado/API frontend

Escopo estimado: medio.

- Tipar payload de pastas em `frontend/src/services/api/config.ts`.
- Adicionar estado de folders no `AppState`.
- Carregar folders junto com config inicial ou por endpoint separado.
- Implementar a selecao de pastas visiveis como filtro visual.
- Manter `manualTokenAddresses` completo para nao afetar monitoramento.

Validacao esperada:

```bash
npm run lint
npm --prefix frontend run build
```

### Bloco 4 - UI Manual Tokens

Escopo estimado: medio.

- Renderizar selector de pastas na secao Manual Tokens.
- Nao exibir `Uncategorized`; `All` e a visao padrao para tokens sem pasta.
- Permitir escolher 1, varias ou todas as pastas.
- Manter o `X` como acao destrutiva de remover manual token do backend.
- Deixar delete de pasta visualmente claro como acao destrutiva para os tokens contidos.

Validacao esperada:

```bash
npm run lint
npm --prefix frontend run build
```

### Bloco 5 - Refinos apos teste manual

Escopo estimado: indefinido, depende do fluxo real.

- Decidir se o formulario de adicionar token deve escolher pasta ativa.
- Decidir se arrastar token entre pastas vale a complexidade.
- Ajustar copy, search, starred-only e sort dentro do filtro de pastas.
- Considerar smoke test se o fluxo visivel ficar estavel.

## Pontos importantes

- Filtro de pasta nao deve reduzir alertas nem monitoramento; qualquer filtro deve ser aplicado apenas no render da UI.
- Delete de pasta passa a reduzir alertas/monitoramento para os tokens removidos, porque remove de `user_tokens`.
- O `X` atual ja remove do backend. Vamos manter esse padrao, mas a UI de pasta precisa evitar ambiguidade entre "filtrar/esconder" e "deletar".
- Permitir token em varias pastas e leve se a relacao for uma tabela de vinculo; nao devemos duplicar dados de token.
- Com token em varias pastas, delete destrutivo de uma pasta pode remover um token que tambem aparece em outra pasta. Isso e uma consequencia direta de remover de `user_tokens`, nao apenas do vinculo visual.
- Tokens sem pasta nao precisam pasta virtual; eles aparecem no filtro `All`.
- Subpastas foram cortadas do MVP para reduzir complexidade de UI, delete destrutivo e validacao de ciclos/profundidade.
- Full sync de config nao deve apagar pastas acidentalmente; pastas precisam contrato proprio ou inclusao muito cuidadosa no payload.
