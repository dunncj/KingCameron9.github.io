// A blocky, hand-authored pixel-art map pin — the overview's markers are
// plain HTML overlaid on the canvas (see service.ts's own comment on why),
// so unlike the 3D scene they never pass through RenderPixelatedPass and
// read as smooth/modern by default. Rasterizing a tiny bitmap and scaling
// it up with `image-rendering: pixelated` (same technique this project
// already uses for particle sprites — see particles/textures.ts — just
// targeting a CSS background-image instead of a THREE.Texture) makes them
// visually belong with the chunky retro look everything behind them has.
//
// The silhouette is computed from actual circle math (a hand-drawn ASCII
// mask was tried first and, despite looking reasonable row-by-row, came out
// as a jagged diamond once rendered — eyeballing per-row pixel widths isn't
// a reliable way to author something that's supposed to read as round).
// Per row y, half-width(y) is the true distance-formula half-width of a
// circle of radius PIN_RADIUS for the head, smoothly continued into a
// short linear taper to a single point for the tail — see buildRowHalfWidths.
const PIN_RADIUS = 8;
const HOLE_RADIUS = 4;
const TAIL_LENGTH = 6;
// Circle rows this coarse close to a point at the very top anyway (their
// natural half-width is under a pixel) — flattening them to a flat cap
// avoids a single stray spike pixel poking out above the dome.
const MIN_CAP_WIDTH = 3;
const OUTLINE_THICKNESS = 1;

const PIN_WIDTH = PIN_RADIUS * 2 + 1;
const PIN_HEIGHT = PIN_RADIUS * 2 + 1 + TAIL_LENGTH;

function buildRowHalfWidths(): number[] {
  const cy = PIN_RADIUS;
  // The taper starts a couple of rows before the circle would fully close
  // on its own and picks up from whatever half-width the circle had there
  // — matching that starting width, rather than resetting to some fixed
  // value, is what keeps the head and tail reading as one continuous
  // silhouette instead of a circle with a disconnected stick glued below it.
  const taperStartRow = PIN_RADIUS * 2 - 2;
  const taperStartDy = taperStartRow - cy;
  const taperStartWidth = Math.sqrt(Math.max(0, PIN_RADIUS * PIN_RADIUS - taperStartDy * taperStartDy));

  const widths: number[] = [];
  for (let y = 0; y < PIN_HEIGHT; y++) {
    const dy = y - cy;
    if (y <= taperStartRow) {
      let halfWidth = Math.sqrt(Math.max(0, PIN_RADIUS * PIN_RADIUS - dy * dy));
      if (y <= cy) halfWidth = Math.max(halfWidth, MIN_CAP_WIDTH);
      widths.push(halfWidth);
    } else {
      const t = (y - taperStartRow) / (TAIL_LENGTH + 2);
      widths.push(taperStartWidth * (1 - t));
    }
  }
  return widths;
}

export interface PinIconOptions {
  fill?: string;
  outline?: string;
  scale?: number;
}

// Returns a data: URL — cheap to inline directly as a CSS background-image
// (no network request, no async loading state to juggle for a handful of
// fixed location markers).
export function createPixelPinIconUrl({
  fill = '#ff5a3c',
  outline = '#ffffff',
  scale = 1,
}: PinIconOptions = {}): { url: string; width: number; height: number } {
  const canvas = document.createElement('canvas');
  canvas.width = PIN_WIDTH;
  canvas.height = PIN_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { url: '', width: PIN_WIDTH * scale, height: PIN_HEIGHT * scale };

  ctx.imageSmoothingEnabled = false;
  const cx = PIN_RADIUS;
  const cy = PIN_RADIUS;
  const rowHalfWidths = buildRowHalfWidths();

  for (let y = 0; y < PIN_HEIGHT; y++) {
    const halfWidth = rowHalfWidths[y]!;
    const dy = y - cy;
    for (let x = 0; x < PIN_WIDTH; x++) {
      const dx = x - cx;
      if (Math.abs(dx) > halfWidth) continue;
      // The hole is squashed slightly on its vertical axis below center —
      // a true circle there reads as sitting too high once the tail pulls
      // the eye down, since the tail has no matching width above it.
      const holeDy = dy > 0 ? dy * 0.9 : dy;
      const inHole = dx * dx + holeDy * holeDy <= HOLE_RADIUS * HOLE_RADIUS;
      const inOutline = !inHole && Math.abs(dx) > halfWidth - OUTLINE_THICKNESS;
      ctx.fillStyle = inHole || inOutline ? outline : fill;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  return { url: canvas.toDataURL('image/png'), width: PIN_WIDTH * scale, height: PIN_HEIGHT * scale };
}
