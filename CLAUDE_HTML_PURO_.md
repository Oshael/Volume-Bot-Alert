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
- HTML com 4 barras de tokens (Manual Tokens, Recent Tokens, Old Tokens 1 Week+, Blocklist) + 3 painéis (Monitored / PumpFun / Alerts)
- Barras Manual/Recent/Old Week usam layout de tabela estilo DexScreener
- JavaScript puro no final do arquivo (sem frameworks)

## Fontes de dados
- DexScreener API — dados de volume e market cap dos tokens (/latest/dex/tokens/{address})
- PumpFun WebSocket (wss://pumpportal.fun/api/data) — feed ao vivo de tokens não listados em DEX
- CoinGecko API — preço do SOL em USD para converter solAmount para USD no PumpFun
- Meteora DLMM API (dlmm-api.meteora.ag) — TVL de pools de liquidez por token (/pair/all_by_groups)

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
| meteora-min-pool | Min Meteora pool TVL to display ($) | 5000 |

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
- bot_config — todos os campos de configuração (incluindo old-mcap-min, old-mcap-max, old-week-mcap-min, old-week-mcap-max, hvnc-min-vol, pump-bond-mcap, meteora-min-pool)
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

## Barra Manual Tokens (azul ciano) — layout tabela
- Aparece quando o usuário adiciona tokens via campo CA + botão ADD
- **Layout tabela** estilo DexScreener com colunas: Token | Age | MCAP | Δ | Vol 5M | Vol 1H | Vol 6H | PChg 1H | PChg 6H | PChg 24H | Meteora | ✕
- MCAP e variação % em colunas separadas (MCAP à direita, Δ à esquerda)
- Token cell: foto (32px), ticker clicável (13px), ↗ DexScreener, 𝕏, 👤, ⧉ Copy CA, 🔗 Trade Terminal, ☆ Star
- Valores de AGE e VOL em branco (#fff), mesma cor do MCAP
- Meteora TVL com tooltip hover: ao passar mouse mostra variações 1H/6H/24H da pool (sempre visível, mostra "–" se sem dados)
- **Ordenação configurável** via filtros: Vol (5M/1H/6H), MCAP, PChange (1H/6H/24H) — default: MCAP descendente
- Estado: manualSortKey (global, default 'mcap'), setOldSort('mcap','manual')
- Filtros: id="mb-filters", cor ciano
- Row hover com highlight ciano sutil
- Atualizado a cada ciclo via updateManualBar() (in-place)
- Funções: renderManualBar(), updateManualBar(), removeManualToken(), copyManualCA()

## Barra Recent Tokens (verde #00cc66) — layout tabela
- Anteriormente "Old Tokens" (amarelo) — renomeado para "Recent Tokens" com cor verde
- Detecta automaticamente tokens entre 1d e 7d de idade
- Faixa de MCAP configurável via campos MCAP MIN e MCAP MAX (padrão: $120k–$2M)
- **Layout tabela** com colunas: # | Token | Age | MCAP | Δ | Vol 1H | Vol 6H | Vol 24H | PChg 1H | PChg 6H | PChg 24H | Meteora | ✕
- MCAP e variação Δ em colunas separadas; AGE/VOL em branco (#fff)
- Token cell: foto (32px), ticker (13px), 𝕏, 👤, ⧉, 🔗 Trade Terminal, ☆ Star
- Meteora TVL com tooltip hover (variações 1H/6H/24H)
- **Ordenação configurável** via filtros: Vol (1H/6H/24H), MCAP, PChange (1H/6H/24H) — default: Vol 24H
- Estado: oldTokensSortKey, setOldSort('vol24h','old'), id="ot-filters" cor verde
- **Paginação**: PER PAGE (default: 30, mínimo: 10)
- Cor do tema: #00cc66 (verde, distinto do #ff8c00 laranja do Old Tokens 1 Week+)
- Funções: renderOldTokens(), updateOldTokensMcap(), addOldToken(), removeOldToken(), applyOldTokensMcapFilter(), copyOldCA()

## Barra Old Tokens 1 Week+ (laranja #ff8c00) — layout tabela
- Detecta automaticamente tokens com 7+ dias de idade (OLD_WEEK_MIN_AGE = 604800000ms)
- Sem limite máximo de idade — qualquer token com 7+ dias entra
- Faixa de MCAP configurável (padrão: $120k–$5M)
- **Layout tabela** com colunas: # | Token | Age | MCAP | Δ | Vol 1H | Vol 6H | Vol 24H | PChg 1H | PChg 6H | PChg 24H | Meteora | ✕
- Mesma estrutura visual das outras barras
- **Ordenação configurável** via filtros: Vol (1H/6H/24H), MCAP, PChange (1H/6H/24H) — default: Vol 24H
- Estado: oldWeekSortKey, setOldSort('vol24h','week'), id="ow-filters" cor laranja
- **Paginação**: PER PAGE (default: 30, mínimo: 10)
- Cor do tema: #ff8c00 (laranja)
- Funções: renderOldWeekTokens(), updateOldWeekTokensMcap(), addOldWeekToken(), removeOldWeekToken(), copyOldWeekCA()
- Removal log próprio: logOldWeekTokenRemoval(), renderOldWeekRemovalLog()

## Comportamento de remoção das barras
- Remover do Old Tokens 1 Week+ bar → entra em dismissedOldWeekTokens (não volta mais)
- Remover do Recent Tokens bar → entra em dismissedOldTokens (não volta mais)
- Remover do Manual Tokens bar → flags limpas; token fica em Monitored se tiver volume
- Remover do PumpFun (✕) → remove do painel e de pumpState.tokens; pode voltar com novos trades
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
- 🔗 / Trade Terminal — dropdown hover com links para abrir o token em terminais de trading:
  - Axiom: https://axiom.trade/meme/{PAIR_ADDRESS}?chain=sol (cor #1a3a6e azul escuro)
    - IMPORTANTE: Axiom usa pair.pairAddress (endereço do pool Raydium), NÃO o token address
    - O token address com "pump" no final não carrega chart na Axiom
    - Prioridade: pairAddress → mintAddress → addr (fallback)
    - tok.pairAddress salvo via pair.pairAddress do DexScreener em processToken() e addManualToken()
  - Photon: https://photon-sol.tinyastro.io/en/lp/{ADDRESS} (cor #5b9bd5 azul claro)
  - BullX: https://neo.bullx.io/terminal?chainId=1399811149&address={ADDRESS} (cor #3ddc84 verde)
  - GMGN: https://gmgn.ai/sol/token/{ADDRESS} (cor #e8a62e amarelo/laranja)
  - Padre: https://trade.padre.gg/sol/{ADDRESS} (cor #00e676 verde)
  - Presente em todos os painéis: Manual, Recent, Old Week, Monitored, Alerts, PumpFun
  - tradeBtnHtml(addr, mintAddr, pairAddr) — 3 parâmetros, Axiom usa pairAddr, resto usa addr
  - CSS: .trade-wrap / .trade-btn / .trade-dd — dropdown com bridge invisível (::before)
  - Hover clareia a cor original de cada terminal (filter: brightness)
- ☆/⭐ Star — marca/desmarca token (todas as barras)
- ✕ (PumpFun) — remove token do painel sem bloquear
- Block — bloqueia o token globalmente

## PumpFun sort pause
- pumpState._sortPaused — flag que pausa reordenação dos tokens quando mouse está sobre o pump-list
- Listeners: mouseenter no #pump-list seta true, mouseleave seta false
- Permite interagir com dropdowns de trade terminal sem o token mudar de posição

## Convenções de código
- Estado global: state (tokens manuais/trending), pumpState (PumpFun), oldTokens (recent 1d-7d), oldWeekTokens (7d+)
- pumpState.migrationCount — contador total de migrações recebidas via WS na sessão (começa em 0)
- pumpState.recentMigrationMcaps — array rolling, máx 3 entradas, MCAPs reais das últimas migrações
- pumpState._sortPaused — flag que pausa sort dos PumpFun tokens durante hover no pump-list
- dismissedOldTokens — Set global, endereços removidos da barra Recent Tokens, persiste em old_dismissed
- dismissedOldWeekTokens — Set global, endereços removidos da barra Old Tokens 1 Week+, persiste em old_week_dismissed
- tok.mintAddress — mint address real do token (pair.baseToken.address do DexScreener)
- tok.pairAddress — endereço do par/pool no Raydium (pair.pairAddress do DexScreener) — usado pela Axiom
- oldTokensSortKey — estado global do sort da barra Recent Tokens (default: 'vol24h')
- oldWeekSortKey — estado global do sort da barra Old Tokens 1 Week+ (default: 'vol24h')
- manualSortKey — estado global do sort da barra Manual Tokens (default: 'mcap')
- setOldSort(key, barType) — altera sort e re-renderiza; barType: 'old'|'week'|'manual'
- oldSortCompare(key, addrA, a, addrB, b) — comparador genérico; suporta vol5m/vol1h/vol6h/vol24h/mcap/pc1h/pc6h/pc24h
- tradeBtnHtml(addr, mintAddr, pairAddr) — gera dropdown de trading terminals; Axiom usa pairAddr
- meteoraCellHtml(addr, prefix) — gera célula de tabela com TVL + tooltip hover variações 1H/6H/24H
- meteoraTvlHtml(addr, prefix) — gera HTML da linha Meteora (usado em Monitored/PumpFun, não nas tabelas)
- updateMeteoraTvlInPlace(addr, prefix) — atualiza TVL e variações em elementos DOM existentes
- fmt(n) — formata com decimais (ex: $2.73M) — usar para MCAP
- fmtVol(n) — formata sem decimais (ex: $619K) — usar para volumes
- fmtAge(ts) — formata idade: Xs se <1min, Xm se <1h, XhYm se <1d, Xd
- debugTokens() — imprime estado no console (acessível via F12, botão removido da UI)
- alert-search — input no painel Alerts que filtra por ticker/name/address em tempo real

## Layout das barras — tabela estilo DexScreener
- As 3 barras (Manual, Recent, Old Week) usam layout de tabela HTML com header fixo
- MCAP e variação Δ são colunas separadas — evita sobreposição visual
- Foto 32px, ticker 13px bold, botões 10-12px, font base 12px, headers 10px uppercase
- AGE e VOL em branco (#fff), mesma cor do MCAP
- Row hover com highlight sutil na cor da barra (ciano/verde/laranja)
- Meteora TVL com tooltip hover (variações 1H/6H/24H) via meteoraCellHtml()
- Tooltip sempre visível no hover (mostra "–" quando sem dados de variação)
- Scroll horizontal em telas pequenas (overflow-x: auto)
- Dropdowns de filtro e trade terminal usam ::before bridge invisível

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

## Meteora TVL Tracking
Monitora TVL (Total Value Locked) de pools Meteora DLMM para cada token.
- **API**: `dlmm-api.meteora.ag/pair/all_by_groups?include_token_mints=addr1&include_token_mints=addr2&...`
  - NÃO usar `dlmm.datapi.meteora.ag` — esse domínio usa endpoints diferentes (/pools)
  - NÃO usar `search_term` — usar `include_token_mints` que filtra por mint address exato
  - Campo TVL na resposta: `p.liquidity` (string) — NÃO `p.tvl` (não existe)
  - Aceita múltiplos `include_token_mints` na mesma request — busca pools de vários tokens de uma vez
  - Rate limit: 30 req/s (Meteora), mas proxy (corsproxy.io) limita muito antes
  - Sem API key
  - Tem CORS — passa por apiFetch() com cascata de proxies
- **Estratégia bulk**: fetchMeteoraBulk(addrs) faz UMA request por chunk de 15 tokens
  - 60 tokens = 4 requests; 100 tokens = 7 requests; 200 tokens = 14 requests
  - Muito mais eficiente que 1 request por token (era a causa dos 600+ timeouts)
  - Delay de 1s entre chunks para evitar 429 no proxy
  - Retorna mapa { addr: { tvl, poolAddress, poolCount } }
  - Chunk size = 15 mints — conservador para segurança de URL length
- **Estado**: meteoraCache[addr] = { tvl, poolAddress, poolCount, noPool, lastFetch, history: [{tvl, ts}] }
  - Em memória apenas — NÃO persiste entre sessões
  - noPool = true: token não tem pool na Meteora; retry a cada 5 minutos
  - history: array rolling, prune automático de entries > 24h+5min
- **Polling**: meteoraPollAll() a cada 60s (METEORA_POLL_INTERVAL = 60000)
  - Coleta addresses de state.tokens + oldTokens + oldWeekTokens
  - Filtra tokens que precisam fetch (skip recentes) ANTES de chamar fetchMeteoraBulk
  - Skip: tokens com pool = 55s; tokens sem pool = 300s (5min)
  - Iniciado por startMeteoraPoll() em startBot(); parado por stopMeteoraPoll() em stopBot()
- **Variação histórica**: getMeteoraTvlChange(entry, windowMs)
  - 1H (3600000ms), 6H (21600000ms), 24H (86400000ms)
  - Compara TVL atual com baseline mais antigo dentro da janela
  - Tolerância de 1 minuto na busca do baseline
  - Variações < 0.01% não são exibidas
- **Exibição**: meteoraTvlHtml(addr, prefix) — gera HTML com label 🌊 MET, TVL em roxo (#c4a6ff), contagem de pools, variações 1H/6H/24H
  - Aparece em: Manual Tokens (prefix 'mb'), Old Tokens (prefix 'ot'), Old Tokens 1 Week+ (prefix 'ow'), Monitored (prefix 'mn')
  - NÃO aparece se: token sem pool (noPool), TVL = 0, ou TVL < meteora-min-pool configurado
  - getMeteoraMinPool() — lê do input, trata 0 como "show all" (isNaN check, não || fallback)
- **Update in-place**: updateMeteoraTvlInPlace(addr, prefix) — atualiza TVL e variações sem re-render
  - Chamado em: meteoraPollAll() após cada fetch, updateManualBar(), updateOldTokensMcap(), updateOldWeekTokensMcap()
- **Re-render trigger**: meteoraPollAll() seta newPoolsFound = true quando descobre pool pela 1ª vez
  - Ao final do ciclo, se newPoolsFound: chama renderManualBar(), renderOldTokens(), renderOldWeekTokens()
  - NECESSÁRIO porque o primeiro render dos cards acontece antes do fetch completar — sem re-render, os elementos DOM de Meteora nunca são criados
- **Ticker**: "🌊 Meteora: SYMBOL — $X TVL (N pools)" na primeira descoberta de pool
- Funções: fetchMeteoraBulk(), pushMeteoraTvlHistory(), getMeteoraTvlChange(), meteoraTvlHtml(), updateMeteoraTvlInPlace(), meteoraPollAll(), startMeteoraPoll(), stopMeteoraPoll(), getMeteoraMinPool()

## Regra de supressão de alerta por MCAP declinante
- Em processToken(), se volume 5m subiu acima do threshold MAS MCAP caiu comparado ao ciclo anterior, o alerta de volume é SUPRIMIDO
- Condição: mcapDeclining = tok.prevMcap > 0 && mcap > 0 && mcap < tok.prevMcap
- Apenas alertas de tipo 'vol' são suprimidos — alertas de MCAP e HVNC continuam normais
- Log no ticker: "⊘ SYMBOL vol +X% but MCAP declining ($Y → $Z) — alert suppressed"
- Lógica: token com volume crescendo mas MCAP caindo indica dump (sell pressure) — não é sinal de compra

## Search bar nos Alerts
- Input de busca no header do painel Alerts: id="alert-search", placeholder="Search ticker..."
- Filtra por: symbol, name ou address (case insensitive, includes)
- renderAlerts() lê o valor do campo e aplica filtro antes de renderizar
- Quando busca ativa e sem resultados: mostra "No alerts matching X"
- oninput="renderAlerts()" — filtra em tempo real enquanto digita

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
- fetchMeteoraBulk() usa `dlmm-api.meteora.ag` — NÃO usar `dlmm.datapi.meteora.ag` (endpoints diferentes)
- fetchMeteoraBulk() usa parâmetro `include_token_mints` repetido — NÃO usar `search_term` (menos preciso)
- fetchMeteoraBulk() lê `p.liquidity` para TVL — NÃO `p.tvl` (campo não existe na resposta)
- fetchMeteoraBulk() chunk size = 15 mints por request — conservador para URL length; NÃO fazer 1 request por token (era a causa de centenas de timeouts)
- METEORA_POLL_INTERVAL = 60000 (60s) — não reduzir demais; com bulk são poucas requests por ciclo mas o proxy rate limita
- meteoraPollAll() filtra tokens recentes ANTES de chamar fetchMeteoraBulk — skip: noPool = 300s (5min), hasPool = 55s
- meteoraPollAll() deve chamar renderManualBar/renderOldTokens/renderOldWeekTokens quando newPoolsFound — sem isso, Meteora não aparece em barras que renderizaram antes do primeiro fetch
- getMeteoraMinPool() usa isNaN check — NÃO usar `|| 5000`, senão 0 (show all) é impossível
- meteoraCache é em memória apenas — NÃO persistir no localStorage (dados ficam velhos rápido)
- Supressão de alerta por MCAP declinante: só afeta triggerType 'vol' — NÃO suprimir alertas MCAP, HVNC, ou Old Token Surge

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
