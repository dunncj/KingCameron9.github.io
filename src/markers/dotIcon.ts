// A small pixel-art dot — a plain CSS border-radius circle renders with
// smooth, anti-aliased edges, which reads as a modern UI dot dropped on
// top of the site's otherwise chunky retro look. Rasterizing a tiny bitmap
// and scaling it with `image-rendering: pixelated` (same technique this
// project uses for particle sprites — see particles/textures.ts — just
// targeting a CSS background-image instead of a THREE.Texture) gives it
// the same hard, stepped edges as everything else instead.
//
// Computed from real circle distance math, not hand-placed pixels — a
// hand-authored pin shape tried earlier looked reasonable row-by-row but
// rendered as a jagged diamond once drawn, so per-row pixel guessing isn't
// trustworthy even for a shape this simple.
const DOT_RADIUS = 4;
const OUTLINE_THICKNESS = 1;
const DOT_SIZE = DOT_RADIUS * 2 + 1;

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
  outline = '#ff5a3c',
  scale = 1,
}: DotIconOptions = {}): { url: string; size: number } {
  const canvas = document.createElement('canvas');
  canvas.width = DOT_SIZE;
  canvas.height = DOT_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { url: '', size: DOT_SIZE * scale };

  ctx.imageSmoothingEnabled = false;
  const c = DOT_RADIUS;
  for (let y = 0; y < DOT_SIZE; y++) {
    const dy = y - c;
    for (let x = 0; x < DOT_SIZE; x++) {
      const dx = x - c;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > DOT_RADIUS) continue;
      ctx.fillStyle = dist > DOT_RADIUS - OUTLINE_THICKNESS ? outline : fill;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  return { url: canvas.toDataURL('image/png'), size: DOT_SIZE * scale };
}
