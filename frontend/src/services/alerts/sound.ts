import type { AlertEntry } from '../../state/app-state';
import { getAlertImpactTier, isHvncAlert } from './impact-tier';
import { loadCustomSoundAsset, type CustomSoundSlot } from '../../utils/sound-storage';

const DEFAULT_ALERT_SOUND_VOLUME = 0.05;

export type AlertSoundPlaybackResult = 'played' | 'skipped' | 'blocked';

type ToneStep = {
  frequency: number;
  durationMs: number;
};

const ALERT_PATTERNS: Partial<Record<AlertEntry['kind'], ToneStep[]>> = {
  'monitored-vol': [
    { frequency: 523.25, durationMs: 110 },
    { frequency: 659.25, durationMs: 140 },
  ],
  'monitored-mcap': [
    { frequency: 440, durationMs: 120 },
    { frequency: 587.33, durationMs: 160 },
  ],
  'monitored-fdv': [
    { frequency: 440, durationMs: 120 },
    { frequency: 587.33, durationMs: 160 },
  ],
  hvnc: [
    { frequency: 523.25, durationMs: 90 },
    { frequency: 659.25, durationMs: 90 },
    { frequency: 783.99, durationMs: 180 },
  ],
  'old-surge': [
    { frequency: 392, durationMs: 130 },
    { frequency: 523.25, durationMs: 130 },
    { frequency: 659.25, durationMs: 180 },
  ],
  'meteora-surge': [
    { frequency: 392, durationMs: 130 },
    { frequency: 523.25, durationMs: 130 },
    { frequency: 659.25, durationMs: 180 },
  ],
  'gmgn-claim-signal': [
    { frequency: 1567.98, durationMs: 110 },
    { frequency: 2349.32, durationMs: 120 },
    { frequency: 1975.53, durationMs: 130 },
    { frequency: 2637.02, durationMs: 150 },
    { frequency: 1760, durationMs: 180 },
    { frequency: 1174.66, durationMs: 260 },
  ],
  'custom-alert': [
    { frequency: 659.25, durationMs: 110 },
    { frequency: 880, durationMs: 160 },
  ],
};

const MIGRATE_PATTERN: ToneStep[] = [
  { frequency: 523.25, durationMs: 90 },
  { frequency: 659.25, durationMs: 90 },
  { frequency: 783.99, durationMs: 180 },
];

let audioContext: AudioContext | null = null;
const activeCustomAudioElements = new Set<HTMLAudioElement>();

const SOUND_KIND_CONFIG_KEY: Partial<Record<AlertEntry['kind'], string>> = {
  'monitored-vol': 'sound-vol-enabled',
  'monitored-mcap': 'sound-mcap-enabled',
  'monitored-fdv': 'sound-mcap-enabled',
  hvnc: 'sound-hvnc-enabled',
  'meteora-surge': 'sound-meteora-surge-enabled',
  'gmgn-claim-signal': 'sound-gmgn-claim-signal-enabled',
};

function resolveAlertSoundConfigKey(alert: AlertEntry) {
  if (alert.kind === 'old-surge') {
    return alert.surgeWindow === '6H' ? 'sound-old-surge-6h-enabled' : 'sound-old-surge-1h-enabled';
  }

  return SOUND_KIND_CONFIG_KEY[alert.kind] || null;
}

function clampVolume(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_ALERT_SOUND_VOLUME;
  }
  return Math.min(1, Math.max(0, value));
}

function getAudioContext() {
  if (typeof window === 'undefined') {
    return null;
  }

  const AudioCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioCtor();
  }

  return audioContext;
}

async function playPattern(pattern: ToneStep[], options?: { volume?: number; triangle?: boolean }) {
  const context = getAudioContext();
  if (!context) {
    return 'skipped' as const;
  }

  if (context.state === 'suspended') {
    try {
      await context.resume();
    } catch {
      return 'blocked' as const;
    }
  }

  const volume = clampVolume(options?.volume ?? DEFAULT_ALERT_SOUND_VOLUME);
  let offsetSeconds = 0;
  const startAt = context.currentTime + 0.01;

  for (const step of pattern) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    const durationSeconds = step.durationMs / 1000;
    const toneStart = startAt + offsetSeconds;
    const toneEnd = toneStart + durationSeconds;

    osc.type = options?.triangle ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(step.frequency, toneStart);

    gain.gain.setValueAtTime(0.0001, toneStart);
    gain.gain.exponentialRampToValueAtTime(volume, toneStart + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd);

    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(toneStart);
    osc.stop(toneEnd + 0.02);

    offsetSeconds += durationSeconds + 0.03;
  }

  return 'played' as const;
}


async function playCustomSound(slot: CustomSoundSlot, options?: { volume?: number; scope?: string }) {
  const asset = loadCustomSoundAsset(options?.scope || 'anonymous', slot);
  if (!asset || typeof window === 'undefined') {
    return 'skipped' as const;
  }

  return playAudioSource(asset.dataUrl, options?.volume);
}

async function playAudioSource(dataUrl: string, volume?: number) {
  if (!dataUrl || typeof window === 'undefined') return 'skipped' as const;

  const cleanup = (audio: HTMLAudioElement) => {
    activeCustomAudioElements.delete(audio);
    audio.onended = null;
    audio.onerror = null;
  };

  try {
    const audio = new Audio(dataUrl);
    audio.preload = 'auto';
    audio.volume = clampVolume(volume ?? DEFAULT_ALERT_SOUND_VOLUME);
    activeCustomAudioElements.add(audio);
    audio.onended = () => cleanup(audio);
    audio.onerror = () => cleanup(audio);
    await audio.play();
    return 'played' as const;
  } catch {
    for (const audio of activeCustomAudioElements) {
      if (audio.src === dataUrl) {
        cleanup(audio);
      }
    }
    return 'blocked' as const;
  }
}

function resolveAlertSoundSlot(alert: AlertEntry): CustomSoundSlot {
  if (alert.kind === 'admin-token-review') {
    return 'normal';
  }

  if (alert.kind === 'gmgn-claim-signal') {
    return 'claim';
  }
  if (alert.kind === 'old-surge') {
    return alert.surgeWindow === '6H' ? 'old6h' : 'old1h';
  }
  if (alert.kind === 'meteora-surge') {
    return 'old1h';
  }
  if (isHvncAlert(alert)) {
    return 'mega';
  }
  const tier = getAlertImpactTier(alert);
  if (tier === 'mega') return 'mega';
  if (tier === 'critical') return 'critical';
  return 'normal';
}

export async function playAlertSound(
  alert: AlertEntry,
  options?: { enabled?: boolean; volume?: number; scope?: string; configs?: Record<string, string | number> },
): Promise<AlertSoundPlaybackResult> {
  if (shouldSkipAlertSound(alert, options)) {
    return 'skipped';
  }

  const customAlertResult = await playInlineCustomAlertSound(alert, options?.volume);
  if (customAlertResult) {
    return customAlertResult;
  }

  const slot = resolveAlertSoundSlot(alert);
  const customResult = await playCustomSound(slot, { volume: options?.volume, scope: options?.scope });
  if (customResult === 'played') {
    return 'played';
  }

  const pattern = ALERT_PATTERNS[alert.kind];
  if (!pattern) {
    return customResult;
  }

  const patternResult = await playPattern(pattern, {
    volume: options?.volume,
    triangle: alert.kind === 'old-surge' || alert.kind === 'meteora-surge',
  });
  if (patternResult === 'played') {
    return 'played';
  }

  return customResult === 'blocked' ? 'blocked' : patternResult;
}

function shouldSkipAlertSound(
  alert: AlertEntry,
  options?: { enabled?: boolean; configs?: Record<string, string | number> },
) {
  if (alert.kind === 'admin-token-review' || options?.enabled === false) {
    return true;
  }

  const configKey = resolveAlertSoundConfigKey(alert);
  if (configKey && String(options?.configs?.[configKey] ?? 'on') === 'off') {
    return true;
  }

  return false;
}

async function playInlineCustomAlertSound(alert: AlertEntry, volume?: number) {
  if (alert.customSoundDataUrl) {
    return playAudioSource(alert.customSoundDataUrl, volume);
  }

  return null;
}

export async function playMigrateSound(options?: { enabled?: boolean; volume?: number }): Promise<AlertSoundPlaybackResult> {
  if (options?.enabled === false) {
    return 'skipped';
  }

  return playPattern(MIGRATE_PATTERN, { volume: options?.volume });
}

export async function primeAlertAudio() {
  const context = getAudioContext();
  if (!context || context.state !== 'suspended') {
    return;
  }

  try {
    await context.resume();
  } catch {
    // Ignore autoplay unlock failures; playback can retry later.
  }
}
