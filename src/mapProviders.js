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
  // See esriProvider's own comment below on what this compensates for —
  // Google's own scale:2 already delivers full retina texel density, so it
  // needs no extra zoom-level compensation.
  lodBiasOffset: 0,
  // Google's own color response is what applyGlobeShading (usMap.js) was
  // tuned to look good on — no correction needed, so every field here is
  // that pipeline's identity value (see esriProvider's own colorGrade for
  // what a real one does, and usMap.js's applyGlobeShading for what each
  // field controls).
  colorGrade: {
    whiteBalance: [1, 1, 1],
    exposure: 1,
    contrast: 1,
    hslBands: [],
    blueShadowLift: 0,
  },
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
  // fetchZoomFor's zoom-level math (see usMap.js) was tuned against
  // Google's own scale:2 retina imagery — a fixed 256px tile at scale:1
  // has half the texel density per world-unit that formula assumes, so
  // without correction Esri renders visibly softer than Google at the
  // "same" computed zoom. +2 fetches two zoom levels finer (4x the texel
  // density) to more than cover that gap from the very first layer that
  // loads, not just after the user zooms in — free/uncapped tiles, so the
  // extra requests cost nothing but a bit more network/GPU memory.
  lodBiasOffset: 2,
  // A fuller grading pipeline than a flat tint — a first tint-only pass
  // (median per-channel google/esri ratio across 5 real sampled tile
  // pairs) closed most of the gap but left two specific things visibly
  // off: a warm cast overall, and — the one that actually prompted this —
  // dark water (the Great Lakes especially) rendering nearly black instead
  // of Google's saturated blue. Each field below is one stage of a normal
  // photographic grade, applied in this order in applyGlobeShading (usMap.js):
  // white balance -> exposure/contrast -> per-hue-range HSL pushes -> a
  // shadow-only lift on the raw blue channel. Values are a direct
  // translation of a manual Lightroom recipe developed against real
  // before/after captures (temp/tint, exposure/contrast, and per-band
  // HSL sliders map fairly directly; the blue tone-curve's shadow lift
  // is approximated as a smooth falloff rather than a literal curve
  // control-point copy). Per-scene lighting/capture-date differences
  // between the two services mean no fixed grade matches every scene
  // exactly — this targets the typical case.
  colorGrade: {
    // Lightroom Temp -13 / Tint +4 (mild cooling + a touch of magenta) —
    // Esri's own warm cast was the single biggest global difference.
    whiteBalance: [0.96, 0.98, 1.04],
    exposure: 1.109, // +0.15 stops = 2^0.15
    contrast: 0.95, // Lightroom Contrast -5
    // Lightroom HSL panel, one entry per band: hue/width in degrees
    // (width = how far the effect reaches before fading to nothing, not a
    // hard cutoff), hueShift in degrees, satShift as a fraction (-1..1).
    // No lumShift here (see blueShadowLift below for why) — a first pass
    // gave Blues/Aquas +45%/+30% "lighten toward white," applied uniformly
    // across the whole hue band regardless of how bright a pixel already
    // was. That's fine on genuinely dark water but on ordinary mid-tone
    // open ocean it roughly doubled the lightness — confirmed live
    // (rendered pixel value, not the raw tile), which is exactly what
    // read as "fluorescent"/"absurd" instead of Google's actual ocean
    // blue. Only the hue rotation (teal -> blue) and a mild saturation
    // nudge survive here; the actual dark-water fix now lives solely in
    // blueShadowLift, which is shadow-only by construction (its falloff
    // is zero by the time a pixel reaches ordinary open-ocean lightness).
    hslBands: [
      { hue: 220, width: 40, hueShift: 12, satShift: 0.05 }, // Blues
      { hue: 190, width: 30, hueShift: 20, satShift: 0 }, // Aquas
      { hue: 55, width: 25, hueShift: 5, satShift: -0.50 }, // Yellows
      { hue: 120, width: 50, hueShift: 0, satShift: -0.40 }, // Greens
      { hue: 30, width: 25, hueShift: 0, satShift: -0.30 }, // Oranges
    ],
    // Approximates the manual recipe's blue-channel tone curve (shadow
    // input ~10/255 lifted to ~35/255, easing back to unchanged by
    // midtones) — a straight smoothstep falloff, not the literal curve
    // control points, but it hits the same two numbers at the same input
    // level (see applyGlobeShading's own comment on this exact formula).
    // This is the fix for water dark enough to have no real hue/
    // saturation for the HSL bands above to grab onto (the Great Lakes,
    // reported nearly black and nearly colorless) — it works directly off
    // the raw blue channel instead, so it still lifts them.
    blueShadowLift: 0.10,
  },
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
