# Volume Alert Bot — Solana

## O que é esse projeto
Bot de monitoramento de volume em tempo real para tokens da Solana (e outras chains).
Roda 100% no navegador como um único arquivo HTML — sem backend, sem servidor, sem dependências externas instaladas.
UI inteiramente em inglês.

## Como rodar
Abrir o arquivo `volume-alert-bot.html` diretamente no navegador.
Não precisa de npm, build, nem servidor local.

## Estrutura
Tudo em um único arquivo HTML:
- CSS com variáveis de tema (dark, estilo terminal/scanlines)
- HTML com 4 barras de tokens (Manual Tokens, Old Tokens, Old Tokens 1 Week+, Blocklist) + 3 painéis (Monitored / PumpFun / Alerts)
- JavaScript puro no final do arquivo (sem frameworks)

## Fontes de dados
- DexScreener API — dados de volume e market cap dos tokens (/latest/dex/tokens/{address})
- PumpFun WebSocket (wss://pumpportal.fun/api/data) — feed ao vivo de tokens não listados em DEX
- CoinGecko API — preço do SOL em USD para converter solAmount para USD no PumpFun

## Lógica de CORS
A função apiFetch() tenta as requisições em cascata:
1. Direto (sem proxy)
2. corsproxy.io
3. api.allorigins.win

Não mudar essa ordem — foi escolhida por confiabilidade.
Timeouts são rastreados via variável global timeoutCount e exibidos no header (status TIMEOUTS).

## Dois modos de monitoramento

### 1. Tokens manuais / trending (painel esquerdo — "Monitored Tokens")
- Polling via setInterval (padrão: 30s, configurável — testado com 15s sem problemas)
- Chama DexScreener para cada token da lista
- Compara volume 5m atual com ciclo anterior
- Dispara alerta se variação >= threshold configurado (padrão: +50%)
- Tokens sem volume por N ciclos são removidos automaticamente (exceto _userManual)
- Sem limite de quantidade de tokens monitorados simultaneamente
- Token é removido se MCAP cair abaixo do mínimo configurado (exceto _userManual)

### 2. PumpFun ao vivo (painel central — "PumpFun — Live")
- Conexão WebSocket persistente com reconexão automática
  - Auto-reconecta com backoff exponencial (3s → 60s max) quando desconecta sozinho
  - pumpState._userDisconnected — flag que diferencia desconexão manual vs automática
  - pumpState._reconnectDelay — delay atual do backoff, reseta para 3s ao reconectar com sucesso
  - Re-subscreve todos os tokens existentes (pumpState.tokens) ao reconectar
  - Botão mostra countdown durante reconexão ("RECONNECTING 3s...")
  - Só para de reconectar se o user clicar DISCONNECT manualmente
- START MONITORING (btn-start) também conecta o PumpFun automaticamente se não estiver conectado
- STOP desconecta o PumpFun (chama disconnectPump())
- Acumula volume em janela deslizante de 5 minutos (vol5m) para alertas e entry threshold
- Acumula volume total (tok.volTotal) desde que o bot começou a monitorar o token — sem janela de tempo
- Alerta máximo 1x por minuto por token
- Tokens ficam visíveis se vol5m >= pump-entry-vol (padrão: $20k)
- Alerta dispara se vol5m >= pump-min-vol (padrão: $100k)
- Ordenado por MCAP descendente (maior MCAP no topo)
- Tokens atualizam posição dinamicamente conforme MCAP sobe/cai
- Lado direito: MCAP em roxo (principal), V = volume total acumulado em branco (secundário)
- Botão ✕ em cada token — remove do painel sem bloquear (pode voltar se tiver novos trades)

## Garbage Collector do PumpFun
- pumpGarbageCollect() — roda a cada 30s (PUMP_GC_INTERVAL)
- Remove tokens inativos: sem trades há 10 minutos (PUMP_GC_INACTIVE = 600000ms)
- Remove tokens com low MCAP: MCAP abaixo de $4k por 8 minutos consecutivos (PUMP_GC_LOW_MCAP = 4000, PUMP_GC_LOW_MCAP_TIME = 480000ms)
  - tok._lowMcapSince — timestamp de quando o MCAP caiu abaixo do mínimo pela 1ª vez
  - Se MCAP voltar acima de $4k, tok._lowMcapSince reseta para 0
  - Só remove se MCAP confirmado > 0 E abaixo do mínimo (evita falso positivo com mcap = 0)
- Para cada token removido:
  - Manda unsubscribeTokenTrade no WebSocket (reduz tráfego)
  - Remove a row do DOM
  - Deleta de pumpState.tokens
- Tokens com _migrated = true são ignorados (serão limpos pelo handler de migração)
- Usa tok.lastTrade como referência, fallback para tok.createdAt
- Loga no ticker: "🧹 GC: X inactive tokens removed from PumpFun"
- Libera slots no painel para tokens novos e ativos

## O que acontece quando um token migra (PumpFun → DEX)
- Quatro caminhos de detecção — qualquer um dispara o toast (protegidos por tok._migrated para não duplicar):
  1. WebSocket txType: "migrate" — instantâneo, remove do DOM imediatamente
  2. Fallback bondPct >= 100 em renderPumpToken() — detecta quando MCAP passa do target calibrado
  3. REST API polling via checkPumpMigrations() — consulta frontend-api.pump.fun/coins/{mint} a cada 3s
     - Detecta via campo `complete: true` ou `raydium_pool != null`
     - Throttle de 100ms entre tokens para não sobrecarregar a API
     - Remove do DOM após 1.5s (delay para toast aparecer antes do token sumir)
  4. Silence-based detection — token sem trades por 1 minuto (SILENCE_MS = 60000) com MCAP >= $30K
     - Roda a cada 3s via setInterval
     - Ignora ghost tokens (sem symbol ou sem createdAt)
     - Log: "🚀 SYMBOL migrated (silence 1m) at $X MCAP"
- tok._migrated = true setado nos quatro caminhos — garante que toast dispara só 1x por token
- showMigrateToast() tem ghost token guard: retorna sem fazer nada se tok.symbol ou tok.createdAt faltam
- Token é removido do painel PumpFun (delete pumpState.tokens[mint] + remove do DOM)
  - Via WS: remoção imediata
  - Via fallback/REST: remoção após 1.5s
- Toast popup aparece centralizado no topo da tela por 7s com fade-out nos últimos 0.7s
  - Mostra: foto do token, "🚀 Token Migrated", ticker, AGE, vol 5m no momento da migração, botão Copy CA
  - Som sintético de 3 tons crescentes (C5→E5→G5) ao aparecer, respeita sound-volume slider
  - Múltiplos toasts empilham verticalmente se vários tokens migrarem em sequência
  - Mais novo fica no topo (prepend), mais antigos descem — sem sobreposição
  - Hover pause: ao passar o mouse sobre o toast, os timers param e o toast fica visível até tirar o mouse
- pump-bond-mcap (hidden input) é auto-atualizado com a média das últimas 3 migrações reais:
  - Atualiza na 1ª migração da sessão, depois a cada 3 migrações (1, 4, 7, 10...)
  - pumpState.migrationCount — contador total de migrações na sessão
  - pumpState.recentMigrationMcaps — array rolling dos últimos 3 MCAPs de migração
  - Salvo no localStorage via saveConfig() a cada atualização
- Ticker: "🚀 SYMBOL migrated at $X MCAP — bond target updated to $Y"
- showMigrateToast(tok, vol5mTotal) — cria e injeta o toast no #migrate-toast-container
- playMigrateSound() — toca 3 tons via Web Audio API

## Campos de configuração
| ID | Descrição | Padrão |
|----|-----------|--------|
| threshold | Alert when 5m volume rises (%) | 50 |
| mcap-threshold | Alert when MKT CAP rises (%) in 5m | 50 |
| min-vol | Min 5m volume to alert ($) | 500 |
| min-mcap | Min market cap to alert ($) | 10000 |
| max-mcap | Max market cap to alert ($) | 0 (no limit) |
| min-mcap-remove | Min MKT CAP to stay monitored ($) | 0 (disabled) |
| interval | Check interval (seconds) | 30 |
| dead-cycles | Remove token with no volume after (cycles) | 10 |
| chain | Chain | solana |
| pump-entry-vol | Min 5m vol to appear in PumpFun panel ($) | 20000 |
| pump-min-vol | Min 5m vol to alert in PumpFun ($) | 100000 |
| pump-bond-mcap | MCAP target bonding curve — hidden input, gerenciado automaticamente | 35000 |
| old-mcap-min | Min MCAP to enter Old Tokens bar ($) | 120000 |
| old-mcap-max | Max MCAP to enter Old Tokens bar ($) | 1000000 |
| old-week-mcap-min | Min MCAP to enter Old Tokens 1 Week+ bar ($) | 120000 |
| old-week-mcap-max | Max MCAP to enter Old Tokens 1 Week+ bar ($) | 5000000 |
| hvnc-min-vol | Min total vol to trigger High Volume New Coin alert ($) | 300000 |

Todos os campos são salvos automaticamente no localStorage via saveConfig() ao sair do campo.
pump-bond-mcap NÃO aparece na UI — é um hidden input atualizado automaticamente pelas migrações reais.

## Status bar (header)
Exibe 5 indicadores em tempo real:
- STATUS — STOPPED / ACTIVE
- CYCLE — número do ciclo atual
- UPTIME — tempo desde o início (ex: 5m, 1h02m) — inteiros, sem segundos, zerado ao parar
- ALERTS — total de alertas disparados na sessão
- TIMEOUTS — contador de timeouts de API (cinza=0, amarelo=1-5, vermelho>5)
  - Cada timeout aparece também no ticker: ⏱ Timeout (N) — hostname

## Flags de proteção dos tokens — CRÍTICO

Existem duas flags distintas em tok (objeto de token no state):

- tok.manual = true — protege de remoção por dead-cycles (token não some por falta de volume)
  - Setada em: tokens adicionados pelo usuário (_userManual), tokens velhos (enquanto na barra)
  - NÃO é critério para proteger do filtro de MCAP

- tok._userManual = true — protege de remoção pelo filtro min-mcap-remove E aparece na barra Manual Tokens
  - Setada APENAS em: loadManualTokens() e addManualToken() (quando usuário digita CA e clica ADD)
  - Tokens de trending, tokens velhos, tokens do loadTrending NÃO recebem essa flag
  - Essa é a única flag que o sweepMcapFilter() respeita para proteção

NUNCA usar tok.manual como critério para o filtro de MCAP.

## Filtro de MCAP mínimo (min-mcap-remove) — como funciona
Age em 5 camadas via sweepMcapFilter(minMcapRemove):
1. loadTrending — bloqueia na entrada pelo mcapVal do par, token nem entra no state
2. runCycle — sweepMcapFilter() no início de cada ciclo
3. loadTrending().then() — sweepMcapFilter() novamente após trending completar (evita race condition)
4. processToken — deleta quando API confirma MCAP atualizado
5. renderMonitored — última defesa, deleta do state antes de renderizar

Ao mudar o campo, applyMcapRemoveFilter() chama sweepMcapFilter() + renderMonitored() imediatamente.
Somente tokens com tok._userManual = true são protegidos.

## Variação de MCAP (% desde início do monitoramento)
Exibida ao lado do valor de MCAP em todos os painéis: Monitored Tokens, Manual Tokens e Old Tokens.
- Verde (+X.XX%) se subiu, vermelho (-X.XX%) se caiu — sem label de tempo
- Começa a mostrar a partir do SEGUNDO ciclo (precisa de pelo menos 2 entradas no histórico)
- Baseline = entrada mais antiga do histórico (desliza para trás até ~5min conforme ciclos passam)
- Entradas com mais de 6 minutos são descartadas automaticamente — baseline nunca fica mais velho que 6min
- Variações menores que 0.01% não são exibidas
- NÃO persiste entre sessões (histórico é em memória apenas — reseta ao recarregar)
- Implementação:
  - tok.mcapHistory = [{mcap, ts}, ...] — alimentado por pushMcapHistory() a cada ciclo em processToken
  - getMcapChange5m(tok) — compara tok.mcap com history[0] (entrada mais antiga disponível)
  - pushMcapHistory() — adiciona entrada e faz prune de entradas > 6min, sempre preservando ao menos 1
  - Renderizado inline em renderMonitored(), renderManualBar()
  - Atualizado in-place em updateManualBar() e updateOldTokensMcap()

## Persistência (localStorage)
- bot_config — todos os campos de configuração (incluindo old-mcap-min, old-mcap-max, old-week-mcap-min, old-week-mcap-max, hvnc-min-vol, pump-bond-mcap)
- manual_tokens — APENAS tokens que o usuário adicionou via campo CA (tok._userManual = true)
  - saveManualTokens() filtra por _userManual E exclui oldTokens[addr] E oldWeekTokens[addr]
  - Bug fix V57: filtro antigo usava tok.manual e só excluía oldTokens — causava tokens da barra 1 Week+ serem salvos como manuais
- old_tokens — tokens da barra "Old Tokens" (persistência própria, separada de manual_tokens)
- old_dismissed — Set de endereços removidos manualmente da barra Old Tokens
  - Persiste entre sessões via localStorage
  - Tokens nessa lista NUNCA são re-adicionados automaticamente à barra Old Tokens
  - Gerenciado por: dismissedOldTokens (Set global), saveDismissedOld()
- old_removal_log — Log de tokens removidos automaticamente da barra Old Tokens (MCAP fora da faixa)
  - Cada entrada: addr, symbol, imageUrl, pairUrl, mcap, reason, ts
  - Symbol clicável abre DexScreener (usa pairUrl salvo, fallback para /solana/{addr})
  - Entries expiram automaticamente (OLD_LOG_EXPIRY)
  - Gerenciado por: oldRemovalLog (array), logOldTokenRemoval(), renderOldRemovalLog(), removeOldLogEntry(), clearOldRemovalLog()
- old_week_tokens — tokens da barra "Old Tokens 1 Week+" (7+ dias de idade)
- old_week_dismissed — Set de endereços removidos manualmente da barra Old Tokens 1 Week+
- old_week_removal_log — Log de tokens removidos automaticamente da barra Old Tokens 1 Week+
  - Mesma estrutura do old_removal_log (addr, symbol, imageUrl, pairUrl, mcap, reason, ts)
- sound_b64_{level} — áudio customizado salvo como base64 (normal, critical, mega)
  - Restaurado automaticamente ao abrir o bot via loadPersistedSounds()
  - Se arquivo for grande demais para localStorage, avisa no ticker e não persiste
- sound_name_{level} — nome do arquivo de áudio salvo (para exibição no label)

## Barra Manual Tokens (azul ciano)
- Aparece quando o usuário adiciona tokens via campo CA + botão ADD
- Exibe: foto (34px), ticker clicável (DexScreener), ↗ DexScreener, 𝕏 busca, 👤 perfil X (se disponível), ⧉ Copy CA
- Exibe: MCAP + % variação, AGE na linha 2; 5M / 1H / 6H vols na linha 3; price change 1H / 6H / 24H na linha 4
- Price change 1H, 6H, 24H: verde (+X.XX%) se subiu, vermelho (-X.XX%) se desceu — dados da DexScreener priceChange
- Atualizado a cada ciclo via updateManualBar() (in-place, sem re-render desnecessário)
- Remover da barra (✕): limpa _userManual e manual, token pode sair do monitoramento por dead-cycles
- Remover da barra NÃO remove o token do painel Monitored — ele permanece se tiver volume
- Funções: renderManualBar(), updateManualBar(), removeManualToken(), copyManualCA()

## Barra Old Tokens (amarelo)
- Detecta automaticamente tokens entre 1d e 7d de idade durante o ciclo de monitoramento
- Faixa de MCAP configurável via campos MCAP MIN e MCAP MAX na própria barra (padrão: $120k–$2M)
- Ao mudar os campos, applyOldTokensMcapFilter() filtra imediatamente os tokens já na barra
- Exibe: foto, ticker clicável (DexScreener), 𝕏 busca no X, 👤 perfil X (se disponível), ⧉ Copy CA, ☆/⭐ Star
- Exibe: AGE + MCAP + % variação, volumes 1H/6H/24H, price change 1H/6H/24H
- **Ordenado por volume 24H descendente** — tokens com mais volume ficam no topo
- **Paginação**: limite configurável via campo PER PAGE (default: 30, mínimo: 10); tokens fora da página atual continuam sendo atualizados
- oldTokensPage — página atual (0-indexed), getOldPerPage() lê do input
- Exibe: AGE + MCAP + % variação na mesma linha (AGE na frente do MCAP)
- Exibe: price change 1H, 6H, 24H (verde +X.XX% se positivo, vermelho -X.XX% se negativo) — dados da DexScreener priceChange
- Price changes atualizados in-place a cada ciclo via updateOldTokensMcap()
- Token é removido automaticamente se MCAP confirmado (> 0) sair da faixa configurada
  - IMPORTANTE: mcap = 0 (API sem dado naquele ciclo) NÃO dispara remoção — aguarda confirmação
- Remover da barra (✕): adiciona ao dismissedOldTokens — token NUNCA volta automaticamente à barra
- Token removido manualmente CONTINUA no painel Monitored se tiver volume
- Persiste entre sessões via localStorage (old_tokens + old_dismissed)
- Ao entrar na barra: tok.manual = true (protege de dead-cycles), mas NÃO tok._userManual
- addOldToken() salva twitterUrl do token (quando disponível) para exibir link do perfil X na barra
- Funções: getOldMcapMin(), getOldMcapMax(), addOldToken(), removeOldToken(), updateOldTokensMcap(), applyOldTokensMcapFilter(), saveDismissedOld(), copyOldCA()

## Barra Old Tokens 1 Week+ (laranja escuro)
- Detecta automaticamente tokens com 7+ dias de idade durante o ciclo de monitoramento (OLD_WEEK_MIN_AGE = 604800000ms)
- Sem limite máximo de idade — qualquer token com 7+ dias entra
- Faixa de MCAP configurável via campos MCAP MIN e MCAP MAX na própria barra (padrão: $120k–$5M)
- Ao mudar os campos, applyOldWeekMcapFilter() filtra imediatamente os tokens já na barra
- Exibe: foto, ticker clicável (DexScreener), 𝕏 busca no X, 👤 perfil X (se disponível), ⧉ Copy CA, ☆/⭐ Star
- Exibe: AGE + MCAP + % variação, volumes 1H/6H/24H, price change 1H/6H/24H
- **Ordenado por volume 24H descendente** — tokens com mais volume ficam no topo
- **Paginação**: limite configurável via campo PER PAGE (default: 30, mínimo: 10)
- oldWeekPage — página atual (0-indexed), getOldWeekPerPage() lê do input
- Exibe: AGE + MCAP + % variação, price change 1H/6H/24H
- Token é removido automaticamente se MCAP confirmado (> 0) sair da faixa configurada
- Remover da barra (✕): adiciona ao dismissedOldWeekTokens — token NUNCA volta automaticamente
- Persiste entre sessões via localStorage (old_week_tokens + old_week_dismissed + old_week_removal_log)
- Ao entrar na barra: tok.manual = true (protege de dead-cycles), tok.oldWeekToken = true
- Cor do tema: #ff8c00 (laranja escuro, distinto do #ffaa00 do Old Tokens 1d-7d)
- Funções: getOldWeekMcapMin(), getOldWeekMcapMax(), addOldWeekToken(), removeOldWeekToken(), renderOldWeekTokens(), updateOldWeekTokensMcap(), applyOldWeekMcapFilter(), saveOldWeekTokens(), loadOldWeekTokens(), copyOldWeekCA()
- Removal log próprio: logOldWeekTokenRemoval(), renderOldWeekRemovalLog(), removeOldWeekLogEntry(), clearOldWeekRemovalLog()

## Comportamento de remoção das barras
- Remover do Old Tokens 1 Week+ bar → entra em dismissedOldWeekTokens (não volta mais); token fica em Monitored se tiver volume
- Remover do Old Tokens bar → entra em dismissedOldTokens (não volta mais); token fica em Monitored se tiver volume
- Remover do Manual Tokens bar → flags limpas; token fica em Monitored se tiver volume
- Remover do PumpFun (✕) → remove do painel e de pumpState.tokens; não bloqueia; pode voltar com novos trades
- Block → remove de tudo: Monitored, PumpFun e Alerts

## Alerta Old Token Surge (+100% 1H / +150% 6H)
- checkOldTokenAlerts() — roda a cada ciclo após updateOldTokensMcap/updateOldWeekTokensMcap
- Verifica tokens de AMBAS as barras (Old Tokens + Old Tokens 1 Week+)
- Dispara quando priceChange1h >= 100% OU priceChange6h >= 150%
- 1x por token por sessão (oldAlertFired Set em memória)
- Alerta inserido em state.alerts (sobrevive re-renders) com level: 'old-surge', isOldSurge: true
- CSS: .alert-row.old-surge — borda laranja, fundo laranja (mesma cor do .mega)
- renderAlerts() exibe card com 🔥 OLD TOKEN SURGE, badge, MCAP, AGE, DexScreener/Copy CA/Block
- 2 sons distintos modificáveis (upload na config):
  - Old Alert 1H: playOldAlert1hSound(), persiste em sound_b64_old1h
  - Old Alert 6H: playOldAlert6hSound(), persiste em sound_b64_old6h
- Constantes: OLD_ALERT_1H_PCT = 100, OLD_ALERT_6H_PCT = 150

## Blocklist
- Tokens podem ser bloqueados via botão Block em cada token/alerta
- Ao bloquear: remove da lista de monitorados, do painel PumpFun e de todos os alertas
- Exibida como barra vermelha acima dos painéis com botão X para desbloquear
- Não persiste entre sessões (decisão intencional, não é bug)

## Sistema de alertas sonoros
3 níveis: normal (+50%), critical (+100%), mega (+200%)
- Cada nível aceita upload de áudio customizado (MP3/WAV/OGG)
- Fallback: tom sintético gerado via Web Audio API
- Volume controlável via slider (0–100%)
- Sons persistem entre sessões via base64 no localStorage (sound_b64_{level})
- Funções: loadLevelSound(), loadPersistedSounds(), saveSoundToStorage(), decodeSoundFromBase64()

## Alerta High Volume New Coin (HVNC)
- Dispara quando: token com menos de 30 minutos de idade atingir vol24h >= hvnc-min-vol (padrão: $300k)
- Usa nível MEGA de som automaticamente
- Dispara apenas UMA vez por token (flag tok._hvncFired no painel Monitored)
- No card de alerta: substitui o badge "+X% VOL" por "🚨 High Volume New Coin / $Xk total vol"
- Ticker: "🚨 SYMBOL HIGH VOLUME NEW COIN — $Xk total vol"
- Campo de config: hvnc-min-vol (0 = desabilitado)

## Painel PumpFun — Live
- Único painel (sem abas)
- Ordenado por MCAP descendente — token com maior MCAP no topo
- Lado direito: MCAP em roxo (principal, p-total-mcap), V = volume total acumulado sempre em branco (p-total-vol)
  - volColor = '#ffffff' fixo — não muda com threshold, não usar var(--muted) para vol
  - VOL 5M continua na linha de detalhes do token (usado para alertas e entry threshold)
- Botão ✕ por token: remove do painel sem bloquear (não persiste — token pode reaparecer com novos trades)
- Barra de progresso = bonding curve (p-bond-bar / p-bar):
  - Oculta até a 1ª migração da sessão (display:none enquanto pumpState.migrationCount < 1)
  - Após 1ª migração: aparece em todos os tokens com target calibrado automaticamente
  - Cálculo: tok.mcap / pump-bond-mcap * 100
  - Cor: roxo (<50%), amarelo (50–80%), verde (>80% — próximo da migração)
  - Tooltip: "Bonding curve: X% of $Y"
  - Target (pump-bond-mcap) atualiza na 1ª migração, depois a cada 3 (migrationCount: 1, 4, 7, 10...)
  - Usa média rolling dos últimos 3 MCAPs reais de migração
- AGE exibida na linha de detalhes: segundos se <1min (ex: 8s), minutos se >=1min (ex: 5m)
- MCAP atualizado a partir de: usd_market_cap → marketCapSol*solPx → reservas (fallback)
- Tokens só aparecem se tiverem trades durante a sessão atual (limitação do WebSocket)
- renderPumpToken() — render individual throttled (800ms por token)
- Sort: pumpState.tokens[mint].mcap — não reverter para vol5m

## Alertas PumpFun
- firePumpAlert() — dispara quando vol5m >= pump-min-vol, 1x por token por sessão (flag tok._alertFired)
  - tok._alertFired = true após 1º alerta — token nunca alerta novamente na mesma sessão
  - Diferente de tok.lastAlert que era throttle por tempo — agora é bloqueio permanente por sessão
- tok._hvncPumpFired — flag separada de tok._hvncFired; evita HVNC duplicado no painel PumpFun
  - Verificado no início de firePumpAlert(); se true, retorna sem disparar
  - NÃO misturar com tok._hvncFired (usado no painel Monitored)

## Toast de migração
- #migrate-toast-container — div fixo no topo da tela, centralizado, z-index 9999, pointer-events:none, max-height 90vh
- .migrate-toast — card individual com animação toastIn (slide+scale) ao aparecer, pointer-events:auto
- .fade-out — classe adicionada após 6.3s, aciona animação toastOut (fade nos últimos 0.7s)
- Toast removido do DOM após 7s via setTimeout
- Hover pause: mouseenter limpa timers (toast fica indefinidamente), mouseleave reinicia timers
- Múltiplos toasts empilham verticalmente (flex-direction: column, gap: 8px) — novos no topo via prepend
- showMigrateToast(tok, vol5mTotal, mint) — cria toast, injeta no container via prepend, chama playMigrateSound()
- playMigrateSound() — 3 osciladores (C5=523Hz, E5=659Hz, G5=784Hz) com delay de 120ms entre cada

## Ações em cada token/alerta
- ↗ / DexScreener — abre par no DexScreener
- 𝕏 / X Search $TICKER — busca o símbolo no X
- 👤 / X Profile — abre perfil oficial do token no X (quando disponível via pair.info.socials)
- ⧉ / Copy CA — copia o endereço do contrato com feedback visual
- ✕ (PumpFun) — remove token do painel sem bloquear
- Block — bloqueia o token globalmente
- DEBUG MCAP — botão laranja, imprime estado de cada token no console (F12) e roda sweep

## Convenções de código
- Estado global: state (tokens manuais/trending), pumpState (PumpFun), oldTokens (tokens velhos 1d-7d), oldWeekTokens (tokens velhos 7d+)
- pumpState.migrationCount — contador total de migrações recebidas via WS na sessão (começa em 0)
- pumpState.recentMigrationMcaps — array rolling, máx 3 entradas, MCAPs reais das últimas migrações
- dismissedOldTokens — Set global, endereços removidos manualmente da barra Old Tokens, persiste em old_dismissed
- dismissedOldWeekTokens — Set global, endereços removidos manualmente da barra Old Tokens 1 Week+, persiste em old_week_dismissed
- timeoutCount — variável global, incrementada a cada timeout de API, refletida no header
- Render throttled no PumpFun: pumpRenderThrottle — máx 1 render por 800ms por token
- Máx 150 tokens exibidos no painel PumpFun simultaneamente
- Sanitização de dados do WebSocket via função sanitize() inline (evita XSS e quebras de linha)
- fmt(n) — formata com decimais (ex: $2.73M) — usar para MCAP
- fmtVol(n) — formata sem decimais (ex: $619K) — usar para volumes
- fmtAge(ts) — formata idade: Xs se <1min, Xm se <1h, XhYm se <1d, Xd
- getMcapChange5m(tok) — retorna {pct, color, str} comparando tok.mcap com history[0], ou null se < 2 entradas
- pushMcapHistory(tok, mcap) — adiciona entrada ao tok.mcapHistory, prune > 6min, preserva ao menos 1 entrada
- tok.priceChange1h / tok.priceChange6h / tok.priceChange24h — % variação de preço da DexScreener (pair.priceChange.h1/h6/h24)
- copyCA(addr, btn) — copia CA com feedback em token cards do painel Monitored
- copyManualCA(addr, btn) — copia CA com feedback nos cards da barra Manual Tokens
- copyOldCA(addr, btn) — copia CA com feedback nos cards da barra Old Tokens
- copyOldWeekCA(addr, btn) — copia CA com feedback nos cards da barra Old Tokens 1 Week+
- sweepMcapFilter(min) — varre state e remove tokens abaixo do mínimo (exceto _userManual)
- debugTokens() — imprime estado de todos os tokens no console e roda sweep
- ipfsToHttp(url) — converte ipfs:// para https://ipfs.io/ipfs/
- resolveImage(mint, uri) — busca imagem: PumpFun API (1º) → IPFS gateways (2º); máx 2 tentativas por token via _imageResolved + _imageRetried
- checkPumpMigrations() — polling REST a cada 3s; verifica complete/raydium_pool em cada token ativo

## Imagens de tokens
- PumpFun tokens: tok.image — campo separado de tok.imageUrl (usado em Monitored/Manual)
- No create: tok.image recebe msg.image (URL direta) se disponível; msg.uri salvo como tok._uri (metadata JSON, NÃO como imagem)
- resolveImage(mint, uri) — busca imagem do token com cascata de prioridade:
  1. PumpFun API (frontend-api.pump.fun/coins/{mint} via corsproxy.io) — mais confiável, retorna image_uri direto
  2. Metadata JSON via IPFS gateways (ipfs.io → cf-ipfs.com → pinata) — só se uri fornecido
  - Atualiza a imagem na row já renderizada se o token estiver visível no painel
  - Funciona mesmo sem uri (vai direto pro PumpFun API)
- Controle de tentativas (evita spam de requests):
  - tok._imageResolved = true — setado no create ou no 1º trade sem imagem; impede re-chamadas em trades subsequentes
  - tok._imageRetried = true — setado no renderPumpToken quando token aparece sem foto; dá uma 2ª chance
  - Máximo 2 tentativas por token: 1x no create/trade + 1x no render
- No trade handler: só seta tok.image se msg.image existir (URL real), não faz fallback para msg.uri
- IPFS resolvido via ipfsToHttp() — converte ipfs:// para https://ipfs.io/ipfs/
- Fallback visual: placeholder com iniciais do símbolo se imagem falhar (onerror)
- Monitored/Manual tokens: tok.imageUrl — vem da DexScreener (pair.info.imageUrl)
- Erros de CORS/403 nos gateways são esperados e não afetam o funcionamento do bot

## Chains suportadas
Solana (padrão), Ethereum, BSC, Base — selecionável no config.
O filtro de chain é aplicado nos pares retornados pela DexScreener.

## O que não mudar sem motivo
- A cascata de proxies em apiFetch() — funciona assim por CORS
- O throttle de 800ms no render do PumpFun — sem ele a UI trava com muitos tokens
- A janela de 5 minutos (300000ms) no PumpFun — é o núcleo da lógica de volume
- O onerror nas imagens — necessário porque muitos tokens têm imagens quebradas
- A distinção entre tok.manual e tok._userManual — são propósitos diferentes, não consolidar
- saveManualTokens() deve filtrar por _userManual E excluir oldTokens E oldWeekTokens (não por manual)
- removeOldToken() NÃO deve deletar o token do state — apenas remover da barra e adicionar ao dismissedOldTokens
- addOldToken() deve checar dismissedOldTokens antes de adicionar — nunca re-adicionar tokens dispensados
- updateOldTokensMcap() só remove se mcap confirmado > 0 e fora da faixa — nunca remover se mcap = 0 (dado ausente)
- tok._alertFired = true após 1º alerta PumpFun — não remover; garante 1 alerta por token por sessão
- tok._migrated = true após migração detectada (WS ou fallback) — impede toast duplicado
- tok._hvncFired = true após disparar HVNC no painel Monitored — não remover
- tok._hvncPumpFired = true após disparar HVNC em firePumpAlert — flag separada, não misturar
- pushMcapHistory() deve sempre preservar ao menos 1 entrada mesmo após prune — baseline nunca some
- getMcapChange5m() usa history[0] como baseline — não mudar para lógica de busca por timestamp
- renderPumpToken() ordena por tok.mcap (não por vol5m) — não reverter essa ordenação
- p-total-mcap = MCAP em roxo; p-total-vol = Volume Total acumulado em branco — são dois elementos separados no lado direito
- tok.volTotal — volume total acumulado (soma de todos os trades desde conexão), NÃO substituir por vol5m
- Barra do PumpFun (p-bond-bar) = bondPct (tok.mcap / pump-bond-mcap * 100) — NÃO vol5m/threshold
- pump-bond-mcap é hidden input, NÃO deve aparecer na UI — é auto-gerenciado pelas migrações
- Barra oculta (display:none) até pumpState.migrationCount >= 1 — não remover essa lógica
- Target atualiza na migração 1, depois a cada 3 (1, 4, 7...) — não mudar para "toda migração"
- tok._migrated = true previne toast duplo entre os 3 caminhos de detecção — não remover essa flag
- checkPumpMigrations() usa corsproxy.io para CORS — não mudar para fetch direto
- Throttle de 100ms entre tokens em checkPumpMigrations() — evita rate limit da API do PumpFun
- Intervalo de 3s em setInterval(checkPumpMigrations) — não aumentar demais, usuário espera resposta rápida
- PUMP_GC_INACTIVE = 10 minutos — tokens sem trades nesse período são removidos automaticamente do PumpFun; não reduzir demais senão remove tokens que estão só com volume baixo temporário
- PUMP_GC_LOW_MCAP = 4000 e PUMP_GC_LOW_MCAP_TIME = 480000 (8min) — tokens com MCAP baixo por tempo prolongado são removidos; tok._lowMcapSince rastreia início do período de low MCAP, reseta se MCAP voltar acima do mínimo
- addOldToken() salva twitterUrl — necessário para exibir link do perfil X na barra Old Tokens
- logOldTokenRemoval() salva pairUrl — necessário para link clicável no removal log
- SILENCE_MS = 60000 (1 minuto) na silence-based migration detection — não reduzir demais senão gera falsos positivos; não aumentar demais senão migração demora a ser detectada
- showMigrateToast() tem ghost token guard (!tok.symbol || !tok.createdAt) — não remover, previne toasts de tokens sem dados
- pumpState._userDisconnected diferencia desconexão manual vs automática — não remover, senão auto-reconexão roda após disconnect manual
- pumpState._reconnectDelay backoff exponencial (3s → 60s) — não usar intervalo fixo
- START MONITORING conecta PumpFun automaticamente — não separar essas operações
- STOP desconecta PumpFun — não separar essas operações
- OLD_WEEK_MIN_AGE = 604800000 (7 dias) — sem limite máximo de idade, diferente do Old Tokens (1d-7d)
- dismissedOldWeekTokens é separado de dismissedOldTokens — não misturar os dois Sets
- addOldWeekToken() e addOldToken() são independentes — um token com 7d+ pode estar em ambas as barras se a idade mudar durante a sessão
- tok.image no PumpFun: NUNCA setar com msg.uri (é metadata JSON, não imagem) — só msg.image (URL direta) ou via resolveImage
- resolveImage() cascata: PumpFun API (1º) → IPFS gateways (2º) — não inverter prioridade
- resolveImage() limitado a 2 tentativas por token (_imageResolved + _imageRetried) — não remover essas flags, senão gera milhares de requests falhando
- @keyframes toastOut — precisa da declaração de abertura `@keyframes toastOut {` senão invalida todo CSS abaixo

---

# Volume Alert Server — Backend (Node.js)

## Objetivo final
Transformar o Volume Alert Bot em um produto web multi-usuário com login, convites, e dados em tempo real via servidor. O servidor mantém uma única conexão com PumpFun/DexScreener e distribui dados brutos para todos os clientes. Cada usuário tem suas próprias configs (tokens manuais, thresholds, blocklist) salvas no banco. Filtragem acontece no client com base nas configs individuais.

## Stack
- Node.js + Express
- PostgreSQL (usuários, convites, sessões, configs)
- JWT + bcrypt (autenticação)
- Socket.io (distribuição de dados em tempo real — Etapa 3)

## Estrutura de diretórios
```
volume-alert-server/
├── config/index.js           — Configuração centralizada (.env → ../.env)
├── src/
│   ├── server.js             — Express app principal
│   ├── middleware/
│   │   ├── auth.js           — JWT + session validation + user ativo
│   │   └── rate-limit.js     — Rate limiting geral e auth
│   ├── models/
│   │   ├── db.js             — Pool PostgreSQL (exporta { pool, query, getClient })
│   │   ├── user.js           — User CRUD + bcrypt
│   │   ├── invite.js         — Invite CRUD (create, consume, validate, revoke)
│   │   ├── session.js        — Session tracking (create, revoke, cleanup)
│   │   ├── login-attempt.js  — Login audit + lockout
│   │   ├── user-config.js    — Config key-value por user com whitelist + validação
│   │   ├── user-token.js     — Manual tokens por user com validação de endereço
│   │   └── user-blocklist.js — Blocklist por user com validação de endereço
│   ├── routes/
│   │   ├── auth.js           — Register, login, logout, change-password
│   │   ├── invites.js        — Invite management
│   │   ├── admin.js          — Admin panel endpoints
│   │   ├── config.js         — Config CRUD (GET/PUT/PATCH + tokens + blocklist)
│   │   └── health.js         — Health check
│   ├── services/
│   │   ├── sol-price.js      — Polling CoinGecko (preço SOL)
│   │   ├── pumpfun-ws.js     — Conexão WS única com PumpFun
│   │   ├── dexscreener.js    — Fetch direto DexScreener
│   │   └── socket-hub.js     — Socket.io hub (auth + distribuição)
│   └── utils/
│       ├── db-init.js        — Create tables Etapas 1-2 (npm run db:init)
│       ├── db-init-stage4.js — Create tables Etapa 4
│       └── create-invite.js  — Bootstrap invite (npm run invite:create)
├── tests/
│   ├── auth.test.js          — Testes Etapa 1
│   ├── admin.test.js         — Testes Etapa 2
│   └── config.test.js        — Testes Etapa 4 (51 testes)
├── .env                      — Segredos (NUNCA commitar)
├── .env.example              — Template
├── .gitignore
└── package.json
```

## Setup local (já feito)
1. npm install — 160 pacotes instalados
2. PostgreSQL — banco `volume_alert` criado, tabelas inicializadas via `npm run db:init`
3. .env configurado — DB_PASSWORD + JWT_SECRET (128 chars hex)
4. Bootstrap invite criado via `npm run invite:create`
5. Primeiro usuário registrado e promovido a admin
6. Servidor rodando em http://localhost:3000

## Bug fix aplicado
- config/index.js: path do .env era `../../.env` (errado), corrigido para `../.env`
  - `__dirname` = pasta `config/`, um nível acima = raiz do projeto onde está o `.env`

---

## Etapa 1 — Fundação: Auth + Invites + Segurança ✅ CONCLUÍDA

### Autenticação
- Registro invite-only (sem convite não entra)
- Senhas com bcrypt 12 rounds
- JWT com expiração configurável (padrão: 7 dias)
- Sessões rastreáveis no banco, revogáveis individualmente ou em massa
- Change-password revoga todas as sessões (força re-login)

### Segurança
- Rate limiting geral: 100 req/15min por IP
- Rate limiting auth: 10 req/15min por IP (login, register)
- Lockout automático: 5 falhas por email OU 10 por IP = bloqueio 15 min
- Auditoria: toda tentativa de login registrada (IP, user-agent, sucesso/falha)
- Helmet: headers de segurança HTTP
- CORS configurável por .env
- Cleanup automático: sessões expiradas + login attempts antigos limpos a cada hora
- Queries parametrizadas ($1, $2) em todo o código — imune a SQL injection

### Sistema de convites
- Códigos UUID de 16 chars, uppercase
- Consumo atômico (UPDATE ... WHERE use_count < max_uses) — previne race condition
- Expiração configurável (padrão: 72h), max uses configurável (padrão: 1)
- Admins podem customizar maxUses e expiryHours; users normais usam defaults
- Revogável pelo criador ou por admin
- Bootstrap invite: npm run invite:create (created_by = NULL)

### Endpoints
| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| GET | /api/health | ❌ | Status do servidor + DB latency |
| POST | /api/auth/register | ❌ | Registro (requer invite) |
| POST | /api/auth/login | ❌ | Login |
| POST | /api/auth/logout | ✅ | Logout (sessão atual) |
| POST | /api/auth/logout-all | ✅ | Logout de todas sessões |
| GET | /api/auth/me | ✅ | Dados do usuário |
| POST | /api/auth/change-password | ✅ | Trocar senha |
| POST | /api/invites | ✅ | Criar convite |
| GET | /api/invites | ✅ | Listar meus convites |
| GET | /api/invites/all | 🔒 | Listar todos (admin) |
| GET | /api/invites/validate/:code | ❌ | Validar convite |
| DELETE | /api/invites/:id | ✅ | Revogar convite |

### Tabelas do banco
- users — id, username, email, password_hash, role, is_active, invited_by, invite_code, created_at, last_login
- invites — id, code, created_by (nullable p/ bootstrap), max_uses, use_count, expires_at, is_revoked, created_at
- login_attempts — id, email, ip_address, success, user_agent, created_at
- sessions — id, user_id, token_hash (SHA-256 do JWT, não o JWT raw), ip_address, user_agent, expires_at, created_at

### Testes de segurança validados manualmente ✅
1. Registro sem invite → 400 "All fields are required" ✅
2. Registro com invite falso → 400 "Invite code not found" ✅
3. Acesso sem token → 401 "Authentication required" ✅
4. Acesso com token falso → 401 "Invalid token" ✅
5. SQL injection no login (`' OR 1=1 --`) → 401 "Invalid email or password" (não 500) ✅
6. Brute force (6 tentativas) → 429 "Too many failed attempts", retryAfterSeconds: 900 ✅

### Testes automatizados (tests/auth.test.js)
Cobertura: health check, bootstrap invite, registration (validações + duplicatas), login (sucesso/falha/campos faltando), autenticação JWT (válido/inválido/expirado), invites CRUD (criar/validar/revogar/permissões), session management (logout/logout-all), password change, user deactivation, 404 handler.

---

## Etapa 2 — Painel Admin ✅ CONCLUÍDA

### Arquivo novo: src/routes/admin.js
Todas as rotas protegidas por `authenticate` + `requireAdmin` (middleware em cadeia).

### Endpoints Admin
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | /api/admin/stats | Dashboard: total users, sessões ativas, invites disponíveis, falhas de login 1h/24h |
| GET | /api/admin/users | Lista todos com invite tree (quem convidou quem) |
| GET | /api/admin/users/online | Sessões ativas com IP, user-agent, quando começou |
| PATCH | /api/admin/users/:id | Ativar/desativar user, mudar role (user↔admin) |
| DELETE | /api/admin/users/:id/sessions | Force-logout: revoga todas as sessões de um user |
| GET | /api/admin/invites | Lista todos os invites com status |
| POST | /api/admin/invites | Criar invite customizado (maxUses até 100, expiryHours até 720) |
| DELETE | /api/admin/invites/:id | Revogar qualquer invite |
| GET | /api/admin/logs | Login attempts recentes, filtrável por ?email=&success=&limit= |

### Proteções de segurança
- User normal → 403 em todos os endpoints admin
- Sem token → 401 em todos os endpoints admin
- Admin não pode desativar a si mesmo (previne lock-out acidental)
- Admin não pode modificar outro admin (previne escalação)
- Desativar user revoga todas as sessões automaticamente (force-logout imediato)
- Logs filtráveis: limit máx 200 (previne dump de dados), max_uses capped em 100, expiry capped em 720h

### Testes automatizados (tests/admin.test.js)
Cobertura completa:
- Security: 7 testes (user normal bloqueado em todos endpoints, sem token bloqueado)
- Stats: retorna users, sessions, invites, loginAttempts
- Users: lista todos, lista online
- User modification: desativar (revoga sessões), reativar, login bloqueado quando inativo, login restaurado quando reativado, cannot modify self, invalid ID, non-existent user, empty update, promote to admin, cannot modify another admin
- Force logout: revoga sessões, token para de funcionar, user pode relogar
- Invites: criar customizado, listar todos, revogar, 404 para inexistente
- Logs: retorna attempts, filtra por success=false, respeita limit

### Testes manuais validados ✅
1. User normal → stats/users/users-online/PATCH = "Admin access required" (403) ✅
2. Sem token → stats = "Authentication required" (401) ✅
3. Admin → lista 2 users com invite tree ✅
4. Admin → desativa user, "1 session(s) revoked" ✅
5. User desativado tenta logar → "Account is deactivated" (403) ✅
6. Admin → reativa user → "updated" ✅
7. User reativado loga de novo → "Login successful" ✅

---

## Etapa 3 — WebSocket Hub (dados compartilhados) ✅ CONCLUÍDA

### Arquivos novos: src/services/
```
src/services/
├── sol-price.js     — Polling CoinGecko a cada 60s, compartilhado
├── pumpfun-ws.js    — Conexão WS única com PumpFun, reconexão automática
├── dexscreener.js   — Fetch direto DexScreener (sem CORS, sem proxy)
└── socket-hub.js    — Socket.io com auth JWT, distribui dados
```

### Dependências adicionadas
- `socket.io` ^4.7.5 — servidor WebSocket para clients
- `ws` ^8.18.0 — client WebSocket para PumpFun (server-side)

### Arquitetura
- Servidor mantém UMA conexão com PumpFun (não uma por client)
- Servidor faz fetch direto ao CoinGecko e DexScreener (sem CORS)
- Socket.io distribui dados pra todos os clients autenticados
- Autenticação via JWT no handshake do Socket.io (valida sessão no DB)

### Eventos Socket.io
| Direção | Evento | Descrição |
|---------|--------|-----------|
| Server → Client | pump:newToken | Novo token criado no PumpFun |
| Server → Client | pump:trade | Trade em token subscrito |
| Server → Client | pump:migrate | Token migrou pra DEX |
| Server → Client | pump:status | Status da conexão PumpFun |
| Server → Client | sol:price | Preço SOL/USD (broadcast a cada 30s) |
| Server → Client | dex:tokenData | Dados DexScreener de token solicitado |
| Client → Server | dex:subscribe | Solicitar dados DexScreener de um token |
| Client → Server | pump:subscribe | Subscrever trades de um token PumpFun |
| Client → Server | pump:unsubscribe | Dessubscrever trades de um token |

### PumpFun WS (pumpfun-ws.js)
- URL: wss://pumpportal.fun/api/data
- Auto-subscribe em newToken events ao conectar
- Auto-subscribe em trades de cada token criado
- Reconexão automática com backoff exponencial (3s → 60s max)
- Ping keepalive a cada 30s
- unsubscribeToken() e subscribeToken() disponíveis
- Stats: connected, reconnects, messagesReceived, subscribedCount

### SOL Price (sol-price.js)
- Polling CoinGecko a cada 60s
- Broadcast pra clients a cada 30s via Socket.io
- getPrice() disponível pra outros módulos

### DexScreener (dexscreener.js)
- Fetch direto (sem proxy, sem CORS)
- Timeout de 10s por request
- batchGetTokens() com throttle de 100ms entre requests
- getBestPair() filtra por chain e ordena por liquidez

### Endpoint admin
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | /api/admin/ws-status | Status do hub: clients, PumpFun stats, SOL price |

### Mudança no server.js
- `app.listen()` → `http.createServer(app)` + `server.listen()` (necessário pro Socket.io)
- `module.exports = app` → `module.exports = { app, server }`
- Socket.io inicializado com `socketHub.init(server)` antes do listen

### Testes manuais validados ✅
1. Socket.io sem token → "Authentication required" ✅
2. Socket.io com token falso → "Invalid token" ✅
3. Socket.io com token válido → CONECTADO! + trades em tempo real ✅
4. DexScreener via Socket.io → 30 pairs retornados (wrapped SOL) ✅
5. DexScreener com endereço inválido → undefined (sem crash) ✅
6. ws-status admin → {"clients":0,"pumpfun":{"connected":true,"messagesReceived":483,"subscribedCount":29},"solPrice":{"price":84.96}} ✅
7. SOL Price polling → $84.96 confirmado ✅
8. PumpFun WebSocket → connected, trades fluindo ✅

---

## Etapa 4 — Configs individuais + persistência ✅ CONCLUÍDA

### Arquivos novos
```
src/models/user-config.js     — Config key-value com whitelist + validação de tipo/range
src/models/user-token.js      — Manual tokens por user com validação de endereço
src/models/user-blocklist.js  — Blocklist por user com validação de endereço
src/routes/config.js          — Endpoints REST completos (GET/PUT/PATCH + CRUD tokens/blocklist)
src/utils/db-init-stage4.js   — Criação das 3 tabelas (idempotente, seguro para re-rodar)
tests/config.test.js          — Suite de testes completa (51 testes, 51 passando)
```

### Tabelas novas
- **user_configs** — (user_id, config_key, config_value) com UNIQUE constraint; ON DELETE CASCADE
- **user_tokens** — (user_id, address, label) com UNIQUE constraint; ON DELETE CASCADE
- **user_blocklist** — (user_id, address, label) com UNIQUE constraint; ON DELETE CASCADE

Todas com índice em user_id e foreign key para users(id) com CASCADE.

### Endpoints
| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| GET | /api/config | ✅ | Retorna configs (com defaults), tokens e blocklist do user |
| PUT | /api/config | ✅ | Sync total — substitui configs/tokens/blocklist (keys ausentes voltam ao default) |
| PATCH | /api/config | ✅ | Update parcial — só atualiza configs enviadas |
| POST | /api/config/tokens | ✅ | Adicionar manual token |
| DELETE | /api/config/tokens/:address | ✅ | Remover manual token |
| POST | /api/config/blocklist | ✅ | Bloquear token |
| DELETE | /api/config/blocklist/:address | ✅ | Desbloquear token |

### Validação de configs (whitelist server-side)
Toda config key é validada contra CONFIG_SCHEMA em user-config.js:
- Keys fora da whitelist são rejeitadas (previne injeção de configs arbitrárias)
- Números validados: null/undefined rejeitados, isFinite check, range (min/max), castados para Number
- Strings validadas por allowed values e tamanho máximo (64 chars)
- Keys com schema type=number: threshold, mcap-threshold, min-vol, min-mcap, max-mcap, min-mcap-remove, interval, dead-cycles, pump-entry-vol, pump-min-vol, pump-bond-mcap, old-mcap-min, old-mcap-max, hvnc-min-vol, sound-volume
- Keys com schema type=string: chain (allowed: solana, ethereum, bsc, base)

### Validação de endereços
- Solana: base58, 32-44 caracteres (regex: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
- EVM (Ethereum/BSC/Base): 0x + 40 hex chars (regex: /^0x[0-9a-fA-F]{40}$/)
- Endereços inválidos são rejeitados com 400 antes de tocar no banco

### Limites
- Máx 200 manual tokens por user (MAX_TOKENS)
- Máx 500 blocked tokens por user (MAX_BLOCKLIST)
- Label: VARCHAR(32) — truncado silenciosamente pelo banco

### Segurança
- Queries parametrizadas ($1, $2) em todos os models — imune a SQL injection
- Config keys validadas por whitelist — não aceita keys arbitrárias
- Config values validados por tipo e range — não aceita strings em campos numéricos, null/undefined rejeitados
- Endereços validados por regex antes de INSERT — não aceita formatos inválidos
- Transações via db.getClient() + BEGIN/COMMIT/ROLLBACK em operações multi-row (replaceAll, setAll)
- Isolamento total: user A não vê configs/tokens/blocklist do user B
- CASCADE delete: deletar user limpa todas as 3 tabelas automaticamente
- Labels armazenados como plain text — XSS prevenido no frontend, não no banco

### Integração com server.js
```js
app.use('/api/config', require('./routes/config'));
```

### Inicialização das tabelas
```bash
node src/utils/db-init-stage4.js
```
Seguro para rodar múltiplas vezes (CREATE TABLE IF NOT EXISTS).

### Bug fix aplicado durante testes
- Models usavam `db.connect()` mas db.js exporta `{ pool, query, getClient }` — corrigido para `db.getClient()`
- Testes usavam `db.end()` — corrigido para `db.pool.end()`
- Validação de Infinity: JSON serializa `Infinity` como `null`, `Number(null)` = 0 passava validação — adicionado check explícito de null/undefined antes do Number()

### Testes automatizados (tests/config.test.js) — 51/51 ✅
Cobertura completa:
- **Authentication** (6 testes): GET/PUT/PATCH/POST sem token → 401, token inválido → 401
- **GET defaults** (1 teste): todas as keys do schema presentes, valores default corretos
- **PATCH partial** (10 testes): update único, múltiplo, key desconhecida, número inválido (negativo/NaN/Infinity), chain inválida, max excedido, configs vazio, boundary values (min/max)
- **PUT full sync** (5 testes): replace configs, sync completo (configs+tokens+blocklist), config inválida rejeita tudo, endereço inválido rejeita, PUT parcial (só tokens)
- **Tokens CRUD** (7 testes): add, duplicata → 409, endereço inválido → 400, missing → 400, GET retorna, delete, delete inexistente → 404
- **Blocklist CRUD** (6 testes): block, duplicata → 409, endereço inválido → 400, missing → 400, GET retorna, unblock, inexistente → 404
- **User isolation** (3 testes): configs, tokens e blocklist invisíveis entre users diferentes
- **Edge cases & security** (7 testes): SQL injection em value/address, XSS em label, value longo, float, zero, whitespace, endereço EVM
- **CASCADE delete** (1 teste): deletar user limpa todas as tabelas

---

## Etapa 5 — Frontend adaptado ⬜ PRÓXIMA

### O que fazer
- Tela de login/registro no HTML
- Adaptar o bot pra consumir dados via Socket.io do backend (não mais fetch direto)
- Configs carregadas do servidor ao logar (substituem localStorage)
- Salvar alterações de config no servidor em tempo real
- HTTPS obrigatório em produção
- Deploy: VPS (DigitalOcean/Hetzner) ou Railway/Render

---

## O que não mudar no servidor sem motivo
- bcrypt rounds = 12 — não reduzir (segurança de senhas)
- JWT secret via .env — NUNCA hardcodar
- config/index.js busca .env em `path.resolve(__dirname, '../.env')` — já corrigido, não mudar
- Consumo atômico de invites (UPDATE ... WHERE use_count < max_uses) — previne race condition
- Lockout por email E por IP separados — não remover nenhum dos dois
- Session tracking via hash do token (SHA-256) — não armazenar JWT raw no banco
- Login attempts auditados com IP + user-agent — necessário pra detectar ataques
- Cleanup automático a cada hora — não remover, senão tabelas crescem indefinidamente
- created_by nullable em invites — necessário para bootstrap invite quando não há users ainda
- Segurança 100% server-side — NUNCA confiar em verificações do frontend (Inspect/DevTools pode alterar qualquer coisa no client)
- Admin routes usam router.use(authenticate) + router.use(requireAdmin) em cadeia — não remover nenhum dos dois
- Admin não pode modificar a si mesmo via PATCH /api/admin/users/:id — previne lock-out acidental
- Admin não pode modificar outro admin — previne escalação de privilégios
- Desativar user revoga todas as sessões automaticamente — não separar essas operações
- Logs limitados a 200 resultados por query — não aumentar (previne dump massivo)
- Socket.io auth valida JWT + sessão no DB + user ativo — não remover nenhuma dessas checagens
- PumpFun WS é UMA conexão server-side pra todos os clients — não criar uma conexão por client
- SOL price polling 60s + broadcast 30s — não reduzir demais (rate limit CoinGecko)
- PumpFun reconexão com backoff exponencial (3s → 60s) — não usar intervalo fixo
- server.js usa http.createServer(app) + server.listen() — necessário pro Socket.io, não reverter pra app.listen()
- dex:subscribe sanitiza endereço (só alfanumérico, 20-64 chars) — não remover validação
- Endereço inválido no DexScreener retorna silenciosamente — não crashar o servidor
- db.js exporta { pool, query, getClient } — usar db.query() pra queries simples, db.getClient() pra transações, db.pool.end() pra fechar pool
- CONFIG_SCHEMA é a fonte de verdade para keys válidas — não aceitar keys fora da whitelist
- Validação de endereço (Solana + EVM regex) — não relaxar os patterns
- MAX_TOKENS = 200, MAX_BLOCKLIST = 500 — não aumentar sem avaliar impacto no banco
- Transações em replaceAll() e setAll() via db.getClient() + BEGIN/COMMIT/ROLLBACK — não remover
- CASCADE nas foreign keys das tabelas user_configs/user_tokens/user_blocklist — necessário para cleanup automático ao deletar user
- user_configs armazena tudo como VARCHAR — conversão para Number acontece no model (getAll)
- UNIQUE(user_id, config_key) / UNIQUE(user_id, address) — previne duplicatas no nível do banco
- Validação de null/undefined antes de Number() em validateConfigEntry — previne Infinity → null → 0 bypass

---

## Update 2026-03-07 - Login local + Security check

### Correcoes aplicadas
- `volume-alert-botV57.html`:
  - `API_BASE` agora resolve corretamente em ambiente local (`file://`, `origin = null`, localhost em porta diferente).
  - Suporte opcional a override via query string `?api=http://localhost:3000`.
  - Catch de login/register com diagnostico melhor (mostra API base usada e loga erro no console).
- `src/server.js`:
  - CORS em `development` aceita `Origin: null` (arquivo local) e `localhost/127.0.0.1` em portas de dev.

### Security battery criada
- Novo script: `security-check.ps1` (raiz do projeto).
- Cobre: health, user enumeration, JWT/session revoke, RBAC, IDOR/isolation, input validation, CORS, rate-limit, WebSocket auth, stress smoke, npm audit, secret scan, security headers.
- Gera relatorio JSON automatico: `security-report-YYYYMMDD-HHMMSS.json`.

### Resultado validado da rodada completa
- PASS: auth/session, RBAC, isolamento entre usuarios, validacao de input, CORS, rate-limit, secret scan.
- Sem falha critica exploravel identificada na API nesta rodada.
- Pendencias:
  - `npm audit`: high vulnerabilities na cadeia `bcrypt -> @mapbox/node-pre-gyp -> tar` (risco de supply chain; sem fix automatica no lock atual).
  - WebSocket auth test pode sair como SKIP quando `socket.io-client` nao estiver instalado no ambiente local.

### Notas operacionais
- `429` apos stress/rate-limit e comportamento esperado (protecao ativa), nao necessariamente "server unhealthy".
- Em producao: manter HTTPS obrigatorio e revisar XSS no frontend antes de abertura publica.

---

## Update 2026-03-07 - Fase 5 concluida (frontend + backend integration)

### Status
- Fase 5 considerada concluida para desenvolvimento local.
- Frontend autenticado integrado ao backend com sync de estado por usuario.

### Entregas principais da Fase 5
- Login/registro/sessao integrados ao backend (`/api/auth/*`).
- Restore de sessao no carregamento da pagina.
- Sync server-side de configuracoes/tokens/blocklist via `/api/config`.
- PumpFun em modo server stream (Socket.io autenticado) validado.
- Auth gate no frontend para bloquear uso sem sessao valida:
  - bloqueia `START MONITORING` sem sessao valida;
  - bloqueia conexao Pump sem socket autenticado.
- Logout invalida estado local e derruba conexoes ativas no frontend.

### Testes validados nesta fase
- Session restore: OK.
- Token invalido/expirado derruba acesso: OK.
- Multiusuario/isolamento A vs B: OK.
- PumpFun via server stream: OK (`Connected via server stream`).
- Persistencia de config: OK.
- Persistencia de manual tokens (apos fix): OK.
- Persistencia de blocklist: OK.
- Auth gate via DevTools (UI forçada sem auth): bloqueado.
- Backend offline: frontend desloga e bloqueia operacao.

### Ajustes importantes feitos durante os testes
- Correcao de persistencia de tokens manuais:
  - save por `_userManual === true` (flag definitiva);
  - sync agora valida resposta do backend e loga erro real em falha.
- CORS/login local estabilizado para ambiente de desenvolvimento.

### Pendencia nao bloqueante
- Validacao explicita do fluxo `logout-all` ficou pendente por lockout/rate-limit de auth durante os testes.
- Nao bloqueia fechamento da fase; validar depois em janela limpa de tentativas.

### Proxima fase sugerida
- Fase 6: Hardening + Deploy de producao
  - HTTPS obrigatorio;
  - hardening XSS no frontend;
  - CORS de producao estrito;
  - observabilidade e operacao;
  - revisao final de dependencias/security antes de abertura publica.

---

## Etapa 6 - Hardening + Deploy (em andamento)

### Objetivo
Levar o sistema de desenvolvimento validado na Etapa 5 para um ambiente de producao seguro, observavel e operavel.

### Escopo da Etapa 6
- HTTPS obrigatorio em producao (TLS valido + redirect HTTP->HTTPS).
- Frontend production-ready sem caminhos de fallback local sensiveis.
- Hardening de XSS no frontend (revisar pontos com `innerHTML` e padronizar escape/sanitizacao).
- CORS de producao estrito (apenas dominios oficiais).
- Revisao de dependencias e advisories de seguranca antes do go-live.
- Observabilidade minima: logs uteis, healthcheck de runtime e DB, e estrategia de restart.
- Rotina de operacao: backup/restore de banco e checklist de release.

### Checklist pratico
1. Infra e dominio
- Definir alvo de deploy (VPS / Railway / Render).
- Configurar dominio e DNS.

2. Proxy reverso + TLS
- Configurar Nginx/Caddy.
- Certificado TLS valido.
- Forcar HTTPS.

3. Config de ambiente
- `.env` de producao com secrets unicos.
- `NODE_ENV=production`.
- CORS origins limitados ao dominio real.

4. Hardening app
- Revisao de rendering dinamico no frontend (XSS).
- Remover/limitar fallback de desenvolvimento nao necessario em producao.
- Revisao final de auth/session/socket com token invalido/expirado/revogado.

5. Seguranca de dependencias
- Rodar `npm audit` e classificar risco real por contexto.
- Atualizar/substituir dependencias viaveis sem quebrar fluxo.

6. Operacao e confiabilidade
- Definir estrategia de restart (pm2/systemd/plataforma).
- Validar health endpoint em ambiente real.
- Definir backup periodico do Postgres.

### Definition of Done (Etapa 6)
- Aplicacao acessivel somente via HTTPS.
- Login + stream + config sync funcionando em dominio de producao.
- CORS e auth/socket fechados para origens/tokens invalidos.
- Checklist de seguranca final executado sem falha critica aberta.
- Runbook basico de deploy/rollback/backup documentado.

### Pendencias transportadas da Etapa 5
- Validar explicitamente `logout-all` em janela sem lockout/rate-limit para fechar teste de revogacao de sessao em multi-aba.

---

## Update 2026-03-07 - Fase 6 alvo definido (Railway)

### Decisao
- Alvo rapido de deploy escolhido: **Railway**.

### Entregas adicionadas
- `railway.json` com healthcheck (`/api/health`) e start command (`npm start`).
- `docs/phase6-railway.md` com runbook passo a passo (variaveis, deploy, init DB, smoke tests).
- `docs/phase6-checklist.md` atualizado para fluxo Railway.

### Proximos passos imediatos
1. Criar projeto Railway e conectar repo (`volume-alert-server`).
2. Provisionar Postgres no Railway.
3. Definir variaveis de producao (`NODE_ENV`, `JWT_SECRET`, `CORS_ORIGINS`, `FORCE_HTTPS`, `DATABASE_URL`).
4. Deploy inicial + `npm run db:init`.
5. Rodar bateria `security-check.ps1` contra URL Railway e validar login/ws/logout-all.

## Update 2026-03-08 - Valida��o de Produ��o (Railway) conclu�da

Validado com sucesso em produ��o (`Volume-Bot-Alert`):
- Deploy online no Railway com healthcheck passando (`/api/health` = `status: ok`).
- Vari�veis cr�ticas configuradas e aplicadas no servi�o API (`NODE_ENV`, `JWT_SECRET`, `DATABASE_URL`, `CORS_ORIGINS`, `DB_SSL`).
- Inicializa��o de schema conclu�da com sucesso (`npm run db:init`) no banco correto.
- Bootstrap invite criado com sucesso e registro do primeiro usu�rio conclu�do.
- Usu�rio admin autenticando com sucesso em produ��o.
- Fluxo de sess�o validado:
  - `POST /api/auth/login`
  - `GET /api/auth/me`
  - `GET /api/admin/stats`
  - `POST /api/auth/logout-all`
  - novo login ap�s logout-all
- Troca de senha validada (sess�es anteriores revogadas conforme esperado).

Observa��es importantes para pr�ximas sess�es:
- Evitar colar JWT manualmente em comandos PowerShell; sempre reutilizar `$login.token`.
- Em PowerShell, preferir `ConvertTo-Json`/`Invoke-RestMethod` (ou `curl.exe` com JSON simples) para evitar erro de parse (`Unexpected token \\ in JSON`).
- `postgres.railway.internal` s� resolve dentro da rede Railway; para scripts locais usar `DATABASE_PUBLIC_URL` + SSL.

## Pr�ximos passos (ap�s valida��o produ��o em 2026-03-08)

Plano objetivo para continuar na pr�xima conversa:
1. Frontend
- Implementar frontend e integrar com backend Railway.
- Fluxos m�nimos: login, register com invite, `/api/auth/me`, logout, admin stats.

2. CORS
- Assim que frontend tiver URL p�blica, atualizar `CORS_ORIGINS` no Railway (manter localhost apenas para dev).

3. Credenciais e segredos
- Consolidar credenciais finais de produ��o em cofre seguro.
- Evitar edi��o manual desnecess�ria de vari�veis do Postgres.
- Manter `DATABASE_URL` da API consistente com a senha real do banco.

4. Backup e recupera��o
- Backup j� gerado (`backup-volume-alert-2026-03-08.dump`).
- Definir rotina: backup semanal + teste de restore mensal.

5. Checklist de valida��o p�s-frontend
- `/api/health` ok
- Login ok
- `/api/auth/me` ok
- `/api/admin/stats` ok
- `logout-all` + novo login ok

Notas r�pidas para evitar erros recorrentes:
- Em PowerShell, preferir `ConvertTo-Json` + `Invoke-RestMethod`.
- N�o colar JWT manualmente; usar sempre token retornado pelo login.
- `postgres.railway.internal` n�o resolve localmente; scripts locais usam `DATABASE_PUBLIC_URL` + SSL.


## Update 2026-03-08 - Hardening backend realtime compartilhado

### Objetivo imediato
- Priorizar backend da Etapa 6 antes de atualizar o HTML mais novo.
- Fechar riscos de producao no stream compartilhado sem exigir mudanca de infraestrutura no Railway.

### Correcoes aplicadas nesta sessao
- `src/services/socket-hub.js`
  - tracking de subscriptions PumpFun por socket;
  - refcount global por mint;
  - cleanup automatico no disconnect;
  - limpeza de subscriptions locais quando token migra;
  - JWT do Socket.io aceito apenas via `auth.token`.
- `src/services/pumpfun-ws.js`
  - remove auto-subscribe server-side em todo token `create`;
  - servidor so assina trades quando ao menos um cliente pedir;
  - reset de stats volateis no stop.

### Proximos passos imediatos
1. Re-deploy no Railway com essas correcoes.
2. Validar socket em producao com 2 usuarios simultaneos.
3. Confirmar que unsubscribe de um cliente nao corta trades do outro.
4. Revalidar `logout-all` em cenario multi-aba/multi-cliente.
5. Rodar `security-check.ps1` novamente contra a URL Railway apos o deploy.

### Observacao de compatibilidade
- O HTML atual ja usa `io(API_BASE, { auth: { token } })`, entao a remocao de JWT via query string no backend nao exige mudanca nesse client.
- A atualizacao do HTML mais novo continua adiada ate o backend da Etapa 6 ficar estavel em producao.

## Update 2026-03-08 - Testes de producao no frontend Vercel/Railway

### Resultado dos testes manuais
- Login em producao via frontend Vercel: ok.
- Segunda sessao com outro usuario: ok.
- Pump monitor/alertas: ok no fluxo observado.
- Subscription compartilhada PumpFun: ok apos correcao de refcount por socket.
- `logout-all`: falhou no primeiro teste porque as sessoes ja conectadas continuavam ativas no navegador/socket.
- Persistencia por conta: comportamento inconsistente no primeiro teste; parte do estado ainda vazava pelo `localStorage` global do browser.

### Correcoes aplicadas apos esse teste
- Backend:
  - `src/services/socket-hub.js` agora rastreia sockets por usuario e permite revogar conexoes ativas quando a sessao e invalidada.
  - `src/routes/auth.js` agora revoga sockets ativos em `logout`, `logout-all` e `change-password`.
  - `src/models/user-config.js` passou a aceitar `sound-mode` como config persistida por usuario.
- Frontend integrado:
  - `volume-alert-botV57.html` agora usa chaves de storage escopadas por usuario autenticado para `bot_config` e `manual_tokens`.
  - `volume-alert-botV57.html` inclui `sound-mode` no conjunto de configs sincronizadas.
  - `volume-alert-botV57.html` faz verificacao periodica de sessao autenticada e executa logout local quando a sessao for revogada.
  - `syncConfigsToServer()` agora acusa erro se o backend rejeitar a atualizacao.

### Proximo passo imediato
1. Re-deploy no Railway com essas correcoes adicionais.
2. Re-deploy do frontend Vercel se ele estiver apontando para o arquivo HTML atualizado.
3. Repetir o teste de persistencia por conta com 2 usuarios.
4. Repetir o teste de `logout-all` e confirmar logout efetivo nas sessoes abertas.

## Update 2026-03-08 - Procedimento real validado para frontend local + Railway/Vercel

### Problemas reais encontrados nesta etapa
- O frontend no Vercel chegou a carregar o HTML novo, mas `/api/config` falhava em producao com `{"error":"Failed to load configs"}`.
- A causa nao era o HTML: o Postgres do Railway ainda nao tinha as tabelas da Etapa 4 (`user_configs`, `user_tokens`, `user_blocklist`).
- Rodar `node src/utils/db-init-stage4.js` localmente usando `DATABASE_URL` interno do Railway falha com `ENOTFOUND postgres.railway.internal`.
- Para testar o HTML local contra o backend do Railway, `CORS_ORIGINS` precisava incluir `http://localhost:8080`; sem isso o login falha com erro de CORS.
- O teste com `python -m http.server 8080` so funciona se o terminal estiver na pasta correta do projeto; fora dela o browser recebe `404 file not found` para `volume-alert-botV57.html`.

### Procedimento que funcionou de verdade
1. Criar as tabelas da Etapa 4 no banco do Railway usando conexao publica do Postgres.
- No terminal local, apontar temporariamente `DATABASE_URL` para a `DATABASE_PUBLIC_URL` do servico Postgres do Railway.
- Tambem definir SSL para conexao publica.
- Comandos usados:
  - PowerShell:
    - `$env:DATABASE_URL = "<DATABASE_PUBLIC_URL_DO_RAILWAY>"`
    - `$env:DB_SSL = "true"`
    - `$env:DB_SSL_REJECT_UNAUTHORIZED = "false"`
    - `node src/utils/db-init-stage4.js`
- Resultado esperado: `Stage 4 tables created successfully` com:
  - `user_configs`
  - `user_tokens`
  - `user_blocklist`

2. Confirmar que `/api/config` passou a responder em producao.
- Comandos usados:
  - `$base = "https://volume-bot-alert-production.up.railway.app"`
  - login via `POST /api/auth/login`
  - depois `GET /api/config` com `Authorization: Bearer $login.token`
- Se `/api/config` retornar dados, o backend de persistencia por usuario esta operacional.

3. Testar o HTML local contra o Railway antes de publicar no Vercel.
- Entrar na pasta correta do projeto:
  - `cd "C:\Users\ezequ\Downloads\Volume-Alert-Server"`
- Subir servidor estatico local:
  - `python -m http.server 8080`
- Abrir no navegador:
  - `http://localhost:8080/volume-alert-botV57.html?api=https://volume-bot-alert-production.up.railway.app`
- Nao usar `file:///...` para esse teste e nao iniciar o `http.server` fora da pasta do projeto.

4. Liberar localhost no CORS do backend durante testes locais.
- `CORS_ORIGINS` no Railway precisa incluir exatamente:
  - `https://volume-alert-front-end.vercel.app,http://localhost:8080`
- Se tambem houver teste local em outra porta, adicionar explicitamente a origem correspondente.
- Apos alterar `CORS_ORIGINS`, fazer redeploy/restart do servico API no Railway.

### Estado validado apos esse procedimento
- `GET /api/config` em producao: ok.
- Persistencia de config por conta entre sessoes/navegadores: ok apos criacao correta das tabelas Stage 4.
- Frontend local servindo o HTML novo contra Railway: ok usando `python -m http.server 8080` na pasta do projeto.

### Regra pratica para nao repetir esse retrabalho
- Se login funcionar mas configuracoes por conta nao persistirem, verificar `/api/config` antes de culpar o HTML.
- Se `/api/config` falhar em producao, conferir primeiro se o banco do Railway realmente tem as tabelas `user_configs`, `user_tokens` e `user_blocklist`.
- Para teste local do HTML com backend Railway, sempre lembrar dos dois requisitos juntos:
  - servidor estatico local na pasta certa;
  - `http://localhost:8080` incluido no `CORS_ORIGINS` do Railway.

## Update 2026-03-08 - Incidente de encoding no HTML (nao repetir)

### O que aconteceu
- O arquivo `volume-alert-botV57.html` ficou com texto visualmente corrompido na UI (`—`, `�`, `�`, etc.).
- O problema apareceu depois de uma regravacao ampla do HTML usando PowerShell/serializacao de texto durante patches rapidos.
- O comportamento funcional do bot continuou parcialmente correto, mas varios caracteres especiais da interface ficaram quebrados:
  - travessoes e bullets (`�`, `�`)
  - icones/emoji (`?`, `??`, `?`, `??`, etc.)
  - alguns comentarios e strings com acentos

### Causa raiz
- O HTML deste projeto contem muitos caracteres Unicode validos na UI.
- Regravar o arquivo inteiro por caminhos que passam pelo decoding/encoding errado do PowerShell pode introduzir mojibake.
- Em especial, reescrever trechos grandes de `volume-alert-botV57.html` via `Get-Content` / `Set-Content` / replace amplo e depois salvar pode corromper caracteres mesmo quando o arquivo continua com sintaxe valida.
- O `CLAUDE.md`/`AGENTS.md` ja dizia para preservar o comportamento e a UI do bot; o incidente mostrou que aqui tambem existe um requisito tecnico implicito: preservar rigorosamente o encoding UTF-8 do HTML.

### Procedimento correto para mexer nesse HTML daqui para frente
1. Nao fazer regravacao ampla do arquivo inteiro por PowerShell quando a mudanca for pequena.
2. Preferir alteracoes cirurgicas via `apply_patch`.
3. Se `apply_patch` falhar, preferir script Node lendo e escrevendo explicitamente em UTF-8 (`fs.readFileSync(..., 'utf8')` / `fs.writeFileSync(..., 'utf8')`).
4. Evitar `Set-Content` / replace amplo em PowerShell para esse arquivo, principalmente em blocos grandes.
5. Depois de qualquer alteracao no HTML, validar duas coisas antes de commit:
- sintaxe do script embutido;
- presenca de strings UI conhecidas com caracteres especiais, por exemplo:
  - `Volume Alert Bot � Solana`
  - `Solana � Real-time Monitor`
  - `? START MONITORING`
  - `?? Manual Tokens`
  - `? PUMPFUN � LIVE`
  - `?? ALERTS`

### Procedimento de recuperacao validado
- Restaurar `volume-alert-botV57.html` a partir do ultimo commit bom conhecido.
- Reaplicar somente os diffs funcionais necessarios, sem reserializar o arquivo inteiro.
- No incidente desta sessao, a recuperacao segura foi:
  - restaurar o HTML a partir do commit `74fe98d`;
  - reaplicar apenas:
    - fix de persistencia dos manual tokens no `F5`;
    - fallback de `API_BASE` para o Railway quando o frontend roda em `vercel.app`.

### Regra pratica
- Se aparecer texto quebrado na UI (`—`, `�`, `�`, etc.), assumir problema de encoding antes de assumir bug de logica.
- Antes de publicar novo HTML no Vercel, sempre conferir o arquivo local e evitar commit de UI corrompida.

## Update 2026-03-08 - Validacao final dos fluxos de sessao e persistencia

### Testes concluidos em producao
- Persistencia de configuracoes por conta: ok.
- Persistencia de manual tokens por conta: ok.
- Mesma conta em multiplas sessoes/navegadores: ok.
- Frontend Vercel usando backend Railway por fallback automatico de `API_BASE`: ok.
- `logout-all`: ok.
  - Sessao que disparou o logout foi invalidada.
  - Demais sessoes abertas da mesma conta tambem foram invalidadas.
  - Novo login apos `logout-all`: ok.

### Estado atual da Etapa 6
- Backend compartilhado com subscriptions PumpFun por socket/refcount: validado.
- Persistencia por usuario via `/api/config`: validada em producao.
- Fluxo de login/logout/logout-all com frontend integrado: validado em producao.
- Deploy Railway + frontend Vercel: operacional.

### Proximo foco a partir daqui
- Continuar o hardening final da Etapa 6 com revisao objetiva do que ainda falta para producao estavel.
- Tratar qualquer bug residual do frontend atual sem migrar ainda para o HTML mais novo.
- So depois disso partir para atualizar o frontend para a versao mais avancada do bot.

## Update 2026-03-08 - Decisao de prioridade: fechar Etapa 6 antes de endurecer anti-copia

### Decisao tomada
- A prioridade imediata nao sera tentar "esconder" ou ofuscar o HTML atual.
- A prioridade imediata sera terminar a Etapa 6 e deixar a base confiavel em producao.
- O trabalho de protecao real do produto sera tratado depois, com a direcao de mover o maximo possivel da logica valiosa do bot para o backend.

### Motivo da decisao
- Frontend servido ao navegador nunca e segredo real; ofuscacao so dificulta copia casual.
- O HTML atual ainda nao e a versao final mais avancada do bot, entao investir forte em protecao dele agora gera retrabalho.
- O valor real do produto precisa migrar progressivamente para o backend, nao ficar dependente de esconder JavaScript no browser.

### Ordem de trabalho aprovada
1. Fechar Etapa 6 e estabilizar producao atual.
2. Corrigir os gaps restantes de backend/producao identificados na revisao final.
3. Manter o HTML atual apenas como baseline estavel.
4. So depois preparar a migracao para o HTML mais novo.
5. Apos a migracao, avaliar protecao superficial do frontend final (minify/obfuscate) apenas como camada secundaria.
6. Em paralelo ao longo das proximas etapas, mover logica critica do bot para o backend ate o frontend virar principalmente interface.

### Gaps restantes da Etapa 6 que ainda importam
- Tornar `PUT /api/config` atomicamente consistente para nao gravar estado parcial em erro.
- Deixar documentado explicitamente que a topologia suportada atual e `single replica only`.
- Atualizar checklist/runbook da Etapa 6 para refletir o estado real validado em producao.
- Revisar compatibilidade do schema `/api/config` com a futura migracao do HTML mais novo.

### Regra de escopo
- Nao iniciar trabalho de "encriptar", "esconder" ou blindar o HTML atual antes de fechar os itens acima.
- Nao migrar para o HTML mais novo antes de a base atual da Etapa 6 estar considerada estavel.

## Update 2026-03-08 - `PUT /api/config` tornado atomico e validado

### Correcao aplicada
- O endpoint `PUT /api/config` foi ajustado para validar `configs`, `tokens` e `blocklist` antes de gravar qualquer dado.
- A escrita completa do full sync agora roda em uma unica transacao de banco.
- Resultado esperado a partir dessa correcao:
  - se qualquer parte do payload for invalida, nada e persistido parcialmente;
  - o estado anterior da conta permanece intacto.

### Validacao manual realizada
- Foi salvo um valor conhecido de `threshold`.
- Depois foi enviado um `PUT /api/config` com:
  - `configs.threshold` novo
  - `tokens` invalidos de proposito
- O request falhou e, em seguida, `GET /api/config` confirmou que o `threshold` anterior permaneceu igual.
- Conclusao: o problema de gravacao parcial do full sync foi resolvido.

### Estado atualizado dos gaps da Etapa 6
- `PUT /api/config` atomico: resolvido.
- `single replica only`: ainda precisa ficar documentado explicitamente como restricao operacional atual.
- Checklist/runbook da Etapa 6: ainda precisa ser alinhado ao estado real ja validado.
- Compatibilidade do schema `/api/config` com o HTML mais novo: continua como divida de migracao, nao como bloqueador da base atual.

### Proximos passos imediatos
1. Documentar explicitamente no projeto que a topologia suportada atual e `single replica only`.
2. Atualizar checklist/runbook da Etapa 6 com o que ja foi validado em producao.
3. Encerrar a Etapa 6 com a base atual estabilizada antes de migrar para o HTML mais novo.

## Update 2026-03-09 - Estado atual do security check

### Resultado consolidado do security check
- `T0 Health check`: PASS
- `T2 User enumeration`: PASS
- `T3 JWT/session`: PASS
- `T4 RBAC/admin protection`: PASS
- `T6 Input validation`: PASS
- `T7 CORS policy`: PASS
- `T11B Secret scan`: PASS
- `T12 Security headers`: PASS

### Itens nao marcados como falha de producao neste momento
- `T5 IDOR/isolation`: ficou como SKIP em execucao impactada por lockout/rate limit de auth; nao tratar como falha confirmada da aplicacao sem reexecucao isolada.
- `T8 Rate limiting`: SKIP quando nao solicitado explicitamente; ja houve validacao separada anterior com PASS.
- `T9 WebSocket auth`: SKIP por falha de execucao do teste auxiliar no ambiente local, nao por evidencia de falha do backend.
- `T10 Basic stress/DoS smoke`: SKIP quando nao solicitado explicitamente; ja houve validacao separada anterior com PASS.

### Observacao operacional importante
- O auth rate limit/lockout pode interferir na bateria completa do script se varios testes de login forem rodados em sequencia com as mesmas contas.
- Quando aparecer `Too many authentication attempts, please try again later`, tratar isso como protecao ativa do backend, nao como senha invalida.

### Pendencia objetiva apos security check
- `npm audit` ainda reporta `high=2` e `critical=0`.
- Proximo passo: identificar exatamente quais dependencias estao gerando esses findings e decidir se e possivel atualizar/mitigar agora na Etapa 6.

## Update 2026-03-09 - Etapa 6 considerada praticamente fechada operacionalmente

### Status de encerramento operacional
- A Etapa 6 fica considerada praticamente fechada do ponto de vista operacional da base atual.
- Deploy Railway: operacional.
- Frontend Vercel integrado ao backend Railway: operacional.
- Auth, sessao, persistencia por conta, socket compartilhado e `logout-all`: validados em producao.
- `PUT /api/config` atomico: corrigido e validado contra gravacao parcial.
- Documentacao operacional da Etapa 6: alinhada ao estado real atual.

### Restricao operacional explicitada
- A topologia suportada no estado atual continua sendo `single replica only`.
- Escalabilidade horizontal fica adiada ate existir coordenacao multi-instancia para sockets/sessoes/subscriptions.

### Risco residual conhecido
- `npm audit` continua reportando findings `high` ligados a cadeia de dependencias de `bcrypt`:
  - `bcrypt`
  - `@mapbox/node-pre-gyp`
  - `tar`
- No estado atual, isso fica tratado como risco residual conhecido da Etapa 6, nao como bloqueador imediato do go-live da base atual.
- Nao existe `fixAvailable` simples no resultado atual do audit.
- Follow-up futuro recomendado: reavaliar a estrategia de hashing/dependencia nativa quando houver janela para hardening adicional.

### Proxima etapa aprovada
- A partir daqui, o foco sai do hardening/deploy da base atual e vai para o planejamento da migracao do HTML mais novo do bot.
- Antes da migracao, sera obrigatorio comparar o HTML mais novo com a baseline atual para garantir que nenhum bug fix importante seja perdido.

### Checklist minimo para a proxima fase
1. Inventariar os fixes obrigatorios da baseline atual do frontend.
2. Comparar esses fixes com o HTML mais novo.
3. Identificar gaps de compatibilidade com o schema atual de `/api/config`.
4. Planejar migracao com regressao obrigatoria dos fluxos criticos.


## Update 2026-03-09 - Migracao V68 em andamento

### Estado atual da migracao do frontend V68
- O `volume-alert-botV68.html` passou a incorporar a camada de autenticacao e integracao com o backend:
  - login/register/restauracao de sessao;
  - `API_BASE` com fallback Railway quando servido em `vercel.app`;
  - `Socket.io` autenticado via `auth.token`;
  - persistencia por usuario para `configs`, `manual_tokens`, `blocklist`, dismissed sets, removal logs e starred tokens;
  - sincronizacao com `/api/config`.
- O backend tambem foi ampliado para aceitar os novos campos de config do V68.

### Bugs de migracao ja identificados e tratados
- O backend rejeitava campos novos do V68 em `/api/config` (`old-per-page`, `old-week-mcap-min`, `old-week-mcap-max`, `old-week-per-page`, `meteora-min-pool`) enquanto a versao nova do schema nao estava deployada no Railway.
- O full sync de `manual_tokens`/`blocklist` falhava com `500 Failed to sync configs` porque `normalizeAddressItems(...)` nao existia em `src/routes/config.js`; isso foi corrigido.
- Depois dessa correcao, o V68 passou a salvar corretamente alteracoes de config e tokens manuais.

### Bug aberto atual do V68
- PumpFun no modo `server stream` conectava e recebia eventos `pump:newToken` (ticker mostrava `New token: ...`), mas o painel nao renderizava tokens.
- Causa raiz identificada no frontend V68:
  - o codigo de subscribe/unsubscribe do modo `server` ficou preso dentro de um `if (pumpState.ws?.readyState === WebSocket.OPEN)`;
  - como no modo backend nao existe WebSocket PumpFun direto no browser, o cliente nunca emitia `pump:subscribe` para o servidor;
  - resultado: chegavam eventos de `newToken`, mas nao chegavam trades suficientes para alimentar `vol5m` e renderizar rows no painel.
- Correcao aplicada localmente no V68:
  - `pump:subscribe` e `pump:unsubscribe` agora sao emitidos corretamente quando `pumpState.transport === 'server' && socketClient?.connected`, independentemente de `pumpState.ws`.
- Hardening adicional aplicado no V68 para PumpFun:
  - trades agora guardam tambem `solAmount` e o calculo de `vol5m` passou a recalcular o total em USD com o `SOL/USD` atual;
  - isso evita perder volume quando os primeiros trades chegam antes de `pumpState.solPrice` estar preenchido.

### Proximo reteste obrigatorio do V68
1. Conectar PumpFun no V68 local.
2. Confirmar que novas rows aparecem no painel central.
3. Confirmar que `vol5m` acumula e respeita `pump-entry-vol`.
4. Confirmar que remover token e GC enviam `pump:unsubscribe` corretamente.
5. So depois disso considerar trocar o `index.html` publicado no frontend.


## Update 2026-03-09 - V68: progresso recente de migracao

### Itens fechados nesta rodada
- PumpFun live no V68 integrado: validado em uso real.
- Persistencia de `starred tokens`: integrada ao backend e validada entre browsers apos atualizar a versao testada.
- Trading terminals:
  - `Axiom` confirmado com prioridade `pairAddress -> mintAddress -> addr`.
  - `Padre` alinhado para usar a mesma prioridade da `Axiom`.
- Dropdown do trading terminal no V68:
  - foi ajustado para comportamento edge-aware na viewport;
  - abre para baixo perto do topo e para cima perto da parte inferior;
  - deixou de causar scroll/clipping indevido na barra.
- Delta do V69 incorporado ao V68 integrado:
  - auto-migracao de `Recent Tokens` para `Old Tokens 1 Week+` ao passar de 7 dias, respeitando o range de MCAP da barra destino.

### Estado atual do V68 integrado
- Auth/sessao/sync por conta: ok.
- Manual tokens: ok.
- PumpFun live: ok.
- `logout-all`: ok.
- Exclusao entre barras: ok.
- Dismissed tokens: ok.
- Regra critica de alerta com MCAP invalidando o sinal: ok.
- Primeira migracao/calibracao: ok.
- `starred tokens`: ok com backend.
- Trading terminal behavior: ok para `Axiom` e `Padre`.

### Pendencias restantes mais provaveis da migracao
- Revisar/validar `removal logs` no fluxo integrado.
- Revisar se ainda existe algum comportamento fino do `CLAUDE_HTML_PURO_.md` que nao tenha sido exercitado manualmente.
- Decidir a estrategia para carregar o historico inicial de moedas no produto (idealmente entrando pelo backend como seed, nao so pelo HTML).
- So depois disso considerar o V68 como baseline definitiva publicada.


## Bootstrap Seed (Cold Start)
- Added project seed file: `data/initial-monitored-tokens.txt` with 85 unique token contracts.
- Added authenticated backend endpoint `GET /api/bootstrap/tokens` in `src/routes/bootstrap.js`.
- Registered bootstrap route in `src/server.js` under `/api/bootstrap`.
- Integrated `volume-alert-botV68.html` to load bootstrap tokens only for cold-start accounts.
- Cold-start rules:
  - seed is fetched only when the user has no current monitored/manual/old/old-week baseline
  - seed is applied once per user via `bootstrap_seed_applied` scoped storage flag
  - seed tokens are added as monitored baseline only
  - seed tokens do NOT become `_userManual` and do NOT populate `manual_tokens`
- Product intent: improve first-run experience without polluting user-owned state.



## Permanent Token Catalog (Next Architecture Step)
- After V68 is stable in production, the next backend-first feature is a persistent token catalog/history.
- Goal: tokens discovered by the bot should remain known to the backend even when they fall out of the active UI ranges.
- UX intent: token can disappear from visible bars, but continue to exist in backend history and become eligible to re-enter monitoring when its MCAP/rules fit again.
- This is separate from `manual_tokens` and separate from the cold-start seed.
- Recommended implementation phase: after V68 publication as the next backendization step.



## Post-Stability Roadmap
- Permanent token catalog/history.
  - Backend keeps tokens known even when they leave visible UI bars.
  - Tokens can re-enter monitoring automatically when MCAP/range rules fit again.
  - This becomes the long-term memory of the bot, separate from `manual_tokens` and separate from the cold-start seed.
- Persist Meteora pool history in backend.
  - Store pool TVL snapshots over time.
  - Enable real historical movement views for Meteora pool over 1H / 6H / 24H.
- Inline sparkline mini-chart for price/MCAP history.
  - Backend accumulates MCAP/price history in PostgreSQL continuously (24/7).
  - Frontend receives prebuilt historical series on load.
  - Sparkline should already be populated with real hours/days of data when the user opens the bot.
  - Intended UX: compact green inline chart per token, similar to PumpFun-style mini charting.



## Known Limitation ? Frontend MCAP Delta Baseline
- The current V68 baseline computes the visible MCAP delta from a short in-memory history window in the browser.
- Result: the displayed 5m-style MCAP delta can appear to "jump", "reset", or change direction when the oldest baseline sample ages out of the local window.
- This is not necessarily a fetch bug; it is a consequence of the current baseline strategy (`mcapHistory` rolling window in frontend memory).
- A real fix requires backend historical storage of MCAP/price over time (24/7), so delta and future sparkline views can use persistent history instead of ephemeral client memory.



## Update 2026-03-10 - Backend-first Phase Started
- Started the backend-first phase by creating the initial permanent token catalog foundation.
- Added DB init script: `src/utils/db-init-stage5.js`.
- Added base model: `src/models/token-catalog.js`.
- Current scope is intentionally limited to schema + model layer.
- Ingestion, eligibility engine, snapshot history, and sparkline support remain future steps of the same phase.

