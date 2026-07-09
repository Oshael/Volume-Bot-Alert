# Monitored pinned tokens

## Objetivo

Adicionar pins por usuario no painel `MONITORED TOKENS` para que o usuario consiga manter moedas especificas em posicoes escolhidas, sem depender da ordenacao normal por volume/MCAP/idade.

Esta feature deve ser persistida no backend com uma tabela nova chamada `user_pinned_monitored_tokens`.

## Comportamento acertado

### Pin por click simples

- O card tera um handle pequeno no centro superior.
- Um click rapido no handle pina o token.
- Quando pinado por click simples, o token entra no topo da area de pins.
- O token permanece no monitored mesmo se a ordenacao normal mudaria a posicao dele.

### Pin por drag

- O usuario pode clicar e arrastar o handle do card.
- Arrastar qualquer token normal e soltar em uma posicao transforma esse token em pin.
- Arrastar um token ja pinado para outra posicao mantem o token pinado e atualiza a ordem.
- A posicao escolhida pelo usuario deve ser persistida por usuario.

### Reset por double click

- Dois clicks rapidos no handle removem o pin daquele token.
- Depois do reset, o token volta ao comportamento padrao do monitored segundo os filtros e sorts do usuario.
- A implementacao deve diferenciar click simples de double click com um pequeno atraso para evitar pinar e despinar no mesmo gesto.

### Reset all

- Quando houver 2 ou mais tokens pinados pelo usuario, mostrar um botao no topo do monitored para resetar todos.
- Esse botao remove todos os pins do usuario, nao apenas os cards visiveis na pagina atual.
- Depois do reset all, todos os tokens voltam para o comportamento padrao do monitored.

## Persistencia e backend

Criar a tabela:

```sql
user_pinned_monitored_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address VARCHAR(64) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, address)
)
```

Indices esperados:

- `idx_user_pinned_monitored_tokens_user_order` em `(user_id, sort_order, updated_at DESC)`.
- Opcional: indice por `address` se o join com catalog precisar.

Rotas/modelos esperados:

- Listar pins do usuario.
- Substituir a ordem completa dos pins do usuario.
- Remover um pin especifico.
- Remover todos os pins do usuario.

Rotas definidas no bloco 1:

- `GET /api/dashboard/monitored-pins`
- `PUT /api/dashboard/monitored-pins`
- `DELETE /api/dashboard/monitored-pins`
- `DELETE /api/dashboard/monitored-pins/:address`

Contrato consolidado no bloco 3:

- `sort_order` representa o indice absoluto do card sobre a lista normal ja ordenada, nao apenas a ordem relativa entre pins.
- `PUT /api/dashboard/monitored-pins` recebe `{ "pinnedTokens": [{ "address": "...", "sortOrder": 4 }] }`.
- O payload antigo `{ "addresses": ["..."] }` continua aceito e atribui as posicoes sequencialmente para compatibilidade.

O endpoint do monitored deve incluir pins do usuario no payload, mesmo quando o token pinado nao passar mais por `eligible_for_monitoring = TRUE` ou pelo MCAP minimo padrao.

## Regra de seguranca/importante

Pin deve ignorar filtros normais de elegibilidade e MCAP do monitored, mas nao deve ignorar bloqueios reais.

Ou seja:

- Pode aparecer mesmo se `eligible_for_monitoring = FALSE`.
- Pode aparecer mesmo se `last_mcap` estiver abaixo do minimo do monitored.
- Nao deve reaparecer se estiver bloqueado por `user_blocklist`.
- Nao deve reaparecer se estiver bloqueado por admin/blocklist estrutural do backend.

Essa regra evita que o pin vire uma forma de burlar bloqueio ou limpeza intencional.

## Ordenacao esperada

Interpretacao definida para seguir:

- Existem tokens pinados e tokens normais.
- Tokens pinados usam a ordem persistida do usuario.
- Tokens normais continuam usando a ordenacao atual do monitored.
- Click simples manda o token para o topo dos pins.
- Drag/drop salva a posicao escolhida dentro da lista renderizada.
- Ao remover o pin, o token deixa de usar a ordem persistida e volta para a ordenacao normal.

Se a posicao exata misturar pins com tokens normais, a implementacao deve materializar isso como uma ordem de pins capaz de reproduzir a intencao visual depois do refresh. O ponto essencial e que o usuario veja o token no local escolhido enquanto ele estiver pinado.

## UI

O handle deve seguir a linguagem visual do drag handle existente dos paineis:

- pequeno;
- centralizado no topo do card;
- formato pill;
- cursor `grab` / `grabbing`;
- cores padrao do bot, usando a mesma familia do `.live-panel-drag-handle`;
- dots/bolinhas internas como no exemplo enviado pelo usuario, mas sem vermelho.

Nao usar a estrela existente para pin.

Motivo: estrela ja significa favorito e usa `user_starred_tokens`. Pin e outro contrato: ele altera permanencia e ordem no monitored.

## Interacao com refresh/realtime

O monitored atualiza com frequencia. Durante drag:

- evitar que refresh reordene ou destrua o draft visual;
- commit no drop deve persistir a ordem;
- se a persistencia falhar, a UI deve reverter ou recarregar a ordem do servidor.

## Paginacao

O reset all remove todos os pins do usuario, incluindo pins fora da pagina atual.

Para drag/drop, a implementacao inicial pode operar sobre os tokens renderizados/visiveis no monitored. Se depois for necessario mover entre paginas, isso deve ser tratado como melhoria separada, porque envolve UX de auto-scroll/paginacao durante drag.

## Pontos importantes

- Esta mudanca e maior que um ajuste visual: envolve schema, rotas, estado de frontend, ordenacao e drag/drop.
- Estimativa anterior: aproximadamente 700 a 1000 linhas somando backend, frontend, CSS e testes.
- Implementar em blocos menores, evitando uma mudanca unica gigante.
- Como mexe em schema/init, rodar `npm run db:schema-check`.
- Como mexe em frontend, rodar `npm --prefix frontend run build`.
- Rodar `npm run lint` antes de encerrar.
- Rodar testes afetados com `node --test ...`.
- Revisar `git diff` antes de sugerir commit.

## Testes sugeridos

Backend:

- Model/rota preserva ordem de pins por usuario.
- Remover um pin nao remove os outros.
- Reset all remove todos os pins do usuario.
- Pins aparecem no monitored mesmo fora da elegibilidade/MCAP padrao.
- Pins nao passam por bloqueio de usuario/admin.

Frontend/unit ou camada mais barata disponivel:

- Click simples cria pin no topo.
- Double click remove pin sem deixar estado intermediario incorreto.
- Drag de token normal gera pin.
- Drag de token pinado altera ordem.
- Reset all so aparece com 2 ou mais pins.

## Fora do escopo inicial

- Drag entre paginas com auto-scroll/paginacao.
- Reaproveitar estrela como pin.
- Fazer pins globais compartilhados entre usuarios.
- Permitir pin burlar blocklist do usuario ou bloqueio admin.
