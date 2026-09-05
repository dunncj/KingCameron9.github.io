// A user-facing panel (left side) mirroring the Explore panel's look (see
// player.js) but purely informational — a bio plus a simple experience
// timeline. Landing-page only: main.js hides it once a visitor enters
// world view, the mirror image of how the Explore panel hides during
// landing (see main.js's onLandingChange wiring).

const EXPERIENCE = [
  {
    org: 'Tesla',
    role: 'Software Engineer Intern, FleetNet',
    period: 'Aug 2026 – Present',
    line: "Building Go microservices on FleetNet, the connectivity platform behind Tesla's Robotaxi fleet.",
  },
  {
    org: 'VTG',
    role: 'DevOps Engineer Intern',
    period: 'May – Jul 2026',
    line: 'Deployed Kubernetes workloads for naval combat systems; built a Go tool that now enforces architecture rules in CI.',
  },
  {
    org: 'Frontier Foundries',
    role: 'AI Systems Intern',
    period: 'Dec 2025 – Apr 2026',
    line: 'Built Rust/Go pipelines and LLM validation systems for on-prem AI serving defense and financial clients.',
  },
  {
    org: 'UIUC BCI Lab',
    role: 'Undergraduate Research Assistant',
    period: 'Aug 2025 – May 2026',
    line: 'Decoded live EEG signals into real-time robot commands, 62% accuracy, ~200ms latency.',
  },
  {
    org: 'The Meridian Lasso',
    role: 'Software Engineer',
    period: 'Nov 2024 – May 2025',
    line: 'Built a full-stack editorial platform serving 1,000+ monthly users; cut hosting costs ~95%.',
  },
  {
    org: 'Welcoming Falls Church',
    role: 'Web Administrator',
    period: 'Jan 2024 – Dec 2025',
    line: 'Administer production infrastructure supporting 500+ users at 99.9% uptime.',
  },
];

const PROJECTS = [
  {
    name: 'P2P Networking Research',
    stack: 'C++ · WebRTC · Linux',
    line: 'Simulated peer-to-peer routing at scale, cutting bandwidth overhead ~70% through adaptive routing.',
  },
  {
    name: 'Homelab (agartha)',
    stack: 'NixOS · Kubernetes · Tailscale',
    line: 'A declarative NixOS + Kubernetes homelab running 8 self-hosted services at 99.99% uptime.',
  },
];

const SKILLS = [
  'Go', 'Rust', 'Python', 'TypeScript', 'C++', 'React',
  'Kubernetes', 'Docker', 'Linux', 'Kafka', 'PyTorch', 'AI', 'Distributed Systems',
];

const INTERESTS = [
  'Distributed systems',
  'Networking',
  'Linux and infrastructure',
  'Low-latency and performance',
  'Development tools and automation',
];

const STYLE = /* css */`
  .bio-panel {
    position: fixed;
    left: 12px;
    top: 12px;
    bottom: 12px;
    width: 30vw;
    min-width: 300px;
    max-width: calc(100vw - 24px);
    max-height: calc(100vh - 24px);
    background: rgba(18, 20, 26, 0.35);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    color: #f2f4f8;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    z-index: 900;
    transition: opacity 0.3s ease;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .bio-banner {
    flex: none;
    width: 100%;
    height: 190px;
    object-fit: cover;
    object-position: center 45%;
    display: block;
    image-rendering: pixelated;
  }
  .bio-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .bio-header {
    display: flex;
    align-items: center;
    padding: 12px 22px;
    flex: none;
  }
  .bio-title {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.01em;
  }
  .bio-intro {
    flex: none;
    padding: 0 22px 14px;
    font-size: 13px;
    line-height: 1.55;
    opacity: 0.9;
  }
  .bio-interests {
    flex: none;
    margin: 0 22px 14px;
    padding-left: 16px;
    font-size: 12px;
    line-height: 1.7;
    opacity: 0.7;
  }
  .bio-interests li { list-style: disc; }
  .bio-panels {
    flex: none;
    padding: 0 22px 14px;
  }

  .bio-timeline { position: relative; }
  .bio-timeline-item {
    position: relative;
    padding: 8px 10px 18px 22px;
    margin: 0 -10px;
    border-left: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    transition: background 0.18s ease, transform 0.18s ease, border-left-color 0.18s ease;
  }
  .bio-timeline-item:last-child { border-left-color: transparent; padding-bottom: 8px; }
  .bio-timeline-item:hover {
    background: rgba(108, 199, 255, 0.08);
    transform: translateX(3px);
    border-left-color: #6cc7ff;
  }
  .bio-timeline-bullet {
    position: absolute;
    left: -6px;
    top: 12px;
    width: 10px;
    height: 10px;
    image-rendering: pixelated;
    transition: transform 0.18s ease;
  }
  .bio-timeline-item:hover .bio-timeline-bullet { transform: scale(1.6); }
  .bio-timeline-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .bio-timeline-org { font-size: 13px; font-weight: 700; }
  .bio-timeline-period { font-size: 10px; font-weight: 600; opacity: 0.5; white-space: nowrap; }
  .bio-timeline-role { font-size: 11px; opacity: 0.6; margin-top: 1px; }
  .bio-timeline-line { font-size: 12px; line-height: 1.5; opacity: 0.85; margin-top: 5px; }

  .bio-projects {
    flex: none;
    padding: 4px 22px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bio-project-card {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
    transition: background 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
  }
  .bio-project-card:hover {
    background: rgba(108, 199, 255, 0.08);
    border-color: rgba(108, 199, 255, 0.35);
    transform: translateX(3px);
  }
  .bio-project-icon {
    width: 22px;
    height: 22px;
    flex: none;
    margin-top: 1px;
    image-rendering: pixelated;
    transition: transform 0.18s ease;
  }
  .bio-project-card:hover .bio-project-icon { transform: rotate(-8deg) scale(1.15); }
  .bio-project-name { font-size: 12.5px; font-weight: 700; }
  .bio-project-stack { font-size: 10px; font-weight: 600; opacity: 0.5; margin-top: 1px; }
  .bio-project-line { font-size: 11.5px; line-height: 1.5; opacity: 0.8; margin-top: 4px; }

  .bio-skills {
    flex: none;
    padding: 12px 22px 14px;
    font-size: 11.5px;
    opacity: 0.55;
    letter-spacing: 0.01em;
  }
  .bio-skills span { transition: opacity 0.15s ease; }
  .bio-skills span:hover { opacity: 0.6; }

  .bio-simple-link {
    flex: none;
    display: block;
    padding: 12px 22px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 11.5px;
    color: #f2f4f8;
    opacity: 0.7;
    text-decoration: none;
    transition: opacity 0.15s ease, background 0.15s ease;
  }
  .bio-simple-link span { color: #6cc7ff; font-weight: 600; }
  .bio-simple-link:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.04);
  }
`;

function injectStyleOnce() {
  if (document.getElementById('bio-panel-style')) return;
  const styleEl = document.createElement('style');
  styleEl.id = 'bio-panel-style';
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);
}

export function buildBioPanel() {
  injectStyleOnce();

  const panel = document.createElement('div');
  panel.className = 'bio-panel';

  const banner = document.createElement('img');
  banner.className = 'bio-banner';
  banner.src = '/images/uiuc-quad.png';
  banner.alt = '';
  panel.appendChild(banner);

  const scroll = document.createElement('div');
  scroll.className = 'bio-scroll';
  panel.appendChild(scroll);

  const header = document.createElement('div');
  header.className = 'bio-header';
  header.innerHTML = `<span class="bio-title">Cameron Dunn</span>`;
  scroll.appendChild(header);

  const intro = document.createElement('div');
  intro.className = 'bio-intro';
  intro.textContent = 'Software Engineer Intern at Tesla (FleetNet). CS @ UIUC. Recruiting for internships Spring and Summer 2027.';
  scroll.appendChild(intro);

  const interests = document.createElement('ul');
  interests.className = 'bio-interests';
  interests.innerHTML = INTERESTS.map((i) => `<li>${i}</li>`).join('');
  scroll.appendChild(interests);

  const panels = document.createElement('div');
  panels.className = 'bio-panels';
  const timeline = document.createElement('div');
  timeline.className = 'bio-timeline';
  timeline.innerHTML = EXPERIENCE.map((job) => `
    <div class="bio-timeline-item">
      <img class="bio-timeline-bullet" src="/images/pixel-bullet.png" alt="" />
      <div class="bio-timeline-head">
        <span class="bio-timeline-org">${job.org}</span>
        <span class="bio-timeline-period">${job.period}</span>
      </div>
      <div class="bio-timeline-role">${job.role}</div>
      <div class="bio-timeline-line">${job.line}</div>
    </div>
  `).join('');
  panels.appendChild(timeline);
  scroll.appendChild(panels);

  const projects = document.createElement('div');
  projects.className = 'bio-projects';
  projects.innerHTML = PROJECTS.map((p) => `
    <div class="bio-project-card">
      <img class="bio-project-icon" src="/images/pixel-cube.png" alt="" />
      <div>
        <div class="bio-project-name">${p.name}</div>
        <div class="bio-project-stack">${p.stack}</div>
        <div class="bio-project-line">${p.line}</div>
      </div>
    </div>
  `).join('');
  scroll.appendChild(projects);

  // Pinned footer, outside the scrollable area — always at the bottom of
  // the panel rather than trailing off wherever the scrollable content
  // happens to end.
  const skills = document.createElement('div');
  skills.className = 'bio-skills';
  skills.innerHTML = SKILLS.map((s) => `<span>${s}</span>`).join(' &nbsp;·&nbsp; ');
  panel.appendChild(skills);

  const simpleLink = document.createElement('a');
  simpleLink.className = 'bio-simple-link';
  // Trailing slash matters: /simplified with no slash has no exact file
  // match, so Vite's dev server falls through to its SPA default (root
  // index.html — the full 3D app) instead of simplified/index.html.
  simpleLink.href = '/simplified/';
  simpleLink.innerHTML = 'Prefer simple view? <span>Click here to view simplified →</span>';
  panel.appendChild(simpleLink);

  // Scrolling the bio itself must never reach usMap.js's wheel handler
  // (bound to document.body, which this panel is a plain sibling of, not
  // a descendant of the canvas) — left alone, that bubbling reads as
  // globe-zoom input and can push the landing straight into /world/.
  panel.addEventListener('wheel', (e) => e.stopPropagation());

  document.body.appendChild(panel);

  return {
    setVisible: (visible) => { panel.style.opacity = visible ? '1' : '0'; panel.style.pointerEvents = visible ? '' : 'none'; },
  };
}
