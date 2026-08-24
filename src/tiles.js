import { Vector3, Matrix4, PerspectiveCamera } from 'three';
import { TilesRenderer, OBJECT_FRAME } from '3d-tiles-renderer/three';
import { GoogleCloudAuthPlugin, GLTFExtensionsPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Downtown Palo Alto (University Ave / City Hall).
const DEFAULT_LAT = 37.4419;
const DEFAULT_LON = -122.1430;

function toRad(deg) {
  return deg * (Math.PI / 180);
}

export function buildTiles(camera, renderer) {
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');

  const tiles = new TilesRenderer();

  tiles.registerPlugin(new GoogleCloudAuthPlugin({
    apiToken: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
  }));

  // Re-center tileset at origin facing up — makes Three.js camera positioning trivial
  const reorientation = new ReorientationPlugin({
    lat: toRad(DEFAULT_LAT),
    lon: toRad(DEFAULT_LON),
  });
  tiles.registerPlugin(reorientation);

  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));

  // errorTarget=2 (tighter than the library default of 16px) used to force
  // extremely fine-LOD tiles to keep streaming in, and the huge cache below
  // meant almost none of it ever got evicted — triangle counts (and draw
  // calls) climbed effectively without bound the longer the camera sat at
  // one spot, tanking frame rate over the course of a session regardless of
  // weather. That level of detail was mostly wasted anyway: the scene is
  // rendered through RenderPixelatedPass at 1/9th resolution (pixelSize=3)
  // before being upscaled for the retro look, so ultra-fine tile geometry
  // gets rasterized into a coarse, blocky buffer and thrown away. Left at
  // the library default now — main.js's syncTilesResolution() corrects the
  // resolution this is measured against down to what the pixelation pass
  // actually rasterizes, so the default error target already resolves
  // detail to match what's visible instead of what the raw CSS size implies.
  tiles.errorTarget = 16;
  tiles.lruCache.maxBytesSize = 400 * 1024 * 1024;
  tiles.lruCache.maxSize = 4000;

  tiles.setCamera(camera);
  // Resolution (for screen-space-error/LOD calc) is set from main.js once
  // the composer exists — it needs to account for RenderPixelatedPass's
  // internal downsample, not the renderer's full CSS size, or tile
  // selection ends up resolving detail nothing ever actually displays.
  tiles.setResolutionFromRenderer(camera, renderer);

  tiles.teleport = (latDeg, lonDeg, height = 0) => {
    reorientation.transformLatLonHeightToOrigin(toRad(latDeg), toRad(lonDeg), height);
  };
  tiles.defaultLatLon = { lat: DEFAULT_LAT, lon: DEFAULT_LON };

  // Converts a position in the recentered local scene (e.g. camera.position)
  // back to real-world geographic coordinates. tiles.group.matrixWorld maps
  // the group's *local* space (where the raw tile geometry lives, in ECEF)
  // into this recentered scene space — i.e. ECEF -> local — so getting from
  // a local/scene position back to ECEF needs its inverse.
  const _ecef = new Vector3();
  const _cart = {};
  const _localToEcef = new Matrix4();
  tiles.getGeoPosition = (localPosition) => {
    _localToEcef.copy(tiles.group.matrixWorld).invert();
    _ecef.copy(localPosition).applyMatrix4(_localToEcef);
    tiles.ellipsoid.getPositionToCartographic(_ecef, _cart);
    return {
      lat: _cart.lat * (180 / Math.PI),
      lon: _cart.lon * (180 / Math.PI),
      height: _cart.height,
    };
  };

  // Warms the shared tile cache for a location the visible camera isn't at
  // yet, without a second TilesRenderer/WebGL context: a second, unrendered
  // camera dropped at that lat/lon and registered alongside the real one.
  // TilesRenderer streams for the union of every registered camera's
  // frustum, and both share the same LRU cache, so whatever this pulls in
  // is already resident by the time a real teleport there happens.
  // resolutionW/H default small (coarser tiles satisfy the same errorTarget)
  // for the light, generic "warm every location a little" background pass —
  // callers that already know exactly where a visit is headed (see
  // prefetchLocationHeavy in main.js) pass a much larger resolution instead,
  // to pull in the same fine detail the real arrival would.
  const _prefetchPos = new Vector3();
  const _prefetchTarget = new Vector3();
  tiles.prefetch = (latDeg, lonDeg, {
    heightAboveGround = 700, durationMs = 12000, resolutionW = 96, resolutionH = 96,
  } = {}) => {
    const cam = new PerspectiveCamera(55, 1, 1, 20000);
    tiles.ellipsoid.getCartographicToPosition(toRad(latDeg), toRad(lonDeg), heightAboveGround, _prefetchPos);
    tiles.ellipsoid.getCartographicToPosition(toRad(latDeg), toRad(lonDeg), 0, _prefetchTarget);
    cam.position.copy(_prefetchPos).applyMatrix4(tiles.group.matrixWorld);
    cam.up.set(0, 1, 0);
    cam.lookAt(_prefetchTarget.applyMatrix4(tiles.group.matrixWorld));
    cam.updateMatrixWorld(true);

    tiles.setCamera(cam);
    tiles.setResolution(cam, resolutionW, resolutionH);
    setTimeout(() => tiles.deleteCamera(cam), durationMs);
  };

  // Converts a point in some OTHER (not necessarily current) teleport
  // origin's recentered local space back to real-world lat/lon/height —
  // e.g. a saved view's `target`, which is only meaningful relative to the
  // lat/lon it was authored against, not wherever the tileset happens to be
  // centered right now. getObjectFrame(originLat, originLon, 0, ...) builds
  // exactly the local-to-ECEF matrix teleporting there would use (the same
  // call ReorientationPlugin itself makes — see its transformLatLonHeight-
  // ToOrigin), independent of the live tiles.group transform, so this works
  // correctly no matter where the tileset is actually centered right now.
  const _geoAtMatrix = new Matrix4();
  const _geoAtEcef = new Vector3();
  const _geoAtCart = {};
  tiles.geoAt = (originLatDeg, originLonDeg, localPoint) => {
    tiles.ellipsoid.getObjectFrame(toRad(originLatDeg), toRad(originLonDeg), 0, 0, 0, 0, _geoAtMatrix, OBJECT_FRAME);
    _geoAtEcef.copy(localPoint).applyMatrix4(_geoAtMatrix);
    tiles.ellipsoid.getPositionToCartographic(_geoAtEcef, _geoAtCart);
    return {
      lat: _geoAtCart.lat * (180 / Math.PI),
      lon: _geoAtCart.lon * (180 / Math.PI),
      height: _geoAtCart.height,
    };
  };

  return tiles;
}
