// A polished, user-facing control panel — distinct from the raw dev GUI
// (lil-gui), which stays available behind the "Menu" toggle for tuning
// individual parameters. By default the site tracks real local time and
// today's real-ish weather for whatever location you're at (see main.js's
// "live" timeMode); this panel reports that, and its one control lets a
// visitor leave live mode and fast-forward through the simulated
// day/weather cycle instead — not what the weather or hour actually is.

const STYLE = /* css */`
  .player-panel {
    position: fixed;
    right: 12px;
    bottom: 12px;
    width: 300px;
    max-width: calc(100vw - 24px);
    max-height: calc(100vh - 24px);
    overflow-y: auto;
    background: rgba(18, 20, 26, 0.72);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    color: #f2f4f8;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    z-index: 900;
    transition: opacity 0.2s ease;
  }
  .player-panel.collapsed .player-body { display: none; }
  .player-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    cursor: pointer;
    user-select: none;
  }
  .player-title {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .player-chevron {
    font-size: 11px;
    opacity: 0.6;
    transition: transform 0.2s ease;
  }
  .player-panel.collapsed .player-chevron { transform: rotate(-90deg); }
  .player-body {
    padding: 0 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .player-section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.55;
  }
  .player-status-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .player-status-value {
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  /* Small "UTC" tag next to the clock reading, in place of the old
     "World Time (UTC)" / "Local Time" row label — shown only in space,
     where the reading genuinely isn't a location's local time. */
  .player-time-tz {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    opacity: 0.55;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 4px;
    padding: 1px 4px;
    margin-left: 6px;
    vertical-align: middle;
  }
  /* Live/Forward: a real two-position switch (iOS-style segmented control)
     instead of the old single button that cycled Live -> speed 1 -> speed
     2 -> speed 3 -> back to Live, with tiny arrow glyphs as the only
     indication of which speed was active. Two clearly-labeled segments the
     whole mode fits in — "how fast" is a separate, secondary control below,
     not folded into the same click target. */
  .player-toggle {
    display: flex;
    gap: 2px;
    padding: 3px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
  }
  .player-toggle-btn {
    appearance: none;
    flex: 1;
    border: none;
    background: transparent;
    color: #f2f4f8;
    opacity: 0.6;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 7px 10px;
    border-radius: 7px;
    cursor: pointer;
    transition: background 0.15s ease, opacity 0.15s ease, color 0.15s ease;
  }
  .player-toggle-btn:hover { opacity: 0.85; }
  .player-toggle-btn:focus-visible {
    outline: 2px solid #6cc7ff;
    outline-offset: 1px;
  }
  .player-toggle-btn.active {
    background: #4a9eff;
    color: #08131f;
    opacity: 1;
  }
  /* Speed sub-control — only shown once "Forward" is the active mode, right
     under the toggle it belongs to instead of a separate "Time" section. */
  .player-speed-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .player-speed-row.hidden { display: none; }
  .player-speed-label {
    font-size: 10px;
    opacity: 0.5;
  }
  .player-speed-chip {
    appearance: none;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.06);
    color: #f2f4f8;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    padding: 5px 9px;
    border-radius: 7px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .player-speed-chip:hover { background: rgba(255, 255, 255, 0.13); }
  .player-speed-chip.active {
    background: #4a9eff;
    border-color: #4a9eff;
    color: #08131f;
  }
`;

function injectStyleOnce() {
  if (document.getElementById('player-panel-style')) return;
  const styleEl = document.createElement('style');
  styleEl.id = 'player-panel-style';
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);
}

function formatHour(hour) {
  const h24 = ((hour % 24) + 24) % 24;
  // Rounds in total-minutes space, not hour-then-minutes separately —
  // rounding hour and minute parts independently let a value like 5.999h
  // floor to "5" for the hour but round its 59.9something minutes up to a
  // literal "60", instead of rolling over into "6:00".
  const totalMinutes = Math.round(h24 * 60) % (24 * 60);
  const period = totalMinutes < 12 * 60 ? 'AM' : 'PM';
  let h12 = Math.floor(totalMinutes / 60) % 12;
  if (h12 === 0) h12 = 12;
  const minutes = totalMinutes % 60;
  return `${h12}:${String(minutes).padStart(2, '0')} ${period}`;
}

// A speed value's display label — relative to the slowest option, so
// whatever hours-per-sim-second values main.js actually uses (see
// TIME_SPEEDS), the panel always reads "1x / 2x / 4x" rather than the raw
// numbers, which meant nothing to a visitor.
function speedMultiplierLabel(speedOptions, value) {
  const base = speedOptions[0] || value;
  const mult = base > 0 ? Math.round((value / base) * 10) / 10 : 1;
  return `${mult}×`;
}

// opts: { initialWeather, initialTempF, initialHour, initialTimeLabel,
//         speedOptions: number[], initialMode: 'live'|'sim', initialSpeedIndex,
//         onModeChange(mode, speedValue?) }
// No location picker here — traveling is a console command now (see
// commands/travelCommand.ts's "travel" — the panel only ever reported
// state, it never needed to be the place that changes it), so main.js owns
// all of the travel/routing logic in one place instead of splitting it
// between a UI component and the console.
export function buildPlayerPanel(opts) {
  injectStyleOnce();

  const panel = document.createElement('div');
  panel.className = 'player-panel';

  const header = document.createElement('div');
  header.className = 'player-header';
  header.innerHTML = `<span class="player-title">Explore</span><span class="player-chevron">▾</span>`;
  header.addEventListener('click', () => panel.classList.toggle('collapsed'));
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'player-body';
  panel.appendChild(body);

  // --- Status: weather, temperature, and time just happen — reported, not
  // chosen. Space isn't a special case the panel itself knows about: main.js
  // just feeds these the same setters with space-appropriate values (see
  // its own comment) — a "condition" of vacuum, a temperature of deep cold,
  // and world/UTC time instead of a location's local time.
  const weatherRow = document.createElement('div');
  weatherRow.className = 'player-status-row';
  weatherRow.innerHTML = `
    <span class="player-section-label">Weather</span>
    <span class="player-status-value" data-role="weather"></span>
  `;
  const weatherValue = weatherRow.querySelector('[data-role="weather"]');
  weatherValue.textContent = opts.initialWeather;
  body.appendChild(weatherRow);

  const tempRow = document.createElement('div');
  tempRow.className = 'player-status-row';
  tempRow.innerHTML = `
    <span class="player-section-label">Temp</span>
    <span class="player-status-value" data-role="temp"></span>
  `;
  const tempValue = tempRow.querySelector('[data-role="temp"]');
  tempValue.textContent = `${Math.round(opts.initialTempF)}°F`;
  body.appendChild(tempRow);

  // Plain "Time" label, same weight as Weather/Temp above it — no separate
  // "Local Time" / "World Time (UTC)" subheader taking up its own line.
  // That distinction still matters in space (this genuinely isn't anywhere's
  // local time), so it survives as a small "UTC" tag right on the value
  // instead of a whole extra row.
  const timeRow = document.createElement('div');
  timeRow.className = 'player-status-row';
  timeRow.innerHTML = `
    <span class="player-section-label">Time</span>
    <span class="player-status-value">
      <span data-role="time"></span><span class="player-time-tz" data-role="time-tz" style="display:none">UTC</span>
    </span>
  `;
  const timeValue = timeRow.querySelector('[data-role="time"]');
  const timeTzTag = timeRow.querySelector('[data-role="time-tz"]');
  timeValue.textContent = formatHour(opts.initialHour);
  timeTzTag.style.display = opts.initialTimeLabel === 'Local Time' ? 'none' : '';
  body.appendChild(timeRow);

  // --- Live/Forward: a two-position switch right under the time it
  // controls, plus a speed sub-row that only appears once Forward is
  // selected — see the .player-toggle/.player-speed-row comments above for
  // why this replaced the old single cycling button.
  const toggleRow = document.createElement('div');
  toggleRow.className = 'player-toggle';
  const liveBtn = document.createElement('button');
  liveBtn.className = 'player-toggle-btn';
  liveBtn.textContent = 'Live';
  liveBtn.setAttribute('aria-label', 'Live — real local time and weather');
  const forwardBtn = document.createElement('button');
  forwardBtn.className = 'player-toggle-btn';
  forwardBtn.textContent = 'Forward';
  forwardBtn.setAttribute('aria-label', 'Forward — fast-forward through the simulated day/weather cycle');
  toggleRow.appendChild(liveBtn);
  toggleRow.appendChild(forwardBtn);
  body.appendChild(toggleRow);

  const speedRow = document.createElement('div');
  speedRow.className = 'player-speed-row';
  const speedLabel = document.createElement('span');
  speedLabel.className = 'player-speed-label';
  speedLabel.textContent = 'Speed';
  speedRow.appendChild(speedLabel);
  const speedChips = opts.speedOptions.map((value, i) => {
    const chip = document.createElement('button');
    chip.className = 'player-speed-chip';
    chip.textContent = speedMultiplierLabel(opts.speedOptions, value);
    chip.addEventListener('click', () => {
      speedIndex = i;
      renderControls();
      opts.onModeChange('sim', opts.speedOptions[speedIndex]);
    });
    speedRow.appendChild(chip);
    return chip;
  });
  body.appendChild(speedRow);

  // -1 isn't a real mode here (unlike the old cycling button) — `mode`
  // ('live'/'sim') and `speedIndex` are tracked separately since the speed
  // row now needs to keep showing which speed is selected even while Live
  // is the active mode, instead of losing that state every time.
  let mode = opts.initialMode;
  let speedIndex = opts.initialSpeedIndex ?? 0;

  function renderControls() {
    const isLive = mode === 'live';
    liveBtn.classList.toggle('active', isLive);
    forwardBtn.classList.toggle('active', !isLive);
    speedRow.classList.toggle('hidden', isLive);
    speedChips.forEach((chip, i) => chip.classList.toggle('active', i === speedIndex));
  }
  renderControls();

  liveBtn.addEventListener('click', () => {
    if (mode === 'live') return;
    mode = 'live';
    renderControls();
    opts.onModeChange('live');
  });
  forwardBtn.addEventListener('click', () => {
    if (mode === 'sim') return;
    mode = 'sim';
    renderControls();
    opts.onModeChange('sim', opts.speedOptions[speedIndex]);
  });

  document.body.appendChild(panel);

  return {
    setWeather: (name) => { weatherValue.textContent = name; },
    setTemp: (f) => { tempValue.textContent = `${Math.round(f)}°F`; },
    // label: "Local Time" (ground) or "World Time (UTC)" (space) — see
    // main.js's own comment on why the conversion itself lives there, not
    // here. Only surfaces as the small UTC tag now, not a whole row.
    setTime: (h, label) => {
      timeValue.textContent = formatHour(h);
      timeTzTag.style.display = label === 'Local Time' ? 'none' : '';
    },
    // Keeps the toggle in sync when the mode changes from somewhere other
    // than this control itself — the hidden console's "time live"/"time
    // sim", or the dev GUI's raw hour slider forcing sim mode.
    setMode: (newMode, speedIdx = 0) => {
      mode = newMode;
      speedIndex = speedIdx;
      renderControls();
    },
  };
}
