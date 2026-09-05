// Left-side panel shown while in local/ground view at one of the four
// travelable locations (see main.js's onArriveAt) — same glass styling as
// bioPanel.js's landing panel, but swaps its content per location instead
// of showing the full timeline. Hidden during landing and during the US
// overview; visible only once a specific location's ground view is active
// (main.js wires setLocation/setVisible into onArriveAt and enterOverview).

const LOCATION_INFO = {
  paloAlto: {
    org: 'Tesla',
    logo: '/images/tesla-logo-pixel.png',
    role: 'Software Engineer Intern, FleetNet',
    address: '3500 Deer Creek Rd, Palo Alto, CA 94304',
    lines: [
      "Spending the fall at Tesla's Palo Alto engineering headquarters, my first stretch living on the West Coast.",
      "I'm working on FleetNet, the connectivity platform behind the Robotaxi fleet: Go microservices, real-time telemetry, the stuff that keeps the cars talking to home base.",
      "The Bay is super exciting, and the weather and nature out here are unbelievable.",
    ],
  },
  chantilly: {
    org: 'VTG',
    logo: '/images/vtg-logo-pixel.png',
    role: 'DevOps Engineer Intern',
    address: 'Chantilly, VA',
    lines: [
      'Spent a summer here as a DevOps intern working on naval combat systems: Kubernetes, CI tooling, infrastructure that has to just work.',
      'VTG is a Lockheed Martin subcontractor, and this was on an LM naval subcontract. Lots of fun, and honestly the most serious work I had done up to that point. Definitely learned a lot.',
      "Defense contractor work, so most of the specifics aren't something I can talk about publicly.",
    ],
  },
  urbana: {
    org: 'UIUC',
    logo: '/images/uiuc-logo-pixel.png',
    role: 'CS Student · BCI Lab Researcher',
    address: 'Urbana, IL',
    lines: [
      'Home base for most of the year, studying Computer Science at the Grainger College of Engineering.',
      "In between classes, I do EEG and robotics research with the BCI Lab: decoding live brain signals into real-time robot commands.",
      "Coming from Virginia, the winters still catch me off guard every year. Really cold. But some of the most exciting research I've ever been exposed to happens right here.",
    ],
  },
  fallsChurch: {
    org: 'Meridian High School',
    logo: '/images/meridian-logo-pixel.png',
    role: 'Where I grew up',
    address: '121 Mustang Alley, Falls Church, VA 22043',
    lines: [
      'I went through the Falls Church City Public School system from elementary all the way through high school, finishing up at Meridian.',
      'Outside of class it was mostly robotics, track, and Boy Scouts. Eagle Scout, actually.',
      "I also built The Meridian Lasso, the school newspaper's publishing platform, and kept the infrastructure running for Welcoming Falls Church, a local nonprofit.",
      "It still feels like home every single time I'm back.",
    ],
  },
};

const STYLE = /* css */`
  .loc-panel {
    position: fixed;
    left: 12px;
    top: 12px;
    width: 30vw;
    min-width: 300px;
    max-width: calc(100vw - 24px);
    max-height: calc(90vh - 24px);
    background: rgba(18, 20, 26, 0.35);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    color: #f2f4f8;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    z-index: 900;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .loc-header {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 22px;
    flex: none;
  }
  .loc-logo {
    width: 52px;
    height: 52px;
    border-radius: 12px;
    image-rendering: pixelated;
    flex: none;
  }
  .loc-org { font-size: 17px; font-weight: 700; }
  .loc-role { font-size: 12.5px; opacity: 0.6; margin-top: 2px; }
  .loc-address { font-size: 11px; opacity: 0.45; margin-top: 3px; }
  .loc-lines {
    flex: 1;
    overflow-y: auto;
    padding: 0 22px 22px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .loc-line {
    font-size: 13.5px;
    line-height: 1.6;
    opacity: 0.9;
  }
`;

function injectStyleOnce() {
  if (document.getElementById('loc-panel-style')) return;
  const styleEl = document.createElement('style');
  styleEl.id = 'loc-panel-style';
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);
}

export function buildLocationBioPanel() {
  injectStyleOnce();

  const panel = document.createElement('div');
  panel.className = 'loc-panel';

  const header = document.createElement('div');
  header.className = 'loc-header';
  panel.appendChild(header);

  const lines = document.createElement('div');
  lines.className = 'loc-lines';
  panel.appendChild(lines);

  // Scrolling this panel must never reach the ground view's own wheel
  // dolly-zoom (bound to document.body, which this panel is a plain
  // sibling of, not a descendant of the canvas) — left alone, that
  // bubbling reads as camera-zoom input.
  panel.addEventListener('wheel', (e) => e.stopPropagation());

  document.body.appendChild(panel);

  return {
    setLocation: (name) => {
      const info = LOCATION_INFO[name];
      if (!info) return;
      header.innerHTML = `
        <img class="loc-logo" src="${info.logo}" alt="${info.org}" />
        <span>
          <div class="loc-org">${info.org}</div>
          <div class="loc-role">${info.role}</div>
          <div class="loc-address">${info.address}</div>
        </span>
      `;
      lines.innerHTML = info.lines.map((l) => `<div class="loc-line">${l}</div>`).join('');
    },
    // Arriving fades in slowly, delayed to land roughly when the travel
    // flight itself settles rather than popping in the instant the flight
    // starts; leaving (back to overview) hides quickly, no delay.
    setVisible: (visible) => {
      panel.style.transition = visible ? 'opacity 1.6s ease 1s' : 'opacity 0.3s ease';
      panel.style.opacity = visible ? '1' : '0';
      panel.style.pointerEvents = visible ? '' : 'none';
    },
  };
}
