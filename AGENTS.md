Sempre valide criticamente os pedidos e suposicoes do usuario com base no codigo real deste repositorio.

Nao aceite sugestoes apenas porque foram pedidas. Antes de implementar:
- confronte a ideia com o codigo existente
- aponte inconsistencias, riscos e premissas falsas
- diga claramente quando o pedido conflita com a arquitetura atual
- prefira evidencias do codigo a suposicoes do usuario

Se faltar contexto, investigue o repositorio antes de concordar com a abordagem.

Sempre Declarar "Ponto importantes" que eu deva considerar quando fizermos mudanças, atualizações de features e outras coisas maiores e/ou que tenham um impacto signficativo no comportamento do bot. Isso é bom pra eu possa tomar cuidado com certos detalhes relevantes que podem passar batidos e que vão trazer alguma consequencia no funcionamento das mudanças em aplicadas e/ou no bot no geral. 

sempre rodar npm --prefix frontend run build após mudança de frontend
sempre rodar node --test ... nos testes afetados
sempre rodar npm run db:schema-check quando mexer em schema/init
sempre revisar git diff antes de sugerir commit
sempre separar commits por escopo

## Disciplina de testes

Testes devem ser proporcionais ao risco e proteger comportamento relevante. Nao use quantidade de testes, linhas de teste ou cobertura bruta como objetivo.

Antes de criar ou ampliar testes:
- identifique qual regressao concreta o teste deve detectar
- procure testes existentes que ja protejam o mesmo contrato
- escolha a camada mais barata capaz de detectar a regressao
- prefira ampliar um teste existente quando o novo cenario pertencer ao mesmo contrato
- nao replique em integracao todos os detalhes ja garantidos por teste unitario

Camadas:
- unitario:
  - usar para regras de negocio, limites, calculos, normalizacao, deduplicacao e maquinas de estado
  - deve ser a opcao padrao quando nao for necessario banco, servidor ou navegador
- integracao:
  - usar para contratos entre modulos, persistencia, schema, rotas criticas, auth, billing e efeitos transacionais
  - cobrir o fluxo principal e falhas criticas; nao repetir todas as variacoes dos testes unitarios
- smoke/E2E:
  - usar apenas para fluxos visiveis e integracoes que so podem ser verificadas pelo sistema montado
  - evitar testar por navegador combinacoes ja cobertas em camadas inferiores

Um teste novo deve cumprir pelo menos um destes criterios:
- protege uma regra de negocio ou limite significativo
- reproduz uma regressao real ou um risco plausivel
- verifica um contrato publico entre componentes
- protege seguranca, autorizacao, dinheiro, persistencia ou idempotencia
- cobre tratamento de falha externa com consequencia relevante

Evite criar testes para:
- getters, setters, wrappers ou mapeamentos triviais sem logica
- detalhes internos sem impacto no contrato observavel
- ordem exata de chamadas quando a ordem nao faz parte do comportamento
- todos os campos de objetos grandes quando apenas alguns representam o contrato
- repetir o mesmo cenario em unitario, integracao e E2E sem justificativa de risco
- restaurar estado para testes posteriores; cada teste ou grupo deve preparar e limpar o proprio estado

Regras de manutencao:
- use fixtures, builders e helpers compartilhados quando setup relevante estiver sendo repetido
- prefira casos tabelados para variacoes da mesma regra
- nao crie mocks que reimplementem o modulo testado
- teste resultados e efeitos observaveis; espione detalhes internos apenas quando forem parte real do contrato
- arquivos de teste grandes, estado compartilhado e dependencia de ordem sao sinais de refactor
- ao corrigir um bug, escreva o menor teste que falhe antes da correcao e passe depois dela
- nao adicione teste apenas porque houve alteracao de codigo; adicione quando existir comportamento ou risco novo

Ao concluir uma mudanca:
- rode os testes afetados, mas nao use isso como motivo para criar testes desnecessarios
- informe quais riscos foram cobertos e por qual camada
- se decidir nao criar teste, registre brevemente por que a validacao existente e suficiente
- para auth, billing, autorizacao, schema e persistencia, mantenha validacao mais forte, eliminando duplicacao em vez de reduzir cenarios criticos

Comandos por camada:
- `npm run test:unit`: suites rapidas e isoladas; e o caminho padrao de `npm test`
- `npm run test:integration`: suites sequenciais com banco/servidor e schema check de teste
- `npm run test:all`: unitarios e integracao
- `npm run test:smoke`: Playwright para fluxos visiveis aplicaveis

## Disciplina de validacao

Sempre use o lint como primeira linha de defesa contra acoplamento, complexidade excessiva, codigo morto e regressao estrutural.

Regras obrigatorias:
- Sempre que editar qualquer arquivo relevante, rode validacao antes de considerar a tarefa concluida.
- Nao deixe warnings novos entrarem sem justificativa clara.
- Se a mudanca tocar arquivos centrais, trate warnings de complexidade como sinal de refactor imediato, nao como detalhe estetico.
- Se a mudanca for estrutural, valide em camadas: lint, typecheck/build e testes.

Checklist minimo por tipo de mudanca:
- Mudanca pequena de frontend:
  - rodar `npm run lint`
- Mudanca media:
  - rodar `npm run lint`
  - rodar `cd frontend && npm run build`
- Mudanca que toca fluxo visivel, auth, billing, config, app shell, controller ou routes centrais:
  - rodar `npm run lint`
  - rodar `cd frontend && npm run build`
  - rodar `npm run test:smoke` quando aplicavel
- Antes de encerrar qualquer tarefa maior:
  - rodar `npm run lint` no repo inteiro

Politica de warnings:
- Warning novo deve ser corrigido no mesmo trabalho, sempre que possivel.
- Nao empurre warning para depois sem motivo concreto.
- Se um warning nao puder ser resolvido agora, explique por que ele ficou e qual o risco.

Prioridade de higiene:
- Prefira prevenir acumulacao de warnings em vez de fazer mutirao de limpeza no futuro.
- Ao detectar funcao-hub, branching excessivo ou arquivo concentrando responsabilidades demais, quebre o problema cedo.

Deixe claro antes de fazer mudanças grandes e me dê uma estimativa de quantas linhas adicionais de mudanças pedidas/sugeridas serão adicionadas no código antes de de fato aplicar alguma coisa. Esse aviso é apenas para mudanças realmente grandes, de possíveis 450 linhas ou mais de código. E nunca em hipotese alguma faça uma mudança grande de uma vez, sempre quebre em blocos menores de 300 linhas cada bloco mais ou menos(Não precisa ser literalmente esse valor, estou dando um teto médio do quanto cada bloco teria, pode ser menos ou um pouquinho mais.)

Me faça perguntas até que você tenha certeza de que você entendeu o que eu pedi, não adivinhe o que eu quero.
