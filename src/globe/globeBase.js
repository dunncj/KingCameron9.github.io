// --- Persistent globe base (base globe + whole-globe-entry imagery) ------
// This content is identical every time regardless of which location the
// overview is centered on, so it's module-level state — fetched once for
// the app's whole lifetime, not per overview mount. It used to live inside
// mountUSOverview (usMap.js) and get fully torn down in dispose() like
// everything else there, which was the actual cause of "tiles blank out and
// reload" on zoom-out (startZoomOutToOverview): the same handful of always-
// identical requests, re-fetched from nothing, every single time the
// overview was re-entered — including right as flyOut's own zoom-out
// animation needed them on screen. Built lazily on first mount (see
// ensureGlobeBase), then just shown/hidden (never disposed) on every
// mount/dispose after that.
import {
  MeshBasicMaterial, Mesh, Texture, SRGBColorSpace, Line, LineBasicMaterial,
  BufferGeometry, BufferAttribute,
} from 'three';
import { US_CANADA_BORDER_SEGMENTS, US_MEXICO_BORDER_SEGMENTS } from '../usBorders';
import {
  TILE_SIZE, US_FRAME_BOUNDS, EARTH_RADIUS_SCENE,
  worldX, worldY, xToLng, yToLat, wrapLon, sphereXYZ,
} from './mercatorMath';
import { activeProvider, REQUEST_SIZE, REQUEST_SCALE } from './provider';
import { applyGlobeShading } from './shading';
import { buildGroundPatch } from './groundPatch';

const WORLD_IMG_CONTENT_FRAC = 0.8;
const WORLD_IMG_PAD = (1 - WORLD_IMG_CONTENT_FRAC) / 2;
const BASE_GLOBE_LAT_LIMIT = 85; // just inside the ±85.05° Mercator cutoff
const BASE_GLOBE_SEGMENTS_LON = 64;
const BASE_GLOBE_SEGMENTS_LAT = 32;
// All three ground layers (base globe, whole-globe entry detail, dynamic
// close-up grid) — and the location markers — sit at the exact same radius.
// They used to be nudged to slightly different radii (0.998/0.999/1.0) to
// dodge z-fighting, but a marker is placed once, at ONE fixed radius,
// independent of which layer happens to be showing underneath it — any gap
// between that radius and the visible layer's own is a real parallax error,
// tiny when looking straight down at it but growing rapidly toward the
// limb/zoomed-out views where the sphere is seen edge-on (a small radial
// offset shifts a lot along a nearly-tangent line of sight). Z-fighting
// between layers is handled instead via polygonOffset on their materials
// (see applyGlobeShading's callers), which biases the *depth test*, not the
// actual geometry, so this radius can stay exact for every layer.
const BASE_GLOBE_RADIUS = EARTH_RADIUS_SCENE;
const WHOLE_GLOBE_ENTRY_RADIUS = EARTH_RADIUS_SCENE;

// The always-present base globe's geometry — same idea as buildGroundPatch
// but spanning the whole sphere, and cropping the fetched whole-world
// image's UV back to the single non-repeated/non-padded copy (see
// WORLD_IMG_CONTENT_FRAC's comment).
function buildFullGlobeGeometry() {
  const lonSegs = BASE_GLOBE_SEGMENTS_LON;
  const latSegs = BASE_GLOBE_SEGMENTS_LAT;
  const positions = new Float32Array((lonSegs + 1) * (latSegs + 1) * 3);
  const uvs = new Float32Array((lonSegs + 1) * (latSegs + 1) * 2);
  let p = 0;
  let t = 0;
  for (let j = 0; j <= latSegs; j++) {
    const v = j / latSegs; // 0 (north) -> 1 (south)
    const lat = BASE_GLOBE_LAT_LIMIT - v * 2 * BASE_GLOBE_LAT_LIMIT;
    const texV = 1 - (WORLD_IMG_PAD + WORLD_IMG_CONTENT_FRAC * worldY(lat));
    for (let i = 0; i <= lonSegs; i++) {
      const u = i / lonSegs; // 0 -> 1 maps -180 -> 180
      const lon = -180 + u * 360;
      const texU = WORLD_IMG_PAD + WORLD_IMG_CONTENT_FRAC * u;
      const pos = sphereXYZ(lat, lon, BASE_GLOBE_RADIUS);
      positions[p++] = pos.x;
      positions[p++] = pos.y;
      positions[p++] = pos.z;
      uvs[t++] = texU;
      uvs[t++] = texV;
    }
  }
  const indices = [];
  for (let j = 0; j < latSegs; j++) {
    for (let i = 0; i < lonSegs; i++) {
      const a = j * (lonSegs + 1) + i;
      const b = a + 1;
      const c = a + (lonSegs + 1);
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

// A small, standalone polar-cap patch — deliberately separate from the base
// globe mesh above rather than a fix to it. That mesh spans the whole
// sphere and (per its own comment) is meant to always lose the depth test
// to the finer layers via polygonOffset; an earlier attempt to also make it
// reach the true poles required flipping its triangle winding so it would
// render there at all, which made the *entire* sphere start rendering (not
// just the poles) — and its polygonOffset didn't reliably lose to the
// finer layers everywhere, producing visible artifacts (blobs, a swirl at
// the pole) across the whole globe instead of just filling the small polar
// gap. This patch avoids that blast radius entirely: it's built at a
// slightly SMALLER radius than every other ground layer, so it loses via
// real geometric distance, not a depth-bias heuristic, and it only exists
// in a small band near each pole — nowhere else to go wrong.
// Deliberately NOT tightened to loadPolarRings' own ~84.7-85.0° reach:
// this disc is the fallback for the *whole* ring band, not just the
// genuinely-unreachable sliver above it. loadPolarRings' several levels
// tile close to flush against each other and against
// loadWholeGlobeAtEntryDetail's own edge (see safeEdgeRow), but aren't
// guaranteed gap-free, and Google's own complete fallback sphere
// (buildFullGlobeGeometry) — which used to quietly mask any such gap with
// at least a coarse, reasonably-colored image — doesn't exist at all for
// a provider without supportsWholeWorldImage (Esri: confirmed live, a
// real gap between ring levels rendered as a stark black ring with
// nothing behind it to fall through to). 80 comfortably undercuts
// loadWholeGlobeAtEntryDetail's own single-row reach at any zoom this app
// actually uses, so this disc reliably sits behind the entire ring band
// as a real safety net — invisible wherever a ring loads over it, only
// ever showing (now correctly colored and lit, see POLAR_RING_MIN_LIGHT)
// on whatever gap one leaves.
const POLAR_CAP_LAT = 80;
const POLAR_CAP_RADIUS = EARTH_RADIUS_SCENE * 0.9998;
// Starting guess only — loadPolarRings' onColorSample recolors each
// hemisphere's cap from the real imagery its own rings just fetched right
// next to it (open ocean, sea ice, the Antarctic ice sheet — whatever's
// actually there) the moment those tiles load, same technique as
// sampleAverageColor's own comment describes. This fixed icy off-white is
// only ever seen for the brief moment before that first sample arrives.
const POLAR_CAP_COLOR = 0xeef4f8;

function buildPolarCapGeometry(loLat, hiLat) {
  const segs = 16;
  const lonSegs = 32;
  const positions = new Float32Array((lonSegs + 1) * (segs + 1) * 3);
  let p = 0;
  for (let j = 0; j <= segs; j++) {
    const v = j / segs;
    const lat = loLat + v * (hiLat - loLat); // increasing with j, matching buildGroundPatch's proven-correct winding
    for (let i = 0; i <= lonSegs; i++) {
      const u = i / lonSegs;
      const lon = -180 + u * 360;
      const pos = sphereXYZ(lat, lon, POLAR_CAP_RADIUS);
      positions[p++] = pos.x;
      positions[p++] = pos.y;
      positions[p++] = pos.z;
    }
  }
  const indices = [];
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < lonSegs; i++) {
      const a = j * (lonSegs + 1) + i;
      const b = a + 1;
      const c = a + (lonSegs + 1);
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

// Incremental average: each new sample nudges the cap's color a little
// rather than snapping straight to it, so one unusually bright/dark tile
// (a cloud, a shadow) among many can't single-handedly yank the whole cap
// off — converges within a handful of samples, which loadPolarRings
// supplies plenty of (nCellsLon per ring level, three levels).
function nudgeCapColor(mesh, sample, sampleCount) {
  const t = 1 / sampleCount;
  const c = mesh.material.color;
  c.r += (sample.r / 255 - c.r) * t;
  c.g += (sample.g / 255 - c.g) * t;
  c.b += (sample.b / 255 - c.b) * t;
}

function buildPolarCaps(scene) {
  const meshes = [];
  const sampleCounts = [0, 0]; // parallel to meshes: [north, south]
  for (const [lo, hi] of [[POLAR_CAP_LAT, 90], [-90, -POLAR_CAP_LAT]]) {
    const geometry = buildPolarCapGeometry(lo, hi);
    const material = new MeshBasicMaterial({ color: POLAR_CAP_COLOR, toneMapped: false });
    // Same brighter floor as loadPolarRings' own POLAR_RING_MIN_LIGHT (see
    // its comment) — this cap sits in the exact same region, so it's
    // subject to the exact same near-black-crush risk on a dark sample.
    applyGlobeShading(material, POLAR_RING_MIN_LIGHT);
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    meshes.push(mesh);
  }
  // meshes[0] is north ([POLAR_CAP_LAT, 90]), meshes[1] is south — matches
  // loadPolarRings' own poleSign convention (1 = north, -1 = south).
  const onColorSample = (poleSign, sample) => {
    const idx = poleSign > 0 ? 0 : 1;
    sampleCounts[idx] += 1;
    nudgeCapColor(meshes[idx], sample, sampleCounts[idx]);
  };
  return { meshes, onColorSample };
}

// The US borders (Canada and Mexico), draped directly onto the globe as
// real geometry — each point is a genuine (lat, lon) from Natural Earth's
// public-domain admin-0 boundary-lines dataset (see usBorders.js), not a
// screen-space post-processing effect. A post-process edge-detection pass
// would need to find the border in the *imagery* itself (which doesn't
// actually draw a political line) or maintain its own separate mask
// texture kept in sync with the imagery's own projection/zoom — genuine
// surface geometry avoids both problems for free, and reuses sphereXYZ,
// the same projection every other globe layer already trusts. One `Line`
// per disconnected coordinate strip (the Canada dataset itself has a real
// gap where the border runs through open water, not land — see
// usBorders.js's own comment) — joining them would draw a spurious
// straight line across that gap.
const BORDER_COLOR = 0xd8dde3; // pale white/gray — a subtle reference line, not a bold graphic
const BORDER_OPACITY = 0.35;
function buildBorderLines(scene) {
  const lines = [];
  for (const segment of [...US_CANADA_BORDER_SEGMENTS, ...US_MEXICO_BORDER_SEGMENTS]) {
    const positions = new Float32Array(segment.length * 3);
    let p = 0;
    for (const [lat, lon] of segment) {
      const pos = sphereXYZ(lat, lon, EARTH_RADIUS_SCENE);
      positions[p++] = pos.x;
      positions[p++] = pos.y;
      positions[p++] = pos.z;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    // Negative polygonOffset pulls this toward the camera in the depth
    // test — the same trick the ground layers below use in the opposite
    // (positive) direction to make coarser layers lose to finer ones (see
    // fetchWholeGlobeCell's and fetchBaseGlobe's own comments) — so the
    // border reliably wins against all of them at the same real radius,
    // without needing its own separate radius gap to stay stable at the
    // extreme near-plane precision deep zoom already pushes to its limit
    // (see usMap.js's applyCamera's own comment on that).
    const material = new LineBasicMaterial({
      color: BORDER_COLOR, transparent: true, opacity: BORDER_OPACITY, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const line = new Line(geometry, material);
    scene.add(line);
    lines.push(line);
  }
  return lines;
}

let globeBase = null; // { baseGlobeMesh: Mesh|null, wholeGlobeCache: Map, wholeGlobeZ: number } | null until first mount

// offset, onImage, and minLight (defaults: 1, undefined, 0.38 — all
// loadWholeGlobeAtEntryDetail's own untouched behavior) exist only for
// loadPolarRings below — see its own comment for why a per-call
// polygonOffset, a raw-pixel hook, and a brighter shading floor are all
// needed there.
function fetchWholeGlobeCell(scene, apiKey, z, ix, iy, cellSize, key, cache, offset = 1, onImage, minLight = 0.38) {
  if (activeProvider.requiresApiKey && !apiKey) return;
  cache.set(key, { mesh: null });
  // +0.5: cell (ix, iy) spans [ix, ix+1) * cellSize in zoom-0 world-space,
  // so this is that cell's true center, not its edge — matters for more
  // than just correctness of where the fetched image lands: it's what
  // makes ix/iy line up exactly with a standard XYZ tile provider's own
  // tile numbering whenever cellSize matches that provider's native tile
  // size (see mapProviders.js's own top comment). Harmless for Google,
  // which only wants a center point and doesn't care what grid it's on.
  // wrapLon: this loop's own final ix can still land past 180° — see
  // wrapLon's own comment on why.
  const lon = wrapLon(xToLng((ix + 0.5) * cellSize));
  const lat = yToLat((iy + 0.5) * cellSize);
  const url = activeProvider.buildTileUrl({
    lat, lon, z, ix, iy, apiKey,
  });
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (!cache.has(key)) return; // superseded before it arrived (shouldn't happen — this cache is never cleared — but matches the same defensive pattern everywhere else)
    const texture = new Texture(img);
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    const geometry = buildGroundPatch(lat, lon, z, WHOLE_GLOBE_ENTRY_RADIUS);
    // polygonOffset biases the depth *test*, not the actual geometry, so
    // this coplanar-with-the-dynamic-grid layer still reliably loses to it
    // wherever both exist, without needing a real radius gap (see the
    // comment on WHOLE_GLOBE_ENTRY_RADIUS for why that gap was a bug).
    const material = new MeshBasicMaterial({
      map: texture, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset,
    });
    applyGlobeShading(material, minLight);
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    cache.set(key, { mesh });
    onImage?.(img);
  };
  img.onerror = () => {
    console.error('US overview: whole-globe tile failed to load (check API key / Static Maps API enablement)');
    cache.delete(key);
  };
  img.src = url;
}

function loadWholeGlobeAtEntryDetail(scene, apiKey, z, cache) {
  const cellSize = REQUEST_SIZE / 2 ** z;
  // ceil (not round) + iterating ix directly (rather than picking evenly
  // spaced lon samples and rounding each to its nearest ix) guarantees
  // every ix bin from 0 up gets covered with no skips — round() previously
  // under-counted whenever TILE_SIZE/cellSize wasn't a whole number,
  // silently dropping the antimeridian-centered cell (ix=0) and leaving a
  // ~112° gap there whose eastern edge happened to fall right at the
  // California coastline.
  const nCellsLon = Math.max(1, Math.ceil(TILE_SIZE / cellSize));
  // Each cell's Static Maps request is centered on iy*cellSize (see
  // fetchWholeGlobeCell), covering iy*cellSize ± cellSize/2 — so the naive
  // floor/ceil here can land iy on the cell straddling the true ±85.0511°
  // Mercator edge (worldY 0/TILE_SIZE): Google has no imagery past that
  // edge and renders it solid black, so half of that cell's fetched image
  // is a black band, stretched by buildGroundPatch's Mercator-correct (and
  // much taller in real degrees near the pole) vertex placement into a
  // large black polar cap — the actual pole "hole". Requiring the cell's
  // far edge to stay inside [0, TILE_SIZE] excludes any cell that would
  // pull in that black band; the base globe (a complete, if coarser,
  // sphere all the way to the true poles — see buildFullGlobeGeometry) is
  // the fallback for the small remaining polar gap this leaves.
  const halfCell = cellSize / 2;
  let iyMin = Math.floor(worldY(BASE_GLOBE_LAT_LIMIT) / cellSize);
  if (iyMin * cellSize - halfCell < 0) iyMin += 1;
  let iyMax = Math.ceil(worldY(-BASE_GLOBE_LAT_LIMIT) / cellSize);
  if (iyMax * cellSize + halfCell > TILE_SIZE) iyMax -= 1;
  for (let iy = iyMin; iy <= iyMax; iy++) {
    for (let ix = 0; ix < nCellsLon; ix++) {
      const key = `${ix}_${iy}`;
      if (!cache.has(key)) fetchWholeGlobeCell(scene, apiKey, z, ix, iy, cellSize, key, cache);
    }
  }
}

// Real per-cell imagery can never reach the true pole — Mercator's own y
// coordinate genuinely runs to infinity there, not a fetching choice (see
// loadWholeGlobeAtEntryDetail's own comment) — but it CAN get much closer
// to the ±85.0511° edge than that function's single, fairly coarse zoom
// does, simply by using smaller cells there. This finds, at a given
// cellSize, the row nearest each pole whose fetched *center* (not just its
// footprint) still stays within ±BASE_GLOBE_LAT_LIMIT — solved directly
// against the same value fetchWholeGlobeCell hands Google/Esri, rather
// than reasoning about a cell's footprint edges the way
// loadWholeGlobeAtEntryDetail's iyMin/iyMax do, because an out-of-range
// value handed to a provider doesn't error, it silently resolves to
// something else entirely (confirmed via wrapLon's own fix for the exact
// same failure mode on the longitude axis — see its comment). A plain
// linear search: nRows never exceeds a few hundred at the zooms
// loadPolarRings actually uses, so this costs nothing.
function safeEdgeRow(cellSize, poleSign) {
  const nRows = TILE_SIZE / cellSize;
  if (poleSign > 0) {
    for (let iy = 0; iy < nRows; iy++) {
      if (yToLat((iy + 0.5) * cellSize) <= BASE_GLOBE_LAT_LIMIT) return iy;
    }
  } else {
    for (let iy = Math.floor(nRows) - 1; iy >= 0; iy--) {
      if (yToLat((iy + 0.5) * cellSize) >= -BASE_GLOBE_LAT_LIMIT) return iy;
    }
  }
  return null;
}

// Downsamples a loaded tile image to a single average color via a 1x1
// canvas draw (cheap: the browser's own image scaling does the averaging,
// no manual pixel loop) — used to color buildPolarCaps' small remaining
// flat disc from whatever loadPolarRings actually found up there (open
// ocean, sea ice, Antarctic ice sheet) instead of a fixed guess.
function sampleAverageColor(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b };
}

// Three more, still finer imagery layers hugging each pole, each reaching
// closer to ±85.0511° than the last (see safeEdgeRow) — layered on top of
// loadWholeGlobeAtEntryDetail's own layer with progressively smaller
// polygonOffset so the finest ring always wins the depth test in whatever
// each ring overlaps (adjacent rings mostly tile flush by construction —
// see safeEdgeRow — but aren't guaranteed to; overlap here is harmless,
// a gap is not, which is why buildPolarCaps' own disc still sits behind
// all of this as the fallback for both). onColorSample feeds
// sampleAverageColor's output for every loaded ring tile back to the
// caller, which is how buildPolarCaps' own flat remainder ends up colored
// from whatever's actually up there instead of a fixed guess.
//
// POLAR_RING_MIN_LIGHT (well above applyGlobeShading's normal 0.38
// default): found live, not guessed — a top-down view of the Arctic ring
// showed a stark black band where real (correctly-fetched, verified via
// its own network request) dark-navy ocean imagery should have been.
// Real polar water/ice is legitimately dark in places, and stacks with
// this provider's own colorGrade (also a darkening correction for Esri —
// see mapProviders.js) — compounded with the normal 0.38 unlit-hemisphere
// floor, that crushed real imagery to near-black, visually indistinguishable
// from a rendering gap. A brighter floor here only matters where content is
// already dark; it's invisible everywhere content is mid-to-bright already.
const POLAR_RING_LEVELS = 3;
const POLAR_RING_MIN_LIGHT = 0.8;

function loadPolarRings(scene, apiKey, baseZ, cache, onColorSample) {
  for (let level = 1; level <= POLAR_RING_LEVELS; level++) {
    const z = baseZ + level;
    const cellSize = REQUEST_SIZE / 2 ** z;
    const nCellsLon = Math.max(1, Math.ceil(TILE_SIZE / cellSize));
    const offset = 1 - level * 0.1; // finer ring = smaller offset = wins ties against coarser layers
    for (const poleSign of [1, -1]) {
      const iy = safeEdgeRow(cellSize, poleSign);
      if (iy === null) continue;
      for (let ix = 0; ix < nCellsLon; ix++) {
        const key = `${z}_${ix}_${iy}`; // z-qualified: distinct ring levels' (ix, iy) values otherwise collide
        if (!cache.has(key)) {
          fetchWholeGlobeCell(scene, apiKey, z, ix, iy, cellSize, key, cache, offset, (img) => {
            onColorSample(poleSign, sampleAverageColor(img));
          }, POLAR_RING_MIN_LIGHT);
        }
      }
    }
  }
}

// A second, finer whole-globe-entry layer, US-only — same idea as
// fetchWholeGlobeCell/loadWholeGlobeAtEntryDetail above, but bounded to
// US_FRAME_BOUNDS and fetched at tilesParams.wholeGlobeLodBoost sharper
// (see its own settings.toml comment). Layered on top of the regular
// whole-globe layer (polygonOffset between it and the live per-frame
// grid) rather than replacing it there — everywhere outside the US still
// only needs the coarser layer, so this only pays the sharper layer's
// real cost (more, smaller tiles) where it's actually visible.
function fetchUSRegionCell(scene, apiKey, z, ix, iy, cellSize, key, cache) {
  if (activeProvider.requiresApiKey && !apiKey) return;
  cache.set(key, { mesh: null });
  // wrapLon: never actually triggers within US_FRAME_BOUNDS, applied for
  // the same reason as fetchWholeGlobeCell's identical loop shape.
  const lon = wrapLon(xToLng((ix + 0.5) * cellSize));
  const lat = yToLat((iy + 0.5) * cellSize);
  const url = activeProvider.buildTileUrl({
    lat, lon, z, ix, iy, apiKey,
  });
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (!cache.has(key)) return;
    const texture = new Texture(img);
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    const geometry = buildGroundPatch(lat, lon, z, WHOLE_GLOBE_ENTRY_RADIUS);
    // Between the regular whole-globe layer (offset 1, loses to this) and
    // the live per-frame grid (offset 0/none, still wins over this once it
    // arrives) — see this function's own comment on why this exists as a
    // separate layer rather than replacing the coarser one everywhere.
    const material = new MeshBasicMaterial({
      map: texture, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: 0.5, polygonOffsetUnits: 0.5,
    });
    applyGlobeShading(material);
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    cache.set(key, { mesh });
  };
  img.onerror = () => {
    console.error('US overview: US-region tile failed to load (check API key / Static Maps API enablement)');
    cache.delete(key);
  };
  img.src = url;
}

function loadUSRegionAtBoostedDetail(scene, apiKey, z, cache) {
  const cellSize = REQUEST_SIZE / 2 ** z;
  const ixMin = Math.floor(worldX(US_FRAME_BOUNDS.west) / cellSize);
  const ixMax = Math.ceil(worldX(US_FRAME_BOUNDS.east) / cellSize);
  const iyMin = Math.floor(worldY(US_FRAME_BOUNDS.north) / cellSize);
  const iyMax = Math.ceil(worldY(US_FRAME_BOUNDS.south) / cellSize);
  for (let iy = iyMin; iy <= iyMax; iy++) {
    for (let ix = ixMin; ix <= ixMax; ix++) {
      const key = `${ix}_${iy}`;
      if (!cache.has(key)) fetchUSRegionCell(scene, apiKey, z, ix, iy, cellSize, key, cache);
    }
  }
}

function fetchBaseGlobe(scene, apiKey, onLoaded) {
  // Google-only: this asks for the *entire* equirectangular world in one
  // request, a shape only Google's flexible arbitrary-size API supports —
  // a fixed-tile provider like Esri has no single-request equivalent (its
  // own zoom-1 tile is one quarter of the world, not the whole thing), and
  // this is only ever the deepest, briefly-visible fallback underneath the
  // real per-cell imagery (loadWholeGlobeAtEntryDetail/
  // loadUSRegionAtBoostedDetail) — losing it for another provider means a
  // moment of black instead of a coarse placeholder while those load, not
  // a permanent gap once they have.
  if (!activeProvider.supportsWholeWorldImage || !apiKey) return;
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=0,0&zoom=1&size=${REQUEST_SIZE}x${REQUEST_SIZE}&scale=${REQUEST_SCALE}&maptype=satellite&key=${apiKey}`;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const texture = new Texture(img);
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    const geometry = buildFullGlobeGeometry();
    // toneMapped: false — this is a flat, already-correct sRGB photo, not
    // an HDR-lit PBR surface; running it through the ground scene's
    // ACES/exposure curve (tuned dark for the Preetham sky) just crushes
    // it for no reason. Same on every other overview material.
    // The coarsest/bottom layer — the largest polygonOffset push, so it
    // loses the depth test to both finer layers above it (see the
    // whole-globe-entry material's comment).
    const material = new MeshBasicMaterial({
      map: texture, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
    });
    applyGlobeShading(material);
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    onLoaded(mesh);
  };
  img.onerror = () => console.error('US overview: base globe image failed to load');
  img.src = url;
}

// Called on every mount. First call ever: kicks off the base globe + whole-
// globe-entry fetches for real. Every call after that: the fetches are
// already done (or already in flight and will finish on their own — see
// fetchWholeGlobeCell/fetchBaseGlobe's onLoaded), so this is just a lookup.
// entryZoomFetchZoom (fetchZoomFor(entryZoom), computed by the caller,
// which — unlike this module-level function — has a live viewportW/H to
// compute it from) becomes wholeGlobeZ, frozen from here on: a mid-session
// window resize won't refine an already-fetched whole-globe layer, which
// is an accepted simplification (see this function's own age — it hasn't
// been worth revisiting).
// usRegionZoomFetchZoom sharper than entryZoomFetchZoom (by
// tilesParams.wholeGlobeLodBoost — see loadUSRegionAtBoostedDetail's own
// comment) covers just US_FRAME_BOUNDS, layered on top of the coarser
// whole-globe layer that still covers the entire sphere underneath it.
export function ensureGlobeBase(scene, apiKey, entryZoomFetchZoom, usRegionZoomFetchZoom) {
  if (!globeBase) {
    globeBase = {
      baseGlobeMesh: null,
      wholeGlobeCache: new Map(),
      usRegionCache: new Map(),
      polarRingCache: new Map(),
      wholeGlobeZ: entryZoomFetchZoom,
      polarCapMeshes: [],
      borderLines: [],
    };
    fetchBaseGlobe(scene, apiKey, (mesh) => { globeBase.baseGlobeMesh = mesh; });
    loadWholeGlobeAtEntryDetail(scene, apiKey, entryZoomFetchZoom, globeBase.wholeGlobeCache);
    loadUSRegionAtBoostedDetail(scene, apiKey, usRegionZoomFetchZoom, globeBase.usRegionCache);
    const { meshes: polarCapMeshes, onColorSample } = buildPolarCaps(scene);
    globeBase.polarCapMeshes = polarCapMeshes;
    loadPolarRings(scene, apiKey, entryZoomFetchZoom, globeBase.polarRingCache, onColorSample);
    globeBase.borderLines = buildBorderLines(scene);
  }
  setGlobeBaseVisible(true);
  return globeBase.wholeGlobeZ;
}

export function setGlobeBaseVisible(visible) {
  if (!globeBase) return;
  if (globeBase.baseGlobeMesh) globeBase.baseGlobeMesh.visible = visible;
  for (const entry of globeBase.wholeGlobeCache.values()) {
    if (entry.mesh) entry.mesh.visible = visible;
  }
  for (const entry of globeBase.usRegionCache.values()) {
    if (entry.mesh) entry.mesh.visible = visible;
  }
  for (const entry of globeBase.polarRingCache.values()) {
    if (entry.mesh) entry.mesh.visible = visible;
  }
  for (const mesh of globeBase.polarCapMeshes) mesh.visible = visible;
  for (const line of globeBase.borderLines) line.visible = visible;
}
