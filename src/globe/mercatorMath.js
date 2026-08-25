// Web Mercator "slippy map" math (TILE_SIZE, doubling per zoom level) and
// real spherical placement on the globe — shared by usMap.js's own live
// per-frame grid/camera code and by globeBase.js's persistent-layer
// fetching, which is the whole reason this is its own module rather than
// living in either one of them.
import { Vector3 } from 'three';

export const TILE_SIZE = 256;

// Meters per Mercator zoom-0 world-unit (TILE_SIZE=256 convention),
// compressed by an arbitrary meters-per-scene-unit factor so the whole
// globe and the camera's overview altitude both stay comfortably within the
// main camera's existing near/far planes without touching them.
export const METERS_PER_MERCATOR_UNIT = 156543.03392804097;
export const SCENE_UNITS_PER_METER = 1 / 3000;
export const SCENE_UNITS_PER_MERCATOR_UNIT = METERS_PER_MERCATOR_UNIT * SCENE_UNITS_PER_METER;
export const EARTH_RADIUS_SCENE = 6371000 * SCENE_UNITS_PER_METER;

// Used only to frame the *initial* view (whole continental US visible) —
// panning/zooming are no longer clamped to this or any other region; you
// can orbit anywhere on the globe, and each new area gets its own fetch.
export const US_FRAME_BOUNDS = {
  west: -124.5, east: -71.5, south: 24.0, north: 49.5,
};

export function worldX(lng) {
  return ((lng + 180) / 360) * TILE_SIZE;
}
export function worldY(lat) {
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return y * TILE_SIZE;
}
export function xToLng(x) {
  return (x / TILE_SIZE) * 360 - 180;
}
// A raw xToLng(...) result can land outside ±180 two different ways, both
// near the antimeridian: ensureGrid/prefetchDestinationGrid build a cell's
// ix by offsetting from a center cell (ixCenter + dx), which can walk past
// the real column range while exploring the Alaska/Aleutians area (see
// wrapCellIx below); loadWholeGlobeAtEntryDetail's ix instead sweeps a
// fixed 0..nCellsLon-1 every time, but nCellsLon is a ceil() of a generally
// non-integer TILE_SIZE/cellSize (true for Google's 640px cells), which
// overshoots 360° of real coverage — deliberately, to guarantee no gap at
// the seam (see its own comment) — so that final column's center still
// lands past 180 even though its ix is perfectly in-range. Either way, an
// out-of-range lon reaching Google's center= param doesn't error; it
// silently resolves to imagery for some unrelated point (observed: a
// request built this way at lon 185.625 returned imagery for lon 0 —
// Africa — striped in among genuine Alaska tiles instead of it). Confirmed
// live via this app's own network requests before writing this fix, not
// from a spec reading of Google's API. Every lon this app hands to a
// provider is wrapped through this on the way out.
export function wrapLon(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}
// Esri's buildTileUrl uses ix directly as its own tile-x, which a real XYZ
// tile server won't have past its actual column count — wrapLon alone
// doesn't help there since Esri never even reads the lon this file derives
// from ix, only ix itself. Only matters for ensureGrid/prefetchDestination-
// Grid's centered-offset ix (see wrapLon's own comment); cellsPerRow is an
// exact 2^z for Esri (whose cellSize is a clean TILE_SIZE/2^z division), so
// this cleanly wraps ix the same way a standard XYZ provider would.
export function wrapCellIx(ix, cellSize) {
  const cellsPerRow = TILE_SIZE / cellSize;
  return ((ix % cellsPerRow) + cellsPerRow) % cellsPerRow;
}
export function yToLat(y) {
  const n = Math.PI - (2 * Math.PI * y) / TILE_SIZE;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// Real spherical placement — Y is the polar axis (matches three.js y-up),
// lon=0 at +Z, lon=90° at +X (east).
export function sphereXYZ(latDeg, lonDeg, r) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const cosLat = Math.cos(lat);
  return new Vector3(r * cosLat * Math.sin(lon), r * Math.sin(lat), r * cosLat * Math.cos(lon));
}
// Unit tangent pointing toward increasing latitude (north) at that point.
export function sphereNorth(latDeg, lonDeg) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return new Vector3(-Math.sin(lat) * Math.sin(lon), Math.cos(lat), -Math.sin(lat) * Math.cos(lon));
}
// Unit tangent pointing toward increasing longitude (east) at that point —
// the derivative of sphereXYZ w.r.t. longitude, normalized (latitude-
// independent once normalized, since cosLat cancels out).
export function sphereEast(lonDeg) {
  const lon = (lonDeg * Math.PI) / 180;
  return new Vector3(Math.cos(lon), 0, -Math.sin(lon));
}
