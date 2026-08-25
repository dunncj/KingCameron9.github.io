import { createPixelDotIconUrl } from './dotIcon';
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

// Plain HTML dots + tags layered over the canvas, not WebGL geometry —
// stay crisp regardless of the pixelation shader and get click handling
// for free (see usMap.js's own original comment, preserved here since it's
// still exactly why this overlay exists). A pixel-art pin icon (rounded
// head, punched-out hole, tapered tail) was tried here and repeatedly
// rendered wrong at this size — a plain white-fill/accent-outline dot is
// simple enough that there's no shape left to get wrong. It's a rasterized
// bitmap (see dotIcon.ts), not a CSS border-radius circle — a CSS circle
// renders smooth/anti-aliased, which reads as a modern dot dropped onto
// the site's otherwise chunky pixel-art look instead of belonging with it.
const LABEL_BG = 'rgba(10,10,14,0.82)';
const LABEL_BG_HOVER = 'rgba(24,24,30,0.95)';
const LABEL_BORDER = 'rgba(255,255,255,0.25)';
const LABEL_BORDER_HOVER = 'rgba(255,255,255,0.7)';
const CONNECTOR_COLOR = 'rgba(255,255,255,0.5)';
const CONNECTOR_COLOR_HOVER = 'rgba(255,255,255,0.95)';
const DOT_OUTLINE_HOVER = '#ffb347';

export function createMarkerOverlay(
  container: HTMLElement,
  markers: MarkerDescriptor[],
  onSelect: (id: string) => void,
): MarkerOverlay {
  const dot = createPixelDotIconUrl();
  // A second bitmap, not a CSS filter — swapping to a differently-colored
  // baked pixel-art image keeps the exact same crisp, hard-edged look on
  // hover; a filter (brightness/saturate) would soften those edges.
  const dotHover = createPixelDotIconUrl({ outline: DOT_OUTLINE_HOVER });

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
      width: ${dot.size}px; height: ${dot.size}px;
      background-image: url(${dot.url});
      background-size: 100% 100%;
      image-rendering: pixelated;
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
      color: #fff; background: ${LABEL_BG};
      border: 1px solid ${LABEL_BORDER};
      padding: 3px 8px; border-radius: 2px; white-space: nowrap;
      cursor: pointer; user-select: none;
      transition: background-color 0.12s ease, border-color 0.12s ease;
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
      height: 1px; background: ${CONNECTOR_COLOR};
      transform-origin: 0 0; pointer-events: none;
      display: none;
      transition: background-color 0.12s ease;
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

    // Hovering either half highlights both — they read as one marker, so
    // the reaction shouldn't depend on which part the cursor happens to be
    // over. The dot swaps to a brighter-outlined bitmap (no resizing — it
    // scaled up in an earlier pass and didn't read well). The label's
    // border/background brighten too, but font-weight stays fixed: toggling
    // it changes the text's rendered width, which resized the label's box
    // on every hover and read as a jitter rather than a highlight.
    const setHovered = (hovered: boolean) => {
      pinEl.style.backgroundImage = `url(${hovered ? dotHover.url : dot.url})`;
      labelEl.style.backgroundColor = hovered ? LABEL_BG_HOVER : LABEL_BG;
      labelEl.style.borderColor = hovered ? LABEL_BORDER_HOVER : LABEL_BORDER;
      connectorEl.style.backgroundColor = hovered ? CONNECTOR_COLOR_HOVER : CONNECTOR_COLOR;
    };
    pinEl.addEventListener('mouseenter', () => setHovered(true));
    pinEl.addEventListener('mouseleave', () => setHovered(false));
    labelEl.addEventListener('mouseenter', () => setHovered(true));
    labelEl.addEventListener('mouseleave', () => setHovered(false));

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
