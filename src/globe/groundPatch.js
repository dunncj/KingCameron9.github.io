// Builds a curved grid draped over the real sphere, covering the same
// lat/lon bounding box a fetched Static Maps image covers, with UV
// coordinates matching that box linearly in Mercator space (u: west→east
// 0→1, v: south→north 0→1) — the same effective mapping a flat Mercator
// tile plane would use, just with each vertex placed on the globe instead
// of a flat rectangle. Over a large box (very low zoom) this inherits some
// of Mercator's own distortion rather than true equal-area geodesic tiling
// — an accepted simplification for now. Shared by usMap.js's own per-view
// dynamic grid and destination prefetch, and by globeBase.js's persistent
// whole-globe-entry/US-region layers — the only reason this is its own
// module rather than living in either one of them.
import { BufferGeometry, BufferAttribute } from 'three';
import {
  worldX, worldY, xToLng, yToLat, sphereXYZ, EARTH_RADIUS_SCENE,
} from './mercatorMath';
import { REQUEST_SIZE } from './provider';

const PATCH_SEGMENTS = 16; // ground patch grid resolution per axis

export function buildGroundPatch(lat, lon, z, radius = EARTH_RADIUS_SCENE) {
  const centerWorldX = worldX(lon);
  const centerWorldY = worldY(lat);
  const half = REQUEST_SIZE / 2 / 2 ** z;
  const westWorldX = centerWorldX - half;
  const eastWorldX = centerWorldX + half;
  const northWorldY = centerWorldY - half;
  const southWorldY = centerWorldY + half;

  const n = PATCH_SEGMENTS;
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  const uvs = new Float32Array((n + 1) * (n + 1) * 2);
  let p = 0;
  let t = 0;
  for (let j = 0; j <= n; j++) {
    const v = j / n;
    const worldYv = northWorldY + (1 - v) * (southWorldY - northWorldY);
    const latV = yToLat(worldYv);
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const worldXu = westWorldX + u * (eastWorldX - westWorldX);
      const lonU = xToLng(worldXu);
      const pos = sphereXYZ(latV, lonU, radius);
      positions[p++] = pos.x;
      positions[p++] = pos.y;
      positions[p++] = pos.z;
      uvs[t++] = u;
      uvs[t++] = v;
    }
  }
  const indices = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('uv', new BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}
