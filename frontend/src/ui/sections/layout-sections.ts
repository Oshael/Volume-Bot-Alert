import type { AppController } from '../../state/app-controller';
import { getStatusMetrics, type AppState } from '../../state/app-state';
import { loadCustomSoundAsset, saveCustomSoundAsset, type CustomSoundSlot } from '../../utils/sound-storage';
import { renderFlash } from './shared';

const CONFIG_FIELDS: Array<{ key: string; label: string; type?: 'number' | 'text'; min?: number; placeholder?: string }> = [
  { key: 'threshold', label: 'Alert when 5m volume rises (%)', min: 1 },
  { key: 'mcap-threshold', label: 'Alert when MKT CAP rises (%) in 5m', min: 0, placeholder: '0 = disabled' },
  { key: 'min-vol', label: 'Min 5m volume to alert ($)', min: 0 },
  { key: 'min-mcap', label: 'Min market cap to alert ($)', min: 0 },
  { key: 'max-mcap', label: 'Max market cap to alert ($)', min: 0, placeholder: '0 = no limit' },
  { key: 'interval', label: 'Check interval (seconds)', min: 5 },
  { key: 'dead-cycles', label: 'Remove token with no volume after (cycles)', min: 0 },
  { key: 'chain', label: 'Chain', type: 'text' },
  { key: 'hvnc-min-vol', label: 'High Vol New Coin min total vol ($)', min: 0 },
];

export function renderLegacyShell(state: AppState, controller: AppController) {
  const wrapper = document.createElement('section');
  wrapper.className = 'legacy-shell';

  if (state.session.status !== 'authenticated') {
    wrapper.append(renderLegacyLogin(state, controller));
    return wrapper;
  }

  wrapper.append(
    renderLegacyHeader(state, controller),
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

function renderLegacyHeader(state: AppState, controller: AppController) {
  const header = document.createElement('header');
  header.className = 'legacy-topbar';
  const metrics = getStatusMetrics(state);
  const soundLabel = state.ui.soundEnabled ? 'NOTIF ON' : 'SOUND OFF';

  header.innerHTML = `
    <div class="legacy-logo">
      <div class="logo-dot"></div>
      <div>
        <h1>VOLUME ALERT BOT</h1>
        <div class="subtitle">Solana  DexScreener Feed  5m Monitor</div>
      </div>
    </div>
    <div class="status-bar">
      ${metrics.map((metric) => `
        <div class="status-item">
          <span>${metric.label}</span>
          <div class="status-value ${metric.tone === 'ok' ? 'active' : ''} ${metric.tone === 'warn' ? 'warn' : ''}">${metric.value}</div>
        </div>
      `).join('')}
      <div class="status-item"><span>${soundLabel.includes('ON') ? '??' : '??'} ${soundLabel}</span></div>
      <div class="status-item user-status"><span>${state.session.username ?? state.session.email ?? 'User'}</span><button type="button" class="logout-btn" data-action="logout">LOGOUT</button></div>
    </div>
  `;

  header.querySelector<HTMLButtonElement>('[data-action="logout"]')?.addEventListener('click', () => void controller.logout());
  return header;
}

function renderLegacyConfig(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'config-grid legacy-config-grid';
  section.innerHTML = `
    ${CONFIG_FIELDS.map((field) => renderConfigField(state, field)).join('')}
    <div class="config-item config-item-sound">
      <label>Sound alert</label>
      <select name="sound-mode">
        <option value="on" ${state.ui.soundEnabled ? 'selected' : ''}>Enabled</option>
        <option value="off" ${state.ui.soundEnabled ? '' : 'selected'}>Disabled</option>
      </select>
    </div>
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

  const volumeInput = section.querySelector<HTMLInputElement>('input[name="sound-volume"]');
  const volumeLabel = volumeInput?.closest('.config-item')?.querySelector('label');
  volumeInput?.addEventListener('input', (event) => {
    const value = Number((event.currentTarget as HTMLInputElement).value || '0');
    if (volumeLabel) volumeLabel.textContent = `Sound volume: ${value}%`;
    controller.setSoundVolume(value / 100);
  });

  bindSoundUploadStrip(section, state);
  return section;
}

function renderSoundUploadStrip(state: AppState) {
  const scope = state.session.email || state.session.username || 'anonymous';
  const slots: Array<{ slot: CustomSoundSlot; title: string; sub: string; dot: string }> = [
    { slot: 'normal', title: 'Sound Level Normal', sub: '(+50%) ? MP3/WAV/OGG', dot: 'sound-dot normal' },
    { slot: 'critical', title: 'Sound Level Critical', sub: '(+100%) ? MP3/WAV/OGG', dot: 'sound-dot critical' },
    { slot: 'mega', title: 'Sound Level Mega', sub: '(+200%) ? MP3/WAV/OGG', dot: 'sound-dot mega' },
    { slot: 'old1h', title: 'Old Token Alert ? 1H', sub: '(+100%) ? MP3/WAV/OGG', dot: 'sound-dot old1h' },
    { slot: 'old6h', title: 'Old Token Alert ? 6H', sub: '(+150%) ? MP3/WAV/OGG', dot: 'sound-dot old6h' },
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

  await controller.saveMonitoringConfig(payload);
}

function renderLegacyActions(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'btn-row legacy-action-row';
  const isRunning = state.runtime.mode === 'active';
  section.innerHTML = `
    ${renderFlash(state)}
    <div class="legacy-button-strip">
      <button type="button" class="legacy-btn btn-start ${isRunning ? 'running' : ''}" data-action="toggle-monitoring">${isRunning ? ' STOP' : '? START MONITORING'}</button>
      <a class="legacy-btn legacy-btn-accent" href="#manual-tokens-section">+ ADD TOKEN</a>
      <button type="button" class="legacy-btn legacy-btn-accent" data-action="reload-config">? LOAD CONFIG</button>
      <button type="button" class="legacy-btn legacy-btn-clear" data-action="clear-notice">? CLEAR STATUS</button>
      <button type="button" class="legacy-btn legacy-btn-accent legacy-btn-sound" data-action="toggle-sound">${state.ui.soundEnabled ? '?? SOUND ON' : '?? SOUND OFF'}</button>
      <button type="button" class="legacy-btn legacy-btn-clear" data-action="logout-all">LOGOUT ALL</button>
    </div>
  `;

  section.querySelector<HTMLButtonElement>('[data-action="toggle-monitoring"]')?.addEventListener('click', () => {
    if (isRunning) {
      controller.stopMonitoring();
      return;
    }
    controller.startMonitoring();
  });
  section.querySelector<HTMLButtonElement>('[data-action="reload-config"]')?.addEventListener('click', () => void controller.reloadConfig());
  section.querySelector<HTMLButtonElement>('[data-action="clear-notice"]')?.addEventListener('click', () => controller.clearNotice());
  section.querySelector<HTMLButtonElement>('[data-action="toggle-sound"]')?.addEventListener('click', () => controller.setSoundEnabled(!state.ui.soundEnabled));
  section.querySelector<HTMLButtonElement>('[data-action="logout-all"]')?.addEventListener('click', () => void controller.logoutAll());
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
    interval: 30,
    'dead-cycles': 10,
    'hvnc-min-vol': 300000,
  };
  return String(defaults[key] ?? 0);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
