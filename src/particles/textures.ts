// Canvas-generated sprite textures shared across particle fields — pure
// factories, no state, called once at construction time by whichever field
// needs them (see rain.ts/snow.ts/windStreaks.ts).
import { CanvasTexture } from 'three';

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('particles/textures: 2D canvas context unavailable');
  return { canvas, ctx };
}

// A soft, radially-fading disc — snow's own sprite (and a reasonable default
// for any future point-sprite particle: embers, dust, pollen).
export function createSoftCircleTexture(size = 64): CanvasTexture {
  const { ctx } = makeCanvas(size, size);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(ctx.canvas);
  texture.needsUpdate = true;
  return texture;
}

// A soft, tapered elongated streak (bright center band, fading to nothing at
// both the leading/trailing ends and the top/bottom edges). Mapping this
// onto a stretched quad/line is what actually reads as a "streak" or
// "wisp" — round dots on a stretched shape still look like a row of dots,
// not a smear. Shared by rain (line-segment streaks) and wind wisps.
export function createSoftStreakTexture(width = 128, height = 32): CanvasTexture {
  const { ctx } = makeCanvas(width, height);

  const hGrad = ctx.createLinearGradient(0, 0, width, 0);
  hGrad.addColorStop(0, 'rgba(255,255,255,0)');
  hGrad.addColorStop(0.12, 'rgba(255,255,255,0.15)');
  hGrad.addColorStop(0.45, 'rgba(255,255,255,1)');
  hGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hGrad;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = 'destination-in';
  const vGrad = ctx.createLinearGradient(0, 0, 0, height);
  vGrad.addColorStop(0, 'rgba(255,255,255,0)');
  vGrad.addColorStop(0.5, 'rgba(255,255,255,1)');
  vGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = vGrad;
  ctx.fillRect(0, 0, width, height);

  const texture = new CanvasTexture(ctx.canvas);
  texture.needsUpdate = true;
  return texture;
}
