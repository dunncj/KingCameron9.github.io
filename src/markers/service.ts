import { layoutLabels, type LabelCandidate } from './layout';

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
  // The true viewport-relative point a marker's pin sits at — used for
  // hover-proximity checks against real mouse coordinates (e.clientX/Y).
  getScreenPoint(id: string): { x: number; y: number } | null;
  dispose(): void;
}

const PIN_ACCENT = '#ff5a3c';
const PIN_DIAMETER = 12;
const PIN_BORDER = 2;

// Plain HTML dots + tags layered over the canvas, not WebGL geometry —
// stay crisp regardless of the pixelation shader and get click handling
// for free (see usMap.js's own original comment, preserved here since it's
// still exactly why this overlay exists). A pixel-art pin icon (rounded
// head, punched-out hole, tapered tail) was tried here and repeatedly
// rendered wrong at this size — a plain white-fill/accent-outline circle
// is simple enough that there's no shape left to get wrong.
export function createMarkerOverlay(
  container: HTMLElement,
  markers: MarkerDescriptor[],
  onSelect: (id: string) => void,
): MarkerOverlay {
  // Two flat layers instead of one wrapper-per-marker: every marker's pin
  // lives in the lower layer, every marker's label+connector in the upper
  // one. A per-marker wrapper with its own z-index only controls paint
  // order *within* that marker (pin under its own label) — it does nothing
  // for two *different* markers sitting close together, where document
  // order (not z-index) decides which one's pin ends up covering the
  // other's label. Splitting into shared layers makes "no pin ever covers
  // any label" true globally, regardless of which markers are nearby or in
  // what order they were created.
  const pinsLayer = document.createElement('div');
  pinsLayer.style.cssText = 'position: absolute; left: 0; top: 0; z-index: 10;';
  const labelsLayer = document.createElement('div');
  labelsLayer.style.cssText = 'position: absolute; left: 0; top: 0; z-index: 20;';
  container.appendChild(pinsLayer);
  container.appendChild(labelsLayer);

  const entries = markers.map((marker) => {
    // Centered on the point — a circle has no "tip" the way the old
    // asymmetric pin did, so it just centers its whole box on the true
    // screen point. left/top are set every frame in update() to place
    // that origin at the marker's true screen point.
    const pinEl = document.createElement('div');
    pinEl.style.cssText = `
      position: absolute; left: 0; top: 0;
      transform: translate(-50%, -50%);
      width: ${PIN_DIAMETER}px; height: ${PIN_DIAMETER}px;
      border-radius: 50%; box-sizing: border-box;
      background: #fff; border: ${PIN_BORDER}px solid ${PIN_ACCENT};
      cursor: pointer; user-select: none;
    `;

    // Positioning anchor for this marker's label + connector, in the
    // labels layer — left/top track the same screen point as pinEl (set
    // together in update()), but this wrapper itself has zero size so
    // labelEl/connectorEl's own offsets stay relative to that exact point.
    const labelAnchor = document.createElement('div');
    labelAnchor.style.cssText = 'position: absolute; left: 0; top: 0;';

    // A tag, not a pill — hard corners (2px, not 999px) read as belonging
    // with the site's own chunky pixel-art aesthetic the way a fully
    // rounded badge didn't. Positioned via a plain translate(x, y) with no
    // centering math of its own (which edge is "centered" depends on
    // which of layoutLabels()'s four candidate directions was picked).
    const labelEl = document.createElement('div');
    labelEl.textContent = marker.label;
    labelEl.style.cssText = `
      position: absolute; left: 0; top: 0;
      font: 600 12px system-ui, -apple-system, sans-serif;
      color: #fff; background: rgba(10,10,14,0.82);
      border: 1px solid rgba(255,255,255,0.25);
      padding: 3px 8px; border-radius: 2px; white-space: nowrap;
      cursor: pointer; user-select: none;
    `;

    // A thin leader line back to the point — only shown when layoutLabels()
    // actually had to push this label away from its default resting spot
    // to keep it from overlapping a neighbor's. A 1px-tall bar rotated to
    // whatever angle actually reaches the label (it isn't always straight
    // down anymore now that above/right/left are real candidates too).
    // Purely decorative, so it stays out of the way of clicks/hover.
    const connectorEl = document.createElement('div');
    connectorEl.style.cssText = `
      position: absolute; left: 0; top: 0;
      height: 1px; background: rgba(255,255,255,0.5);
      transform-origin: 0 0; pointer-events: none;
      display: none;
    `;

    labelAnchor.appendChild(connectorEl);
    labelAnchor.appendChild(labelEl);
    pinsLayer.appendChild(pinEl);
    labelsLayer.appendChild(labelAnchor);

    const handleClick = (e: MouseEvent) => {
      e.stopPropagation();
      onSelect(marker.id);
    };
    const stopDrag = (e: MouseEvent) => e.stopPropagation();
    // Both the pin and the label are independently clickable/draggable-safe
    // now that they're no longer nested under one shared hit-target.
    pinEl.addEventListener('mousedown', stopDrag);
    pinEl.addEventListener('click', handleClick);
    labelEl.addEventListener('mousedown', stopDrag);
    labelEl.addEventListener('click', handleClick);

    // Measured once — the label's text never changes after creation, and
    // layoutLabels() needs a real pixel width (marker names vary a lot in
    // length) to know whether two labels would actually overlap.
    const labelWidth = labelEl.offsetWidth;
    const labelHeight = labelEl.offsetHeight;

    return {
      id: marker.id, pinEl, labelAnchor, labelEl, connectorEl, labelWidth, labelHeight,
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
      const display = p.visible ? 'block' : 'none';
      entry.pinEl.style.display = display;
      entry.labelAnchor.style.display = display;
      if (!p.visible) continue;

      entry.pinEl.style.left = `${p.px}px`;
      entry.pinEl.style.top = `${p.py}px`;
      entry.labelAnchor.style.left = `${p.px}px`;
      entry.labelAnchor.style.top = `${p.py}px`;

      const placement = placements.get(p.id);
      const offset = placement?.offset ?? { x: -entry.labelWidth / 2, y: 6 };
      entry.labelEl.style.transform = `translate(${offset.x}px, ${offset.y}px)`;

      // Always drawn, not just when layoutLabels() had to push the label
      // out of its default spot — a bare gap between pin and tag read as
      // the two being unrelated rather than as one marker.
      const connectorTo = placement?.connectorTo ?? { x: offset.x, y: offset.y };
      const { x: tx, y: ty } = connectorTo;
      const length = Math.hypot(tx, ty);
      const angleDeg = (Math.atan2(ty, tx) * 180) / Math.PI;
      entry.connectorEl.style.width = `${length}px`;
      entry.connectorEl.style.transform = `rotate(${angleDeg}deg)`;
      entry.connectorEl.style.display = 'block';
    }
  }

  function getScreenPoint(id: string): { x: number; y: number } | null {
    const entry = byId.get(id);
    if (!entry || entry.pinEl.style.display === 'none') return null;
    // pinEl's own box is centered on the true anchor point (translate
    // -50%,-50%), so the box's own center is exactly that point.
    const rect = entry.pinEl.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function dispose() {
    pinsLayer.remove();
    labelsLayer.remove();
  }

  return {
    update, getScreenPoint, dispose,
  };
}
