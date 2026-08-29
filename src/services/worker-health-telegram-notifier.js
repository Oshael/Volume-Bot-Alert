'use strict';

const { createTelegramBotClient } = require('./telegram-bot-client');

const DESCRIPTIONS = Object.freeze({
  lease_missing: 'Worker sem lease ativa',
  lease_expired: 'Worker parou de renovar a lease',
  lease_halted: 'Worker interrompido por erro fatal',
  telemetry_missing: 'Worker sem telemetria',
  telemetry_error: 'Falha ao coletar a telemetria do worker',
  component_disabled: 'Componente obrigatório está desligado',
  component_stopped: 'Componente do worker está parado',
  component_halted: 'Componente do worker foi interrompido',
  component_unhealthy: 'Componente declarou estado não saudável',
  component_disconnected: 'Componente perdeu a conexão necessária',
  consecutive_errors: 'Worker acumulou erros consecutivos',
  active_error: 'Worker mantém um erro ativo',
  execution_stalled: 'Execução do worker parece travada',
  progress_stale: 'Worker está sem progresso recente',
  startup_stalled: 'Worker não concluiu a inicialização',
  lag_blocks_high: 'Worker está atrasado em blocos',
  lag_time_high: 'Worker está atrasado no tempo',
  loop_overrun: 'Ciclo do worker excedeu o tempo esperado',
  queue_backlog: 'Fila do worker está acumulando trabalho',
  process_memory_high: 'Processo usando memória RSS acima do limite',
  process_heap_high: 'Heap do processo próximo do limite',
  event_loop_lag_high: 'Event loop do processo com atraso excessivo',
  disk_space_low: 'Pouco espaço livre no disco do worker',
  database_latency_high: 'Leitura do PostgreSQL está lenta',
  database_pool_pressure: 'Pool do PostgreSQL está saturado',
  database_long_transaction: 'Transação ociosa está aberta por tempo excessivo',
  database_blocked_queries: 'Consultas do PostgreSQL estão bloqueadas',
  database_probe_failed: 'Probe avançado do PostgreSQL falhou',
  wal_growth_high: 'PostgreSQL está gerando WAL em ritmo anormal',
  health_control_plane_unavailable: 'Monitor não consegue ler ou persistir sua própria saúde',
});
const AMBIGUOUS_STOP_CODES = new Set([
  'lease_missing', 'component_disabled', 'component_stopped',
]);

function printable(value, code) {
  if (value === undefined || value === null || value === '') return 'não informado';
  if (code === 'active_error' || code === 'telemetry_error') return 'presente (consulte os logs)';
  if (typeof value === 'object') return 'dados estruturados (consulte os logs)';
  return String(value).slice(0, 200);
}

function createWorkerHealthTelegramNotifier(options = {}) {
  const bot = options.botClient || createTelegramBotClient({
    enabled: true, botToken: options.botToken, timeoutMs: options.timeoutMs,
  });
  const chatId = String(options.chatId || '').trim();

  async function sendIncident(incident = {}) {
    const details = incident.details || {};
    const code = String(incident.code || details.code || 'worker_health_incident');
    const lines = [
      `${incident.severity === 'critical' ? '🚨' : '⚠️'} TrendScope: problema em worker`,
      `Worker: ${details.componentLabel || incident.componentKey || 'desconhecido'}`,
      `Problema: ${DESCRIPTIONS[code] || code}`,
      `Código: ${code}`,
      `Local: ${incident.path || details.path || 'não informado'}`,
      `Valor observado: ${printable(details.observedValue, code)}`,
      `Detectado em: ${incident.openedAt || incident.firstObservedAt || new Date().toISOString()}`,
    ];
    if (AMBIGUOUS_STOP_CODES.has(code)) {
      lines.push('Worker desligado. Se foi você, tudo bem; caso contrário, averigue a situação.');
    }
    await bot.sendMessage({
      chat_id: chatId, disable_web_page_preview: true, text: lines.join('\n'),
    });
  }

  async function sendRecovery(incident = {}) {
    const details = incident.details || {};
    await bot.sendMessage({
      chat_id: chatId,
      disable_web_page_preview: true,
      text: [
        '✅ TrendScope: worker recuperado',
        `Worker: ${details.componentLabel || incident.componentKey || 'desconhecido'}`,
        `Problema resolvido: ${DESCRIPTIONS[incident.code] || incident.code || 'desconhecido'}`,
        `Recuperado em: ${incident.resolvedAt || new Date().toISOString()}`,
      ].join('\n'),
    });
  }

  return { sendIncident, sendRecovery };
}

module.exports = { createWorkerHealthTelegramNotifier };
