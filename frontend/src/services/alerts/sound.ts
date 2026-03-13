import type { AlertEntry } from '../../state/app-state';
import { loadCustomSoundAsset, type CustomSoundSlot } from '../../utils/sound-storage';

const DEFAULT_ALERT_SOUND_VOLUME = 0.05;

type ToneStep = {
  frequency: number;
  durationMs: number;
};

const ALERT_PATTERNS: Record<AlertEntry['kind'], ToneStep[]> = {
  'monitored-vol': [
    { frequency: 523.25, durationMs: 110 },
    { frequency: 659.25, durationMs: 140 },
  ],
  'monitored-mcap': [
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
  'pumpfun-vol': [
    { frequency: 349.23, durationMs: 110 },
    { frequency: 523.25, durationMs: 150 },
    { frequency: 659.25, durationMs: 170 },
  ],
  'pumpfun-hvnc': [
    { frequency: 523.25, durationMs: 90 },
    { frequency: 659.25, durationMs: 90 },
    { frequency: 783.99, durationMs: 90 },
    { frequency: 1046.5, durationMs: 180 },
  ],
};

const MIGRATE_PATTERN: ToneStep[] = [
  { frequency: 523.25, durationMs: 90 },
  { frequency: 659.25, durationMs: 90 },
  { frequency: 783.99, durationMs: 180 },
];

let audioContext: AudioContext | null = null;

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
    return;
  }

  if (context.state === 'suspended') {
    try {
      await context.resume();
    } catch {
      return;
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
}


async function playCustomSound(slot: CustomSoundSlot, options?: { volume?: number; scope?: string }) {
  const asset = loadCustomSoundAsset(options?.scope || 'anonymous', slot);
  if (!asset || typeof window === 'undefined') {
    return false;
  }

  try {
    const audio = new Audio(asset.dataUrl);
    audio.volume = clampVolume(options?.volume ?? DEFAULT_ALERT_SOUND_VOLUME);
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

function resolveAlertSoundSlot(alert: AlertEntry): CustomSoundSlot {
  if (alert.kind === 'old-surge') {
    return (Number(alert.pct) || 0) >= 150 ? 'old6h' : 'old1h';
  }
  if (alert.kind === 'hvnc' || alert.kind === 'pumpfun-hvnc') {
    return 'mega';
  }
  const pct = Math.abs(Number(alert.pct) || 0);
  if (pct >= 200) return 'mega';
  if (pct >= 100) return 'critical';
  return 'normal';
}

export async function playAlertSound(alert: AlertEntry, options?: { enabled?: boolean; volume?: number; scope?: string }) {
  if (options?.enabled === false) {
    return;
  }

  const slot = resolveAlertSoundSlot(alert);
  const playedCustom = await playCustomSound(slot, { volume: options?.volume, scope: options?.scope });
  if (playedCustom) {
    return;
  }

  const pattern = ALERT_PATTERNS[alert.kind];
  if (!pattern) {
    return;
  }

  await playPattern(pattern, {
    volume: options?.volume,
    triangle: alert.kind === 'old-surge',
  });
}

export async function playMigrateSound(options?: { enabled?: boolean; volume?: number }) {
  if (options?.enabled === false) {
    return;
  }

  await playPattern(MIGRATE_PATTERN, { volume: options?.volume });
}
