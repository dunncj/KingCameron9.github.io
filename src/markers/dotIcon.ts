// A small pixel-art dot — a plain CSS border-radius circle renders with
// smooth, anti-aliased edges, which reads as a modern UI dot dropped on
// top of the site's otherwise chunky retro look. Rasterizing a tiny bitmap
// and scaling it with `image-rendering: pixelated` (same technique this
// project uses for particle sprites — see particles/textures.ts — just
// targeting a CSS background-image instead of a THREE.Texture) gives it
// the same hard, stepped edges as everything else instead.
//
// A literal 4x4 mask, not computed circle math — a 2x2 white core with a
// 1px-deep border, corners omitted so the border reads as a diamond/plus
// ring rather than a solid square. '.' = transparent, 'r' = border,
// 'w' = core.
const DOT_MASK = [
  '.rr.',
  'rwwr',
  'rwwr',
  '.rr.',
];
const DOT_SIZE = DOT_MASK.length;

export interface DotIconOptions {
  fill?: string;
  outline?: string;
  scale?: number;
}

// Returns a data: URL — cheap to inline directly as a CSS background-image
// (no network request, no async loading state to juggle for a handful of
// fixed location markers).
export function createPixelDotIconUrl({
  fill = '#ffffff',
  outline = '#ff3b30',
  scale = 2,
}: DotIconOptions = {}): { url: string; size: number } {
  const canvas = document.createElement('canvas');
  canvas.width = DOT_SIZE;
  canvas.height = DOT_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { url: '', size: DOT_SIZE * scale };

  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < DOT_SIZE; y++) {
    const row = DOT_MASK[y]!;
    for (let x = 0; x < DOT_SIZE; x++) {
      const cell = row[x];
      if (cell === '.') continue;
      ctx.fillStyle = cell === 'r' ? outline : fill;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  return { url: canvas.toDataURL('image/png'), size: DOT_SIZE * scale };
}
