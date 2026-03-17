import type { AppController } from '../../state/app-controller';
import type { AppState } from '../../state/app-state';
import { loadCustomSoundAsset, saveCustomSoundAsset, type CustomSoundSlot } from '../../utils/sound-storage';
import { renderFlash } from './shared';

const CONFIG_FIELDS: Array<{ key: string; label: string; type?: 'number' | 'text'; min?: number; placeholder?: string }> = [
  { key: 'threshold', label: 'Alert when 5m volume rises (%)', min: 1 },
  { key: 'mcap-threshold', label: 'Alert when MKT CAP rises (%) in 5m', min: 0, placeholder: '0 = disabled' },
  { key: 'min-vol', label: 'Min 5m volume to alert ($)', min: 0 },
  { key: 'min-mcap', label: 'Min market cap to alert ($)', min: 0 },
  { key: 'max-mcap', label: 'Max market cap to alert ($)', min: 0, placeholder: '0 = no limit' },
  { key: 'chain', label: 'Chain', type: 'text' },
  { key: 'hvnc-min-vol', label: 'High Vol New Coin min total vol ($)', min: 0 },
];

const ALERT_TOGGLE_FIELDS = [
  { key: 'alert-vol-enabled', label: 'VOL' },
  { key: 'alert-mcap-enabled', label: 'MCAP' },
  { key: 'alert-hvnc-enabled', label: 'HIGH VOLUME NEW COIN' },
  { key: 'alert-old-surge-enabled', label: 'SURGE' },
  { key: 'alert-pumpfun-vol-enabled', label: 'PUMPFUN VOL' },
  { key: 'alert-pumpfun-hvnc-enabled', label: 'PUMPFUN HVNC' },
] as const;

const SOUND_TOGGLE_FIELDS = [
  { key: 'sound-vol-enabled', label: 'VOL' },
  { key: 'sound-mcap-enabled', label: 'MCAP' },
  { key: 'sound-hvnc-enabled', label: 'HIGH VOLUME NEW COIN' },
  { key: 'sound-old-surge-enabled', label: 'SURGE' },
  { key: 'sound-pumpfun-vol-enabled', label: 'PUMPFUN VOL' },
  { key: 'sound-pumpfun-hvnc-enabled', label: 'PUMPFUN HVNC' },
] as const;

export function renderLegacyShell(state: AppState, controller: AppController) {
  const wrapper = document.createElement('section');
  wrapper.className = 'legacy-shell';

  if (state.session.status !== 'authenticated') {
    wrapper.append(renderLegacyLogin(state, controller));
    return wrapper;
  }

  wrapper.append(
    renderLegacyConfig(state, controller),
    renderLegacyActions(state, controller),
  );

  return wrapper;
}

function renderLegacyLogin(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'legacy-login-shell';
  section.innerHTML = `
    <div class="legacy-login-box">
      <h2><span class="legacy-login-dot"></span> VOLUME ALERT BOT</h2>
      <div class="legacy-login-sub">Solana  Real-time Monitor</div>
      ${renderFlash(state)}
      <form class="legacy-login-form" data-role="login-form">
        <label>Email</label>
        <input name="email" type="email" placeholder="testeuser5@example.com" autocomplete="username" required ${state.ui.busy ? 'disabled' : ''} />
        <label>Password</label>
        <input name="password" type="password" placeholder="SenhaForte123!" autocomplete="current-password" required ${state.ui.busy ? 'disabled' : ''} />
        <button type="submit" class="legacy-btn legacy-btn-primary" ${state.ui.busy ? 'disabled' : ''}>${state.ui.busy ? 'LOGIN...' : 'LOGIN'}</button>
      </form>
    </div>
  `;

  section.querySelector<HTMLFormElement>('form[data-role="login-form"]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    void controller.login(String(data.get('email') || '').trim(), String(data.get('password') || ''));
  });

  section.querySelector<HTMLButtonElement>('[data-action="dismiss-flash"]')?.addEventListener('click', () => controller.clearNotice());
  return section;
}

function renderLegacyConfig(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'config-grid legacy-config-grid';
  section.innerHTML = `
    <div class="legacy-userbar">
      <button type="button" class="legacy-userbar-link logout-link" data-action="logout">Log Out</button>
      <div class="legacy-user-menu" data-user-menu>
        <button type="button" class="legacy-userbar-link user-link" data-action="toggle-user-menu">${state.session.username ?? state.session.email ?? 'User'}</button>
        <div class="legacy-user-dropdown">
          <button type="button" class="legacy-user-dd-item">Profile (Soon)</button>
          <button type="button" class="legacy-user-dd-item">Preferences (Soon)</button>
        </div>
      </div>
    </div>
    ${CONFIG_FIELDS.map((field) => renderConfigField(state, field)).join('')}
    <div class="config-item config-item-sound">
      <label>Sound alert</label>
      <select name="sound-mode">
        <option value="on" ${state.ui.soundEnabled ? 'selected' : ''}>Enabled</option>
        <option value="off" ${state.ui.soundEnabled ? '' : 'selected'}>Disabled</option>
      </select>
    </div>
    ${renderOldSurgeThresholdMenu(state)}
    ${renderConfigToggleMenu(state, 'Alert toggles', 'Choose which alert types can fire', ALERT_TOGGLE_FIELDS)}
    ${renderConfigToggleMenu(state, 'Sound by alert type', 'Choose which alert types can play sound', SOUND_TOGGLE_FIELDS)}
    <div class="legacy-sound-row">
      <div class="config-item config-item-sound config-item-sound-volume">
        <label>Sound volume: ${Math.round(state.ui.soundVolume * 100)}%</label>
        <input name="sound-volume" class="legacy-volume-slider" type="range" min="0" max="100" step="1" value="${Math.round(state.ui.soundVolume * 100)}" />
      </div>
      ${renderSoundUploadStrip(state)}
    </div>
  `;

  section.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]').forEach((input) => {
    const name = input.name;
    if (name === 'sound-mode' || name === 'sound-volume') {
      return;
    }
    input.addEventListener('change', () => void submitLegacyConfig(section, controller));
  });

  section.querySelector<HTMLSelectElement>('select[name="sound-mode"]')?.addEventListener('change', (event) => {
    controller.setSoundEnabled((event.currentTarget as HTMLSelectElement).value !== 'off');
  });
  section.querySelector<HTMLButtonElement>('[data-action="logout"]')?.addEventListener('click', () => void controller.logout());
  section.querySelectorAll<HTMLButtonElement>('.legacy-user-dd-item').forEach((button) => {
    button.addEventListener('click', () => {
      section.querySelector<HTMLElement>('[data-user-menu]')?.classList.remove('open');
    });
  });

  const volumeInput = section.querySelector<HTMLInputElement>('input[name="sound-volume"]');
  const volumeLabel = volumeInput?.closest('.config-item')?.querySelector('label');
  volumeInput?.addEventListener('input', (event) => {
    const value = Number((event.currentTarget as HTMLInputElement).value || '0');
    if (volumeLabel) volumeLabel.textContent = `Sound volume: ${value}%`;
    controller.setSoundVolume(value / 100);
  });

  bindConfigToggleMenus(section, controller);
  bindSoundUploadStrip(section, state);
  return section;
}

function isConfigEnabled(state: AppState, key: string) {
  return String(state.data.configs[key] ?? 'on') !== 'off';
}

function renderOldSurgeThresholdMenu(state: AppState) {
  const value1h = Number(state.data.configs['old-alert-1h-threshold'] ?? 100);
  const value6h = Number(state.data.configs['old-alert-6h-threshold'] ?? 150);
  return `
    <div class="config-item config-item-menu">
      <label>Surge threshold</label>
      <div class="sort-menu-wrap config-menu-wrap" data-sort-wrap>
        <button type="button" class="old-filter-btn config-menu-button active" data-sort-toggle="old-surge-threshold">${Math.round(value1h)}% / ${Math.round(value6h)}%</button>
        <div class="sort-menu-dropdown config-menu-dropdown config-threshold-dropdown">
          <div class="config-threshold-grid">
            <div class="config-threshold-field">
              <span>1H</span>
              <input type="number" min="0" name="old-alert-1h-threshold" value="${Math.round(value1h)}" />
            </div>
            <div class="config-threshold-field">
              <span>6H</span>
              <input type="number" min="0" name="old-alert-6h-threshold" value="${Math.round(value6h)}" />
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderConfigToggleMenu(
  state: AppState,
  label: string,
  summaryLabel: string,
  fields: ReadonlyArray<{ key: string; label: string }>,
) {
  const enabledCount = fields.filter((field) => isConfigEnabled(state, field.key)).length;
  return `
    <div class="config-item config-item-menu">
      <label>${label}</label>
      <div class="sort-menu-wrap config-menu-wrap" data-sort-wrap>
        <button type="button" class="old-filter-btn config-menu-button active" data-sort-toggle="${label.toLowerCase().replace(/\s+/g, '-')}">${enabledCount}/${fields.length} on</button>
        <div class="sort-menu-dropdown config-menu-dropdown">
          <div class="config-menu-summary">${summaryLabel}</div>
          <div class="config-toggle-list">
            ${fields.map((field) => {
              const enabled = isConfigEnabled(state, field.key);
              return `
                <button
                  type="button"
                  class="config-toggle-item ${enabled ? 'active' : ''}"
                  data-config-toggle-key="${field.key}"
                  data-config-toggle-next="${enabled ? 'off' : 'on'}"
                >
                  <span>${field.label}</span>
                  <span class="config-toggle-state">${enabled ? 'ON' : 'OFF'}</span>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSoundUploadStrip(state: AppState) {
  const scope = state.session.email || state.session.username || 'anonymous';
  const old1hThreshold = Number(state.data.configs['old-alert-1h-threshold'] ?? 100);
  const old6hThreshold = Number(state.data.configs['old-alert-6h-threshold'] ?? 150);
  const slots: Array<{ slot: CustomSoundSlot; title: string; sub: string; dot: string }> = [
    { slot: 'normal', title: 'Sound Level Normal', sub: '(+50%) ? MP3/WAV/OGG', dot: 'sound-dot normal' },
    { slot: 'critical', title: 'Sound Level Critical', sub: '(+100%) ? MP3/WAV/OGG', dot: 'sound-dot critical' },
    { slot: 'mega', title: 'Sound Level Mega', sub: '(+200%) ? MP3/WAV/OGG', dot: 'sound-dot mega' },
    { slot: 'old1h', title: 'Old Token Alert ? 1H', sub: `(+${Math.round(old1hThreshold)}%) ? MP3/WAV/OGG`, dot: 'sound-dot old1h' },
    { slot: 'old6h', title: 'Old Token Alert ? 6H', sub: `(+${Math.round(old6hThreshold)}%) ? MP3/WAV/OGG`, dot: 'sound-dot old6h' },
  ];

  return `
    <div class="legacy-sound-strip">
      ${slots.map(({ slot, title, sub, dot }) => {
        const asset = loadCustomSoundAsset(scope, slot);
        return `
          <div class="legacy-sound-item">
            <div class="legacy-sound-head"><span class="${dot}"></span><span>${title}</span></div>
            <div class="legacy-sound-sub">${sub}</div>
            <div class="legacy-sound-picker">
              <label class="legacy-file-btn">
                Escolher arquivo
                <input type="file" accept="audio/*" data-sound-slot="${slot}" />
              </label>
            </div>
            <div class="legacy-sound-meta">${asset?.name || 'Default (tone)'}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function bindSoundUploadStrip(section: HTMLElement, state: AppState) {
  const scope = state.session.email || state.session.username || 'anonymous';
  section.querySelectorAll<HTMLInputElement>('input[type="file"][data-sound-slot]').forEach((input) => {
    input.addEventListener('click', () => {
      input.value = '';
    });
    input.addEventListener('change', () => {
      const slot = input.dataset.soundSlot as CustomSoundSlot | undefined;
      const file = input.files?.[0];
      if (!slot || !file) return;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl) return;
        saveCustomSoundAsset(scope, slot, { name: file.name, dataUrl });
        const label = input.closest('.legacy-sound-item')?.querySelector<HTMLElement>('.legacy-sound-meta');
        if (label) label.textContent = file.name;
      };
      reader.readAsDataURL(file);
    });
  });
}

function bindConfigToggleMenus(section: HTMLElement, controller: AppController) {
  section.querySelectorAll<HTMLButtonElement>('[data-config-toggle-key]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.configToggleKey;
      const nextValue = button.dataset.configToggleNext;
      if (!key || !nextValue) return;

      const wrap = button.closest<HTMLElement>('[data-sort-wrap]');
      if (wrap) {
        wrap.classList.remove('open');
      }

      void controller.saveMonitoringConfig({ [key]: nextValue });
    });
  });
}

async function submitLegacyConfig(section: HTMLElement, controller: AppController) {
  const inputs = section.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]');
  const payload: Record<string, number | string> = {};

  for (const input of inputs) {
    const key = input.name;
    if (!key) continue;
    if (input instanceof HTMLSelectElement) {
      payload[key] = input.value;
      continue;
    }
    if (input.type === 'range' || input.type === 'number') {
      payload[key] = Number(input.value || '0');
      continue;
    }
    payload[key] = input.value;
  }

  console.info('[config-debug-ui]', {
    stage: 'submitLegacyConfig',
    minVolInputValue: (section.querySelector('input[name="min-vol"]') as HTMLInputElement | null)?.value ?? null,
    payloadMinVol: payload['min-vol'],
    payload,
  });

  await controller.saveMonitoringConfig(payload);
}

function renderLegacyActions(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'btn-row legacy-action-row';
  const isRunning = state.runtime.mode === 'active';
  section.innerHTML = `
    ${renderFlash(state)}
    <div class="legacy-button-strip">
      <button type="button" class="legacy-btn btn-start ${isRunning ? 'running' : ''}" data-action="toggle-monitoring">${isRunning ? '&#9632; STOP' : '&#9654; START MONITORING'}</button>
    </div>
  `;

  section.querySelector<HTMLButtonElement>('[data-action="toggle-monitoring"]')?.addEventListener('click', () => {
    if (isRunning) {
      controller.stopMonitoring();
      return;
    }
    controller.startMonitoring();
  });
  section.querySelector<HTMLButtonElement>('[data-action="dismiss-flash"]')?.addEventListener('click', () => controller.clearNotice());
  return section;
}

function renderConfigField(state: AppState, field: { key: string; label: string; type?: 'number' | 'text'; min?: number; placeholder?: string }) {
  const value = state.data.configs[field.key];
  const type = field.type ?? 'number';
  const resolved = value == null || value === ''
    ? defaultConfigValue(field.key, type)
    : String(value);

  if (field.key === 'chain') {
    const current = resolved || 'solana';
    return `
      <div class="config-item">
        <label>${field.label}</label>
        <select name="chain">
          ${['solana', 'ethereum', 'bsc', 'base'].map((chain) => `<option value="${chain}" ${current === chain ? 'selected' : ''}>${capitalize(chain)}</option>`).join('')}
        </select>
      </div>
    `;
  }

  return `
    <div class="config-item">
      <label>${field.label}</label>
      <input type="${type}" name="${field.key}" value="${resolved}" ${field.min != null ? `min="${field.min}"` : ''} ${field.placeholder ? `placeholder="${field.placeholder}"` : ''}>
    </div>
  `;
}

function defaultConfigValue(key: string, type: 'number' | 'text') {
  if (type === 'text') {
    return key === 'chain' ? 'solana' : '';
  }

  const defaults: Record<string, number> = {
    threshold: 50,
    'mcap-threshold': 50,
    'min-vol': 500,
    'min-mcap': 10000,
    'max-mcap': 0,
    'hvnc-min-vol': 300000,
    'old-alert-1h-threshold': 100,
    'old-alert-6h-threshold': 150,
  };
  return String(defaults[key] ?? 0);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
