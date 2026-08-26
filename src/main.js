import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildScene } from './scene.js';
import { buildTiles } from './tiles.js';
import { buildSky } from './sky.js';
import { buildClouds, CLOUD_FORMATIONS } from './clouds.js';
import { createPostFxService } from './postprocessing';
import { createWeatherSystem } from './weather';
import { buildPlayerPanel } from './player.js';
import { buildBioPanel } from './bioPanel.js';
import { buildHighlightsPanel } from './highlightsPanel.js';
import { buildLocationBioPanel } from './locationBioPanel.js';
import { buildDevConsole } from './devconsole';
import { buildDevGui as buildDevGuiExternal } from './devGui';
import { createLocalCameraControl } from './camera/localCameraControl';
import {
  mountUSOverview, TILT_RAD, flyInParams, overviewStartParams, overviewFlightState,
  destPrefetchParams, hoverParams, tilesParams,
} from './usMap.js';
import { PROVIDERS } from './mapProviders';
import { createCacheSystem } from './cache';
import { createRenderQualitySystem } from './quality';
import { movementParams, curveOptions } from './flightCurves';
import { settings, exportSettingsToml } from './settings/store';
import { buildSettingsCommand } from './settings/commands';
import { buildTimeCommand } from './commands/timeCommand';
import { buildWeatherCommand } from './commands/weatherCommand';
import { buildStarsCommand } from './commands/starsCommand';
import { buildTravelCommand } from './commands/travelCommand';
import { buildControlsCommand } from './commands/controlsCommand';
import { buildDebugCommand } from './commands/debugCommand';
import { buildCacheCommand } from './commands/cacheCommand';
import { buildQualityCommand } from './commands/qualityCommand';

// Every saved location's position/target start as plain {x,y,z} data (TOML
// has no "point" type — see settings.toml's [locations.*] tables); upgrade
// each one to a real THREE.Vector3 once, in place, right here before
// anything reads them. A Vector3 still has plain writable x/y/z fields, so
// this is a transparent swap: "locations.paloAlto.position.x" keeps working
// as a settings path either way, and every call below that expects a real
// Vector3 (.clone(), .add(), handing it straight to a THREE API) still gets
// one.
for (const location of Object.values(settings.locations)) {
  location.position = new THREE.Vector3(location.position.x, location.position.y, location.position.z);
  location.target = new THREE.Vector3(location.target.x, location.target.y, location.target.z);
}

// Palo Alto's saved view — one of four peer locations (see
// settings.locations further down), not a privileged "home": which one a
// visitor actually starts at is picked at random on load.
// Real-world geo position of `position` (via tiles.getGeoPosition), NOT the
// reorientation origin — this view predates the lat/lon-per-location system
// (unlike URBANA/FALLS_CHURCH/CHANTILLY_VIEW below, whose position sits
// ~directly above their own lat/lon), so its local position/target were
// authored a couple thousand units away from tiles.defaultLatLon instead of
// right on top of it. LOCATION_CONFIGS still teleports here using
// tiles.defaultLatLon (position/target are only meaningful relative to that
// exact origin) — these fields exist solely so the globe overview's
// marker/fly-in can plot the real spot instead of tiles.defaultLatLon,
// which sits ~2.6km north of it (see enterOverview's marker list).
const PALO_ALTO_VIEW = settings.locations.paloAlto;

// A saved view at a different lat/lon (UIUC's Main Quad — actually in
// Urbana, not Champaign, despite the university's name covering both)
// — unlike PALO_ALTO_VIEW, reaching this requires re-centering the tileset
// first (tiles.teleport), since these local coordinates are only
// meaningful relative to that origin.
// The debug capture this came from reported the camera's *absolute*
// real-world position after flying far from wherever it had originally
// teleported — those large local numbers are an offset from some other,
// unknown origin, not from this one. Re-derived: anchor the new origin
// directly at the reported lat/lon (so local (0, height, 0) already *is*
// that point), keeping only the camera→target offset, which is the part
// of the original numbers that's actually meaningful.
const URBANA_VIEW = settings.locations.urbana;

// Meridian High School, Falls Church, VA — from a real debug-GUI capture
// (lat/lon/height plus the camera's local position/target at that moment),
// re-derived the same way as URBANA_VIEW above: the captured local position
// is only meaningful relative to whatever origin was active during that
// capture, not this location's own re-centered origin, so only the
// camera→target *offset* carries over — anchored at local (0, height, 0),
// which is where re-centering the tileset at this lat/lon actually puts it.
const FALLS_CHURCH_VIEW = settings.locations.fallsChurch;

// Chantilly, VA — same real-capture derivation as the two above.
const CHANTILLY_VIEW = settings.locations.chantilly;

// --- Renderer ---
// No antialias: the scene never lands in the default framebuffer directly —
// RenderPixelatedPass rasterizes it into its own plain (non-MSAA) render
// target at a fraction of the resolution first, and every pass after that
// reads/writes plain WebGLRenderTargets too. A multisampled default
// framebuffer would sit there unused the whole time.
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
// Uncapped devicePixelRatio (2 on any Retina/HiDPI display) means the whole
// post-processing chain — god rays' 60-tap loop, bloom's 25-tap loop,
// weather grade, wind blur, all running at full composer resolution,
// unlike the pixelated scene render itself — pays for 4x the pixels of
// what the CSS size actually shows. 1.5 keeps things visibly sharp while
// cutting that cost roughly in half on a 2x display.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

// --- FPS counter & dev GUI --- both off by default and both dev-only tools
// nobody sees on a typical visit, so lil-gui/stats.module (and every
// controller/folder built from them below) are dynamically imported and
// built only the first time the "Menu" button is actually clicked, instead
// of paying for them in the initial bundle every visitor downloads.
let stats = null;
let gui = null;

// --- Camera ---
// Bootstrap pose only — every object built below (tiles, clouds, controls)
// needs a valid starting position/target to exist at all, and this gets
// fully replaced the instant the overview map mounts (see mountUSOverview
// further down) before the first frame ever renders, so which saved view
// happens to sit here doesn't matter.
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 160000);
camera.position.copy(PALO_ALTO_VIEW.position);
camera.lookAt(PALO_ALTO_VIEW.target);

// --- Scene & lighting rig ---
const { scene, fog, ambient, hemi, sun, moon, lightning } = buildScene();

// --- Sky dome ---
const sky = buildSky(scene);
scene.background = null; // the sky dome is the backdrop now

// --- 3D Tiles ---
const tiles = buildTiles(camera, renderer);
scene.add(tiles.group);

// --- Clouds ---
const clouds = buildClouds(scene, camera.position);

// --- Postprocessing ---
const postFx = createPostFxService(renderer, scene, camera, settings.pixelArt.pixelSize);
postFx.pixelation.set({
  normalEdgeStrength: settings.pixelArt.normalEdgeStrength,
  depthEdgeStrength: settings.pixelArt.depthEdgeStrength,
});

// The scene only ever gets rasterized at 1/pixelSize resolution before
// RenderPixelatedPass upscales it — telling the tile LOD system the full
// renderer resolution (the default from setResolutionFromRenderer) makes it
// select detail fine enough for `pixelSize`x more pixels than ever actually
// render. Scaling the resolution it's told about down to match is what lets
// errorTarget stay reasonable without wasting triangles on detail the
// pixelation pass immediately throws away.
function syncTilesResolution() {
  const size = renderer.getSize(new THREE.Vector2());
  const pixelSize = postFx.pixelation.pass.pixelSize;
  tiles.setResolution(camera, size.x / pixelSize, size.y / pixelSize);
}
syncTilesResolution();

// Everything downstream of the renderer's actual pixel dimensions — used
// both by the window 'resize' listener further down and by the render-
// quality system (see src/quality/), for which a devicePixelRatio change
// is, as far as the renderer's concerned, indistinguishable from a resize.
function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  postFx.resize(window.innerWidth, window.innerHeight);
  syncTilesResolution();
}

// --- Render quality --- how much rendering cost the site spends: retro-
// pixelation size, devicePixelRatio, star density/brightness, and (read
// each frame below) how much of clouds'/rain's/snow's/wind streaks' fixed
// particle pools actually get drawn. The counterpart to the cache service's
// cache-quality dial (see src/cache/) — same low/medium/high/epic tiers,
// switched together by the ":quality" console command below.
const renderQuality = createRenderQualitySystem({
  renderer, postFx, pixelArt: settings.pixelArt, stars: settings.stars, render: settings.render, onResize: handleResize,
});

// --- Weather --- rain/snow/wind streaks (the particles service), wind
// blur and lightning flash (the postprocessing service), and the state/
// simulation driving all of it. `gui`/`playerPanel`/`estimatedTempF` below
// are read inside onPresetApplied only once a preset is actually applied
// (well after both exist), not at construction time here, so referencing
// them this early is safe.
const weather = createWeatherSystem({
  scene,
  camera,
  postFx,
  fog,
  lightningLight: lightning,
  rainSettings: settings.rain,
  snowSettings: settings.snow,
  cloudSettings: settings.clouds,
  windSettings: settings.wind,
  windShakeSettings: settings.wind.shake,
  stormSettings: settings.storm,
  postfxSettings: settings.postfx,
  presets: settings.presets,
  weatherGraphs: settings.weatherGraphs,
  cloudFormations: CLOUD_FORMATIONS,
  onPresetApplied: (preset) => {
    if (gui) gui.controllersRecursive().forEach((c) => c.updateDisplay());
    if (playerPanel) { playerPanel.setWeather(preset.label); playerPanel.setTemp(estimatedTempF()); }
  },
});
const {
  cloudParams, windParams, windShakeParams, stormParams, gust, rain, snow, windStreaks,
} = weather;

// --- Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
// Wheel/scroll-zoom is fully owned by localCameraControl below (its own
// listener, its own velocity+momentum, its own exit-to-overview threshold)
// so it works the same way regardless of whether WASD/drag nav is toggled
// on — disabling OrbitControls' own built-in wheel-zoom here keeps exactly
// one thing driving camera distance instead of two fighting over it.
controls.enableZoom = false;
controls.minDistance = settings.camera.scroll.minDistance;
controls.maxDistance = settings.camera.scroll.maxDistance;
// OrbitControls always re-orients the camera toward its own target on the
// first update() — matching that to where camera.lookAt() already pointed,
// otherwise the target's default (0,0,0) silently overrides it.
controls.target.copy(PALO_ALTO_VIEW.target);
controls.enabled = false; // mouse/touch nav off by default — toggled by the "Controls" button

// --- Local view camera control (WASD fly movement + wheel dolly-zoom) ---
// See camera/localCameraControl.ts: composition-first, owns everything that
// turns raw ground-view input into camera motion. WASD stays gated behind
// the "controls" toggle (isNavEnabled) same as always; wheel-zoom is not —
// it's meant to always work, the same way page-scroll always works.
// isLocalViewActive/onExitToOverview both close over `flight`/
// `overviewActive`/`startZoomOutToOverview`, all declared further down this
// module — safe here because none of these closures actually run until a
// real event fires, well after the whole module has finished evaluating.
const localCameraControl = createLocalCameraControl({
  camera,
  controls,
  moveParams: settings.camera.move,
  scrollParams: settings.camera.scroll,
  isNavEnabled: () => navEnabled,
  isLocalViewActive: () => !flight && !overviewActive,
  onExitToOverview: () => startZoomOutToOverview(),
});

// --- Smooth "quick travel" (Google-Maps-style, not a cut) ---
// A lat/lon re-center is a single-frame world swap — nothing to interpolate
// across — so on its own it's a jarring cut, even between two views that
// happen to share an origin (a "same-space" fly is a false economy: it only
// works if you already know you're at that origin, and there's no cheap way
// to guarantee that). Every quick-travel goes through the same re-center, so
// every one gets the full treatment: climb and tilt up toward the sky,
// re-center at the top of the climb — while both endpoints of that instant
// are "high up, looking at open sky," so the cut is effectively invisible —
// then tilt back down and descend, focusing into the destination.
let flight = null;
function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}
// Descend's own curve, deliberately NOT ease-in-out: this phase's t=0 is
// also the exact instant the overview's zoom-in (now easeInCubic, fastest
// right at the handoff — see usMap.js's flyTo) hands off into it. Starting
// descend with an ease-in-out's slow-building first half met that fast
// incoming motion with a near-standstill, so the two eased curves
// bracketing the cut both went quiet right at the seam and the "one
// continuous dive" read as the camera actually stopping. Ease-OUT instead
// starts at full speed — matching the zoom's momentum — and only decelerates
// on its way into the landing, where slowing down to settle is expected.
function easeOutCubic(x) {
  return 1 - (1 - x) ** 3;
}
// The zoom-out handoff's own climb (see startZoomOutToOverview) wants the
// opposite pairing from the dive-in's ascend/descend above: it should end
// at full speed, not settle, so the overview's own flyOut (started right
// where this leaves off) can pick up that motion instead of both easing in
// back to back. Same curve travelTo's startLookDown-driven descend used to
// get wrong before it was fixed to ease-out — see that comment.
function easeInCubic(x) {
  return x * x * x;
}

// Real-world compass bearing (radians, clockwise from north) a saved local
// view actually faces, derived from its own target-minus-position — passed
// to the overview as loc.bearing (see enterOverview) so flyTo can turn to
// match before handing off (see usMap.js). ReorientationPlugin's local
// frame has +Z as north and +X as west (its own docstring), so north/east
// components of the horizontal look direction are dz and -dx respectively.
function bearingRad(position, target) {
  const dx = target.x - position.x;
  const dz = target.z - position.z;
  return Math.atan2(-dx, dz);
}

// Defaults for the overview→ground-level handoff (opts.startLookDown below)
// — settings.transitions.handoff (see settings.toml), so the dev-GUI
// "Transition Speed" folder and ":settings set" can both retune it live.
const handoffParams = settings.transitions.handoff;

const travelFacing = new THREE.Vector3();
function travelTo(lat, lon, position, target, opts = {}) {
  localCameraControl.clearHeldKeys();
  bobEase = 0;

  // Coming straight from the globe overview, which already ends its own
  // shot diving in close to the ground — there's no "current ground
  // position" to climb away from, and nothing to hide behind a look-at-the-
  // sky beat. Skip ascend entirely and start the descent a modest distance
  // above the destination but still facing down at it (matching the
  // overview's own framing), then pan up into the normal saved framing as
  // it settles — a continuous dive, not a climb-then-dive. This needs its
  // *own*, much smaller height than the regular ascendHeight (5000, tuned
  // for climbing into open sky) — reusing that height here first jumps
  // sharply back up before diving again (the overview leaves off close to
  // street level; 5000 units reads as a jarring return to high altitude),
  // and its thick ground-fog at that height also renders as a flat,
  // featureless wall when looking straight down through it, instead of
  // through it toward the horizon the way the sky-facing ascend does.
  if (opts.startLookDown) {
    const startHeight = opts.startHeight ?? handoffParams.startHeight;
    tiles.teleport(lat, lon);
    // Opens on the exact same shot the overview just ended on, so the cut
    // reads as one continuous camera rather than a jump: the globe's own
    // applyCamera() sits its camera back along the destination's own facing
    // (loc.bearing, animated in during flyTo — see usMap.js) by
    // h*tan(TILT_RAD) and looks forward-and-down at the ground point (see
    // TILT_RAD's comment). This reproduces that same offset and look angle
    // in local space — trailing behind `target`'s own direction from
    // `position`, not a fixed compass direction — so a view that doesn't
    // face north (Urbana faces almost exactly south) opens already turned
    // to match instead of snapping 180° once local view takes over.
    const lookDir = target.clone().sub(position).setY(0);
    if (lookDir.lengthSq() < 1e-6) lookDir.set(0, 0, 1);
    lookDir.normalize();
    const destHighPos = new THREE.Vector3(
      position.x - lookDir.x * startHeight * Math.tan(TILT_RAD),
      position.y + startHeight,
      position.z - lookDir.z * startHeight * Math.tan(TILT_RAD),
    );
    const lookDownTarget = position.clone();
    flight = {
      phase: 'descend',
      t: 0,
      descendDuration: opts.descendDuration ?? handoffParams.descendDuration,
      destHighPos,
      destSkyTarget: lookDownTarget,
      destPos: position.clone(),
      destTarget: target.clone(),
      // This descend only ever follows the overview's own dive (see
      // travelToLocation's onSelect wiring) — there's no ground location to
      // have been "at" a moment ago, so the reported temp lerps up from
      // space's own reading instead of snapping straight to the
      // destination's the instant onArriveAt applies its weather (see
      // updateTravelTempDisplay). destTempF gets filled in by
      // travelToLocation once that real value is known.
      lerpTempFromSpace: true,
      destTempF: null,
    };
    camera.position.copy(destHighPos);
    controls.target.copy(lookDownTarget);
    return;
  }

  const ascendHeight = opts.ascendHeight ?? 5000;
  const destHighPos = new THREE.Vector3(position.x, position.y + ascendHeight, position.z);

  // Look up and ahead in whatever direction the camera already happens to
  // be facing — a climbing flyby, not a fixed-direction stare. A fixed
  // world-space offset here would occasionally line up dead-on with the
  // sun (blinding god-ray flare mid-transition); tying it to wherever the
  // user was already looking, at a moderate ~60° tilt rather than near-
  // vertical, makes that essentially incidental instead of systematic.
  camera.getWorldDirection(travelFacing);
  travelFacing.y = 0;
  if (travelFacing.lengthSq() < 1e-6) travelFacing.set(0, 0, 1);
  travelFacing.normalize().multiplyScalar(550);
  const skyOffset = new THREE.Vector3(travelFacing.x, 900, travelFacing.z);

  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const startHighPos = new THREE.Vector3(startPos.x, startPos.y + ascendHeight, startPos.z);
  const startSkyTarget = startHighPos.clone().add(skyOffset);

  const destSkyTarget = destHighPos.clone().add(skyOffset);

  flight = {
    phase: 'ascend',
    t: 0,
    ascendDuration: opts.ascendDuration ?? 1.1,
    descendDuration: opts.descendDuration ?? 1.2,
    startPos,
    startTarget,
    startHighPos,
    startSkyTarget,
    lat,
    lon,
    destPos: position.clone(),
    destTarget: target.clone(),
    destHighPos,
    destSkyTarget,
  };
}

function updateFlight(dt) {
  if (!flight) return false;
  if (localCameraControl.isMoving()) { flight = null; return false; } // user input cancels the auto-travel

  if (flight.phase === 'ascendToSpace') {
    flight.t += dt;
    const e = easeInCubic(Math.min(flight.t / flight.duration, 1));
    camera.position.lerpVectors(flight.startPos, flight.destPos, e);
    controls.target.lerpVectors(flight.startTarget, flight.destTarget, e);
    if (flight.t >= flight.duration) {
      const { onArrive } = flight;
      flight = null;
      onArrive();
    }
    return true;
  }

  if (flight.phase === 'ascend') {
    flight.t += dt;
    const e = easeInOutCubic(Math.min(flight.t / flight.ascendDuration, 1));
    camera.position.lerpVectors(flight.startPos, flight.startHighPos, e);
    controls.target.lerpVectors(flight.startTarget, flight.startSkyTarget, e);
    if (flight.t >= flight.ascendDuration) {
      tiles.teleport(flight.lat, flight.lon);
      camera.position.copy(flight.destHighPos);
      controls.target.copy(flight.destSkyTarget); // still looking up, now over the destination
      flight.phase = 'descend';
      flight.t = 0;
    }
    return true;
  }

  // phase === 'descend': tilt back down and focus into the destination
  flight.t += dt;
  const e = easeOutCubic(Math.min(flight.t / flight.descendDuration, 1));
  camera.position.lerpVectors(flight.destHighPos, flight.destPos, e);
  controls.target.lerpVectors(flight.destSkyTarget, flight.destTarget, e);
  if (flight.t >= flight.descendDuration) flight = null;
  return true;
}

// Overrides the panel's displayed temp with an in-progress reading between
// space and the destination while a flight.lerpTempFromSpace descend plays
// out — takes the flight object as it stood *before* this frame's
// updateFlight(dt) call, since that call can null out the module-level
// `flight` the instant the descend crosses its duration; the object itself
// (still held here) keeps its final t and destTempF either way, so this
// naturally lands on exactly destTempF once e reaches 1 instead of missing
// the last frame's update. Purely a display effect — reads flight.t, never
// writes to it or anything camera-related.
function updateTravelTempLerp(flightBeforeUpdate) {
  if (!flightBeforeUpdate?.lerpTempFromSpace || flightBeforeUpdate.destTempF == null) return;
  if (!playerPanel) return;
  const e = easeOutCubic(Math.min(flightBeforeUpdate.t / flightBeforeUpdate.descendDuration, 1));
  playerPanel.setTemp(SPACE_TEMP_F + (flightBeforeUpdate.destTempF - SPACE_TEMP_F) * e);
}

// --- Camera bob (only while moving; applied to render pose only, never to
// the tracked camera.position/controls.target, so it can't accumulate or
// fight with OrbitControls' own state each frame) ---
// `speed` here is the bob's own timing (seconds per full cycle) — entirely
// separate from WASD move speed. `amount`/`idleAmount` are pure magnitude.
const BOB_PATTERNS = ['Vertical', 'Circle', 'Figure8', 'Line'];
const bobParams = settings.camera.bob;
let bobPhase = 0;
let bobEase = 0; // eases 0..1 so the moving bob doesn't snap on/off
const bobForward = new THREE.Vector3();
const bobRight = new THREE.Vector3();
const bobOffset = new THREE.Vector3();
function computeBob(dt) {
  bobOffset.set(0, 0, 0);
  if (!bobParams.enabled) return bobOffset;

  const moving = localCameraControl.isMoving();
  const target = moving ? 1 : 0;
  bobEase += (target - bobEase) * Math.min(dt * 6, 1);
  const angularSpeed = (Math.PI * 2) / Math.max(bobParams.periodSeconds, 0.05);
  bobPhase += dt * angularSpeed;
  const movingAmp = bobParams.amount * bobEase;
  const idleAmp = bobParams.idleAmount * (1 - bobEase);
  const amp = movingAmp + idleAmp;

  camera.getWorldDirection(bobForward);
  bobForward.y = 0;
  if (bobForward.lengthSq() < 1e-6) bobForward.set(0, 0, 1);
  bobForward.normalize();
  bobRight.crossVectors(bobForward, camera.up).normalize();

  switch (bobParams.pattern) {
    case 'Circle':
      bobOffset.y = Math.sin(bobPhase) * amp;
      bobOffset.addScaledVector(bobRight, Math.cos(bobPhase) * amp);
      break;
    case 'Figure8':
      bobOffset.y = Math.sin(bobPhase) * amp;
      bobOffset.addScaledVector(bobRight, Math.sin(bobPhase * 2) * amp * 0.6);
      break;
    case 'Line':
      bobOffset.addScaledVector(bobRight, Math.sin(bobPhase) * amp);
      break;
    case 'Vertical':
    default:
      bobOffset.y = Math.sin(bobPhase) * amp;
      break;
  }

  return bobOffset;
}

// --- Time of day / sky ---
// Lower turbidity than the "hazy noon" default (6) keeps the sky a clear,
// saturated blue instead of washing toward white; exposure 0.55 matches
// what the Preetham sky model (very HDR-bright by construction) actually
// needs — three.js's own Sky example pairs it with ~0.5, not 1.0.
const skyParams = settings.sky;
// How starry the night sky looks — density is how many of the fixed star
// pool are drawn, brightness is their opacity ceiling. Both are dev-only
// knobs (see the "Stars" GUI folder); stars themselves always fade in/out
// with day and night on their own.
// Raised well past the old 1.3 — the night sky tint (WeatherGradeShader)
// multiplies the whole frame by a dark blue-grey at night, which by itself
// was crushing stars down to faint navy specks regardless of this value;
// see sky.js's raised opacity ceiling (now 6, was 2) for the actual fix,
// this default just picks a point on that wider range that reads as a
// properly bright white point once the night tint is applied on top.
const starParams = settings.stars;
// cloudParams/windParams/windShakeParams/stormParams/gust are all owned by
// the weather subsystem now (see its construction above) — destructured
// from `weather` there under these exact names so every reference below
// (GUI folders, updateGodRays' cloud damping, the lighting/weather-grade
// blend) keeps working unchanged.
const fxParams = settings.postfx;

// Sky.js's own cloud-color term gets multiplied by `vSunE * 0.00002` inside
// the shader (~0.013 at noon) — a hard-coded factor that crushes cloud color
// toward black regardless of how bright it started. `density` controls how
// much of the sky gets replaced by that near-black color, so it has to be
// kept low (not the 0.5-0.9 that "looks like real cloud opacity" would
// suggest) or cloudy presets read as night. This can't be fixed on the
// brightness side — it's baked into the vendored shader — only by limiting
// how much of the sky that blend affects.
// cloudFormation/cloudLevels pick the 3D cloud field's personality and how
// many altitude bands are in play (see clouds.js's CLOUD_FORMATIONS) — set
// directly (not cross-faded) when a preset applies, same as `storm` below;
// only coverage/density/fog/wind smoothly transition.
// Preset tuning values live in settings.toml's [presets.*] tables now (see
// settings/types.ts's PresetSettings) — keyed by camelCase (clear,
// partlyCloudy, heavySnow, ...) rather than their display strings, so a
// preset name is always a clean settings path/console argument; `label`
// carries the display string ("Partly Cloudy") for anywhere it needs to
// actually show on screen. tempDeltaF (a rough panel-temperature estimate,
// not a real climate model) is folded into each preset instead of a
// separate lookup, same reasoning PRESET_TEMP_DELTA_F used to give for
// *not* folding it in — with everything already namespaced under one
// preset key, there's no separate lookup left to justify.
// PRESETS/presetOptions/matchPresetName/WEATHER_GRAPHS/pickWeatherFor/
// applyPreset/updatePresetTransition/the auto-roll timer are all owned by
// the weather subsystem now (see its construction above) — reached via
// weather.* below instead of module-level names.

// The panel's displayed temperature: a location's own rough baseline (see
// settings.locations), nudged by whatever the sky is currently doing (see
// weather.tempDeltaF, sourced from the current preset's own tempDeltaF) —
// an estimate for flavor, not a forecast.
function estimatedTempF() {
  const baseTempF = LOCATION_CONFIGS[currentLocationName]?.baseTempF ?? 60;
  return baseTempF + weather.tempDeltaF();
}

// Real-world UTC offset for an IANA timeZone at this instant, DST included
// — unlike LocationSettings.utcOffset (a fixed winter/standard-time value
// used only for sim mode's fictional display), live mode needs today's
// actual offset so the real local hour — and the sun's actual daytime vs.
// nighttime position — come out right whether or not DST happens to be in
// effect right now. Formats the same instant into both the target zone's
// and UTC's wall-clock strings and diffs them — no timezone database
// bundled, just what the browser's Intl implementation already knows.
function currentUtcOffsetHours(timeZone, now = new Date()) {
  const tzWall = new Date(now.toLocaleString('en-US', { timeZone }));
  const utcWall = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  return (tzWall.getTime() - utcWall.getTime()) / (1000 * 60 * 60);
}

// Re-picks weather for whichever location is current from
// weather.pickLiveWeather — deterministic per real-world hour, so it holds
// steady across reloads within the same hour instead of re-rolling every
// time. Tracks which hour bucket it last ran for so tick()'s live branch
// only needs to call this again once a new real hour actually starts.
let lastLiveWeatherHourBucket = -1;
function applyLiveWeather() {
  lastLiveWeatherHourBucket = Math.floor(Date.now() / (1000 * 60 * 60));
  weather.applyPreset(weather.pickLiveWeather(currentLocationName));
}

// There genuinely is no weather in space — but the panel reporting nothing
// at all up there read as broken, not intentional, so it gets its own
// deadpan "condition" and a suitably brutal temperature instead of hiding
// the row (see enterOverview).
const SPACE_WEATHER_LABEL = 'Vacuum';
const SPACE_TEMP_F = -457;

let playerPanel = null; // set once buildPlayerPanel runs; keeps the user-facing panel in sync
// Placeholder only — overwritten as soon as a real location is picked (see
// the random startup pick near LOCATION_CONFIGS further down), before the
// first frame ever renders.
let currentLocationName = 'paloAlto';
// How bright the night sky (stars + moon) reads — a function of location,
// not a global constant: real light pollution varies hugely by where you
// actually are. Palo Alto sits in the middle of Bay Area light pollution;
// Urbana's Illinois farmland has far less competing light, so its night
// sky is genuinely denser/brighter in reality. Lives on each location's own
// settings.locations.<key>.nightBrightness now (see settings.toml) rather
// than a separate lookup here.
// Weather and time of day aren't visitor-controlled — they just happen, on
// a fixed interval — the only dial a visitor gets is how fast time passes.
const TIME_SPEEDS = [0.05, 0.1, 0.2]; // hours of sim time per real second: slow/normal/fast
const DEFAULT_SPEED_INDEX = 1;
let timeSpeed = TIME_SPEEDS[DEFAULT_SPEED_INDEX];
// 'live' (default): skyParams.hour tracks the real wall clock and weather
// is re-picked from what's plausible right now (see applyLiveWeather) —
// every location opens showing its own actual local time and today's
// real-ish weather. 'sim': the pre-existing fast-forward simulation —
// timeSpeed-accelerated clock, weather auto-rolling randomly along each
// location's graph. The player panel's Time button (see player.js) and the
// hidden console's "time live"/"time sim" toggle between them.
let timeMode = 'live';
// Set from the ":" console's "time freeze"/"time run" — this is the single
// master pause for the whole simulation, not just the clock. The render
// loop forces `dt` to 0 for every simulation update while this is true, so
// every dt-driven effect (movement, flight, gust, weather particles,
// lightning, preset cross-fades, camera bob/shake) freezes as a direct
// consequence rather than needing its own separate check — the two things
// that don't read dt (mouse-drag orbiting, and anything keyed to real
// wall-clock time like cloud drift) are handled explicitly where they're
// used (see `controls.update()` below and `simTime`).
let timeFrozen = false;
let navEnabledBeforeTimeFreeze = false;

// --- GUI --- toggled via the hidden ":" console (see the "settings menu"
// command below), not a visible button — one less thing cluttering the
// screen for a tool nobody but the site owner ever needs.
let guiVisible = false;
async function setGuiVisible(visible) {
  if (!gui) await initDevGui();
  guiVisible = visible;
  gui.show(guiVisible);
  stats.dom.style.display = guiVisible ? 'block' : 'none';
}

// Caches the in-flight build so two overlapping "show" calls before the
// first one finishes (e.g. a fast double-toggle from the console) await the
// same construction instead of racing past `if (!gui)` and each building
// their own lil-gui/stats.module instance.
let devGuiPromise = null;
function initDevGui() {
  if (!devGuiPromise) {
    devGuiPromise = buildDevGuiExternal({
      exportSettingsToml,
      renderQuality,
      qualityControl,
      weather,
      skyParams,
      starParams,
      cloudParams,
      rain,
      snow,
      windParams,
      windShakeParams,
      stormParams,
      fxParams,
      settingsPixelArt: settings.pixelArt,
      postFx,
      tiles,
      camera,
      travelTo,
      paloAltoView: PALO_ALTO_VIEW,
      urbanaView: URBANA_VIEW,
      fallsChurchView: FALLS_CHURCH_VIEW,
      chantillyView: CHANTILLY_VIEW,
      flyInParams,
      overviewStartParams,
      tilesParams,
      providers: PROVIDERS,
      movementParams,
      curveOptions,
      handoffParams,
      destPrefetchParams,
      cache,
      cacheControl,
      hoverParams,
      heavyPrefetchParams,
      debugState,
      settingsCameraMove: settings.camera.move,
      bobParams,
      bobPatterns: BOB_PATTERNS,
      settingsCameraScroll: settings.camera.scroll,
      onManualHourChange,
      refreshGui,
    }).then(({ gui: builtGui, stats: builtStats }) => {
      gui = builtGui;
      stats = builtStats;
    });
  }
  return devGuiPromise;
}
// See devGui.js's skyFolder comment on why this is a bare flag flip, not a
// call to setTimeMode() — by the time this fires, lil-gui has already
// written the slider's new value into skyParams.hour, and setTimeMode's own
// hour-conversion math would corrupt that just-set value.
function onManualHourChange() { timeMode = 'sim'; }

// --- Debug: live camera state, copyable --- plain data, kept outside the
// lazy dev-GUI builder below since the render loop writes to it every
// frame; only the lil-gui display bound to it is deferred.
// Position alone isn't enough to reconstruct a view — without target/zoom/fov
// too, "go here" lands at the right point but framed completely differently.
const debugState = {
  x: 0, y: 0, z: 0, lat: 0, lon: 0, height: 0,
  targetX: 0, targetY: 0, targetZ: 0, zoom: 1, fov: 60,
  // Only meaningful in the globe overview (usMap.js's fetch resolution) —
  // -1 at ground level, where there's no equivalent concept.
  lod: -1,
};

// Keyboard (WASD) and mouse/touch (OrbitControls) navigation are both off
// by default — a passive/ambient viewing mode until explicitly opted into
// via the ":" console's "controls" command.
let navEnabled = false;

// Boots in live mode (see timeMode's declaration) — auto-roll only matters
// once something switches into sim mode (see setTimeMode), where runAuto()
// re-arms it.
weather.freezeAuto();
applyLiveWeather();

// --- Locations --- one source of truth for each place's lat/lon and saved
// camera pose, shared by the globe overview's markers, the background
// prefetch below, and the console's "travel" command — instead of the
// flight-animated path and the instant-teleport path drifting out of sync.
// utcOffset: standard-time hours from UTC (winter/non-DST) — good enough
// for a labeled "local time" readout, not meant to track real DST
// transitions. baseTempF: a rough year-round-average outdoor temperature
// for the location, combined with the current weather preset's own
// tempDeltaF (see PRESETS) into the panel's displayed estimate — see
// estimatedTempF.
// Derived from settings.locations (see settings.toml), keyed the same
// camelCase way, with one deliberate override: Palo Alto's `lat`/`lon` here
// use tiles.defaultLatLon (tiles.js's own hardcoded re-centering origin —
// Palo Alto City Hall) rather than settings.locations.paloAlto's own
// lat/lon (a different nearby point — see PALO_ALTO_VIEW's own comment,
// ~2.6km north of it, used only for marker/prefetch placement). That's a
// wiring decision about how navigation re-centers, not a tunable value, so
// it stays here rather than in settings.toml.
const LOCATION_CONFIGS = {
  paloAlto: { ...PALO_ALTO_VIEW, lat: tiles.defaultLatLon.lat, lon: tiles.defaultLatLon.lon },
  urbana: URBANA_VIEW,
  fallsChurch: FALLS_CHURCH_VIEW,
  chantilly: CHANTILLY_VIEW,
};
const LOCATION_SLUGS = Object.values(LOCATION_CONFIGS).map((c) => c.slug);

// Kicked off the instant a globe marker is clicked (see usMap.js's
// loc.onFlightStart), not when the flight actually arrives — nothing else
// touches this destination's real 3D tiles until travelTo's own teleport,
// seconds later, so this is the earliest possible head start instead of a
// cold start right as the camera needs them. Prefetches both ends of the
// saved shot — where the camera opens, and what it's actually looking at
// (LOCATION_CONFIGS' target can be a couple kilometers from its own
// lat/lon, see PALO_ALTO_VIEW's comment) — at close to the resolution the
// real arrival renders at, not the light background warm-up's coarse
// placeholder (see tiles.prefetch's own comment).
// Tunable, not the render resolution itself — a prefetch camera's whole
// purpose is to bias TilesRenderer's tile *selection* toward the right
// area/LOD ahead of time, not to render anything. Handing it the same
// resolution the real camera renders at was asking for exactly that much
// detail on THREE simultaneous brand-new cameras at once (every one of
// them starting from zero — unlike the real camera's already-settled,
// incrementally-refined selection) — bursty enough GLB/Draco parsing work
// right at click time to read as a lag spike. A camera told it's rendering
// at a fraction of the real resolution asks for proportionally coarser
// (cheaper, faster-to-parse) tiles for the exact same screen coverage —
// the real camera still refines further, live, once it actually arrives.
// resolutionScale: applied to the two full "final shot" cameras below.
// wideResW/wideResH: the third, already-coarse "opening altitude" camera
// stays fixed — no scale applied. durationMs: comfortably longer than the
// overview's own zoom-in + descend. staggerMs: each of the 3
// tiles.prefetch() calls below registers a brand-new camera TilesRenderer
// has never evaluated before — unlike the real, already-settled camera,
// each one needs a real (if now much smaller, see resolutionScale) burst of
// tile selection/downloading/GLB parsing the moment it's added. Registering
// all 3 in the same tick asked for all three bursts at once; spacing them
// out over a few frames instead gives TilesRenderer's own per-frame budget
// room to interleave them with whatever the main camera and each other are
// already doing. See settings.toml's [prefetch.heavy] table for defaults.
const heavyPrefetchParams = settings.prefetch.heavy;

function prefetchLocationHeavy(name) {
  const cfg = LOCATION_CONFIGS[name];
  const usePaloAltoView = name === 'paloAlto';
  const positionLat = usePaloAltoView ? PALO_ALTO_VIEW.lat : cfg.lat;
  const positionLon = usePaloAltoView ? PALO_ALTO_VIEW.lon : cfg.lon;
  const targetGeo = tiles.geoAt(cfg.lat, cfg.lon, cfg.target);
  const size = renderer.getSize(new THREE.Vector2());
  const {
    resolutionScale, wideResW, wideResH, durationMs, staggerMs,
  } = heavyPrefetchParams;
  const resW = Math.max(64, Math.round((size.x / postFx.pixelation.pass.pixelSize) * resolutionScale));
  const resH = Math.max(64, Math.round((size.y / postFx.pixelation.pass.pixelSize) * resolutionScale));
  const jobs = [
    // The far end of the shot — where the local view actually settles, and
    // the one most worth arriving with full detail already resident.
    () => tiles.prefetch(positionLat, positionLon, {
      heightAboveGround: Math.max(cfg.position.y, 30), durationMs, resolutionW: resW, resolutionH: resH,
    }),
    () => tiles.prefetch(targetGeo.lat, targetGeo.lon, {
      heightAboveGround: Math.max(targetGeo.height, 30), durationMs, resolutionW: resW, resolutionH: resH,
    }),
    // The overview's own opening altitude, wider but coarser — covers
    // what's actually in frame during the dive itself, not just the two
    // endpoints.
    () => tiles.prefetch(positionLat, positionLon, {
      heightAboveGround: handoffParams.startHeight, durationMs, resolutionW: wideResW, resolutionH: wideResH,
    }),
  ];
  jobs.forEach((job, i) => setTimeout(job, i * staggerMs));
}

// The cache/preload system (see src/cache/) — one shared scheduler for
// every preload trigger below (hovering near a marker, clicking one, idle
// background warming when nothing else is going on), plus the active
// quality tier that governs how aggressively all of it runs, including the
// 3D-tiles LRU cache itself (tiles.lruCache/errorTarget). "heavy" is the
// real thing (prefetchLocationHeavy above); "light" is the same low-res,
// low-stakes single-camera warm every location used to get unconditionally
// a few seconds after every page load — now only spent on whichever
// location is actually still idle-eligible, on the scheduler's own
// schedule.
const cache = createCacheSystem(tiles, settings.prefetch, settings.preload, settings.cache);
Object.keys(LOCATION_CONFIGS).forEach((name) => {
  const cfg = LOCATION_CONFIGS[name];
  cache.registerLocation(name, {
    heavy: () => prefetchLocationHeavy(name),
    light: () => tiles.prefetch(cfg.lat, cfg.lon),
  });
});

// Bookkeeping every arrival needs regardless of how the camera got there —
// re-centering the cloud field on the new position, rolling this location's
// own weather, and resetting the auto-weather clock so a fresh arrival
// doesn't immediately roll again a moment later.
// push=false when *syncing to* a URL that's already correct — the initial
// page load handing off to a deep-linked location, or a popstate firing
// because the user hit back/forward — where pushing again would leave a
// stray duplicate entry in history instead of actually going back/forward.
function onArriveAt(name, { push = true } = {}) {
  const cfg = LOCATION_CONFIGS[name];
  clouds.recenter(cfg.position);
  currentLocationName = name;
  // Live mode: this location's own actual weather right now. Sim mode: keep
  // random-walking from wherever the fast-forwarded weather already was —
  // resetAutoRollTimer either way, so a fresh arrival that's already in sim
  // mode doesn't immediately re-roll again a moment later.
  if (timeMode === 'live') applyLiveWeather();
  else weather.applyPreset(weather.pickNextPreset(currentLocationName));
  weather.resetAutoRollTimer();
  // Every arrival lands in local view, whichever path got it here — a
  // deep link straight to a location (see syncToPath) never goes through
  // leaveOverview(), which is otherwise the only place this normally gets
  // shown, and would otherwise leave it stuck hidden with no way back to
  // the overview.
  backToEarthBtn.style.display = 'block';
  // A deep link straight to /world/<slug> also never mounts the overview
  // at all, so onLandingChange (the only other place these two hide) never
  // fires either — without this they'd default to visible, stacked right
  // on top of this location's own panel.
  bioPanel.setVisible(false);
  highlightsPanel.setVisible(false);
  locationBioPanel.setLocation(name);
  locationBioPanel.setVisible(true);
  if (push) history.pushState(null, '', `/world/${cfg.slug}`);
}

// The flight-animated path — climb, cross-fade the tileset root, descend —
// same as clicking a location button.
function travelToLocation(name, opts) {
  // The player panel's location buttons stay live even while the overview
  // is mounted (only its weather row hides — see setInSpace) — calling this
  // without first leaving the overview left overviewActive stuck true, so
  // setLocalViewVisible(false) was still hiding the tiles/sky/clouds this
  // flight is about to fly the camera into, and controls.enabled stayed
  // forced off. Every other entry point into this function already calls
  // leaveOverview() itself; this makes that a guarantee instead of a
  // caller's responsibility.
  if (overviewActive) leaveOverview();
  const cfg = LOCATION_CONFIGS[name];
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  travelTo(cfg.lat, cfg.lon, cfg.position, cfg.target, opts);
  onArriveAt(name, { push: opts?.push ?? true });
  // onArriveAt's own weather.applyPreset already set the panel to the real
  // destination temp immediately — this is the value updateTravelTempDisplay
  // lerps toward instead, now that it's known, once per descend frame.
  if (flight?.lerpTempFromSpace) flight.destTempF = estimatedTempF();
}

// Instant cut, no flight animation — cancels any flight already in
// progress, re-roots the tileset immediately, and drops the camera straight
// into the saved pose. This is what deep-linking and back/forward (see
// syncToPath) use — browser navigation should land you there immediately,
// not sit through the same animated flight a click gets.
function teleportToLocation(name, { push = true } = {}) {
  const cfg = LOCATION_CONFIGS[name];
  if (overviewActive) leaveOverview();
  flight = null;
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  tiles.teleport(cfg.lat, cfg.lon);
  camera.position.copy(cfg.position);
  controls.target.copy(cfg.target);
  onArriveAt(name, { push });
}

// Matched against each location's slug (e.g. "palo-alto"), not its
// space-containing display name — a CLI argument is one token, not
// "Palo Alto" split across two by the console's own whitespace parsing.
function matchLocationName(raw) {
  const slug = (raw || '').toLowerCase();
  return Object.keys(LOCATION_CONFIGS).find((k) => LOCATION_CONFIGS[k].slug === slug);
}

// Switches between 'live' (real local time + today's real-ish weather) and
// 'sim' (the fast-forward simulation) — the single entry point for every
// path that can change modes: the player panel's Time button, the hidden
// console's "time live"/"time sim", and the dev GUI forcing sim on manual
// overrides. Keeps the panel's button in sync even when the mode changed
// from one of those other paths instead of its own click.
function setTimeMode(mode, speedValue) {
  if (mode === 'sim' && timeMode === 'live') {
    // Live mode stores skyParams.hour as this location's own already-local
    // hour (see tick()); sim mode's display/render both expect it back in
    // the "shift by utcOffset only for display" convention the simulation
    // has always used. Converting once here keeps the switch visually
    // continuous — the rendered sky and the readout hold steady at the
    // instant of the click instead of jumping — free to diverge from real
    // time afterward, which is the whole point.
    //
    // Deliberately the location's static utcOffset here, not
    // currentUtcOffsetHours — sim mode's own display (below, in tick())
    // adds back that same static value, so subtracting it now is what
    // makes the two sides cancel out to a continuous readout. Using the
    // DST-aware offset here instead would reintroduce exactly the jump
    // this is trying to avoid, whenever DST currently differs from
    // standard time.
    const utcOffset = overviewActive ? 0 : (LOCATION_CONFIGS[currentLocationName]?.utcOffset ?? 0);
    skyParams.hour = (skyParams.hour - utcOffset + 24) % 24;
  }
  timeMode = mode;
  if (mode === 'sim') {
    if (speedValue !== undefined) timeSpeed = speedValue;
    weather.runAuto();
  } else {
    weather.freezeAuto();
    applyLiveWeather();
  }
  playerPanel?.setMode(timeMode, TIME_SPEEDS.indexOf(timeSpeed));
}

// --- User-facing panel (bottom-right): reports weather, temperature, and
// time (converted to whichever location you're at, or world/UTC time in
// space — see updatePlayerPanelStatus), plus a way to leave live mode and
// fast-forward. No location picker — traveling is a console command (see
// commands/travelCommand.ts).
playerPanel = buildPlayerPanel({
  initialWeather: weather.presetLabel(weather.getCurrentPresetName()),
  initialTempF: estimatedTempF(),
  initialHour: skyParams.hour,
  initialTimeLabel: 'Local Time',
  speedOptions: TIME_SPEEDS,
  initialMode: timeMode,
  initialSpeedIndex: DEFAULT_SPEED_INDEX,
  onModeChange: setTimeMode,
});

// Landing-page bio panels: bio/experience on the left (bioPanel.js) and a
// widget-first "Now" panel on the right (highlightsPanel.js) — both stay
// clear of the center so the globe reads through. Visible only on the
// landing page itself; onLandingChange below fades them out (the mirror
// image of the Explore panel, which fades IN once landing ends).
const bioPanel = buildBioPanel();
const highlightsPanel = buildHighlightsPanel();

// Left-side counterpart shown while in ground view at a specific location
// (see onArriveAt/enterOverview below) — same slot bioPanel occupies on
// the landing page, but they're mutually exclusive so this never overlaps.
const locationBioPanel = buildLocationBioPanel();

// The landing experience is the pixelated globe overview — one continuous
// 3D camera throughout, never a hard cut to a separate renderer. It starts
// high above the whole Earth and clicking a marker flies the SAME camera
// continuously down into that location's saved view via the ordinary
// travelToLocation flight, with the real 3D tiles resolving in as it
// descends.
//
// "Earth view" (the overview) and "local view" (the ground-level
// flythrough) are two distinct visual modes sharing one scene/camera, and
// every system that only makes sense at human/local scale — the
// photorealistic tiles, the cloud field, rain/snow/wind streaks, the
// ground-level sky dome + sun/moon sprites + stars, and the near/far fog
// tuned for human-scale distances — needs to be hidden while in earth view,
// not just the tiles. Toggled together here so the two modes can't drift
// out of sync with each other again.
// Stars stay reusable across both modes rather than a separate starfield
// built for the overview — real ground-level shader, already tuned to look
// good, already following the camera everywhere it goes. Its opacity is
// normally driven by the day/night cycle (see tick()'s override below,
// which forces it fully on while overviewActive, since day/night is a
// ground-level phenomenon that shouldn't apply to a view from space).
function setLocalViewVisible(visible) {
  tiles.group.visible = visible;
  clouds.mesh.visible = visible;
  rain.object.visible = visible;
  snow.object.visible = visible;
  windStreaks.object.visible = visible;
  sky.sky.visible = visible;
  sky.sunSprite.visible = visible;
  sky.moonSprite.visible = visible;
  scene.fog = visible ? groundFog : null;
}
const groundFog = fog;
let overviewActive = false;
let overview = null;

// A persistent control, separate from the overview's own "zoom out" reset —
// this one gets you *back* to the earth view from anywhere in the
// ground-level flythrough, not just while already inside the overview.
// Hidden while the overview itself is up (it has its own reset for that).
const backToEarthBtn = document.createElement('button');
backToEarthBtn.textContent = '🌐 Earth View';
backToEarthBtn.style.cssText = `
  position: fixed; top: 28px; right: 28px; z-index: 900;
  appearance: none; border: 1px solid rgba(255,255,255,0.25);
  background: rgba(18,20,26,0.75); backdrop-filter: blur(10px);
  color: #f2f4f8; font: 600 12px system-ui, -apple-system, sans-serif;
  padding: 8px 16px; border-radius: 999px; cursor: pointer;
  display: none;
`;
backToEarthBtn.addEventListener('click', () => startZoomOutToOverview());
document.body.appendChild(backToEarthBtn);

function leaveOverview() {
  overview.dispose();
  overview = null;
  overviewActive = false;
  setLocalViewVisible(true);
  // Ground weather/temp get set for real the moment onArriveAt's own
  // applyPreset() runs (every caller of leaveOverview immediately travels
  // somewhere) — the time label self-corrects next tick (see tick()'s own
  // playerPanel.setTime call, which branches on overviewActive) — so
  // there's nothing to explicitly restore here.
  controls.enabled = navEnabled;
  // The globe overview orbits with camera.up set to the *local* radial "up"
  // at wherever it's currently centered (needed so the globe itself renders
  // right-side up from any point on its surface) — leaving that in place
  // corrupts every ground-level orientation computation afterward (the
  // travelTo flight, OrbitControls, WASD), which all assume the standard
  // (0,1,0) up used everywhere else in the app.
  camera.up.set(0, 1, 0);
  backToEarthBtn.style.display = 'block';
}

// The reverse of the overview→local dive (travelTo's opts.startLookDown
// branch): climbs from wherever the camera currently is up to the same
// kind of shot that dive opened on — behind the camera's own current
// bearing, at handoffParams.startHeight, looking down at the ground point
// below — then hands the overview a seed (see enterOverview) so it opens
// already framed on this exact spot and continues the motion outward via
// its own flyOut, instead of an instant cut straight to the whole-US view.
function startZoomOutToOverview() {
  if (flight || overviewActive) return;
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const bearing = bearingRad(startPos, startTarget);
  // Snapshotted now, not after the climb — a straight-up climb doesn't
  // change which point on the ground is below the camera, only how far
  // above it, so there's nothing to gain by waiting.
  const departureGeo = tiles.getGeoPosition(startPos);
  const lookDir = startTarget.clone().sub(startPos).setY(0);
  if (lookDir.lengthSq() < 1e-6) lookDir.set(0, 0, 1);
  lookDir.normalize();
  // Ground level is only ever approximately y=0 in this local frame (real
  // terrain has relief this ignores), but it's the same approximation
  // startLookDown's own opening shot already makes for the same reason —
  // see its comment.
  const groundPoint = new THREE.Vector3(startPos.x, 0, startPos.z);
  const { startHeight, descendDuration } = handoffParams;
  const destPos = new THREE.Vector3(
    groundPoint.x - lookDir.x * startHeight * Math.tan(TILT_RAD),
    startHeight,
    groundPoint.z - lookDir.z * startHeight * Math.tan(TILT_RAD),
  );
  localCameraControl.clearHeldKeys();
  bobEase = 0;
  flight = {
    phase: 'ascendToSpace',
    t: 0,
    duration: descendDuration,
    startPos,
    startTarget,
    destPos,
    destTarget: groundPoint,
    onArrive: () => enterOverview({
      lat: departureGeo.lat, lon: departureGeo.lon, zoom: flyInParams.zoom, bearing,
    }),
  };
}

// seed: optional { lat, lon, zoom, bearing } — passed through to
// mountUSOverview so it opens already framed on that spot and animates
// zooming out from there (see startZoomOutToOverview and usMap.js's
// flyOut), instead of an instant cut to the whole-US view. push=false for
// the initial page load's own default landing in space, and for popstate
// syncing back to a URL that's already correct — see onArriveAt's comment.
function enterOverview(seed, { push = true, landing = false } = {}) {
  // Defensive, not just the normal path in: browser back/forward can land
  // here while an overview is already mounted (e.g. going from one /world/
  // history entry straight to another) — dispose it first rather than
  // leaking the old one under a second, freshly-mounted overview.
  if (overview) { overview.dispose(); overview = null; }
  flight = null;
  localCameraControl.clearHeldKeys();
  backToEarthBtn.style.display = 'none';
  overviewActive = true;
  setLocalViewVisible(false);
  locationBioPanel.setVisible(false);
  if (playerPanel) { playerPanel.setWeather(SPACE_WEATHER_LABEL); playerPanel.setTemp(SPACE_TEMP_F); }
  if (push) history.pushState(null, '', '/world/');
  // OrbitControls shares the same renderer.domElement usMap.js's own
  // wheel/pointer handlers listen on — left enabled, it independently
  // dollies/orbits the camera off the *same* input events usMap.js is
  // already handling, and its damping keeps decaying leftover velocity
  // from ground-mode navigation on top of whatever usMap.js just set the
  // camera to. Both together read as camera "shake", worst while zooming.
  controls.enabled = false;
  overview = mountUSOverview({
    scene, camera, controls, renderer,
    seed,
    landing,
    // The player panel reports weather/temp/time for a *place* — none of
    // that means anything before the visitor has actually entered the
    // overview, so it stays hidden for as long as landing does.
    onLandingChange: (isLanding) => {
      playerPanel?.setVisible(!isLanding);
      bioPanel.setVisible(isLanding);
      highlightsPanel.setVisible(isLanding);
      // Landing lives at root (/); scrolling in out of it is the same
      // destination /world/ opens directly on, so the URL should reflect
      // that the moment you're there instead of staying stuck at /.
      if (!isLanding && window.location.pathname === '/') {
        history.pushState(null, '', '/world/');
      }
    },
    onActivity: () => cache.notifyActivity(),
    // Every travelToLocation destination gets a marker — clicking any of
    // them zooms in, then continues straight into that same dive at ground
    // level (startLookDown; see travelTo). Palo Alto is the one exception
    // for *marker placement*: LOCATION_CONFIGS.paloAlto.lat/lon is
    // tiles.defaultLatLon, the teleport origin PALO_ALTO_VIEW's local
    // position/target are authored relative to, not where that saved view
    // actually looks — PALO_ALTO_VIEW.lat/lon (see its own comment) is the
    // real spot. The other three locations' position sits ~directly above
    // their own lat/lon already, so cfg.lat/lon is correct as-is for them.
    locations: Object.keys(LOCATION_CONFIGS).map((name) => {
      const cfg = LOCATION_CONFIGS[name];
      const usePaloAltoView = name === 'paloAlto';
      return {
        name,
        label: cfg.label,
        lat: usePaloAltoView ? PALO_ALTO_VIEW.lat : cfg.lat,
        lon: usePaloAltoView ? PALO_ALTO_VIEW.lon : cfg.lon,
        // The compass direction this location's own saved view actually
        // faces — flyTo turns to match it before handing off (see
        // bearingRad's comment).
        bearing: bearingRad(cfg.position, cfg.target),
        // Anticipatory — see src/cache/. Hovering near a marker
        // runs the same heavy preload a click does, just earlier, subject
        // to the manager's own concurrency cap/cooldown so a fast sweep
        // across several markers doesn't fire all of them at once.
        onHoverNear: () => cache.requestPreload(name),
        onFlightStart: () => {
          // A click always runs immediately regardless of the manager's
          // concurrency cap — hover may already have started this, but
          // travelTo needs it regardless of whether hover got there first.
          cache.requestPreload(name, { immediate: true });
          cache.notifyFlightStart();
        },
        onSelect: () => {
          leaveOverview();
          travelToLocation(name, { startLookDown: true });
        },
      };
    }),
  });
}
// GitHub Pages' 404.html (see public/404.html) redirects a deep link it
// can't serve directly (no server-side router there) into this same app
// with the originally requested path preserved in ?redirect= — swap it
// back into the real URL, silently, before syncToPath below ever reads
// window.location. Vite's dev server never takes this path (its own
// world-subpath-fallback middleware, see vite.config.js, serves the
// original path directly), but production always does.
const redirectedPath = new URLSearchParams(window.location.search).get('redirect');
if (redirectedPath) history.replaceState(null, '', redirectedPath);

// Deep-linking + browser back/forward: the app boots into whatever the
// current URL already names — the landing page at plain /, a location's
// own /world/<slug>, or the overview at plain /world/ — and later back/
// forward navigation re-syncs to it the same way. Always the instant
// teleportToLocation/enterOverview path, never an animated flight — browser
// navigation is expected to land immediately, not sit through the same
// flight a click gets.
//
// `initial` gates the landing state (see enterOverview's `landing` option
// and usMap.js's LANDING_* constants): only the very first call below, and
// only for a visit that landed on plain / (root), opens on the
// slow-spinning globe rather than straight into the interactive resting
// view — /world with no deep link opens straight into that resting view
// (the scrolled-in destination landing leads to), a location deep link
// skips it outright (nothing to spin toward), and every later popstate is
// expected to re-sync instantly like any other browser-navigation landing,
// not replay the one-time intro.
function syncToPath({ initial = false } = {}) {
  const match = window.location.pathname.match(/\/world\/([^/]+)\/?$/);
  const name = match ? matchLocationName(match[1]) : undefined;
  if (name) {
    teleportToLocation(name, { push: false });
  } else {
    const isRoot = !window.location.pathname.startsWith('/world');
    enterOverview(undefined, { push: false, landing: isRoot && initial });
  }
}
window.addEventListener('popstate', syncToPath);
syncToPath({ initial: true });

// --- Hidden debug console (":" to open) --- see devconsole.ts. Each
// command is a small factory from src/commands/ (composition-first,
// TypeScript, no classes — see that directory) that this section wires up
// with exactly the closures it needs over this module's own state, the
// same pattern src/settings/commands.ts already used for "settings". Every
// argument is declared (type/range/optional) so a bad command fails with a
// specific, visible reason instead of quietly feeding NaN into a shader
// uniform or a WebGL draw call somewhere downstream and freezing the frame.
const clockControl = {
  getHour: () => skyParams.hour,
  // A manual hour is a sim-mode override — left in live mode, tick() would
  // just overwrite it with the real clock again next frame.
  setHour: (hour) => { setTimeMode('sim', timeSpeed); skyParams.hour = hour; },
  getSpeed: () => timeSpeed,
  setSpeed: (v) => { setTimeMode('sim', v); },
  getMode: () => timeMode,
  setLive: () => setTimeMode('live'),
  setSim: () => setTimeMode('sim', timeSpeed),
  freeze: () => {
    timeFrozen = true;
    // This is the master pause, not just the clock — see the comment by
    // `timeFrozen`'s declaration — so mouse-drag orbiting (the one camera
    // input that isn't driven by the loop's own dt) needs its own explicit
    // hold here, saved to restore on "time run".
    navEnabledBeforeTimeFreeze = navEnabled;
    navEnabled = false;
    controls.enabled = false;
    localCameraControl.clearHeldKeys();
  },
  run: () => {
    timeFrozen = false;
    navEnabled = navEnabledBeforeTimeFreeze;
    controls.enabled = navEnabled;
  },
};

const weatherControl = {
  matchPreset: weather.matchPresetName,
  presetLabel: weather.presetLabel,
  presetLabels: weather.presetLabels,
  applyPreset: weather.applyPreset,
  currentPresetLabel: () => weather.presetLabel(weather.getCurrentPresetName()),
  setChangeIntervalHours: weather.setChangeIntervalHours,
  freezeAuto: weather.freezeAuto,
  runAuto: weather.runAuto,
  graphInfo: () => weather.graphSummary(currentLocationName, LOCATION_CONFIGS[currentLocationName].label),
  cloudFormations: weather.cloudFormations,
  setCloudCoverage: weather.setCloudCoverage,
  setCloudDensity: weather.setCloudDensity,
  setCloudLevels: weather.setCloudLevels,
  setCloudFormation: weather.setCloudFormation,
};

// Both quality switches write straight into settings.prefetch/.preload/
// .stars/.pixelArt (live objects several dev-GUI sliders are bound to,
// same as a weather preset does) — lil-gui only re-reads a bound value
// into its own display on user interaction, not when something else
// changes the underlying object, so every switch needs to explicitly
// nudge every controller to catch up, same as applyPreset already does.
function refreshGui() {
  if (gui) gui.controllersRecursive().forEach((c) => c.updateDisplay());
}

const cacheControl = {
  getQuality: cache.getQuality,
  qualityOptions: cache.qualityOptions,
  setQuality: (name) => { cache.setQuality(name); refreshGui(); },
};

const qualityControl = {
  getQuality: renderQuality.getQuality,
  qualityOptions: renderQuality.qualityOptions,
  setQuality: (name) => {
    renderQuality.setQuality(name);
    cache.setQuality(name);
    refreshGui();
  },
};

const starsControl = {
  setDensity: (v) => { starParams.density = v; },
  setBrightness: (v) => { starParams.brightness = v; },
};

// "location set <slug>" and "traveler goto <slug>" used to live here as two
// separate commands — each just resolved a slug and called one of two
// travel functions, so they were two thin near-identical wrappers around
// the same lookup. Merged into one "travel" command (see
// commands/travelCommand.ts) with go/instant modes instead.
const travelControl = {
  slugs: () => LOCATION_SLUGS,
  matchLocation: matchLocationName,
  label: (key) => LOCATION_CONFIGS[key].label,
  travelAnimated: (key) => travelToLocation(key),
  teleportInstant: (key) => teleportToLocation(key),
};

const controlsToggle = {
  toggle: () => {
    navEnabled = !navEnabled;
    controls.enabled = navEnabled;
    if (!navEnabled) localCameraControl.clearHeldKeys(); // don't leave WASD keys "stuck" held when turned off
    return navEnabled;
  },
};

const debugSnapshot = {
  snapshot: () => ({
    hour: skyParams.hour, timeMode, timeSpeed, currentLocationName, currentPresetName: weather.getCurrentPresetName(),
    starOpacity: sky.stars.material.opacity,
    starDrawRange: sky.stars.geometry.drawRange,
    sunOpacity: sky.sunSprite.material.opacity,
    moonOpacity: sky.moonSprite.material.opacity,
  }),
};

buildDevConsole([
  buildTimeCommand(clockControl),
  buildWeatherCommand(weatherControl),
  buildStarsCommand(starsControl),
  // A standalone "menu" command used to live here too, duplicating exactly
  // what "settings menu show/hide/toggle" already does to the same
  // `guiVisible` flag — dropped in favor of the one entry point.
  buildSettingsCommand({
    show: () => setGuiVisible(true),
    hide: () => setGuiVisible(false),
    toggle: () => setGuiVisible(!guiVisible),
    isVisible: () => guiVisible,
  }),
  buildTravelCommand(travelControl),
  buildControlsCommand(controlsToggle),
  buildDebugCommand(debugSnapshot),
  buildCacheCommand(cacheControl),
  buildQualityCommand(qualityControl),
]);

// --- Lighting / sky update ---
// Was near-pure-black (0x0a0a18) — this is scene.fog's color at night, and
// THREE.Fog linearly blends anything past fog.near toward it regardless of
// how bright the actual scene lights (ambient/hemi/moon) are. With Clear's
// fog starting at 2000 units, most of a typical view is well past that, so
// a near-black fog color was crushing the whole frame back to black no
// matter how much the lights themselves got boosted — a dim moonlit navy
// here is what actually fixes "no light after dark," not more light
// intensity on geometry that then gets fogged straight back to black.
const NIGHT = new THREE.Color(0x424f78);
const SUNRISE = new THREE.Color(0xffb877);
// Near-neutral daylight white, not sky-blue — the blue of the sky is already
// visible via the dome itself. Using a blue here double-dipped: it tinted
// the sun light AND multiplied over the whole final image again, making
// broad daylight read as blue instead of neutral.
const DAY = new THREE.Color(0xfff4e8);
// A distinctly cool blue-grey, not a near-neutral grey — cloudy days should
// read as cool/moody, not just desaturated and flat.
const OVERCAST = new THREE.Color(0x6f85b0);
// Deep orange, specifically for the sun's *glow* (bloom), not the base
// image — the Preetham sky's own disc color stays fairly neutral/white
// even at sunset, so without this the sun reads as a white blob rather
// than the warm orange a real setting sun has.
const SUN_GLOW = new THREE.Color(0xff8a3d);
const WHITE = new THREE.Color(0xffffff);
const skyTone = new THREE.Color();
const bloomTint = new THREE.Color();
const overcastColor = new THREE.Color();
const frameTint = new THREE.Color();

// Day runs longer than night (sunrise earlier, sunset later) — a straight
// 12/12 split made night drag on with little to look at. Both arcs are
// plain half-sines so elevation is continuous (and 0) at both boundaries.
const SUNRISE_HOUR = 5.5;
const SUNSET_HOUR = 20.5;
const DAY_LEN = SUNSET_HOUR - SUNRISE_HOUR;
const NIGHT_LEN = 24 - DAY_LEN;
// Only the dead-of-night stretch nudges along a little faster — not the
// whole night anymore (that blew through sunset, moonrise, and the
// approach to sunrise too fast to actually see any of it). 11pm-3am is the
// one span with genuinely nothing new happening, and even that only gets a
// mild bump, not a full 3x.
const DEEP_NIGHT_START_HOUR = 23;
const DEEP_NIGHT_END_HOUR = 3;
const DEEP_NIGHT_SPEED_MULTIPLIER = 1.4;
function isDeepNight(hour) {
  return hour >= DEEP_NIGHT_START_HOUR || hour < DEEP_NIGHT_END_HOUR;
}

function updateLighting() {
  // Azimuth is driven by day/night *phase* (0 at sunrise, 1 at sunset, then
  // 0..1 again through the night back to the next sunrise) rather than raw
  // clock hour directly. Stretching the day out longer changed which clock
  // hour sunset falls on, but sunset should still happen facing the same
  // compass direction it always has — tying azimuth straight to hour would
  // drag that direction around by however much the day/night split shifted.
  let elevation, azimuth;
  if (skyParams.hour >= SUNRISE_HOUR && skyParams.hour <= SUNSET_HOUR) {
    const dayFrac = (skyParams.hour - SUNRISE_HOUR) / DAY_LEN;
    elevation = 90 * Math.sin(Math.PI * dayFrac);
    azimuth = dayFrac * 180;
  } else {
    const sinceSunset = (skyParams.hour - SUNSET_HOUR + 24) % 24;
    const nightFrac = sinceSunset / NIGHT_LEN;
    elevation = -90 * Math.sin(Math.PI * nightFrac);
    azimuth = 180 + nightFrac * 180;
  }
  // Computed from elevation (available now) rather than sunDir.y (only
  // available after sky.update() returns) since it's needed to boost
  // rayleigh going *into* that same call — see below.
  // Narrower band than before (3.0 vs 2.2): at 2.2 the warm/boosted twilight
  // treatment was active across a ~54° swing around the horizon — most of
  // the afternoon/dusk descent, not just the actual sunset — which is what
  // read as the lighting staying "too powerful" for too long.
  const twilight = THREE.MathUtils.clamp(1 - Math.abs(Math.sin(elevation * Math.PI / 180)) * 3.0, 0, 1);

  const sunDir = sky.update({
    elevation,
    azimuth,
    turbidity: skyParams.turbidity,
    // Boosted during twilight. Rayleigh is what fills the *whole* sky with
    // color via atmospheric scattering, not just the region right around
    // the sun — kept low at the base value to avoid the noon-brightness
    // blowout from earlier, but that low value starves the sky of ambient
    // light at low sun angles: everywhere goes black except a bright ring
    // hugging the horizon around the sun. This restores the rest of the
    // sky's color specifically during sunset/sunrise, without reintroducing
    // the noon problem (twilight is ~0 outside a ±14° window around the
    // horizon).
    rayleigh: skyParams.rayleigh + 0.2 * twilight,
    mieCoefficient: skyParams.mieCoefficient,
    mieDirectionalG: skyParams.mieDirectionalG,
    cloudCoverage: cloudParams.coverage,
    cloudDensity: cloudParams.density,
    cloudScale: cloudParams.scale,
    // Wind speeds up cloud drift a little on top of whatever base speed is
    // dialed in. Capped low — gust.speed can spike well above the base wind
    // speed during a gust, and an uncapped multiplier here made clouds
    // occasionally streak across the sky absurdly fast.
    cloudSpeed: cloudParams.speed * THREE.MathUtils.clamp(1 + gust.speed / 90, 1, 1.5),
    windDirection: gust.direction,
    time: simTime,
    starDensity: starParams.density,
    starBrightness: starParams.brightness,
    // One frame stale (this function computes this frame's real frameTint
    // further down, from the sunDir this very call returns — a chicken/egg
    // ordering issue) but utterly imperceptible, and far simpler than
    // restructuring the ordering just to shave off a single frame of lag.
    nightTint: frameTint,
    nightBrightness: LOCATION_CONFIGS[currentLocationName]?.nightBrightness ?? 1,
  });
  sky.sky.position.copy(camera.position);
  sky.sunSprite.position.add(camera.position);
  sky.moonSprite.position.add(camera.position);
  sky.stars.position.copy(camera.position);
  // Suppressed during quick-travel, same reasoning as god rays: the climb
  // briefly points near-vertical and can incidentally line up with the sun
  // (or moon) and flare blindingly.
  if (flight) {
    sky.sunSprite.material.opacity = 0;
    sky.moonSprite.material.opacity = 0;
  }

  const dayAmount = THREE.MathUtils.clamp(sunDir.y, 0, 1);

  sun.position.copy(sunDir).multiplyScalar(1000);
  // Coverage dims the sun (it's genuinely occluded) but not this hard —
  // 0.6 at full coverage plus the hemi/ambient reduction below combined to
  // look like night, not an overcast day.
  sun.intensity = THREE.MathUtils.lerp(0.05, 2.6, dayAmount) * (1 - cloudParams.coverage * 0.3);

  skyTone.copy(DAY).lerp(SUNRISE, twilight);
  if (sunDir.y < 0) skyTone.lerp(NIGHT, THREE.MathUtils.clamp(-sunDir.y * 3, 0, 1));
  sun.color.copy(skyTone);

  // Moonlight: opposite the sun (a simplification — real moon phase/position
  // aren't tied to time of day like this, but it reads fine), fading in only
  // once the sun is genuinely below the horizon so it never fights the sun
  // itself for "key light" during the day.
  moon.position.copy(sunDir).multiplyScalar(-1000);
  // Ramps up faster than the equivalent daytime curve (5 vs the old 3) —
  // at 3 there was a real dark trough for a while right after sunset before
  // the moon/night floor caught up (dayAmount had already bottomed out but
  // nightAmount hadn't ramped up yet); this closes most of that gap.
  const nightAmount = THREE.MathUtils.clamp(-sunDir.y * 5, 0, 1);
  moon.intensity = nightAmount * 1.4;

  // Google's photorealistic tiles have no baked night-lighting texture, so
  // with the sun fully down the only light is this floor (plus the moon
  // above) — keep it high enough that the city stays a dim, moonlit blue
  // instead of going black. Kept well under the sun's own intensity (up to
  // 2.6) so the sun reads as the accent/key light rather than everything
  // sitting at one flat wash.
  // dayAmount alone is 0 for the entire night (it clamps at the horizon),
  // so the old formula gave "just after sunset" and "deepest night" the
  // exact same flat floor — nightAmount adds a further boost that only
  // ramps in past the horizon, so full night reads brighter than dusk.
  ambient.intensity = THREE.MathUtils.lerp(0.28, 0.3, dayAmount) + nightAmount * 0.35;
  // Diffuse skylight barely drops under cloud cover in reality (overcast
  // skies scatter light more evenly, not less) — this used to cut it by up
  // to 30%, stacking with the sun reduction above into a near-night look.
  hemi.intensity = THREE.MathUtils.lerp(0.35, 0.5, dayAmount) * (1 - cloudParams.coverage * 0.1) + nightAmount * 0.4;

  // OVERCAST is tuned for daylight; blending toward it at fixed brightness
  // regardless of time of day made cloudy/stormy presets look *brighter*
  // than Clear at night (Clear's skyTone correctly goes dark, but every
  // other preset got pulled toward this fixed mid-brightness color instead)
  // — scaling it down at night fixes that without touching the daytime look.
  // Floor raised alongside the NIGHT color bump above (0.2 was tuned to
  // roughly match the old near-black NIGHT; left as-is it now undershoots
  // the brighter NIGHT, making cloudy/stormy nights darker than Clear).
  overcastColor.copy(OVERCAST).multiplyScalar(THREE.MathUtils.lerp(0.65, 1, dayAmount));

  fog.color.copy(skyTone).lerp(overcastColor, cloudParams.coverage);

  frameTint.copy(skyTone).lerp(overcastColor, cloudParams.coverage * 0.5);
  bloomTint.copy(WHITE).lerp(SUN_GLOW, twilight);
  // Lighter touch than before — cloudy days should stay cool and blue, not
  // wash all the way to flat grey.
  postFx.weatherGrade.set({
    tint: [frameTint.r, frameTint.g, frameTint.b],
    desaturate: THREE.MathUtils.clamp(
      cloudParams.coverage * 0.22 + (stormParams.enabled ? 0.15 : 0), 0, 0.4,
    ),
    vignetteStrength: fxParams.vignette,
  });
  postFx.bloom.set({ tint: [bloomTint.r, bloomTint.g, bloomTint.b] });

  // Earth view (the globe overview) is lit like a view from space, not a
  // ground-level sunset/sunrise — none of the above, all driven by the
  // simulated ground clock, should leak into it as a full-screen tint/
  // desaturation/vignette. Stars are forced fully on too: day/night is a
  // ground-level phenomenon that doesn't apply from space.
  if (overviewActive) {
    // A touch brighter and more saturated than the raw satellite photos —
    // reads more like a vivid "postcard" globe, less like a flat scan.
    postFx.weatherGrade.set({ tint: [1.08, 1.08, 1.1], desaturate: -0.22, vignetteStrength: 0 });
    postFx.bloom.set({ tint: [1, 1, 1] });
    sky.setStarUniforms({ opacity: 1 });
  }

  return sunDir;
}

const camForward = new THREE.Vector3();
const sunScreenPos = new THREE.Vector3();
function updateGodRays(sunDir) {
  // No ground-level "sun" concept from space — skip the pass entirely
  // rather than let it fire based on the simulated ground clock's sun
  // position, which has nothing to do with the earth view.
  if (overviewActive) {
    postFx.godRays.set({ strength: 0 });
    return;
  }
  camera.getWorldDirection(camForward);
  // Sun-only: extending this to fire off the moon at night sounded nice in
  // theory, but with hundreds of individually bright stars now on screen
  // (see sky.js's per-star magnitude/size variation) this pass's own
  // "sample toward the light from every bright pixel" design turned every
  // single star into its own streak converging on the moon — a chaotic
  // "warp speed" starfield, not a calm moonlit sky. The moon's own bloom
  // halo (from its brightness alone) is doing that job instead.
  const facingSun = camForward.dot(sunDir);
  sunScreenPos.copy(camera.position).addScaledVector(sunDir, 10000).project(camera);
  const edgeDist = Math.max(Math.abs(sunScreenPos.x), Math.abs(sunScreenPos.y));
  const edgeFade = THREE.MathUtils.clamp(1.6 - edgeDist, 0, 1);
  const frontFade = THREE.MathUtils.clamp(facingSun * 4, 0, 1);
  // Offset so this doesn't cut off right at the horizon, the moment sunsets
  // actually look best — full by ~16° elevation (matching sky.js's sun-disc
  // glow), tapering out gradually rather than hard-stopping until ~6° below.
  const elevationFade = THREE.MathUtils.clamp((sunDir.y + 0.1) * 3.2, 0, 1);

  // Suppressed during quick-travel: the climb briefly points near-vertical,
  // which can incidentally line up with the sun — a blinding flare mid-
  // transition looks like a bug, not a feature.
  const flightFade = flight ? 0 : 1;

  // Steeper than a straight coverage falloff (squared, not linear): this
  // pass samples toward the sun from *every* bright pixel on screen, not
  // just ones near the sun, so a bright 3D cloud anywhere in frame can
  // streak on its own — a real "clear sky with a sunbeam" look needs
  // clouds to actually be sparse, not just "coverage isn't 100%."
  const cloudDamp = (1 - cloudParams.coverage) ** 2;
  const strength =
    fxParams.godRayStrength * edgeFade * frontFade * elevationFade * cloudDamp * flightFade;
  // Skips the pass's full-screen draw and render-target swap entirely once
  // it has nothing to contribute (sun below the horizon, facing away, mid-
  // flight, etc.) rather than running it just to blend in zero.
  postFx.godRays.set({
    lightPosition: [(sunScreenPos.x + 1) / 2, (sunScreenPos.y + 1) / 2],
    strength,
  });
}

// Directional wind-driven streak blur is owned by the weather subsystem
// now (see weather/windBlur.ts) — reached via weather.updateWindBlur()
// below.

// Radial blur toward screen center — sells the speed of the overview's own
// zoom-in and the local-view descend that continues it, and doubles as
// cover for whatever's genuinely still coarse or half-loaded on screen
// during either (a satellite patch not yet refined, 3D tiles not yet
// streamed in — see prefetchLocationHeavy, which narrows but can't fully
// close that window). Center is left at the shader's own (0.5, 0.5)
// default rather than tracked per-frame — both flyTo's pan and the
// descend's pan-up already keep the destination close to center by design,
// and chasing the exact point here would be effort spent on a detail this
// blurry moment doesn't make legible anyway.
function updateZoomBlur() {
  let strength = 0;
  // The globe overview's own dive — ramps up on the same accelerating
  // curve the zoom itself uses (see flyTo), peaking right at the handoff.
  if (overviewFlightState.active) {
    strength = Math.max(strength, overviewFlightState.blurStrength);
  }
  // The local descend that continues it (or, for a plain teleport with no
  // overview involved, sells that dive on its own) — the mirror image:
  // full strength the instant it opens, fading out as it settles into the
  // final framing, tracking the same ease-out curve the descend itself now
  // uses (see updateFlight) so the blur clears at the same rate the camera
  // does.
  if (flight && flight.phase === 'descend') {
    const t = Math.min(flight.t / flight.descendDuration, 1);
    strength = Math.max(strength, 1 - easeOutCubic(t));
  }
  // The zoom-out handoff's own climb (startZoomOutToOverview) — the
  // opposite shape from descend above, matching its own ease-in: builds
  // toward full strength as it approaches the handoff into the overview's
  // flyOut, rather than opening at full strength and fading.
  if (flight && flight.phase === 'ascendToSpace') {
    const t = Math.min(flight.t / flight.duration, 1);
    strength = Math.max(strength, easeInCubic(t));
  }
  // Skip the pass's full-screen draw entirely the rest of the time, same as
  // every other situational effect here.
  postFx.zoomBlur.set({ strength: strength * fxParams.zoomBlurStrength });
}

// precipitationAmounts/weatherIntensity/computeWindShake/computeFov/
// updateLightning are all owned by the weather subsystem now — reached via
// weather.* below.

function updatePostFX(nightAmount) {
  postFx.setExposure(fxParams.exposure);
  // Extra bloom at night, on top of whatever the weather preset already
  // wants — daytime bloom is tuned around the sun, and that same modest
  // strength left stars/moon reading as small tight dots with barely any
  // halo. A wider, stronger glow specifically at night is what actually
  // sells them as bright, significant light sources instead of pinpoints.
  // Earth view uses a fixed, un-pulsing bloom instead — nightAmount is a
  // ground-clock concept that shouldn't visibly breathe in and out while
  // looking at the globe from space.
  const effectiveNightAmount = overviewActive ? 0 : nightAmount;
  postFx.bloom.set({
    strength: fxParams.bloomStrength + weather.getFlash() * 1.2 + effectiveNightAmount * 0.9,
    radius: fxParams.bloomRadius + effectiveNightAmount * 1.8,
    threshold: fxParams.bloomThreshold,
  });
}

// --- Resize ---
window.addEventListener('resize', handleResize);

// --- Loop ---
const clock = new THREE.Clock();
const renderOffset = new THREE.Vector3();
// Accumulated simulation seconds — advances only by `dt` below, so it (and
// everything driven by it, like cloud drift) stops the instant `dt` does.
// Real wall-clock time (performance.now()) is what cloud drift used to
// read directly, which is exactly why it kept animating even with "time
// freeze" on: freezing `dt` doesn't touch the real clock, only this one does.
let simTime = 0;
function tick() {
  if (stats) stats.begin();
  const rawDt = Math.min(clock.getDelta(), 0.1);
  // The single master pause (see `timeFrozen`'s declaration): every line
  // below multiplies by `dt` somewhere down the chain, so forcing it to 0
  // freezes movement, flight, gust, weather particles, lightning, and
  // preset cross-fades all at once, with no separate check needed in any
  // of them. `controls.update()` is the one exception (OrbitControls reads
  // real mouse deltas, not dt) and is skipped explicitly below.
  const dt = timeFrozen ? 0 : rawDt;
  simTime += dt;

  // localCameraControl.update() moves camera.position directly every frame
  // WASD is held or the wheel is spinning — fine for the ground flythrough,
  // but during the globe overview nothing else reacts to that move:
  // usMap.js's marker <div>s are only repositioned by its own wheel/drag/
  // zoom handlers, not by this. Held WASD (if navEnabled was ever toggled
  // on) would silently drag the camera away from the overview's own lat/
  // lon/zoom pose every frame, while the globe itself (rendered fresh from
  // the real camera every frame) visibly moved and the markers stayed
  // frozen at their last computed position — exactly the "ground moves,
  // pins don't" symptom, worsening the longer WASD was held, independent of
  // anything zoom-related. (Wheel input is separately guarded inside
  // localCameraControl itself via isLocalViewActive, since its listener
  // stays attached the whole time rather than only being called from here.)
  const flightBeforeUpdate = flight;
  if (!updateFlight(dt) && !overviewActive) localCameraControl.update(dt);
  updateTravelTempLerp(flightBeforeUpdate);
  weather.updateGust(dt);

  if (timeMode === 'live') {
    // Reads Date.now() directly rather than integrating dt — dt only covers
    // time this tab was actually open/foregrounded, which would drift from
    // the real clock the moment the tab was backgrounded or the machine
    // slept. timeFrozen still applies here too (console "time freeze" is
    // the whole-simulation pause, live mode included), so it holds at
    // whatever real moment freeze was hit instead of jumping ahead the
    // instant it's lifted.
    //
    // Unlike sim mode, this sets skyParams.hour to the CURRENT location's
    // own real local hour, not raw UTC — the sun/star rendering below reads
    // skyParams.hour directly with no per-location shift of its own (see
    // SUNRISE_HOUR/SUNSET_HOUR azimuth math), so a real Palo Alto afternoon
    // needs an actual afternoon hour value to render as daylight, not a
    // "world clock" that happens to read as UTC night. Only the overview
    // (no single location) falls back to plain UTC, matching its "World
    // Time (UTC)" label below.
    //
    // Uses currentUtcOffsetHours (timeZone, DST-aware), not the location's
    // static utcOffset — that field is a fixed winter/standard-time value,
    // so for roughly half the year (whenever DST is in effect) it was an
    // hour off from the actual local clock.
    if (!timeFrozen) {
      const now = new Date();
      const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
      const utcOffset = overviewActive ? 0 : currentUtcOffsetHours(
        LOCATION_CONFIGS[currentLocationName]?.timeZone ?? 'UTC', now,
      );
      skyParams.hour = (utcHour + utcOffset + 24) % 24;
      const hourBucket = Math.floor(now.getTime() / (1000 * 60 * 60));
      if (hourBucket !== lastLiveWeatherHourBucket) applyLiveWeather();
    }
  } else {
    const hourSpeed = timeSpeed * (isDeepNight(skyParams.hour) ? DEEP_NIGHT_SPEED_MULTIPLIER : 1);
    skyParams.hour = (skyParams.hour + hourSpeed * dt) % 24;
    // sim hours, not real seconds — ties how often weather changes to the
    // world's own clock (including night running faster) instead of a real-
    // world timer that kept rolling regardless of how fast or slow time was
    // actually passing.
    if (weather.tickAutoRoll(hourSpeed * dt)) {
      weather.applyPreset(weather.pickNextPreset(currentLocationName));
    }
  }
  // Sim mode: skyParams.hour is one shared clock for the whole session (it
  // never resets or shifts on arrival) — treated as world/UTC time,
  // converted to whichever location you're actually standing in via its own
  // utcOffset for display. Live mode: skyParams.hour is already that
  // location's real local hour (see above), so the panel shows it as-is.
  // Both: shown raw, labeled UTC, from space where no single location's
  // time would make sense.
  if (playerPanel) {
    if (overviewActive) {
      playerPanel.setTime(skyParams.hour, 'World Time (UTC)');
    } else if (timeMode === 'live') {
      playerPanel.setTime(skyParams.hour, 'Local Time');
    } else {
      const utcOffset = LOCATION_CONFIGS[currentLocationName]?.utcOffset ?? 0;
      playerPanel.setTime((skyParams.hour + utcOffset + 24) % 24, 'Local Time');
    }
  }

  weather.updatePresetTransition(dt);

  // setLocalViewVisible(false) sets rain.object/snow.object/windStreaks.object
  // .visible = false the instant the overview opens — but each system's own
  // update() unconditionally does `object.visible = params.enabled` (or
  // `windSpeed > minVisibleWindSpeed`) as its very first line (see
  // src/particles/), and params.enabled can still be true for as long as
  // the preset transition duration after a weather roll starts moving away
  // from rain/snow — applyPreset only flips it false at the *end* of that
  // cross-fade. Left ungated, the next call to .update() (every frame,
  // unconditionally) stomped straight back over what setLocalViewVisible
  // just set, and kept simulating/respawning particles using
  // camera.position — now Earth-scale globe coordinates instead of local
  // ones — scattering them across literally the whole visible sky. Passing
  // `!overviewActive` as weather.updateParticles' `active` flag is what
  // actually makes it stick, immediately, the same way
  // localCameraControl.update()/controls.update() are already skipped there.
  // Render-quality density scale (see src/quality/) — read fresh every
  // frame so a live quality switch takes effect on the next update, same
  // as the wind feed just above it.
  const precipitationDensityScale = renderQuality.precipitationDensityScale();
  rain.params.densityScale = precipitationDensityScale;
  snow.params.densityScale = precipitationDensityScale;
  windStreaks.params.densityScale = renderQuality.windStreaksDensityScale();
  weather.updateParticles(dt, camera.position, !overviewActive);

  const sunDir = updateLighting();
  updateGodRays(sunDir);
  weather.updateWindBlur();
  updateZoomBlur();
  cache.update();
  weather.updateLightning(dt, camera.position);
  // Same curve updateLighting() uses internally for the moon/night light
  // floor — recomputed here since that's a local inside updateLighting(),
  // not something it currently returns.
  const nightAmount = THREE.MathUtils.clamp(-sunDir.y * 5, 0, 1);
  // windSpeed/windDirection/coverage/density/formation/levels/rainAmount/
  // snowAmount/stormAmount/flash all come from the weather subsystem
  // (see cloudUpdateParams' own comment on why darkening/tinting keys off
  // actual precipitation, not coverage or wind); dt/simTime/cameraPosition/
  // sunColor/ambientColor/nightAmount are this frame's lighting context,
  // which clouds isn't part of the weather subsystem's own concerns.
  clouds.update({
    ...weather.cloudUpdateParams(),
    dt,
    simTime,
    cameraPosition: camera.position,
    sunColor: sun.color,
    ambientColor: frameTint,
    nightAmount,
    activeFraction: renderQuality.cloudActiveFraction(),
  });
  updatePostFX(nightAmount);

  // The globe overview sets camera.position/up/quaternion directly every
  // frame itself (see usMap.js's applyCamera) — controls.enabled is already
  // off there, but update() still decays any *existing* damping velocity
  // regardless of .enabled, which fights that direct positioning. Skipping
  // it outright during overview is what actually stops the shake.
  if (!timeFrozen && !overviewActive) controls.update();

  // Debug readout (position/target/lat-lon) is only ever looked at with the
  // dev menu open — tiles.getGeoPosition in particular does a matrix invert
  // plus a cartographic conversion, not worth paying for on every frame of
  // every ordinary visit.
  if (guiVisible) {
    debugState.x = camera.position.x;
    debugState.y = camera.position.y;
    debugState.z = camera.position.z;
    debugState.targetX = controls.target.x;
    debugState.targetY = controls.target.y;
    debugState.targetZ = controls.target.z;
    debugState.zoom = camera.zoom;
    debugState.fov = camera.fov;
    const geo = tiles.getGeoPosition(camera.position);
    debugState.lat = geo.lat;
    debugState.lon = geo.lon;
    debugState.height = geo.height;
    debugState.lod = overviewActive && overview ? overview.getLod() : -1;
  }

  // Bob + weather shake are applied only to this frame's render pose, then
  // immediately reverted — camera.position stays the clean value that
  // movement/controls math relies on next frame. FOV gets the same
  // render-only treatment for the same reason. With dt at 0 these settle to
  // a fixed offset rather than a moving one — frozen, not skipped, so there's
  // no snap when the phase they're built from resumes.
  // None of this applies in the globe overview — it's the ground-level
  // "standing/flying in weather" idle bob and wind shake, computed off
  // camera orientation and the simulated ground weather; applied to a space
  // camera framing a whole planet, that idle-scale jitter reads as visible
  // shake instead of the subtle effect it's tuned for at ground level.
  const baseFov = camera.fov;
  if (overviewActive) {
    renderOffset.set(0, 0, 0);
  } else {
    const intensity = weather.weatherIntensity();
    renderOffset.copy(computeBob(dt)).add(weather.computeWindShake(dt, intensity));
    camera.fov = weather.computeFov(dt, intensity);
    camera.updateProjectionMatrix();
  }
  camera.position.add(renderOffset);

  tiles.update();
  postFx.render();

  camera.fov = baseFov;
  camera.updateProjectionMatrix();
  camera.position.sub(renderOffset);

  if (stats) stats.end();
}
renderer.setAnimationLoop(tick);
