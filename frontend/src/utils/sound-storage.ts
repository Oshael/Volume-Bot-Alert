const SOUND_SETTINGS_KEY = 'frontend_alert_sound';

export interface SoundSettings {
  enabled: boolean;
  volume: number;
}

const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  enabled: true,
  volume: 0.05,
};

function clampVolume(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_SOUND_SETTINGS.volume;
  }
  return Math.min(1, Math.max(0, value));
}

function buildScopedKey(scope: string) {
  return `${SOUND_SETTINGS_KEY}:${scope || 'anonymous'}`;
}

export function loadSoundSettings(scope: string): SoundSettings {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_SOUND_SETTINGS };
  }

  try {
    const raw = window.localStorage.getItem(buildScopedKey(scope));
    if (!raw) {
      return { ...DEFAULT_SOUND_SETTINGS };
    }

    const parsed = JSON.parse(raw) as Partial<SoundSettings>;
    return {
      enabled: parsed.enabled ?? DEFAULT_SOUND_SETTINGS.enabled,
      volume: clampVolume(Number(parsed.volume)),
    };
  } catch {
    return { ...DEFAULT_SOUND_SETTINGS };
  }
}

export function saveSoundSettings(scope: string, settings: SoundSettings) {
  if (typeof window === 'undefined') {
    return;
  }

  const normalized: SoundSettings = {
    enabled: settings.enabled,
    volume: clampVolume(settings.volume),
  };

  window.localStorage.setItem(buildScopedKey(scope), JSON.stringify(normalized));
}


export type CustomSoundSlot = 'normal' | 'critical' | 'mega' | 'old1h' | 'old6h';

export interface CustomSoundAsset {
  name: string;
  dataUrl: string;
}

const CUSTOM_SOUND_KEY = 'frontend_custom_sound';

function buildCustomSoundKey(scope: string, slot: CustomSoundSlot) {
  return `${CUSTOM_SOUND_KEY}:${scope || 'anonymous'}:${slot}`;
}

export function loadCustomSoundAsset(scope: string, slot: CustomSoundSlot): CustomSoundAsset | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(buildCustomSoundKey(scope, slot));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CustomSoundAsset>;
    if (!parsed.dataUrl || !parsed.name) {
      return null;
    }
    return { name: parsed.name, dataUrl: parsed.dataUrl };
  } catch {
    return null;
  }
}

export function saveCustomSoundAsset(scope: string, slot: CustomSoundSlot, asset: CustomSoundAsset) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(buildCustomSoundKey(scope, slot), JSON.stringify(asset));
}

