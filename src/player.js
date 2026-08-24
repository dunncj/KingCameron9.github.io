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
    gap: 14px;
  }
  .player-section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.55;
    margin-bottom: 7px;
  }
  .player-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .player-btn {
    appearance: none;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.06);
    color: #f2f4f8;
    font: inherit;
    font-size: 12px;
    padding: 7px 12px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .player-btn:hover { background: rgba(255, 255, 255, 0.13); }
  .player-btn:focus-visible {
    outline: 2px solid #6cc7ff;
    outline-offset: 1px;
  }
  .player-btn.active {
    background: #4a9eff;
    border-color: #4a9eff;
    color: #08131f;
    font-weight: 600;
  }
  .player-speed-btn {
    display: inline-flex;
    align-items: center;
    gap: 1px;
  }
  .player-speed-arrow {
    font-size: 14px;
    line-height: 1;
    color: #f2f4f8;
    opacity: 0.25;
    transition: opacity 0.15s ease, color 0.15s ease;
  }
  .player-speed-arrow.active {
    opacity: 1;
    color: #6cc7ff;
  }
  .player-speed-live-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
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
  const statusSection = document.createElement('div');
  const weatherRow = document.createElement('div');
  weatherRow.className = 'player-status-row';
  weatherRow.innerHTML = `
    <span class="player-section-label" style="margin-bottom:0">Weather</span>
    <span class="player-status-value" data-role="weather"></span>
  `;
  const weatherValue = weatherRow.querySelector('[data-role="weather"]');
  weatherValue.textContent = opts.initialWeather;
  statusSection.appendChild(weatherRow);

  const tempRow = document.createElement('div');
  tempRow.className = 'player-status-row';
  tempRow.innerHTML = `
    <span class="player-section-label" style="margin-bottom:0">Temp</span>
    <span class="player-status-value" data-role="temp"></span>
  `;
  const tempValue = tempRow.querySelector('[data-role="temp"]');
  tempValue.textContent = `${Math.round(opts.initialTempF)}°F`;
  statusSection.appendChild(tempRow);

  const timeRow = document.createElement('div');
  timeRow.className = 'player-status-row';
  timeRow.innerHTML = `
    <span class="player-section-label" style="margin-bottom:0" data-role="time-label"></span>
    <span class="player-status-value" data-role="time"></span>
  `;
  const timeLabelEl = timeRow.querySelector('[data-role="time-label"]');
  const timeValue = timeRow.querySelector('[data-role="time"]');
  timeLabelEl.textContent = opts.initialTimeLabel;
  timeValue.textContent = formatHour(opts.initialHour);
  statusSection.appendChild(timeRow);

  body.appendChild(statusSection);

  // --- Time: the one dial visitors get over time/weather — a single button
  // that cycles between "Live" (real local time + today's real-ish weather,
  // the default) and increasingly fast simulated speeds, wrapping back to
  // Live rather than a separate button for it.
  const speedSection = document.createElement('div');
  speedSection.innerHTML = '<div class="player-section-label">Time</div>';
  const speedRow = document.createElement('div');
  speedRow.className = 'player-row';
  // Fixed-size button, Cities: Skylines-style: every level's arrow is always
  // present, and increasing speed lights up one more of them (cumulative up
  // to the current level) instead of literally growing the button — the
  // previous '→'.repeat(n) approach resized the button on every click.
  const speedBtn = document.createElement('button');
  speedBtn.className = 'player-btn player-speed-btn';
  const liveLabel = document.createElement('span');
  liveLabel.className = 'player-speed-live-label';
  liveLabel.textContent = 'LIVE';
  speedBtn.appendChild(liveLabel);
  const speedArrows = opts.speedOptions.map(() => {
    const arrow = document.createElement('span');
    arrow.className = 'player-speed-arrow';
    arrow.textContent = '›';
    speedBtn.appendChild(arrow);
    return arrow;
  });
  // -1 = live, 0..speedOptions.length-1 = which simulated speed is active.
  let speedIndex = opts.initialMode === 'sim' ? (opts.initialSpeedIndex ?? 0) : -1;
  const renderSpeedBtn = () => {
    const isLive = speedIndex === -1;
    liveLabel.style.display = isLive ? '' : 'none';
    speedArrows.forEach((arrow, i) => {
      arrow.style.display = isLive ? 'none' : '';
      arrow.classList.toggle('active', !isLive && i <= speedIndex);
    });
    speedBtn.classList.toggle('active', isLive);
    speedBtn.setAttribute('aria-label', isLive
      ? 'Live — real local time and weather. Click to fast-forward.'
      : `Fast-forward speed ${speedIndex + 1} of ${opts.speedOptions.length}, click to change`);
  };
  renderSpeedBtn();
  speedBtn.addEventListener('click', () => {
    speedIndex += 1;
    if (speedIndex >= opts.speedOptions.length) speedIndex = -1;
    renderSpeedBtn();
    if (speedIndex === -1) opts.onModeChange('live');
    else opts.onModeChange('sim', opts.speedOptions[speedIndex]);
  });
  speedRow.appendChild(speedBtn);
  speedSection.appendChild(speedRow);
  body.appendChild(speedSection);

  document.body.appendChild(panel);

  return {
    setWeather: (name) => { weatherValue.textContent = name; },
    setTemp: (f) => { tempValue.textContent = `${Math.round(f)}°F`; },
    // label: "Local Time" (ground) or "World Time (UTC)" (space) — see
    // main.js's own comment on why the conversion itself lives there, not
    // here.
    setTime: (h, label) => {
      timeValue.textContent = formatHour(h);
      timeLabelEl.textContent = label;
    },
    // Keeps the button in sync when the mode changes from somewhere other
    // than this button itself — the hidden console's "time live"/"time sim"
    // commands, or the dev GUI's raw hour slider forcing sim mode.
    setMode: (mode, speedIdx = 0) => {
      speedIndex = mode === 'live' ? -1 : speedIdx;
      renderSpeedBtn();
    },
  };
}
