import {
  MeshBasicMaterial, Mesh, Texture, Vector3, Raycaster, Vector2, Sphere,
  BufferGeometry, BufferAttribute, SRGBColorSpace,
} from 'three';
import { getMovementCurve } from './flightCurves';
import { settings } from './settings/store';
import { patchShaderSource } from './shaders';
import { createScrollVelocity } from './camera/scrollVelocity';
import { createMarkerOverlay } from './markers';

// The landing experience: one continuous 3D camera, never a hard cut to a
// separate renderer. Mounts a live, pixelated satellite-imagery patch onto
// a real curved globe directly in the app's own scene/camera (not a flat
// plane) — panning/zooming orbits the SAME camera around that globe, so it
// looks and moves like Google Earth's own space view. Clicking a location
// marker runs a simple eased zoom-and-pan (see flyTo) toward that spot, then
// hands off to the app's own travelToLocation/teleportToLocation for the
// final cut into the real 3D tiles — the fly-in is deliberately simple for
// now (linear lat/lon lerp, no great-circle path) and is meant to be tuned
// further by feel.
//
// Panning/zooming still key off the same Web Mercator "world pixels at zoom
// 0" math a normal 2D slippy map uses (TILE_SIZE, doubling per zoom level)
// for deciding what to fetch from Google's Static Maps API and for sizing
// the fetched patch — that's simply what the API speaks, and how its zoom
// levels relate to real-world meters. What's different from a flat map is
// that the patch's vertices are placed on the sphere via real spherical
// (lat/lon) coordinates instead of a flat XZ rectangle, and the camera
// orbits at a given altitude *above the sphere's surface* rather than a
// flat Y height.

const TILE_SIZE = 256;
const REQUEST_SIZE = 640; // Maps Static API's max free "size" per axis
const REQUEST_SCALE = 2; // retina pixel density; same geo coverage, sharper texture
const PATCH_SEGMENTS = 16; // ground patch grid resolution per axis
// Used only to frame the *initial* view (whole continental US visible) —
// panning/zooming are no longer clamped to this or any other region; you
// can orbit anywhere on the globe, and each new area gets its own fetch.
const US_FRAME_BOUNDS = { west: -124.5, east: -71.5, south: 24.0, north: 49.5 };
const GRID_RADIUS = 1; // fetch a (2*GRID_RADIUS+1)^2 neighborhood in parallel around the current cell — 1 => 3x3
const CACHE_KEEP_RADIUS = 2; // evict cached cells farther than this from the current center
// A perfectly vertical camera-over-target offset is a singularity for
// OrbitControls' spherical decomposition (used every frame by the ordinary
// tick loop's controls.update(), including during any travelTo flight) —
// position/target still lerp smoothly through it, but the derived
// *orientation* can snap unpredictably frame-to-frame right at that exact
// configuration. A small, fixed tilt off nadir (here: aiming the look-at
// point slightly north of the true sub-camera point, rather than straight
// down) keeps the offset non-degenerate everywhere on the globe.
// Exported so main.js's travelTo(..., {startLookDown}) can open the ground-
// level flight at this exact same tilt — the overview always exits looking
// north-and-down by this angle, and matching it there (rather than picking
// its own tilt) is what keeps the cut from the globe into the local view
// from snapping to a different look direction.
export const TILT_RAD = (12 * Math.PI) / 180;
// The fly-in: a plain eased lerp of zoom + center toward the destination,
// driven by this module's own requestAnimationFrame loop — no dependency on
// the app's separate travelTo/tick machinery. `flyInParams` *is*
// settings.transitions.flyIn (see settings.toml), not a copy, so the dev-GUI
// "Transition Speed" folder and the ":settings" console command both retune
// the exact same fields live instead of requiring a source edit + reload.
// Which curve shapes each movement's speed, and how fast it travels through
// that curve, lives in flightCurves.ts's movementParams instead of here —
// these three fields are just *duration*, a separate concern (see
// getMovementCurve's own comment on why it's snapshotted once per flight
// rather than read live).
export const flyInParams = settings.transitions.flyIn;

// Read every frame by main.js's tick() to drive the zoom-blur post pass
// (see updateZoomBlur) — this module owns the overview's own rAF loop, so
// main.js has no other way to know how far into a flyTo dive it is.
// blurStrength reuses zoomE's own accelerating curve directly (see flyTo)
// rather than recomputing an easing from elapsed/flyInMs a second time.
export const overviewFlightState = { active: false, blurStrength: 0 };

// Tuning for prefetchDestinationGrid's two-tier destination pre-render (see
// its own comment) — a mutable object, not inline literals, so the dev-GUI
// "Transition Speed" folder can retune it live.
// Four named tiers, finest to coarsest — not a hardcoded two, but not a
// fully open-ended list either, since each one needs its own GUI sliders
// (see main.js). `radius` 0 disables a tier outright (skipped, zero
// requests) rather than degenerating to a 1x1 fetch — sliding highRes to 0
// is the intended way to drop full-detail prefetching entirely and lean on
// the coarser tiers alone, which is far cheaper: each request costs the
// same regardless of tier, but a coarser tile also covers proportionally
// more real ground (cellSize doubles per zoomDrop level), so a *smaller*
// radius on a coarse tier still covers more area than a larger radius on a
// fine one. Every (2r+1)^2 requests fires at once on click — keep that in
// mind pushing radii up (radius 3 => 49 requests for that tier alone).
// edgeFadeStrength: 0 = fully opaque to each tier's own edge, 1 = nearly
// transparent there. fetchBatchSize/buildBatchSize: how many tiles get
// their network request issued, and separately how many get their
// geometry/material/mesh actually built, per animation frame — see the two
// queues in mountUSOverview. Lower = smoother but slower for the
// destination patch to fully resolve; higher = faster but closer to the
// original everything-at-once burst. See settings.toml's
// [prefetch.dest.*] tables for the actual defaults.
export const destPrefetchParams = settings.prefetch.dest;

// How close the mouse needs to get to a marker (in screen pixels) to count
// as "about to click it" — see the mousemove handler near the markers
// below, which fires loc.onHoverNear() and lets main.js's preload manager
// decide what that actually triggers. debounceMs stops a mouse sitting
// still near a marker (or a fast sweep across several) from re-firing that
// every single mousemove event.
export const hoverParams = settings.prefetch.hover;

// Meters per Mercator zoom-0 world-unit (TILE_SIZE=256 convention),
// compressed by an arbitrary meters-per-scene-unit factor so the whole
// globe and the camera's overview altitude both stay comfortably within the
// main camera's existing near/far planes without touching them.
const METERS_PER_MERCATOR_UNIT = 156543.03392804097;
const SCENE_UNITS_PER_METER = 1 / 3000;
const SCENE_UNITS_PER_MERCATOR_UNIT = METERS_PER_MERCATOR_UNIT * SCENE_UNITS_PER_METER;
const EARTH_RADIUS_SCENE = 6371000 * SCENE_UNITS_PER_METER;

// A full sphere, always present and fetched once, so the globe is never
// bare beyond the one detailed patch fetched for the current view — this
// is how Google Earth's own low-res base imagery + progressively-loaded
// close-up tiles work. Google centers a whole-world request inside the
// square canvas at exactly (world size at that zoom)/(requested size) —
// here 512/640 = 0.8 — and since longitude wraps but latitude can't, it
// repeats content to fill the width but pads with blank space top/bottom;
// WORLD_IMG_CONTENT_FRAC/PAD crop back down to the one clean copy (measured
// empirically against a real fetch, not documented behavior).
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

function worldX(lng) {
  return ((lng + 180) / 360) * TILE_SIZE;
}
function worldY(lat) {
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return y * TILE_SIZE;
}
function xToLng(x) {
  return (x / TILE_SIZE) * 360 - 180;
}
function yToLat(y) {
  const n = Math.PI - (2 * Math.PI * y) / TILE_SIZE;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
// Pan/zoom during flyTo/flyOut trade off against each other's speed —
// which curve shapes each one and how fast it travels through that curve
// is configured in flightCurves.ts's movementParams (getMovementCurve),
// not here; see flyTo/flyOut below for where each movement's curve gets
// resolved once per flight.
// Azimuth's own curve — smooth start and finish, unlike zoom/descend's
// deliberately lopsided curves above. There's no matching motion on either
// side of this one to carry momentum into or out of (nothing rotates before
// flyTo starts, and the camera holds still the instant local view opens),
// so easing both ends is what keeps the turn itself reading as smooth.
function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

// Real spherical placement — Y is the polar axis (matches three.js y-up),
// lon=0 at +Z, lon=90° at +X (east).
function sphereXYZ(latDeg, lonDeg, r) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const cosLat = Math.cos(lat);
  return new Vector3(r * cosLat * Math.sin(lon), r * Math.sin(lat), r * cosLat * Math.cos(lon));
}
// Unit tangent pointing toward increasing latitude (north) at that point.
function sphereNorth(latDeg, lonDeg) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return new Vector3(-Math.sin(lat) * Math.sin(lon), Math.cos(lat), -Math.sin(lat) * Math.cos(lon));
}
// Unit tangent pointing toward increasing longitude (east) at that point —
// the derivative of sphereXYZ w.r.t. longitude, normalized (latitude-
// independent once normalized, since cosLat cancels out).
function sphereEast(lonDeg) {
  const lon = (lonDeg * Math.PI) / 180;
  return new Vector3(Math.cos(lon), 0, -Math.sin(lon));
}

// All three globe layers (base globe, whole-globe entry detail, dynamic
// close-up grid) are concentric spheres centered at the scene origin with no
// transform of their own, so a vertex's raw object-space `position` already
// equals its outward surface normal once normalized — no separate normal
// attribute needed. Injected into each layer's otherwise-plain
// MeshBasicMaterial to give the flat, evenly-lit satellite photo some of the
// depth a real lit sphere has: a soft view-fixed "terminator" (so it reads
// as a lit ball no matter how the globe is panned/rotated, like Google
// Earth's own space view) plus a thin Fresnel rim light standing the globe
// out from the black background.
function applyGlobeShading(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = patchShaderSource(shader.vertexShader, [
      { find: '#include <common>', replace: '#include <common>\nvarying vec3 vNormalView;' },
      {
        find: '#include <begin_vertex>',
        replace: '#include <begin_vertex>\nvNormalView = normalize(mat3(modelViewMatrix) * normalize(position));',
      },
    ], 'globe shading (vertex)');
    shader.fragmentShader = patchShaderSource(shader.fragmentShader, [
      { find: '#include <common>', replace: '#include <common>\nvarying vec3 vNormalView;' },
      {
        find: '#include <map_fragment>',
        replace: `#include <map_fragment>
        {
          // Fixed in view space (not world space) so the "sunlit" side always
          // faces the same on-screen direction regardless of how far the
          // globe has been panned/rotated — an unlit hemisphere always
          // shades in toward the same corner, exactly like Google Earth's.
          float ndl = dot(vNormalView, normalize(vec3(-0.35, 0.45, 0.75)));
          float lit = smoothstep(-0.15, 0.35, ndl);
          diffuseColor.rgb *= mix(0.38, 1.05, lit);
          float rim = pow(1.0 - clamp(vNormalView.z, 0.0, 1.0), 3.0);
          diffuseColor.rgb += vec3(0.5, 0.72, 1.0) * rim * 0.5;
        }`,
      },
    ], 'globe shading (fragment)');
  };
  material.needsUpdate = true;
}

// Builds a curved grid draped over the real sphere, covering the same
// lat/lon bounding box a fetched Static Maps image covers, with UV
// coordinates matching that box linearly in Mercator space (u: west→east
// 0→1, v: south→north 0→1) — the same effective mapping a flat Mercator
// tile plane would use, just with each vertex placed on the globe instead
// of a flat rectangle. Over a large box (very low zoom) this inherits some
// of Mercator's own distortion rather than true equal-area geodesic tiling
// — an accepted simplification for now. Module-level (not per-mount) since
// it has no dependency on a specific mount — used both by the ordinary
// per-view dynamic grid and destination prefetch (inside mountUSOverview)
// and by the persistent whole-globe-entry layer below.
function buildGroundPatch(lat, lon, z, radius = EARTH_RADIUS_SCENE) {
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
const POLAR_CAP_LAT = 80; // generous margin past whatever loadWholeGlobeAtEntryDetail's edge-cell exclusion leaves uncovered
const POLAR_CAP_RADIUS = EARTH_RADIUS_SCENE * 0.9998;
const POLAR_CAP_COLOR = 0x142a4d; // plausible dark polar-ocean fallback — no texture/UV needed

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

function buildPolarCaps(scene) {
  const meshes = [];
  for (const [lo, hi] of [[POLAR_CAP_LAT, 90], [-90, -POLAR_CAP_LAT]]) {
    const geometry = buildPolarCapGeometry(lo, hi);
    const material = new MeshBasicMaterial({ color: POLAR_CAP_COLOR, toneMapped: false });
    applyGlobeShading(material);
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

// --- Persistent globe base (base globe + whole-globe-entry imagery) ------
// This content is identical every time regardless of which location the
// overview is centered on, so it's module-level state — fetched once for
// the app's whole lifetime, not per overview mount. It used to live inside
// mountUSOverview and get fully torn down in dispose() like everything
// else there, which was the actual cause of "tiles blank out and reload"
// on zoom-out (startZoomOutToOverview): the same handful of always-
// identical requests, re-fetched from nothing, every single time the
// overview was re-entered — including right as flyOut's own zoom-out
// animation needed them on screen. Built lazily on first mount (see
// ensureGlobeBase), then just shown/hidden (never disposed) on every
// mount/dispose after that.
let globeBase = null; // { baseGlobeMesh: Mesh|null, wholeGlobeCache: Map, wholeGlobeZ: number } | null until first mount

function fetchWholeGlobeCell(scene, apiKey, z, ix, iy, cellSize, key, cache) {
  if (!apiKey) return;
  cache.set(key, { mesh: null });
  const lon = xToLng(ix * cellSize);
  const lat = yToLat(iy * cellSize);
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=${z}&size=${REQUEST_SIZE}x${REQUEST_SIZE}&scale=${REQUEST_SCALE}&maptype=satellite&key=${apiKey}`;
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
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    applyGlobeShading(material);
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    cache.set(key, { mesh });
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

function fetchBaseGlobe(scene, apiKey, onLoaded) {
  if (!apiKey) return;
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
function ensureGlobeBase(scene, apiKey, entryZoomFetchZoom) {
  if (!globeBase) {
    globeBase = {
      baseGlobeMesh: null, wholeGlobeCache: new Map(), wholeGlobeZ: entryZoomFetchZoom, polarCapMeshes: [],
    };
    fetchBaseGlobe(scene, apiKey, (mesh) => { globeBase.baseGlobeMesh = mesh; });
    loadWholeGlobeAtEntryDetail(scene, apiKey, entryZoomFetchZoom, globeBase.wholeGlobeCache);
    globeBase.polarCapMeshes = buildPolarCaps(scene);
  }
  setGlobeBaseVisible(true);
  return globeBase.wholeGlobeZ;
}

function setGlobeBaseVisible(visible) {
  if (!globeBase) return;
  if (globeBase.baseGlobeMesh) globeBase.baseGlobeMesh.visible = visible;
  for (const entry of globeBase.wholeGlobeCache.values()) {
    if (entry.mesh) entry.mesh.visible = visible;
  }
  for (const mesh of globeBase.polarCapMeshes) mesh.visible = visible;
}

// Mounts the globe into the app's real scene/camera/controls/renderer —
// `locations`: [{ name, lat, lon, onSelect() }]. `onSkip` fires when the
// "Enter" button is used instead of picking a marker. Returns `{ dispose }`.
export function mountUSOverview({
  scene, camera, controls, renderer, apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY, locations = [], onSkip,
  onActivity, seed,
}) {
  if (!apiKey) console.error('US overview: missing VITE_GOOGLE_MAPS_API_KEY');

  const domParent = renderer.domElement.parentElement || document.body;
  const globeSphere = new Sphere(new Vector3(0, 0, 0), EARTH_RADIUS_SCENE);
  // applyCamera() dynamically shrinks camera.near for this overview's own
  // (much smaller-altitude) needs — restored on dispose so the ground-level
  // flythrough gets back its own near plane, not whatever the overview last
  // left it at.
  const savedCameraNear = camera.near;

  let viewportW = renderer.domElement.clientWidth || window.innerWidth || 1;
  let viewportH = renderer.domElement.clientHeight || window.innerHeight || 1;

  // Continuous camera state: plain lat/lon (degrees) + zoom. zoom still
  // drives altitude/fetch-resolution exactly like a 2D slippy map would.
  let zoom = 0;
  let minZoom = 0;
  let maxZoom = 0;
  let entryZoom = 0; // set once at mount — the floor fetchZoomFor won't fetch coarser than, however far out the camera itself goes
  let wholeGlobeZ = 0; // set once at mount, from the shared/persistent globe base — see ensureGlobeBase
  let centerLat = 39.8283;
  let centerLon = -98.5795;
  // Clockwise from north — see applyCamera's tiltDir. Only flyTo ever moves
  // this away from the default 0 (ordinary panning/zooming always trails
  // due south, looking north).
  let tiltAzimuthRad = 0;
  let flying = false;
  let flyRaf = null;

  function vFovRad() {
    return (camera.fov * Math.PI) / 180;
  }

  function altitudeFor(z) {
    const scale = 2 ** z;
    return (viewportH * SCENE_UNITS_PER_MERCATOR_UNIT) / (2 * Math.tan(vFovRad() / 2) * scale);
  }

  function zoomForAltitude(h) {
    return Math.log2((viewportH * SCENE_UNITS_PER_MERCATOR_UNIT) / (2 * Math.tan(vFovRad() / 2) * h));
  }

  function applyCamera() {
    const h = altitudeFor(zoom);
    // The ground-level flythrough's camera.near (1 scene unit) is shared
    // with this overview, but at deep zoom the overview's own altitude
    // drops well below that — e.g. ~0.93 at zoom 16, ~0.12 at FLY_IN_ZOOM
    // (19) — meaning nearly all of the ground actually in frame is *closer*
    // to the camera than the near plane and gets clipped away outright.
    // What's left visible is only the sliver far enough (toward the tilted
    // look direction's horizon side) to clear that plane, with whatever's
    // behind it — a much more distant, coarser part of the same sphere —
    // showing through the gap. The marker overlay is untouched by any of
    // this (it's plain HTML, not clipped by the 3D camera), so it stays
    // correctly placed while the ground rendering appears to fall away from
    // it — worse the deeper you zoom in, since altitude keeps shrinking.
    // Keeping near a small, fixed fraction of the current altitude (instead
    // of a constant tuned for the ground flythrough's very different scale)
    // keeps it comfortably inside the visible range at every zoom level.
    camera.near = Math.max(0.001, h * 0.05);
    camera.updateProjectionMatrix();
    const up = sphereXYZ(centerLat, centerLon, 1);
    const north = sphereNorth(centerLat, centerLon);
    const groundP = up.clone().multiplyScalar(EARTH_RADIUS_SCENE);
    // Camera trails (centerLat, centerLon) by a small tangential offset and
    // looks back at the ground point — see TILT_RAD's comment. The trail
    // direction is tiltAzimuthRad clockwise from north (0 = trail south,
    // look north — the ordinary panning/zooming default) rather than always
    // north: flyTo animates this toward the destination's own saved facing
    // as it dives in (see flyInParams/flyTo below), so the overview hands
    // off already looking the direction the local view actually opens on,
    // instead of snapping 180° the instant local view takes over for a
    // south-facing view like Urbana's.
    const east = sphereEast(centerLon);
    const tiltDir = north.clone().multiplyScalar(Math.cos(tiltAzimuthRad))
      .addScaledVector(east, Math.sin(tiltAzimuthRad));
    camera.position.copy(up).multiplyScalar(EARTH_RADIUS_SCENE + h)
      .addScaledVector(tiltDir, -h * Math.tan(TILT_RAD));
    camera.up.copy(up);
    camera.lookAt(groundP);
    // lookAt() only sets the quaternion — matrixWorld itself is normally
    // refreshed during the next render's scene traversal, which happens
    // too late for updateMarkers()'s .project(camera) call right below,
    // leaving it reading the previous frame's stale transform.
    camera.updateMatrixWorld(true);
    controls.target.copy(groundP);
    updateMarkers();
  }

  // No pan boundary — clamp only latitude (avoiding the pole singularity)
  // and wrap longitude around the globe.
  function clampCenter() {
    centerLat = Math.min(85, Math.max(-85, centerLat));
    centerLon = ((centerLon + 180) % 360 + 360) % 360 - 180;
  }

  // minZoom: a fixed, generous "see a huge stretch of the globe" floor —
  // no longer tied to any particular region since panning is unbounded. The
  // camera itself is free to go this far out; what's actually clamped is
  // the *fetch* resolution (see fetchZoomFor) so the tile grid never tries
  // to source anything coarser than the entry-level view, which is where
  // the Static Maps math (cell size, UV) stops corresponding to a real
  // request and visibly glitches.
  // maxZoom: no cap beyond Google's own real max zoom level — the wheel can
  // dive all the way in manually, same as the automated fly-in does.
  function computeZoomBounds() {
    minZoom = 2;
    maxZoom = 21;
  }

  // Also used once, at mount, to pick the actual starting zoom (whole
  // continental US visible).
  function initialUSFitZoom() {
    const usBboxW = worldX(US_FRAME_BOUNDS.east) - worldX(US_FRAME_BOUNDS.west);
    const usBboxH = worldY(US_FRAME_BOUNDS.south) - worldY(US_FRAME_BOUNDS.north);
    const aspect = viewportW / viewportH;
    const altitudeForW = (usBboxW * SCENE_UNITS_PER_MERCATOR_UNIT) / (2 * Math.tan(vFovRad() / 2) * aspect);
    const altitudeForH = (usBboxH * SCENE_UNITS_PER_MERCATOR_UNIT) / (2 * Math.tan(vFovRad() / 2));
    return Math.min(zoomForAltitude(altitudeForW), zoomForAltitude(altitudeForH)) - 0.2;
  }

  function resize() {
    // window.innerWidth/innerHeight first, not renderer.domElement's own
    // clientWidth/clientHeight: the browser updates window.innerWidth the
    // instant the viewport actually changes, before any 'resize' listener
    // runs, but the canvas's *own* clientWidth only reflects the new size
    // once main.js's separate 'resize' listener has actually called
    // renderer.setSize() — and listener order between the two modules isn't
    // guaranteed. When this one fires first, clientWidth is still the old
    // size (and, being truthy, `||` never falls through to the already-
    // correct window.innerWidth), so every marker gets projected through a
    // viewport size that's one real resize behind — worse the further off-
    // center the marker is, invisible until the next unrelated pan/zoom
    // happens to recompute it. This app's canvas always fills the full
    // viewport, so window.innerWidth/innerHeight is the right source of
    // truth regardless of whether the canvas itself has caught up yet.
    viewportW = window.innerWidth || renderer.domElement.clientWidth || 1;
    viewportH = window.innerHeight || renderer.domElement.clientHeight || 1;
    // main.js has its own 'resize' listener that updates camera.aspect and
    // calls updateProjectionMatrix() — but listener order across the two
    // modules isn't guaranteed, and applyCamera() below immediately does a
    // marker .project(camera) call. If this module's listener runs first,
    // that projection uses the *old* aspect ratio's matrix (still correct
    // for rendering the ground a moment later, once main.js's listener
    // catches up, but already wrong for the markers right now) — every
    // resize (including just docking/undocking devtools, which changes
    // window.innerWidth) could silently knock every marker hundreds of
    // miles off until the next unrelated pan/zoom happens to refresh them.
    // Setting aspect here too makes this self-sufficient either way.
    camera.aspect = viewportW / viewportH;
    camera.updateProjectionMatrix();
    computeZoomBounds();
    zoom = Math.min(maxZoom, Math.max(minZoom, zoom));
    applyCamera();
  }

  // Raycasts screen coordinates onto the globe and converts back to
  // lat/lon — exact regardless of the camera's tilt or the sphere's
  // curvature, unlike a fixed per-pixel formula. Returns null if the ray
  // misses the globe entirely (looking past its limb) — callers that don't
  // care (drag-panning) use screenToLatLon below, which falls back to the
  // current center; the zoom-toward-cursor correction in stepZoomVelocity
  // needs the real miss/hit distinction (see its own comment on why).
  const raycaster = new Raycaster();
  const ndcVec = new Vector2();
  const hitVec = new Vector3();
  function raySphereLatLon(px, py) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndcVec.x = ((px - rect.left) / rect.width) * 2 - 1;
    ndcVec.y = -(((py - rect.top) / rect.height) * 2 - 1);
    raycaster.setFromCamera(ndcVec, camera);
    const hit = raycaster.ray.intersectSphere(globeSphere, hitVec);
    if (!hit) return null;
    const lat = (Math.asin(Math.min(1, Math.max(-1, hit.y / EARTH_RADIUS_SCENE))) * 180) / Math.PI;
    const lon = (Math.atan2(hit.x, hit.z) * 180) / Math.PI;
    return { lat, lon };
  }
  function screenToLatLon(px, py) {
    return raySphereLatLon(px, py) ?? { lat: centerLat, lon: centerLon };
  }

  // --- Location markers ----------------------------------------------------
  // Projected into screen space every time the camera changes; the actual
  // dot/tag styling and label decluttering (see the Chantilly/Falls Church
  // problem this replaced) live in src/markers/ now — this
  // keeps only the globe-specific part here: real position, and the
  // horizon/frustum visibility test below.
  const markerVec = new Vector3();
  const markerNormal = new Vector3();
  const cameraDir = new Vector3();
  const markers = locations.map((loc) => ({ loc, pos: sphereXYZ(loc.lat, loc.lon, EARTH_RADIUS_SCENE) }));
  // loc.name is a settings key (e.g. "paloAlto"), not display text — loc.
  // label carries the actual "Palo Alto, CA" string (see main.js's
  // enterOverview). Falls back to loc.name for robustness if a caller ever
  // omits it. Also doubles as the marker's id, so onSelect below can look
  // the full loc object back up to hand to flyTo.
  const markerOverlay = createMarkerOverlay(
    domParent,
    markers.map((m) => ({ id: m.loc.name, label: m.loc.label ?? m.loc.name })),
    (id) => {
      const m = markers.find((entry) => entry.loc.name === id);
      if (m) flyTo(m.loc);
    },
  );
  function updateMarkers() {
    // The camera-frustum check below only knows about near/far clipping —
    // it has no idea the globe itself is a solid, opaque ball. A marker on
    // the far side of the sphere (or just past the near horizon once the
    // camera pulls back and sees real curvature) still projects to *some*
    // on-screen point via plain perspective math, so without this it kept
    // rendering there — floating disconnected from the visible disc instead
    // of hidden behind it, worst wherever the globe reads smallest on screen.
    // Standard camera-over-a-sphere horizon test: a surface point is behind
    // the horizon once the angle between its own outward normal and the
    // direction up to the camera exceeds arccos(R / distance-to-center).
    const cameraDist = camera.position.length();
    cameraDir.copy(camera.position).divideScalar(cameraDist);
    const cosHorizon = EARTH_RADIUS_SCENE / cameraDist;
    const projections = markers.map((m) => {
      markerVec.copy(m.pos).project(camera);
      const px = (markerVec.x * 0.5 + 0.5) * viewportW;
      const py = (1 - (markerVec.y * 0.5 + 0.5)) * viewportH;
      markerNormal.copy(m.pos).divideScalar(EARTH_RADIUS_SCENE);
      const belowHorizon = markerNormal.dot(cameraDir) < cosHorizon;
      const offscreen = markerVec.z > 1 || px < -60 || px > viewportW + 60 || py < -60 || py > viewportH + 60;
      const visible = !(offscreen || belowHorizon);
      return { id: m.loc.name, px, py, visible };
    });
    markerOverlay.update(projections);
  }

  // --- Click a marker: pan (no zoom) to center the camera directly above
  // it, then hand off ------------------------------------------------------
  // Pan finishes on its own, much shorter clock — zoom is exponential (each
  // level roughly doubles magnification), so even sharing one progress
  // fraction with pan reads as zoom visibly outrunning it. Landing pan fast
  // and letting zoom take the rest of the full duration on its own is what
  // actually keeps the shot feeling centered while it dives in, instead of
  // hunting for the spot the whole way down.
  function flyTo(loc) {
    if (flying) return;
    stopMomentum();
    flying = true;
    // Fired synchronously, before the dive even starts — the real 3D tiles
    // for this destination aren't touched by anything until travelTo's own
    // teleport, seconds from now, so this is the earliest possible moment
    // to start pulling them in (see prefetchLocationHeavy in main.js).
    loc.onFlightStart?.();
    // Same reasoning for this overview's OWN imagery — fetch the exact grid
    // the destination needs now, well before the camera visually gets
    // there (see prefetchDestinationGrid's own comment for why this
    // replaces per-frame ensureGrid() calls during the flight below).
    prefetchDestinationGrid(loc.lat, loc.lon);
    const startLat = centerLat;
    const startLon = centerLon;
    const startZoom = zoom;
    // Snapshot at the start, not read live per-frame — mid-flight retuning
    // would change the target this specific flight is easing toward.
    const { zoom: flyInZoom, ms: flyInMs, panMs } = flyInParams;
    const panCurve = getMovementCurve('panIn');
    const zoomCurve = getMovementCurve('zoomIn');
    // Rotate the approach to face the same direction the destination's own
    // saved local view actually looks (loc.bearing — see main.js, where
    // it's derived from that view's own target-minus-position), starting
    // immediately and finishing by the time the dive ends. Without this the
    // overview always hands off looking north, and any destination that
    // doesn't itself face north (Urbana faces almost exactly south) had to
    // do a full 180° reorientation in the first instant of local view —
    // spreading it across the whole dive instead reads as one continuous
    // turn instead of a snap. Shortest-path delta so a bearing near 0/360
    // doesn't spin the long way around.
    const startAzimuth = tiltAzimuthRad;
    const destAzimuth = loc.bearing ?? 0;
    let azimuthDelta = destAzimuth - startAzimuth;
    azimuthDelta = ((azimuthDelta % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    overviewFlightState.active = true;
    const t0 = performance.now();
    function step(now) {
      const elapsed = now - t0;
      const panE = panCurve(Math.min(elapsed / panMs, 1));
      const zoomE = zoomCurve(Math.min(elapsed / flyInMs, 1));
      const azimuthE = easeInOutCubic(Math.min(elapsed / flyInMs, 1));
      centerLat = startLat + (loc.lat - startLat) * panE;
      centerLon = startLon + (loc.lon - startLon) * panE;
      zoom = startZoom + (flyInZoom - startZoom) * zoomE;
      tiltAzimuthRad = startAzimuth + azimuthDelta * azimuthE;
      overviewFlightState.blurStrength = zoomE;
      applyCamera();
      // Deliberately no ensureGrid() here — see prefetchDestinationGrid's
      // comment. Letting this keep re-evaluating fetchZoomFor(zoom) every
      // frame during the dive is exactly what caused tiles to repeatedly
      // clear and reload mid-flight; the pre-flight grid just stays as-is
      // now, with the destination's own grid layered on top of it as it
      // arrives instead.
      if (elapsed < flyInMs) {
        flyRaf = requestAnimationFrame(step);
      } else {
        flying = false;
        overviewFlightState.active = false;
        overviewFlightState.blurStrength = 0;
        loc.onSelect?.();
      }
    }
    flyRaf = requestAnimationFrame(step);
  }

  // --- Live tile fetching ----------------------------------------------------
  // A small grid of tiles around the current view, fetched *in parallel* and
  // cached by grid cell — not one tile fetched reactively after the fact.
  // Panning within the cached neighborhood is then instant; only crossing
  // into a cell that isn't cached yet, or changing zoom level, costs a real
  // network round trip, and that cell's own neighbors are already being
  // fetched alongside it.
  const tileCache = new Map(); // key "ix_iy" (grid cell at the current zoom) -> { mesh } | { mesh: null } while loading
  let currentGridZ = null;
  let gridGeneration = 0;

  function disposeTileEntry(entry) {
    if (!entry.mesh) return;
    scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.mesh.material.map.dispose();
    entry.mesh.material.dispose();
  }

  function clearTileCache() {
    for (const entry of tileCache.values()) disposeTileEntry(entry);
    tileCache.clear();
  }

  // A single Static Maps request tops out at REQUEST_SIZE (640) logical
  // pixels square, which is smaller than most viewports — fetched at the
  // same zoom level the camera is showing, a tile would only cover a
  // fraction of the screen. Fetching a constant amount *coarser* than the
  // display zoom (offset by how much wider the viewport is than the
  // request budget, plus extra margin) makes each tile's native content,
  // scaled up, comfortably cover its share of the screen — while still
  // gaining real extra detail every time the user zooms in further, just
  // permanently offset by that constant instead of matching 1:1.
  function fetchZoomFor(zc) {
    // Never fetches coarser than the entry-level view, however far out the
    // camera itself zooms — past that point the Static Maps math (cell
    // size, UV) stops corresponding to a real request and visibly glitches,
    // so the fetched grid just holds at its entry-level resolution while
    // the camera keeps pulling back around it.
    const clamped = Math.max(zc, entryZoom);
    const coverDim = Math.max(viewportW, viewportH);
    const offset = Math.log2(coverDim / REQUEST_SIZE);
    return Math.min(20, Math.max(0, Math.round(clamped - offset - 0.6)));
  }

  function fetchGridCell(z, ix, iy, cellSize, generation) {
    if (!apiKey) return;
    const key = `${ix}_${iy}`;
    tileCache.set(key, { mesh: null });
    const lon = xToLng(ix * cellSize);
    const lat = yToLat(iy * cellSize);
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=${z}&size=${REQUEST_SIZE}x${REQUEST_SIZE}&scale=${REQUEST_SCALE}&maptype=satellite&key=${apiKey}`;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Superseded by a zoom change (new generation) or evicted for being
      // too far away before it arrived — either way, drop it.
      if (generation !== gridGeneration || !tileCache.has(key)) return;
      const texture = new Texture(img);
      texture.colorSpace = SRGBColorSpace;
      texture.needsUpdate = true;
      const geometry = buildGroundPatch(lat, lon, z);
      const material = new MeshBasicMaterial({ map: texture, toneMapped: false });
      applyGlobeShading(material);
      const mesh = new Mesh(geometry, material);
      scene.add(mesh);
      tileCache.set(key, { mesh, ix, iy });
    };
    img.onerror = () => {
      console.error('US overview tile failed to load (check API key / Static Maps API enablement)');
      tileCache.delete(key);
    };
    img.src = url;
  }

  // See ensureGrid's own comment for why this exists. GRID_REBUILD_DEBOUNCE_MS
  // is deliberately short — long enough to coalesce a whole burst of wheel
  // ticks or flyOut animation frames into one rebuild, short enough that a
  // deliberate pause mid-zoom still resolves to real detail quickly.
  const GRID_REBUILD_DEBOUNCE_MS = 150;
  let gridRebuildTimer = null;
  function scheduleGridRebuild() {
    if (gridRebuildTimer) clearTimeout(gridRebuildTimer);
    gridRebuildTimer = setTimeout(() => {
      gridRebuildTimer = null;
      const z = fetchZoomFor(zoom); // re-read — zoom may have moved further since scheduling
      if (z <= wholeGlobeZ + 1) return;
      clearTileCache();
      currentGridZ = z;
      gridGeneration += 1;
      ensureGrid(); // now z === currentGridZ, falls straight into the cheap fill-in path
    }, GRID_REBUILD_DEBOUNCE_MS);
  }

  // Ensures the whole neighborhood around the current view is loaded — not
  // just the single cell under the camera. Cheap to call on every pan/zoom
  // event: most calls find every cell already cached (a handful of Map
  // lookups) and only occasionally trigger real fetches, when the center
  // cell itself changes.
  //
  // The zoom-tier-crossing case is the one exception to "cheap": it tears
  // down and refetches the *entire* grid (clearTileCache + GRID_RADIUS^2
  // new requests), not an incremental top-up. A fast continuous zoom —
  // scrolling the wheel quickly, or flyOut's own animated zoom back out to
  // the overview, both of which call ensureGrid() every frame — can cross
  // several tiers in well under a second, and used to run that full
  // teardown+rebuild at *each* one in turn: measured a single rendered
  // frame stalling for tens of seconds during a fast zoom-out with a real
  // API key configured (a burst of superseded-but-still-loading tile
  // fetches, decodes, and shader-compiling materials, most of them thrown
  // away moments later). scheduleGridRebuild debounces that expensive part
  // — only the tier the zoom gesture actually settles on gets built, same
  // debounce-until-it-settles idea as hoverParams.debounceMs elsewhere in
  // this file. Cells already on screen just stay put (a stale-tier grid,
  // not a flickering empty one) until the debounce fires.
  function ensureGrid() {
    const z = fetchZoomFor(zoom);
    // At or wider than the entry-level zoom, the permanent whole-globe
    // layer (loadWholeGlobeAtEntryDetail) already covers this resolution
    // everywhere — nothing extra to fetch until zooming in past it. The
    // +1 (rather than +0) deliberately skips the very next LOD tier too:
    // zooming in from the entry level jumps straight two tiers finer
    // instead of stopping to fetch (and show) that intermediate one first.
    if (z <= wholeGlobeZ + 1) return;
    if (z !== currentGridZ) {
      scheduleGridRebuild();
      return;
    }
    const generation = gridGeneration;
    const cellSize = REQUEST_SIZE / 2 ** z; // full tile width, in zoom-0 Mercator world units
    const ixCenter = Math.round(worldX(centerLon) / cellSize);
    const iyCenter = Math.round(worldY(centerLat) / cellSize);
    for (let dy = -GRID_RADIUS; dy <= GRID_RADIUS; dy++) {
      for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
        const ix = ixCenter + dx;
        const iy = iyCenter + dy;
        const key = `${ix}_${iy}`;
        if (!tileCache.has(key)) fetchGridCell(z, ix, iy, cellSize, generation);
      }
    }
    // Bounds memory/GPU use during a long pan — drop cells well outside the
    // neighborhood instead of keeping every tile ever seen this session.
    for (const [key, entry] of tileCache) {
      const [ix, iy] = key.split('_').map(Number);
      if (Math.abs(ix - ixCenter) > CACHE_KEEP_RADIUS || Math.abs(iy - iyCenter) > CACHE_KEEP_RADIUS) {
        disposeTileEntry(entry);
        tileCache.delete(key);
      }
    }
  }

  // --- Destination pre-render — fetch a flyTo's endpoint grid immediately,
  // and hold it in a completely separate cache from the one above ----------
  // ensureGrid() re-evaluates fetchZoomFor(zoom) every frame and clears +
  // refetches its whole grid every time that crosses a zoom tier — during
  // flyTo's own fast, continuous zoom that happened several times over one
  // dive, each one a real network round trip with nothing to show in the
  // gap: tiles visibly blacked out and reloaded mid-transition. flyTo
  // already knows exactly which lat/lon/zoom it's diving to well before it
  // gets there, so fetching that grid once, up front (see loc.onFlightStart
  // above) — and simply leaving the pre-flight grid alone for the rest of
  // the dive (flyTo's own step() no longer calls ensureGrid at all) — means
  // there's nothing left to swap: the destination tiles are already
  // resident and rendered by the time the camera visually needs them, and
  // the pre-flight tiles they're drawn over never disappear out from under
  // it mid-flight.
  //
  // Two concentric tiers, not one: a small high-res patch alone still reads
  // as a sharp, obviously-rectangular island of detail dropped into the
  // coarse whole-globe imagery around it. A wider but coarser "medium" ring
  // — sharper than the whole-globe fallback but not full destination
  // detail — plus per-tile opacity fading toward each tier's own outer edge
  // (see fetchDestRing) turns that hard cliff into a gradual falloff.
  const destTileCache = new Map(); // key "z_ix_iy" — z-prefixed because the two tiers sit at different zooms simultaneously, and plain "ix_iy" would collide across them despite meaning completely different places

  // Both stages of getting a destination tile on screen — issuing its
  // network request, and building the geometry/material/mesh once the
  // image arrives — are spread across frames instead of run all at once.
  // Even after cutting the total tile count and resolution (see
  // destPrefetchParams' comment), 40-60 requests fired in one synchronous
  // burst still front-loads a lot of coincidentally-simultaneous img.onload
  // completions a fraction of a second later (similar network round trips
  // to the same host), each doing real synchronous work of its own
  // (Texture/BufferGeometry/Material/Mesh construction) — that clustering,
  // not the fetch-issuing loop itself (measured at ~1ms), is what actually
  // reads as a lag spike shortly after the click that started it. Two
  // small queues, each drained a few items per animation frame, turn both
  // bursts into something spread thin enough not to be felt.
  let destFetchQueue = [];
  let destFetchRaf = null;
  let destBuildQueue = [];
  let destBuildRaf = null;

  function disposeDestTiles() {
    destFetchQueue = [];
    if (destFetchRaf) { cancelAnimationFrame(destFetchRaf); destFetchRaf = null; }
    destBuildQueue = [];
    if (destBuildRaf) { cancelAnimationFrame(destBuildRaf); destBuildRaf = null; }
    for (const entry of destTileCache.values()) disposeTileEntry(entry);
    destTileCache.clear();
  }

  function drainDestFetchQueue() {
    const n = Math.max(1, destPrefetchParams.fetchBatchSize);
    for (let i = 0; i < n && destFetchQueue.length; i++) {
      fetchDestGridCell(destFetchQueue.shift());
    }
    destFetchRaf = destFetchQueue.length ? requestAnimationFrame(drainDestFetchQueue) : null;
  }

  function drainDestBuildQueue() {
    const n = Math.max(1, destPrefetchParams.buildBatchSize);
    for (let i = 0; i < n && destBuildQueue.length; i++) {
      buildDestTile(destBuildQueue.shift());
    }
    destBuildRaf = destBuildQueue.length ? requestAnimationFrame(drainDestBuildQueue) : null;
  }

  // Actually creates the mesh for a loaded image — split out of
  // fetchDestGridCell's onload so drainDestBuildQueue can throttle how many
  // of these run per frame regardless of how many images happen to finish
  // around the same time.
  function buildDestTile({
    key, img, lat, lon, z, opacity, polyOffset,
  }) {
    if (!destTileCache.has(key)) return; // disposed (overview closed, or superseded by a later flight) before its turn came up
    const texture = new Texture(img);
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    const geometry = buildGroundPatch(lat, lon, z);
    // polygonOffset biases which tier wins the depth test where they
    // overlap (more negative = closer to camera = wins) — see each caller
    // below for the actual ordering. opacity < 1 (this tier's edge-fade)
    // needs transparent:true or it's simply ignored.
    const material = new MeshBasicMaterial({
      map: texture, toneMapped: false, transparent: opacity < 1, opacity,
      polygonOffset: true, polygonOffsetFactor: polyOffset, polygonOffsetUnits: polyOffset,
    });
    applyGlobeShading(material);
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    destTileCache.set(key, { mesh });
  }

  function fetchDestGridCell({
    z, ix, iy, cellSize, opacity, polyOffset,
  }) {
    if (!apiKey) return;
    const key = `${z}_${ix}_${iy}`;
    // Two tiers can clamp to the same z (both hitting the wholeGlobeZ+1
    // floor, say) and request the exact same cell twice — tiers are always
    // queued finest-first (see prefetchDestinationGrid), so whichever got
    // here first owns it.
    if (destTileCache.has(key)) return;
    destTileCache.set(key, { mesh: null });
    const lon = xToLng(ix * cellSize);
    const lat = yToLat(iy * cellSize);
    // scale=1 here, not the primary grid's REQUEST_SCALE (2/retina) — these
    // tiers are already deliberately coarse/blurry by design (see
    // destPrefetchParams' own comment), so paying for 4x the pixels
    // (scale doubles both axes) to render them softened and often partly
    // occluded by the finer tier on top is pure waste — real bytes over
    // the network and real decode time for detail that was never going to
    // read as sharp anyway.
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=${z}&size=${REQUEST_SIZE}x${REQUEST_SIZE}&scale=1&maptype=satellite&key=${apiKey}`;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      destBuildQueue.push({
        key, img, lat, lon, z, opacity, polyOffset,
      });
      if (destBuildRaf === null) destBuildRaf = requestAnimationFrame(drainDestBuildQueue);
    };
    img.onerror = () => destTileCache.delete(key);
    img.src = url;
  }

  // Queues one full (2*radius+1)^2 tier centered on (latDeg, lonDeg) at
  // zoom z, fading each cell's opacity from fully opaque at the center to
  // (1 - fadeStrength) at that tier's own outer edge (chebyshev distance,
  // matching the square grid itself) — a cheap per-tile stand-in for a true
  // per-pixel radial fade, soft enough in practice to flatten the seam
  // considerably without needing to reason about exact geographic overlap
  // between tiers of two different resolutions.
  function fetchDestRing(latDeg, lonDeg, z, radius, fadeStrength, polyOffset) {
    const cellSize = REQUEST_SIZE / 2 ** z;
    const ixCenter = Math.round(worldX(lonDeg) / cellSize);
    const iyCenter = Math.round(worldY(latDeg) / cellSize);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cellDist = Math.max(Math.abs(dx), Math.abs(dy));
        const edgeT = radius > 0 ? cellDist / radius : 0;
        const opacity = 1 - fadeStrength * edgeT;
        destFetchQueue.push({
          z, ix: ixCenter + dx, iy: iyCenter + dy, cellSize, opacity, polyOffset,
        });
      }
    }
    if (destFetchRaf === null) destFetchRaf = requestAnimationFrame(drainDestFetchQueue);
  }

  function prefetchDestinationGrid(latDeg, lonDeg) {
    disposeDestTiles(); // a fresh flight supersedes whatever the last one was pre-rendering
    const {
      highRes, medRes, lowRes, veryLowRes, edgeFadeStrength,
    } = destPrefetchParams;
    const destZ = fetchZoomFor(flyInParams.zoom);
    if (destZ <= wholeGlobeZ + 1) return; // the permanent whole-globe layer already covers this — see ensureGrid's own guard
    // Ordered finest to coarsest — a disabled tier (radius 0) just drops
    // out, so e.g. sliding highRes to 0 cleanly leans on medRes as the
    // sharpest layer instead. Whichever tier ends up finest gets pulled
    // fully in front of the pre-flight grid (offset -1: it's the
    // destination's own best available detail, so it should always win);
    // every tier after that only needs to beat the permanent whole-globe
    // fallback (offset 1), staying level with or behind the pre-flight
    // grid so it doesn't cover up whatever's already more relevant to the
    // *current* view.
    const tiers = [highRes, medRes, lowRes, veryLowRes].filter((t) => t.radius > 0);
    tiers.forEach((tier, i) => {
      const z = Math.max(wholeGlobeZ + 1, destZ - tier.zoomDrop);
      const offset = i === 0 ? -1 : i / tiers.length;
      fetchDestRing(latDeg, lonDeg, z, tier.radius, edgeFadeStrength, offset);
    });
  }

  // --- Input -----------------------------------------------------------------
  // Zooming in is far more perceptible per zoom-level than zooming out (each
  // level roughly doubles magnification), so it gets its own, gentler
  // sensitivity — scrolling out stays responsive, scrolling in eases in a
  // bit slower instead of overshooting several levels in one flick.
  //
  // The two previous passes at this both missed the same thing: a single
  // *physical mouse-wheel notch* (one discrete click, not a trackpad's
  // stream of small events) sends one wheel event with deltaY around 100.
  // Sensitivity has to be high enough that deltaY*sensitivity alone reaches
  // maxSpeed on that one event — otherwise the velocity never saturates and
  // raising maxSpeed further does nothing for a mouse-wheel user, only for
  // a trackpad's rapid-fire stream of events (each adding its own impulse
  // before the last one decays). At the previous 0.004, one 100-deltaY
  // notch only reached velocity 0.4 out of a maxSpeed of 0.9 — nowhere
  // near saturated. Both constants below are chosen together so a single
  // average notch (deltaY ~100) reliably saturates maxSpeed on its own.
  const WHEEL_ZOOM_IN_SENSITIVITY = 0.03;
  const WHEEL_ZOOM_OUT_SENSITIVITY = 0.05;

  // Same "flick and glide" primitive the local ground view's dolly-zoom
  // uses (see camera/scrollVelocity.ts) — one wheel flick keeps easing for
  // a beat instead of the zoom level snapping exactly to each raw event's
  // deltaY. The in/out sensitivity asymmetry (see the comment above) is
  // applied before the impulse goes in, so the shared primitive itself
  // stays direction-agnostic — sensitivity here is 1, a pure passthrough.
  // A single saturated impulse's *total* eventual displacement is
  // maxSpeed / damping (the velocity's full exponential decay, integrated)
  // — 2.5 / 5 = 0.5 zoom levels per notch, out of the ~19-level
  // (minZoom..maxZoom) range: enough that a handful of notches covers a
  // meaningful chunk of the range, without one notch overshooting several
  // levels outright.
  const zoomVelocity = createScrollVelocity({ sensitivity: 1, damping: 5, maxSpeed: 2.5 });
  let zoomRaf = null;
  // The cursor position onWheel last fired at — stepZoomVelocity below
  // keeps re-centering on this every eased frame of the glide, not just
  // the instant the wheel itself moved, so the point under the cursor
  // stays put for the whole flick-and-glide, not just its first frame.
  let lastWheelX = 0;
  let lastWheelY = 0;

  function stepZoomVelocity() {
    let lastT = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(0.048, (now - lastT) / 1000);
      lastT = now;
      const applied = zoomVelocity.update(dt);
      if (applied !== 0) {
        // Zoom toward the cursor, exactly — not the "first-order
        // approximation" this used to deliberately avoid (see the removed
        // comment that used to sit here). The difference is real
        // raycasting: find the ground point under the cursor *before*
        // changing zoom, apply the zoom change, find where that same
        // pixel now raycasts to, and pan by exactly the resulting drift.
        // Two genuine ray/sphere intersections, not an estimate, so —
        // unlike the old per-tick formula this replaces — repeating it
        // every eased frame of a long scroll can't accumulate drift the
        // way an approximation would. Uses raySphereLatLon (not
        // screenToLatLon) deliberately: at a deep enough zoom the cursor's
        // fixed screen position can hit the globe before the zoom change
        // but miss it after (the visible patch shrinks as you zoom in), or
        // vice versa. screenToLatLon's fallback-to-current-center on a miss
        // is fine for drag-panning, but here it would diff a real hit
        // against a stale fallback and inject a spurious jump into
        // centerLat/centerLon — bad enough, on a bad-luck frame, to leave
        // the camera looking at empty space and the raycast missing on
        // every subsequent frame too, reading as the zoom having frozen.
        // Skipping the correction outright on a miss avoids ever injecting
        // that jump in the first place.
        const before = raySphereLatLon(lastWheelX, lastWheelY);
        zoom = Math.min(maxZoom, Math.max(minZoom, zoom - applied));
        applyCamera();
        const after = raySphereLatLon(lastWheelX, lastWheelY);
        if (before && after) {
          centerLat += before.lat - after.lat;
          centerLon += before.lon - after.lon;
          clampCenter();
        }
      }
      applyCamera();
      ensureGrid();
      zoomRaf = (!flying && applied !== 0) ? requestAnimationFrame(step) : null;
    };
    zoomRaf = requestAnimationFrame(step);
  }

  function stopZoomVelocity() {
    if (zoomRaf) {
      cancelAnimationFrame(zoomRaf);
      zoomRaf = null;
    }
    zoomVelocity.reset();
  }

  function onWheel(e) {
    if (flying) return;
    e.preventDefault();
    // Re-centers toward wherever the cursor was on the *most recent* wheel
    // event of the current flick-and-glide, not a fresh point every frame
    // — a trackpad's later events during one continuous gesture land
    // almost exactly where the earlier ones did anyway, and holding it
    // fixed avoids re-raycasting a cursor position that hasn't actually
    // moved. See stepZoomVelocity for the actual before/after correction.
    lastWheelX = e.clientX;
    lastWheelY = e.clientY;
    const sensitivity = e.deltaY < 0 ? WHEEL_ZOOM_IN_SENSITIVITY : WHEEL_ZOOM_OUT_SENSITIVITY;
    zoomVelocity.addImpulse(e.deltaY * sensitivity);
    if (zoomRaf === null) stepZoomVelocity();
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  // Google-Earth-style "throw": the drag's recent lat/lon speed carries over
  // as a decaying glide once the mouse releases, instead of stopping dead.
  let lastMoveTime = 0;
  let velLat = 0; // deg/ms
  let velLon = 0; // deg/ms
  let momentumRaf = null;
  const MOMENTUM_FRICTION = 0.96; // per-~16.6ms-frame velocity decay
  const MOMENTUM_MIN_SPEED = 0.0002; // deg/ms — below this, just stop

  function stopMomentum() {
    stopZoomVelocity(); // pan-throw and zoom-glide always start/stop together
    if (momentumRaf) {
      cancelAnimationFrame(momentumRaf);
      momentumRaf = null;
    }
  }

  function onPointerDown(e) {
    if (flying) return;
    stopMomentum();
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    lastMoveTime = performance.now();
    velLat = 0;
    velLon = 0;
    renderer.domElement.style.cursor = 'grabbing';
  }
  function onPointerMove(e) {
    if (!dragging || flying) return;
    // Raycast-based — exact under the camera's tilt and the sphere's
    // curvature, unlike a fixed per-pixel scale.
    const now = performance.now();
    const dt = Math.max(1, now - lastMoveTime);
    const before = screenToLatLon(lastX, lastY);
    const after = screenToLatLon(e.clientX, e.clientY);
    const dLat = -(after.lat - before.lat);
    const dLon = -(after.lon - before.lon);
    centerLat += dLat;
    centerLon += dLon;
    // Blend into the running velocity rather than overwrite it outright, so
    // one jittery final sample right before release doesn't fully dictate
    // the throw's speed/direction.
    velLat = velLat * 0.5 + (dLat / dt) * 0.5;
    velLon = velLon * 0.5 + (dLon / dt) * 0.5;
    lastX = e.clientX;
    lastY = e.clientY;
    lastMoveTime = now;
    clampCenter();
    applyCamera();
    ensureGrid();
  }
  function onPointerUp() {
    dragging = false;
    renderer.domElement.style.cursor = 'grab';
    if (flying || (Math.abs(velLat) <= MOMENTUM_MIN_SPEED && Math.abs(velLon) <= MOMENTUM_MIN_SPEED)) return;
    let lastT = performance.now();
    const step = () => {
      const now = performance.now();
      // Clamp dt so a stalled tab (backgrounded, GC pause) doesn't resume
      // with one giant catch-up jump.
      const dt = Math.min(48, now - lastT);
      lastT = now;
      centerLat += velLat * dt;
      centerLon += velLon * dt;
      velLat *= MOMENTUM_FRICTION;
      velLon *= MOMENTUM_FRICTION;
      clampCenter();
      applyCamera();
      ensureGrid();
      if (!flying && (Math.abs(velLat) > MOMENTUM_MIN_SPEED || Math.abs(velLon) > MOMENTUM_MIN_SPEED)) {
        momentumRaf = requestAnimationFrame(step);
      } else {
        momentumRaf = null;
      }
    };
    momentumRaf = requestAnimationFrame(step);
  }

  // --- Hover-anticipation: proximity to a marker, not just clicking one —
  // fires loc.onHoverNear() so main.js's preload manager can start pulling
  // in that destination's tiles before the click that actually needs them.
  // Skipped mid-drag/mid-flight, where it'd either spam checks against a
  // moving view for no reason or duplicate what the click itself already
  // triggers.
  const hoverFired = new Map(); // loc.name -> last-fired timestamp, for hoverParams.debounceMs
  function onHoverCheck(e) {
    onActivity?.();
    if (dragging || flying) return;
    const now = performance.now();
    for (const m of markers) {
      const point = markerOverlay.getScreenPoint(m.loc.name);
      if (!point) continue;
      const dist = Math.hypot(e.clientX - point.x, e.clientY - point.y);
      if (dist > hoverParams.radiusPx) continue;
      const last = hoverFired.get(m.loc.name) || 0;
      if (now - last < hoverParams.debounceMs) continue;
      hoverFired.set(m.loc.name, now);
      m.loc.onHoverNear?.();
    }
  }

  const prevCursor = renderer.domElement.style.cursor;
  renderer.domElement.style.cursor = 'grab';
  // domParent, not renderer.domElement: the marker <div>s (see buildMarker)
  // are siblings of the canvas under domParent, not descendants of it, so a
  // listener scoped to the canvas alone never sees a wheel event whose
  // target is a marker the cursor happens to be over — wheel events only
  // bubble up their own ancestor chain, never sideways into a sibling.
  // Scoping to domParent instead covers both without changing anything
  // about how the event itself is handled.
  domParent.addEventListener('wheel', onWheel, { passive: false });
  renderer.domElement.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mousemove', onHoverCheck);
  window.addEventListener('mouseup', onPointerUp);
  window.addEventListener('resize', resize);

  // --- "Explore" title + skip button, overlaid on the canvas -----------------
  const title = document.createElement('div');
  title.textContent = 'Explore';
  title.style.cssText = `
    position: fixed; top: 28px; left: 50%; transform: translateX(-50%);
    font: 600 14px system-ui, -apple-system, sans-serif; letter-spacing: 0.12em; text-transform: uppercase;
    color: #f2f4f8; opacity: 0.75; text-shadow: 0 2px 8px rgba(0,0,0,0.6);
    pointer-events: none; z-index: 20;
  `;
  domParent.appendChild(title);

  const enterBtn = document.createElement('button');
  enterBtn.textContent = 'Enter →';
  enterBtn.style.cssText = `
    position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
    appearance: none; border: 1px solid rgba(255,255,255,0.25);
    background: rgba(18,20,26,0.75); backdrop-filter: blur(10px);
    color: #f2f4f8; font: inherit; font-size: 13px; font-weight: 600;
    padding: 10px 22px; border-radius: 999px; cursor: pointer; z-index: 20;
  `;
  enterBtn.addEventListener('click', () => onSkip?.());
  domParent.appendChild(enterBtn);

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.textContent = '⤢ Zoom Out';
  zoomOutBtn.style.cssText = `
    position: fixed; top: 28px; right: 28px;
    appearance: none; border: 1px solid rgba(255,255,255,0.25);
    background: rgba(18,20,26,0.75); backdrop-filter: blur(10px);
    color: #f2f4f8; font: inherit; font-size: 12px; font-weight: 600;
    padding: 8px 16px; border-radius: 999px; cursor: pointer; z-index: 20;
  `;
  zoomOutBtn.addEventListener('click', () => {
    if (flying) return;
    stopMomentum();
    centerLat = (US_FRAME_BOUNDS.south + US_FRAME_BOUNDS.north) / 2;
    centerLon = (US_FRAME_BOUNDS.west + US_FRAME_BOUNDS.east) / 2;
    zoom = Math.min(maxZoom, Math.max(minZoom, initialUSFitZoom()));
    applyCamera();
    ensureGrid();
  });
  domParent.appendChild(zoomOutBtn);

  // Debug reference point: a fixed dot at the exact geometric center of the
  // viewport, independent of any camera/projection math — since applyCamera()
  // always points the camera at groundP (the sphere point under centerLat/
  // centerLon), the *ground* directly under this dot should always be
  // centerLat/centerLon exactly. Comparing this against a marker that's
  // supposed to be centered (e.g. right after flyTo finishes) isolates
  // whether the mismatch is in the marker's own projection or somewhere else
  // (the ground render, tile fetch timing, etc).
  // Off by default — press C to toggle. A permanent on-screen dot has no
  // place in the normal experience; this is purely a debugging aid.
  const centerDot = document.createElement('div');
  centerDot.style.cssText = `
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: 10px; height: 10px; border-radius: 50%;
    background: #00e5ff; border: 2px solid #fff;
    box-shadow: 0 0 0 2px rgba(0,0,0,0.5), 0 0 8px rgba(0,229,255,0.9);
    z-index: 30; pointer-events: none; display: none;
  `;
  domParent.appendChild(centerDot);
  function onCenterDotKeyDown(e) {
    if (e.code === 'KeyC') centerDot.style.display = centerDot.style.display === 'none' ? 'block' : 'none';
  }
  window.addEventListener('keydown', onCenterDotKeyDown);

  // Frame the whole continental US on mount — unless arriving via
  // startZoomOutToOverview (main.js), which hands a `seed`: the exact
  // lat/lon/zoom/bearing the local view just ascended away from, so the
  // overview opens already on that same close-in shot instead of an
  // instant jump back out to the continental view, and flyOut (below)
  // animates the actual zoom-out from there.
  if (seed) {
    centerLat = seed.lat;
    centerLon = seed.lon;
    tiltAzimuthRad = seed.bearing ?? 0;
  } else {
    centerLat = (US_FRAME_BOUNDS.south + US_FRAME_BOUNDS.north) / 2;
    centerLon = (US_FRAME_BOUNDS.west + US_FRAME_BOUNDS.east) / 2;
  }
  computeZoomBounds();
  zoom = seed ? Math.min(maxZoom, Math.max(minZoom, seed.zoom)) : Math.min(maxZoom, Math.max(minZoom, initialUSFitZoom()));
  entryZoom = seed ? Math.min(maxZoom, Math.max(minZoom, initialUSFitZoom())) : zoom;
  resize();
  wholeGlobeZ = ensureGlobeBase(scene, apiKey, fetchZoomFor(entryZoom));
  ensureGrid();
  // Even with the globe base always resident (above), a seeded mount opens
  // zoomed in on one specific spot — the location just departed — and
  // nothing has prefetched *that* area's own finer tiles the way a real
  // flyTo dive-in does on click. flyOut's own zoom is already moving away
  // from this spot from t=0, so this isn't chasing a long head start the
  // way prefetchLocationHeavy's click trigger does — it's just making sure
  // something better than the whole-globe layer alone is at least in
  // flight for the brief moment before that zoom-out actually clears it.
  if (seed) prefetchDestinationGrid(seed.lat, seed.lon);
  if (seed) flyOut();

  // The reverse of flyTo — eases zoom/pan/bearing from wherever flyTo (or a
  // seeded mount, see above) left off back out to the normal whole-US
  // resting framing, rather than an instant unexplained snap. Deliberately
  // asymmetric easing, same reasoning as flyTo's own (see its comment) just
  // mirrored: ease-OUT so it opens at full speed — carrying whatever
  // momentum the local ascend that led here already had — and settles
  // gently into the resting view, instead of easing in a second time right
  // after the ascend already did.
  function flyOut() {
    if (flying) return;
    stopMomentum();
    flying = true;
    const startLat = centerLat;
    const startLon = centerLon;
    const startZoom = zoom;
    const startAzimuth = tiltAzimuthRad;
    const destLat = (US_FRAME_BOUNDS.south + US_FRAME_BOUNDS.north) / 2;
    const destLon = (US_FRAME_BOUNDS.west + US_FRAME_BOUNDS.east) / 2;
    const destZoom = initialUSFitZoom();
    // Shortest-path back to north — see flyTo's identical comment.
    let azimuthDelta = 0 - startAzimuth;
    azimuthDelta = ((azimuthDelta % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    const { ms: flyMs, panMs } = flyInParams;
    // The reverse of flyTo's own pairing (see getMovementCurve/movementParams
    // in flightCurves.ts): zoom opens at full curve speed here — carrying
    // whatever momentum the local ascend that led here already had — while
    // pan opens slow and only picks up speed as zoom's own speed fades, so
    // the two swap dominance the other way around from flyTo.
    const zoomCurve = getMovementCurve('zoomOut');
    const panCurve = getMovementCurve('panOut');
    const t0 = performance.now();
    overviewFlightState.active = true;
    function step(now) {
      const elapsed = now - t0;
      const zoomE = zoomCurve(Math.min(elapsed / flyMs, 1));
      // Panning back to center finishes late here, not early — flyTo's own
      // pan finishes FAST because the destination needs to be centered
      // before diving in; flyOut has no such destination to frame, so
      // panning back to the continental center just rides along with zoom
      // instead of racing ahead of it.
      const panE = panCurve(Math.min(elapsed / Math.max(panMs, flyMs), 1));
      const azimuthE = easeInOutCubic(Math.min(elapsed / flyMs, 1));
      centerLat = startLat + (destLat - startLat) * panE;
      centerLon = startLon + (destLon - startLon) * panE;
      zoom = startZoom + (destZoom - startZoom) * zoomE;
      tiltAzimuthRad = startAzimuth + azimuthDelta * azimuthE;
      overviewFlightState.blurStrength = 1 - zoomE;
      applyCamera();
      ensureGrid();
      if (elapsed < flyMs) {
        flyRaf = requestAnimationFrame(step);
      } else {
        flying = false;
        overviewFlightState.active = false;
        overviewFlightState.blurStrength = 0;
      }
    }
    flyRaf = requestAnimationFrame(step);
  }

  function dispose() {
    if (flyRaf) cancelAnimationFrame(flyRaf);
    stopMomentum();
    camera.near = savedCameraNear;
    camera.updateProjectionMatrix();
    window.removeEventListener('mousemove', onPointerMove);
    window.removeEventListener('mousemove', onHoverCheck);
    window.removeEventListener('mouseup', onPointerUp);
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onCenterDotKeyDown);
    domParent.removeEventListener('wheel', onWheel);
    renderer.domElement.removeEventListener('mousedown', onPointerDown);
    renderer.domElement.style.cursor = prevCursor;
    markerOverlay.dispose();
    title.remove();
    enterBtn.remove();
    zoomOutBtn.remove();
    centerDot.remove();
    // Hidden, not disposed — see ensureGlobeBase/setGlobeBaseVisible's own
    // comment on why this persists across mount/dispose cycles now.
    setGlobeBaseVisible(false);
    if (gridRebuildTimer) { clearTimeout(gridRebuildTimer); gridRebuildTimer = null; }
    clearTileCache();
    disposeDestTiles();
  }

  return {
    dispose,
    // The native Static Maps resolution actually backing whatever's on
    // screen right now — frozen at wholeGlobeZ while zoomed out past the
    // entry level, jumping straight to a finer tier once past the
    // LOD-skip guard in ensureGrid. Exposed for the debug readout.
    getLod: () => fetchZoomFor(zoom),
  };
}
