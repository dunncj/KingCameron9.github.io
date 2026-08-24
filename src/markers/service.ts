import { createPixelPinIconUrl } from './pinIcon';
import { layoutLabels, DEFAULT_LABEL_GAP, type LabelCandidate } from './layout';

export interface MarkerDescriptor {
  id: string;
  label: string;
}

export interface MarkerProjection {
  id: string;
  px: number;
  py: number;
  visible: boolean;
}

export interface MarkerOverlay {
  // Pure DOM/layout — usMap.js still owns projecting each location's real
  // lat/lon into screen space and deciding on/off-screen and behind-the-
  // horizon visibility (that's globe-specific 3D math this overlay has no
  // business knowing about); this just takes the results and lays out the
  // 2D presentation, the same split particles/weather use for GPU rendering
  // vs. simulation.
  update(projections: MarkerProjection[]): void;
  // The true viewport-relative point a marker's anchor sits at — used for
  // hover-proximity checks against real mouse coordinates (e.clientX/Y),
  // which are viewport-relative regardless of whatever offset container
  // sits between it and the page. getBoundingClientRect() (not the raw
  // px/py this overlay was given) is what actually accounts for that, the
  // same reasoning usMap.js's original marker code relied on.
  getScreenPoint(id: string): { x: number; y: number } | null;
  dispose(): void;
}

const PIN_ACCENT = '#ff5a3c';

// Plain HTML pins + tags layered over the canvas, not WebGL geometry —
// stay crisp regardless of the pixelation shader and get click handling
// for free (see usMap.js's own original comment, preserved here since it's
// still exactly why this overlay exists). The pin icon itself is a tiny
// rasterized bitmap (see pinIcon.ts) so it visually belongs with the
// chunky retro look of the 3D scene sitting behind it instead of reading
// as a smooth, modern UI dot dropped on top of it.
export function createMarkerOverlay(
  container: HTMLElement,
  markers: MarkerDescriptor[],
  onSelect: (id: string) => void,
): MarkerOverlay {
  const pin = createPixelPinIconUrl({ fill: PIN_ACCENT });

  const entries = markers.map((marker) => {
    // `el` itself is a zero-size positioning anchor — left/top place its
    // origin exactly at the marker's true screen point, and every child
    // below positions itself relative to *that* origin, each with its own
    // appropriate anchor (a symmetric circle could just center itself on
    // the point; this pin has an asymmetric tip that has to be the part
    // touching it).
    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute; left: 0; top: 0;
      cursor: pointer; z-index: 10; user-select: none;
    `;

    // Bottom-center anchored to el's origin — pinIcon.ts's mask tapers to
    // a single-pixel tip on its last row, centered horizontally, so this
    // is what actually puts that tip (not the pin's bounding-box center)
    // on the real point, the standard map-pin convention.
    const pinEl = document.createElement('div');
    pinEl.style.cssText = `
      position: absolute; left: 0; top: 0;
      transform: translate(-50%, -100%);
      width: ${pin.width}px; height: ${pin.height}px;
      background-image: url(${pin.url});
      background-size: 100% 100%;
      image-rendering: pixelated;
    `;

    // A tag, not a pill — hard corners (2px, not 999px) read as belonging
    // with the site's own chunky pixel-art aesthetic the way a fully
    // rounded badge didn't. Positioned independently of pinEl (both are
    // anchored to el's origin, not to each other) so update() can move it
    // away from its default resting spot once layoutLabels() decides two
    // markers' labels are too close to stay there.
    const labelEl = document.createElement('div');
    labelEl.textContent = marker.label;
    labelEl.style.cssText = `
      position: absolute; left: 0; top: 0;
      transform: translate(-50%, ${DEFAULT_LABEL_GAP}px);
      font: 600 12px system-ui, -apple-system, sans-serif;
      color: #fff; background: rgba(10,10,14,0.82);
      border: 1px solid rgba(255,255,255,0.25);
      padding: 3px 8px; border-radius: 2px; white-space: nowrap;
    `;

    // A thin leader line back to the point — only shown when layoutLabels()
    // actually had to push this label away from its default resting spot
    // to keep it from overlapping a neighbor's.
    const connectorEl = document.createElement('div');
    connectorEl.style.cssText = `
      position: absolute; left: 0; top: 0;
      transform: translateX(-50%);
      width: 1px; background: rgba(255,255,255,0.5);
      display: none;
    `;

    el.appendChild(connectorEl);
    el.appendChild(pinEl);
    el.appendChild(labelEl);
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onSelect(marker.id);
    });
    container.appendChild(el);

    // Measured once — the label's text never changes after creation, and
    // layoutLabels() needs a real pixel width (marker names vary a lot in
    // length) to know whether two labels would actually overlap.
    const labelWidth = labelEl.offsetWidth;
    const labelHeight = labelEl.offsetHeight;

    return {
      id: marker.id, el, pinEl, labelEl, connectorEl, labelWidth, labelHeight,
    };
  });

  const byId = new Map(entries.map((e) => [e.id, e]));

  function update(projections: MarkerProjection[]) {
    const visible = projections.filter((p) => p.visible);
    const candidates: LabelCandidate[] = visible.map((p) => {
      const entry = byId.get(p.id);
      return {
        id: p.id,
        px: p.px,
        py: p.py,
        width: entry?.labelWidth ?? 0,
        height: entry?.labelHeight ?? 0,
      };
    });
    const placements = new Map(layoutLabels(candidates).map((p) => [p.id, p]));

    for (const p of projections) {
      const entry = byId.get(p.id);
      if (!entry) continue;
      entry.el.style.display = p.visible ? 'block' : 'none';
      if (!p.visible) continue;

      entry.el.style.left = `${p.px}px`;
      entry.el.style.top = `${p.py}px`;

      const placement = placements.get(p.id);
      const dy = placement?.dy ?? DEFAULT_LABEL_GAP;
      entry.labelEl.style.transform = `translate(-50%, ${dy}px)`;

      if (placement?.needsConnector) {
        // Runs from the point down to just short of the label's own top
        // edge, so the line visually meets the tag instead of running
        // under/through it.
        entry.connectorEl.style.height = `${Math.max(0, dy - 2)}px`;
        entry.connectorEl.style.display = 'block';
      } else {
        entry.connectorEl.style.display = 'none';
      }
    }
  }

  function getScreenPoint(id: string): { x: number; y: number } | null {
    const entry = byId.get(id);
    if (!entry || entry.el.style.display === 'none') return null;
    const rect = entry.el.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }

  function dispose() {
    entries.forEach((entry) => entry.el.remove());
  }

  return {
    update, getScreenPoint, dispose,
  };
}
