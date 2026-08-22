# Novo worker como serviço na VPS2

Este é o procedimento padrão para publicar um worker permanente no
`TrendScopeWorkers-01`. Não copie uma unit completa: todos os workers herdam a
unit template `/etc/systemd/system/trendscope-worker@.service`.

## Contrato no repositório

O `package.json` precisa expor um script com o mesmo nome da instância:

```text
start:worker:<nome>
trendscope-worker@<nome>.service
```

Exemplo: `start:worker:robinhood-liquidity` é executado pela instância
`trendscope-worker@robinhood-liquidity.service` por meio de
`ExecStart=/usr/bin/npm run start:worker:%i`.

Um executável dedicado que não inicia `src/server.js` não abre HTTP e não usa
`PORT`. Workers baseados em `src/server.js` precisam manter uma porta exclusiva.

### Regra de herança de ambiente

Neste repositório, processos que carregam `config/index.js` já leem o `.env`
global do projeto por `dotenv`. O arquivo `/etc/trendscope/<nome>.env` da
instância serve somente para flags e overrides exclusivos daquele worker.

Não repita `JWT_SECRET`, `DATABASE_URL`, `DB_*`, `PG*` ou credenciais já
presentes no `.env` global. Duplicá-las cria duas fontes de verdade e pode fazer
um único worker apontar para configuração diferente do restante do bot. Só
adicione banco ou segredo ao env da instância quando o entrypoint não carregar o
config global e essa dependência estiver comprovada no código.

## Configuração na VPS2

Defina o nome exatamente como aparece depois de `start:worker:` no `package.json`:

```bash
WORKER_NAME=robinhood-liquidity
```

1. Crie `/etc/trendscope/${WORKER_NAME}.env` somente com flags, identificadores e
   overrides próprios do worker. Não copie `PORT`, banco, segredos ou flags de
   outros workers quando já forem fornecidos pelo script/template ou pelo `.env`
   global. O arquivo deve permanecer `root:root` e modo `0600`:

   ```bash
   sudoedit "/etc/trendscope/${WORKER_NAME}.env"
   sudo chown root:root "/etc/trendscope/${WORKER_NAME}.env"
   sudo chmod 600 "/etc/trendscope/${WORKER_NAME}.env"
   ```

2. Crie o drop-in da instância:

   ```bash
   sudo systemctl edit "trendscope-worker@${WORKER_NAME}.service"
   ```

   O conteúdo editável é somente:

   ```ini
   [Service]
   EnvironmentFile=/etc/trendscope/robinhood-liquidity.env
   ```

   No exemplo, substitua `robinhood-liquidity` pelo valor escolhido para
   `WORKER_NAME`.

   A seção `[Unit]`, usuário, grupo, diretório e `ExecStart` vêm da template e
   não devem ser duplicados no drop-in.

3. Recarregue e confira a composição antes de iniciar:

   ```bash
   sudo systemctl daemon-reload
   systemctl show "trendscope-worker@${WORKER_NAME}.service" \
     -p EnvironmentFiles -p ExecStart -p User -p WorkingDirectory
   ```

4. Se o worker exigir schema novo, aplique a migration/init e execute
   `npm run db:schema-check` antes do primeiro start.

5. Ative e valide:

   ```bash
   sudo systemctl enable --now "trendscope-worker@${WORKER_NAME}.service"
   systemctl status "trendscope-worker@${WORKER_NAME}.service" --no-pager -l
   journalctl -u "trendscope-worker@${WORKER_NAME}.service" -n 30 --no-pager
   ```

6. Confirme também o contrato funcional do worker — lease, cursor, cobertura ou
   outra saída persistida. Processo `active (running)` sozinho não prova que o
   trabalho está avançando.

## Atualização e rollback

Após um deploy que altere o worker, reinicie somente sua instância e repita as
validações de log e progresso. Para rollback operacional, pare e desabilite apenas
a instância; não remova a template compartilhada:

```bash
sudo systemctl disable --now "trendscope-worker@${WORKER_NAME}.service"
```

Preserve o env e o drop-in até decidir que a remoção definitiva é segura.
