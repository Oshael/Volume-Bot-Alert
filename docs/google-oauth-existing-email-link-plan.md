# Google OAuth existing email link plan

## Context

Hoje o login social trata o caso de email existente de forma conservadora:

- Se o Google OAuth ja esta vinculado ao usuario, o login segue normalmente.
- Se o email Google verificado nao existe no sistema, uma conta OAuth-only pode ser criada.
- Se ja existe uma conta local com o mesmo email, mas sem Google vinculado, o login e bloqueado com `email_conflict`.
- O usuario precisa entrar com email/senha e vincular Google em User Settings.

Essa regra evita merge automatico por email. O ponto ruim e UX: um usuario legitimo que possui a conta local precisa lembrar a senha antes de conseguir usar Google.

## Mudanca desejada

Adicionar um fluxo seguro para o usuario confirmar que quer vincular Google a uma conta local existente quando:

- o Google retornou um email verificado;
- esse email ja pertence a uma conta local;
- a conta local ainda nao possui Google vinculado;
- o provider user id do Google ainda nao esta vinculado a outro usuario.

O fluxo nao deve fazer auto-merge silencioso. Ele deve exigir uma segunda prova de posse da conta existente antes de criar o vinculo.

## Fluxo proposto

1. Usuario clica em "Continue with Google".
2. Google retorna callback com email verificado.
3. Backend detecta `email_conflict` com conta local existente.
4. Backend cria um estado temporario de "pending social link confirmation" com:
   - provider;
   - provider user id;
   - provider email;
   - user id da conta local candidata;
   - returnTo original;
   - expiracao curta.
5. Frontend exibe uma tela/modal informando que ja existe uma conta com esse email e pede confirmacao.
6. Usuario confirma posse da conta local por um destes metodos:
   - senha atual da conta local; ou
   - codigo enviado por email; ou
   - link magico de confirmacao.
7. Backend revalida o estado pendente e, se estiver valido, cria o vinculo em `user_social_identities`.
8. Backend cria sessao normal e redireciona o usuario para o destino original.

## Opcao recomendada

Comecar com confirmacao por senha da conta local.

Motivos:

- menor mudanca de infraestrutura;
- nao depende de email delivery;
- prova posse da conta local, nao apenas posse do email Google;
- reaproveita o hash de senha existente.

Limite: contas OAuth-only sem senha nao entram nesse caso, porque o conflito relevante aqui e a conta local existente.

## Arquivos provaveis

- `src/routes/social-auth.js`
  - detectar o conflito como fluxo recuperavel, nao apenas erro final;
  - emitir estado pendente e redirecionar para o frontend com um codigo especifico;
  - adicionar endpoint para confirmar o vinculo pendente.
- `src/services/social-link-session.js`
  - criar/validar cookie ou token de pending confirmation separado do link normal autenticado.
- `src/models/user-social-identity.js`
  - reaproveitar `upsertLinkForUser`, mantendo validacoes de unicidade.
- `src/models/user.js`
  - expor helper de verificacao de senha se ainda nao existir uma funcao reutilizavel.
- `frontend/src/state/app-controller.ts`
  - interpretar o novo status de OAuth e abrir estado de confirmacao.
- `frontend/src/ui/sections/auth-section.ts` ou area equivalente de login
  - renderizar tela/modal para inserir senha e confirmar vinculo.
- `tests/auth.test.js`
  - cobrir sucesso e falhas criticas.

## Validacoes obrigatorias

Testes minimos:

- Google email verificado existente sem link cria pending confirmation, nao loga direto.
- Confirmacao com senha correta cria vinculo Google e cria sessao.
- Confirmacao com senha errada nao cria vinculo.
- Pending confirmation expirado nao cria vinculo.
- Provider identity ja vinculado a outro usuario nao pode ser usado.
- Email local diferente do email Google pendente nao pode ser confirmado.
- Usuario inativo, bloqueado ou nao verificado continua bloqueado.

Comandos:

- `NODE_ENV=test node --test --test-force-exit tests/auth.test.js`
- `npm run lint`
- `npm --prefix frontend run build`

Se houver schema novo para persistir pending confirmations:

- `npm run db:schema-check`

## Pontos importantes

- Nao implementar auto-vinculo baseado apenas em email igual.
- A confirmacao precisa provar posse da conta local existente.
- O estado pendente deve expirar rapido e ser single-use.
- Revalidar tudo no momento da confirmacao, porque o estado da conta pode mudar entre callback e confirmacao.
- Nao vazar se uma conta existe para emails arbitrarios fora do fluxo OAuth valido.
- Manter logs sem expor tokens OAuth, provider user id completo ou dados sensiveis.
- Separar esse trabalho em commit proprio de auth, porque muda comportamento de login.
