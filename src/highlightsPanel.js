// Right-side counterpart to bioPanel.js's left panel — same glass styling,
// but two independently positioned panes (not one stacked container) so
// the layout reads as 1 (left) + 2 (right): "Now" pinned top-right
// (headshot + current employer/location, clock, contact), and a short
// "Places" pane pinned bottom-right nudging toward the globe itself. Both
// size to their own content rather than stretching. Center of the screen
// stays clear so the landing globe reads through.

const STYLE = /* css */`
  .hl-pane {
    position: fixed;
    right: 12px;
    width: 25vw;
    min-width: 300px;
    max-width: calc(100vw - 24px);
    max-height: calc(100vh - 24px);
    z-index: 900;
    transition: opacity 0.3s ease;
    background: rgba(18, 20, 26, 0.35);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    color: #f2f4f8;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .hl-pane-now { top: 12px; }
  .hl-pane-places { bottom: 12px; }
  .hl-header {
    display: flex;
    align-items: center;
    padding: 12px 22px;
    flex: none;
  }
  .hl-title {
    font-size: 16px;
    font-weight: 700;
  }
  .hl-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 22px 14px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 16px;
  }

  .hl-clock-card {
    padding: 2px 0 0;
  }
  .hl-clock-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.55;
  }
  .hl-clock-time {
    font-size: 28px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    margin-top: 4px;
  }
  .hl-clock-date {
    font-size: 11px;
    opacity: 0.6;
    margin-top: 2px;
  }

  .hl-status {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .hl-status-avatar-wrap {
    position: relative;
    flex: none;
  }
  .hl-status-avatar {
    width: 130px;
    height: 130px;
    border-radius: 50%;
    object-fit: cover;
    image-rendering: pixelated;
    border: 1px solid rgba(255, 255, 255, 0.18);
    display: block;
  }
  .hl-status-badge {
    position: absolute;
    right: -4px;
    bottom: -4px;
    width: 42px;
    height: 42px;
    border-radius: 10px;
    image-rendering: pixelated;
    border: 2px solid rgba(18, 20, 26, 0.9);
    background: rgba(18, 20, 26, 0.9);
  }
  .hl-status-text-primary {
    font-size: 17px;
    font-weight: 700;
  }
  .hl-status-text-secondary {
    font-size: 13px;
    opacity: 0.6;
    margin-top: 3px;
  }
  .hl-status-detail {
    font-size: 12.5px;
    line-height: 1.55;
    opacity: 0.75;
  }

  .hl-places-text {
    font-size: 14px;
    line-height: 1.6;
    opacity: 0.85;
    text-align: center;
  }
  .hl-places-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }
  .hl-places-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.05);
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .hl-places-chip:hover {
    background: rgba(74, 158, 255, 0.18);
    border-color: rgba(74, 158, 255, 0.5);
  }
  .hl-places-chip::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ff6b6b;
    flex: none;
  }

  .hl-contact {
    display: flex;
    gap: 10px;
    font-size: 12px;
    font-weight: 600;
  }
  .hl-contact a {
    color: #f2f4f8;
    opacity: 0.7;
    text-decoration: none;
    transition: opacity 0.15s ease;
  }
  .hl-contact a:hover { opacity: 1; }
`;

function injectStyleOnce() {
  if (document.getElementById('hl-panel-style')) return;
  const styleEl = document.createElement('style');
  styleEl.id = 'hl-panel-style';
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);
}

function startClock(timeEl, dateEl, timeZone) {
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric',
  });
  function tick() {
    const now = new Date();
    timeEl.textContent = timeFmt.format(now);
    dateEl.textContent = dateFmt.format(now);
  }
  tick();
  setInterval(tick, 1000);
}

function buildPane(title, extraClass) {
  const pane = document.createElement('div');
  pane.className = extraClass ? `hl-pane ${extraClass}` : 'hl-pane';

  const header = document.createElement('div');
  header.className = 'hl-header';
  header.innerHTML = `<span class="hl-title">${title}</span>`;
  pane.appendChild(header);

  const body = document.createElement('div');
  body.className = 'hl-body';
  pane.appendChild(body);

  // Scrolling within these panes must never reach usMap.js's wheel
  // handler (bound to document.body, which this pane is a plain sibling
  // of, not a descendant of the canvas) — left alone, that bubbling reads
  // as globe-zoom input and can push the landing straight into /world/.
  pane.addEventListener('wheel', (e) => e.stopPropagation());

  return { pane, body };
}

function buildNowPane() {
  const { pane, body } = buildPane('Where am I now?', 'hl-pane-now');

  const status = document.createElement('div');
  status.className = 'hl-status';
  status.innerHTML = `
    <span class="hl-status-avatar-wrap">
      <img class="hl-status-avatar" src="/images/headshot-pixel.png" alt="" />
      <img class="hl-status-badge" src="/images/tesla-logo-pixel.png" alt="Tesla" />
    </span>
    <span>
      <div class="hl-status-text-primary">Currently at Tesla</div>
      <div class="hl-status-text-secondary">Palo Alto, CA</div>
    </span>
  `;
  body.appendChild(status);

  const detail = document.createElement('div');
  detail.className = 'hl-status-detail';
  detail.textContent = "Interning on FleetNet through December, building the connectivity platform behind Tesla's Robotaxi fleet.";
  body.appendChild(detail);

  const clockCard = document.createElement('div');
  clockCard.className = 'hl-clock-card';
  clockCard.innerHTML = `
    <div class="hl-clock-label">Palo Alto, CA</div>
    <div class="hl-clock-time" data-role="time"></div>
    <div class="hl-clock-date" data-role="date"></div>
  `;
  body.appendChild(clockCard);
  startClock(
    clockCard.querySelector('[data-role="time"]'),
    clockCard.querySelector('[data-role="date"]'),
    'America/Los_Angeles',
  );

  const contact = document.createElement('div');
  contact.className = 'hl-contact';
  contact.innerHTML = `
    <a href="https://github.com/dunncj" target="_blank" rel="noopener">GitHub</a>
    <a href="https://linkedin.com/in/cdin" target="_blank" rel="noopener">LinkedIn</a>
  `;
  body.appendChild(contact);

  return pane;
}

const PLACES = ['Palo Alto, CA', 'Urbana, IL', 'Chantilly, VA', 'Falls Church, VA'];

function buildPlacesPane() {
  const { pane, body } = buildPane('Places', 'hl-pane-places');

  const text = document.createElement('div');
  text.className = 'hl-places-text';
  text.textContent = "I've been to some cool places. Scroll in on the earth to see them.";
  body.appendChild(text);

  const chips = document.createElement('div');
  chips.className = 'hl-places-chips';
  chips.innerHTML = PLACES.map((p) => `<span class="hl-places-chip">${p}</span>`).join('');
  body.appendChild(chips);

  return pane;
}

export function buildHighlightsPanel() {
  injectStyleOnce();

  const nowPane = buildNowPane();
  const placesPane = buildPlacesPane();
  document.body.appendChild(nowPane);
  document.body.appendChild(placesPane);

  return {
    setVisible: (visible) => {
      [nowPane, placesPane].forEach((el) => {
        el.style.opacity = visible ? '1' : '0';
        el.style.pointerEvents = visible ? '' : 'none';
      });
    },
  };
}
