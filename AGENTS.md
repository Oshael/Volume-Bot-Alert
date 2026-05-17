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
