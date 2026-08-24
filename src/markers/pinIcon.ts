// A blocky, hand-authored pixel-art map pin — the overview's markers are
// plain HTML overlaid on the canvas (see service.ts's own comment on why),
// so unlike the 3D scene they never pass through RenderPixelatedPass and
// read as smooth/modern by default. Rasterizing a tiny bitmap and scaling
// it up with `image-rendering: pixelated` (same technique this project
// already uses for particle sprites — see particles/textures.ts — just
// targeting a CSS background-image instead of a THREE.Texture) makes them
// visually belong with the chunky retro look everything behind them has.
//
// Authored as a coordinate list, not nested loops shaping a circle — at
// this size (10x12) a real map-pin silhouette (rounded head, pointed foot)
// needs asymmetric, hand-placed pixels a formula won't produce cleanly.
const PIN_WIDTH = 10;
const PIN_HEIGHT = 12;
// Row-by-row fill mask, top to bottom — one string per row, one character
// per pixel column. '.' = transparent, 'o' = outline, 'f' = fill.
const PIN_MASK = [
  '..oooooo..',
  '.offffffo.',
  'offffffffo',
  'offffffffo',
  'offffffffo',
  'offffffffo',
  '.offffffo.',
  '..oofoo...',
  '...offo...',
  '....of....',
  '....of....',
  '.....o....',
];

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
  scale = 3,
}: PinIconOptions = {}): { url: string; width: number; height: number } {
  const canvas = document.createElement('canvas');
  canvas.width = PIN_WIDTH;
  canvas.height = PIN_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { url: '', width: PIN_WIDTH * scale, height: PIN_HEIGHT * scale };

  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < PIN_MASK.length; y++) {
    const row = PIN_MASK[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      const cell = row[x];
      if (cell === '.') continue;
      ctx.fillStyle = cell === 'o' ? outline : fill;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  return { url: canvas.toDataURL('image/png'), width: PIN_WIDTH * scale, height: PIN_HEIGHT * scale };
}
