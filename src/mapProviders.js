// Pluggable satellite-imagery sources for the globe overview, behind one
// shared per-tile URL-building contract — usMap.js's own grid/geometry
// code (buildGroundPatch, the cell-size formulas, the whole-globe/US-region/
// live-grid/destination-prefetch fetch functions) stays identical
// regardless of which provider is active; only the URL a given cell
// resolves to (and how big/scaled that provider's own tiles are) differs.
//
// This works cleanly because usMap.js's cell grid is edge-aligned to
// cellPx/2^z world-units — cell (ix, iy) at zoom z spans exactly
// [ix, ix+1) * cellSize in zoom-0 Mercator world-space (see usMap.js's own
// comment on the ix/iy +0.5 center-of-cell fix). For a provider whose
// cellPx matches its own native tile size (Esri: 256, the standard XYZ
// tile width), that means ix/iy in this app's own grid indexing already
// *are* that provider's own tile x/y — no lat/lon math or tile-stitching
// needed to bridge the two. Google's Static Maps API works the opposite
// way (an arbitrary center point + a custom request size, not a fixed
// tile grid at all) — its own adapter below just uses the cell's center
// lat/lon directly and ignores ix/iy entirely, since its API doesn't need
// them.
export const googleProvider = {
  id: 'google',
  name: 'Google Static Maps',
  // Bigger than a standard 256px tile — Google's flexible arbitrary-size
  // API means fewer, bigger requests cover the same area, unlike a fixed-
  // tile provider like Esri below.
  cellPx: 640,
  scale: 2, // retina — same geographic coverage, sharper texture
  requiresApiKey: true,
  // Only Google's arbitrary-size API can return the entire equirectangular
  // world in one request — see usMap.js's fetchBaseGlobe, which is the
  // only place this matters.
  supportsWholeWorldImage: true,
  // Baked directly into every fetched image's own pixels by Google's API
  // — no separate on-screen credit needed (see usMap.js's attribution
  // overlay, which only renders for providers that don't bake their own).
  attribution: null,
  // scale is overridable per-call (not just this.scale) — the destination
  // pre-render's own deliberately-coarse tiers ask for scale=1 regardless
  // of the provider's normal retina setting, since that imagery is only
  // ever shown softened/partly-occluded under the sharper live tier that
  // arrives on top of it (see fetchDestGridCell's own comment) — paying
  // for 4x the pixels there is pure waste.
  buildTileUrl({
    lat, lon, z, apiKey, scale = 2,
  }) {
    return `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=${z}&size=640x640&scale=${scale}&maptype=satellite&key=${apiKey}`;
  },
};

export const esriProvider = {
  id: 'esri',
  name: 'Esri World Imagery',
  cellPx: 256, // matches this service's own native XYZ tile size exactly
  scale: 1, // no retina variant on this free service
  requiresApiKey: false,
  supportsWholeWorldImage: false, // fixed 256px tiles only — see usMap.js's fetchBaseGlobe
  // Not baked into the imagery — Esri's terms require this credit
  // rendered separately (see usMap.js's attribution overlay).
  attribution: 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
  buildTileUrl({ z, ix, iy }) {
    // Standard XYZ addressing (note ArcGIS's own path order: z/y/x, not
    // z/x/y) — ix/iy already *are* this service's own tile numbers, per
    // this module's own top comment on why no lat/lon conversion is
    // needed here the way Google's adapter above needs one.
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${iy}/${ix}`;
  },
};

export const PROVIDERS = { google: googleProvider, esri: esriProvider };
export const DEFAULT_PROVIDER_ID = 'google';
