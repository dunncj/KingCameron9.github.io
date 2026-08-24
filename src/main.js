import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildScene } from './scene.js';
import { buildTiles } from './tiles.js';
import { buildSky } from './sky.js';
import { buildRain, buildSnow, buildWindStreaks, RAIN_MAX_INTENSITY, SNOW_MAX_INTENSITY } from './weather.js';
import { buildClouds, CLOUD_FORMATIONS } from './clouds.js';
import { buildComposer } from './postprocessing.js';
import { buildPlayerPanel } from './player.js';
import { buildDevConsole } from './devconsole';
import {
  mountUSOverview, TILT_RAD, flyInParams, overviewFlightState, destPrefetchParams, hoverParams,
} from './usMap.js';
import { createPreloadManager } from './preloadManager.js';
import { movementParams, curveOptions } from './flightCurves';
import { settings, exportSettingsToml } from './settings/store';
import { buildSettingsCommand } from './settings/commands';
import { buildTimeCommand } from './commands/timeCommand';
import { buildWeatherCommand } from './commands/weatherCommand';
import { buildStarsCommand } from './commands/starsCommand';
import { buildTravelCommand } from './commands/travelCommand';
import { buildControlsCommand } from './commands/controlsCommand';
import { buildDebugCommand } from './commands/debugCommand';

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

// --- Weather particles ---
const rain = buildRain(scene, settings.rain);
const snow = buildSnow(scene, settings.snow);
const windStreaks = buildWindStreaks(scene);
const clouds = buildClouds(scene, camera.position);

// --- Postprocessing ---
const {
  composer, renderPixelatedPass, godRaysPass, bloomPass, weatherGradePass, windBlurPass, zoomBlurPass,
} = buildComposer(renderer, scene, camera, settings.pixelArt.pixelSize);
renderPixelatedPass.normalEdgeStrength = settings.pixelArt.normalEdgeStrength;
renderPixelatedPass.depthEdgeStrength = settings.pixelArt.depthEdgeStrength;

// The scene only ever gets rasterized at 1/pixelSize resolution before
// RenderPixelatedPass upscales it — telling the tile LOD system the full
// renderer resolution (the default from setResolutionFromRenderer) makes it
// select detail fine enough for `pixelSize`x more pixels than ever actually
// render. Scaling the resolution it's told about down to match is what lets
// errorTarget stay reasonable without wasting triangles on detail the
// pixelation pass immediately throws away.
function syncTilesResolution() {
  const size = renderer.getSize(new THREE.Vector2());
  tiles.setResolution(camera, size.x / renderPixelatedPass.pixelSize, size.y / renderPixelatedPass.pixelSize);
}
syncTilesResolution();

// --- Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 50;
controls.maxDistance = 50000;
// OrbitControls always re-orients the camera toward its own target on the
// first update() — matching that to where camera.lookAt() already pointed,
// otherwise the target's default (0,0,0) silently overrides it.
controls.target.copy(PALO_ALTO_VIEW.target);
controls.enabled = false; // mouse/touch nav off by default — toggled by the "Controls" button

// --- WASD/QE fly movement (pans camera + orbit target together) ---
const moveParams = settings.camera.move; // speed in meters/sec
const KEY_MAP = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  KeyE: 'up', KeyQ: 'down', Space: 'up', ShiftLeft: 'down',
};
const held = new Set();
window.addEventListener('keydown', (e) => { if (navEnabled && KEY_MAP[e.code]) held.add(KEY_MAP[e.code]); });
window.addEventListener('keyup', (e) => { if (KEY_MAP[e.code]) held.delete(KEY_MAP[e.code]); });

const moveForward = new THREE.Vector3();
const moveRight = new THREE.Vector3();
function applyMovement(dt) {
  if (held.size === 0) return;
  const speed = moveParams.speed * dt;
  camera.getWorldDirection(moveForward);
  moveForward.y = 0;
  moveForward.normalize();
  moveRight.crossVectors(moveForward, camera.up).normalize();

  const delta = new THREE.Vector3();
  if (held.has('forward')) delta.addScaledVector(moveForward, speed);
  if (held.has('back')) delta.addScaledVector(moveForward, -speed);
  if (held.has('right')) delta.addScaledVector(moveRight, speed);
  if (held.has('left')) delta.addScaledVector(moveRight, -speed);
  if (held.has('up')) delta.y += speed;
  if (held.has('down')) delta.y -= speed;

  camera.position.add(delta);
  controls.target.add(delta);
}

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
  held.clear();
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
  if (held.size > 0) { flight = null; return false; } // user input cancels the auto-travel

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

  const moving = held.size > 0;
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
const cloudParams = settings.clouds; // formation: see clouds.js's CLOUD_FORMATIONS for the full list; levels: altitude bands, 1-3
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
// windParams is the base/average the GUI controls; `gust` is the effective,
// continuously-fluctuating value everything actually renders with — real
// wind isn't constant, it surges, dies down, and swings direction over time.
const windParams = settings.wind;
const gust = { speed: windParams.speed, direction: windParams.direction };
let gustPhase = 0;
function updateGust(dt) {
  gustPhase += dt;
  // Mismatched, slow periods read as organic gusting rather than a fixed
  // value or per-frame jitter — no RNG needed, just uncorrelated sines.
  const speedWobble =
    Math.sin(gustPhase * 0.09) * 0.5 +
    Math.sin(gustPhase * 0.033 + 1.7) * 0.35 +
    Math.sin(gustPhase * 0.021 + 4.1) * 0.25;
  const dirWobble =
    Math.sin(gustPhase * 0.015 + 2.3) * 0.6 +
    Math.sin(gustPhase * 0.028 + 5.5) * 0.4;

  const speedMultiplier = THREE.MathUtils.clamp(1 + speedWobble, 0.1, 1.8);
  gust.speed = windParams.speed * speedMultiplier;
  // Was *40 (up to ±40°) — barely noticeable at a calm preset's low speed,
  // but the exact same swing at a windy preset's much higher speed made
  // clouds/rain/streaks visibly change direction hard enough to read as
  // "the wind direction just changed" during a weather transition, when
  // really it was always doing this and speed just made it obvious. A much
  // smaller swing keeps direction feeling stable across every preset.
  gust.direction = windParams.direction + dirWobble * 12;
}
const windShakeParams = settings.wind.shake;
const stormParams = settings.storm;
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
const PRESETS = settings.presets;

// { <preset's display label>: <preset's settings key> } — the shape
// lil-gui wants for a dropdown (see the "Weather Preset" folder below),
// same pattern as flightCurves.ts's curveOptions.
function presetOptions() {
  const options = {};
  for (const [key, preset] of Object.entries(PRESETS)) options[preset.label] = key;
  return options;
}

// Resolves free-form console input (either a preset's key or its display
// label, case-insensitively — "Partly Cloudy" and "partlyCloudy" both
// work) to its settings key, or undefined if nothing matches.
function matchPresetName(raw) {
  const needle = raw.toLowerCase();
  const found = Object.entries(PRESETS).find(
    ([key, preset]) => key.toLowerCase() === needle || preset.label.toLowerCase() === needle,
  );
  return found?.[0];
}

// The panel's displayed temperature: a location's own rough baseline (see
// settings.locations), nudged by whatever the sky is currently doing (see
// each preset's own tempDeltaF) — an estimate for flavor, not a forecast.
function estimatedTempF() {
  const baseTempF = LOCATION_CONFIGS[currentLocationName]?.baseTempF ?? 60;
  return baseTempF + (PRESETS[currentPresetName]?.tempDeltaF ?? 0);
}

// There genuinely is no weather in space — but the panel reporting nothing
// at all up there read as broken, not intentional, so it gets its own
// deadpan "condition" and a suitably brutal temperature instead of hiding
// the row (see enterOverview).
const SPACE_WEATHER_LABEL = 'Vacuum';
const SPACE_TEMP_F = -200;

// Weather as a directed graph, per location: each node's outgoing edges are
// [presetKey, weight] pairs — where the sky can plausibly go next from
// here, and how likely each option is relative to the others. This is what
// actually produces "clear -> partly cloudy -> cloudy -> rain -> clearing ->
// partly cloudy" style progressions instead of any preset being reachable
// from any other. Palo Alto skews sunny and never sees snow; Urbana leans
// colder/windier and routes through snow/heavySnow/blizzard instead of
// rain. Falls Church and Chantilly don't have their own graphs yet —
// pickWeatherFor below falls back to Palo Alto's for any location without
// one, which is a reasonable enough default for both (mid-Atlantic, not
// dramatically different from coastal California's mix). See
// settings.toml's [weatherGraphs.*] tables for the actual data.
const WEATHER_GRAPHS = settings.weatherGraphs;

// Weighted walk along the current location's graph from wherever the
// weather is now. If the current preset isn't a node in this location's
// graph at all (e.g. it was set manually via the console to something this
// location doesn't normally roll), fall back to an even pick across every
// node in the graph rather than getting stuck.
function pickWeatherFor(locationKey) {
  const graph = WEATHER_GRAPHS[locationKey] || WEATHER_GRAPHS.paloAlto;
  const edges = graph[currentPresetName];
  const options = edges && edges.length
    ? edges
    : Object.keys(graph).filter((name) => name !== currentPresetName).map((name) => [name, 1]);
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [name, weight] of options) {
    roll -= weight;
    if (roll <= 0) return name;
  }
  return options[options.length - 1][0];
}

let playerPanel = null; // set once buildPlayerPanel runs; keeps the user-facing panel in sync
let currentPresetName = 'clear';
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
// Sim hours between automatic weather rolls, not real seconds — ties how
// often weather changes to the world's own clock (including night running
// 3x faster) instead of a real-world timer that kept rolling regardless of
// how fast or slow time was actually passing, which is what made it feel
// like it was changing too often.
let weatherChangeIntervalHours = 10;
let autoWeatherFrozen = false; // set from ":" console's "weather freeze"/"weather run"
let autoWeatherTimer = weatherChangeIntervalHours;
// A little randomness so rolls don't happen on an eerily exact metronome.
function nextWeatherInterval() {
  return weatherChangeIntervalHours * (0.8 + Math.random() * 0.4);
}

// Weather presets cross-fade rather than snap: capture where every affected
// param currently sits, where the new preset wants it, and ease between the
// two over a few seconds each frame (see updatePresetTransition). Rain/snow
// specifically fade via `intensity` (weather.js scales opacity by it below
// 1), and get switched on immediately / off only once the fade-out
// finishes, so the particles are actually visible while fading rather than
// popping in/out at full or zero opacity.
let presetTransition = null;
// Matches clouds.js's SPAWN_GROW_SECONDS — every part of a weather change
// (fog/wind/bloom/rain/snow crossfade here, cloud cluster grow-in/shrink-out
// there) targets the same 10 seconds so a weather cycle reads as one
// unified transition instead of some parts finishing well before others.
const PRESET_TRANSITION_DURATION = 10;
// The very first call (module init, always 'clear') has nothing real to
// cross-fade *from* — "from" would just be weather.js/scene.js's raw
// constructor defaults, which were never actually shown on screen. Cross-
// fading from them anyway is exactly why rain (and to a lesser extent,
// clouds) could briefly appear on load before settling to Clear: the
// system was fading out a "rain" that only existed as an uninitialized
// default, never as something actually rendered.
let hasAppliedFirstPreset = false;

function applyPreset(name) {
  currentPresetName = name;
  const p = PRESETS[name];
  const targetRainEnabled = p.rain;
  const targetSnowEnabled = p.snow;

  if (!hasAppliedFirstPreset) {
    hasAppliedFirstPreset = true;
    cloudParams.coverage = p.coverage;
    cloudParams.density = p.density;
    fog.near = p.fogNear;
    fog.far = p.fogFar;
    windParams.speed = p.wind;
    fxParams.bloomStrength = p.bloom;
    fxParams.godRayStrength = p.godray;
    rain.params.enabled = targetRainEnabled;
    rain.params.intensity = targetRainEnabled ? (p.rainIntensity ?? 1) : 0;
    snow.params.enabled = targetSnowEnabled;
    snow.params.intensity = targetSnowEnabled ? (p.snowIntensity ?? 1) : 0;
    stormParams.enabled = p.storm;
    cloudParams.formation = p.cloudFormation;
    cloudParams.levels = p.cloudLevels;
    if (gui) gui.controllersRecursive().forEach((c) => c.updateDisplay());
    if (playerPanel) { playerPanel.setWeather(p.label); playerPanel.setTemp(estimatedTempF()); }
    return;
  }

  presetTransition = {
    t: 0,
    from: {
      coverage: cloudParams.coverage,
      density: cloudParams.density,
      fogNear: fog.near,
      fogFar: fog.far,
      windSpeed: windParams.speed,
      bloomStrength: fxParams.bloomStrength,
      godRayStrength: fxParams.godRayStrength,
      rainIntensity: rain.params.enabled ? rain.params.intensity : 0,
      snowIntensity: snow.params.enabled ? snow.params.intensity : 0,
    },
    to: {
      coverage: p.coverage,
      density: p.density,
      fogNear: p.fogNear,
      fogFar: p.fogFar,
      windSpeed: p.wind,
      bloomStrength: p.bloom,
      godRayStrength: p.godray,
      rainIntensity: targetRainEnabled ? (p.rainIntensity ?? 1) : 0,
      snowIntensity: targetSnowEnabled ? (p.snowIntensity ?? 1) : 0,
    },
    targetRainEnabled,
    targetSnowEnabled,
  };

  if (targetRainEnabled) rain.params.enabled = true;
  if (targetSnowEnabled) snow.params.enabled = true;
  // Lightning is an occasional event/accent, not a continuous base visual —
  // nothing to usefully cross-fade, so this just switches on/off directly.
  stormParams.enabled = p.storm;
  // Also set directly, not cross-faded — a discrete "personality" swap
  // isn't something that can be smoothly interpolated the way a number
  // can. New shapes only actually roll out gradually anyway, as clusters
  // naturally drift out and respawn with the new formation — see clouds.js.
  cloudParams.formation = p.cloudFormation;
  cloudParams.levels = p.cloudLevels;

  if (gui) gui.controllersRecursive().forEach((c) => c.updateDisplay());
  if (playerPanel) { playerPanel.setWeather(p.label); playerPanel.setTemp(estimatedTempF()); }
}

function updatePresetTransition(dt) {
  if (!presetTransition) return;
  presetTransition.t += dt;
  const raw = Math.min(presetTransition.t / PRESET_TRANSITION_DURATION, 1);
  const k = raw * raw * (3 - 2 * raw); // smoothstep ease
  const { from, to } = presetTransition;

  cloudParams.coverage = THREE.MathUtils.lerp(from.coverage, to.coverage, k);
  cloudParams.density = THREE.MathUtils.lerp(from.density, to.density, k);
  fog.near = THREE.MathUtils.lerp(from.fogNear, to.fogNear, k);
  fog.far = THREE.MathUtils.lerp(from.fogFar, to.fogFar, k);
  windParams.speed = THREE.MathUtils.lerp(from.windSpeed, to.windSpeed, k);
  fxParams.bloomStrength = THREE.MathUtils.lerp(from.bloomStrength, to.bloomStrength, k);
  fxParams.godRayStrength = THREE.MathUtils.lerp(from.godRayStrength, to.godRayStrength, k);
  rain.params.intensity = THREE.MathUtils.lerp(from.rainIntensity, to.rainIntensity, k);
  snow.params.intensity = THREE.MathUtils.lerp(from.snowIntensity, to.snowIntensity, k);

  if (raw >= 1) {
    rain.params.enabled = presetTransition.targetRainEnabled;
    snow.params.enabled = presetTransition.targetSnowEnabled;
    presetTransition = null;
  }
}

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
  if (!devGuiPromise) devGuiPromise = buildDevGui();
  return devGuiPromise;
}

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

// Built once, on first "Menu" click: lil-gui and stats.module (plus every
// folder/controller below) are dev-only tools hidden by default, so nobody
// who never opens the menu should pay to download or construct them.
async function buildDevGui() {
  const [{ default: GUI }, { default: Stats }] = await Promise.all([
    import('lil-gui'),
    import('three/addons/libs/stats.module.js'),
  ]);

  stats = new Stats();
  stats.dom.style.top = '8px';
  stats.dom.style.left = 'auto';
  stats.dom.style.right = '8px';
  document.body.appendChild(stats.dom);

  gui = new GUI();
  // lil-gui defaults to the top-right corner — move it to the left instead.
  gui.domElement.style.right = 'auto';
  gui.domElement.style.left = '8px';

  // Everything below is one branch or another of the same centralized
  // settings tree (see settings/store.ts) — this button copies the whole
  // thing out in one shot, in the same TOML shape settings.toml itself
  // uses, so a session of GUI tweaking can be pasted straight back in to
  // make it the new defaults (see also the ":settings copy" console
  // command, which does the same thing).
  gui.add({
    copySettings: async () => {
      try {
        await navigator.clipboard.writeText(exportSettingsToml());
      } catch (err) {
        console.warn('Clipboard write failed:', err);
      }
    },
  }, 'copySettings').name('Copy All Settings');

  const weatherFolder = gui.addFolder('Weather Preset');
  weatherFolder.add({ preset: 'clear' }, 'preset', presetOptions()).name('preset').onChange(applyPreset);

  const skyFolder = gui.addFolder('Sky & Time');
  skyFolder.add(skyParams, 'hour', 0, 24, 0.05).name('time of day');
  skyFolder.add(skyParams, 'turbidity', 1, 20, 0.1);
  skyFolder.add(skyParams, 'rayleigh', 0, 0.5, 0.005);
  skyFolder.add(skyParams, 'mieCoefficient', 0, 0.02, 0.0005);
  skyFolder.add(skyParams, 'mieDirectionalG', 0, 0.99, 0.01);

  const cloudFolder = gui.addFolder('Clouds');
  cloudFolder.add(cloudParams, 'coverage', 0, 1, 0.01);
  cloudFolder.add(cloudParams, 'density', 0, 1, 0.01);
  cloudFolder.add(cloudParams, 'scale', 0.0001, 0.003, 0.0001);
  cloudFolder.add(cloudParams, 'speed', 0, 0.001, 0.00001);

  const starFolder = gui.addFolder('Stars');
  starFolder.add(starParams, 'density', 0, 1, 0.01).name('how starry');
  starFolder.add(starParams, 'brightness', 0, 6, 0.01);

  const rainFolder = gui.addFolder('Rain');
  rainFolder.add(rain.params, 'enabled').name('rain');
  rainFolder.add(rain.params, 'intensity', 0, 3, 0.1);

  const snowFolder = gui.addFolder('Snow');
  snowFolder.add(snow.params, 'enabled').name('snow');
  snowFolder.add(snow.params, 'intensity', 0, 3, 0.1);

  const windFolder = gui.addFolder('Wind');
  windFolder.add(windParams, 'speed', 0).step(1); // no upper bound — drag or type past 80
  windFolder.add(windParams, 'direction', 0, 360, 1);
  windFolder.add(windParams, 'streakBlur', 0, 1, 0.05).name('wind streak blur');
  windFolder.add(windShakeParams, 'enabled').name('weather camera shake');
  windFolder.add(windShakeParams, 'amount', 0, 3, 0.1).name('shake amount');

  const stormFolder = gui.addFolder('Storm');
  stormFolder.add(stormParams, 'enabled').name('lightning');

  const fxFolder = gui.addFolder('Post FX');
  fxFolder.add(fxParams, 'exposure', 0, 2.5, 0.01);
  fxFolder.add(fxParams, 'bloomStrength', 0, 3, 0.01).name('bloom strength');
  fxFolder.add(fxParams, 'bloomRadius', 0, 6, 0.05).name('bloom radius');
  fxFolder.add(fxParams, 'bloomThreshold', 0, 1.5, 0.01).name('bloom threshold');
  fxFolder.add(fxParams, 'godRayStrength', 0, 2, 0.01).name('god rays');
  fxFolder.add(fxParams, 'vignette', 0, 1.5, 0.01);

  const pixelFolder = gui.addFolder('Pixel Art');
  pixelFolder.close();
  // Bound to settings.pixelArt (not renderPixelatedPass directly) so
  // ":settings set pixelArt.pixelSize 5" and this slider both drive the
  // same value — onChange pushes it into the actual pass, which doesn't
  // read live from a params object the way sky/fx do.
  pixelFolder.add(settings.pixelArt, 'pixelSize', 1, 16, 1).onChange((v) => renderPixelatedPass.setPixelSize(v));
  pixelFolder.add(settings.pixelArt, 'normalEdgeStrength', 0, 2, 0.05).onChange((v) => {
    renderPixelatedPass.normalEdgeStrength = v;
  });
  pixelFolder.add(settings.pixelArt, 'depthEdgeStrength', 0, 1, 0.05).onChange((v) => {
    renderPixelatedPass.depthEdgeStrength = v;
  });

  // --- Teleport UI (lat/lon coordinates) ---
  const teleportState = { lat: tiles.defaultLatLon.lat, lon: tiles.defaultLatLon.lon };
  const teleportFolder = gui.addFolder('Teleport');
  teleportFolder.add(teleportState, 'lat', -90, 90, 0.0001).name('latitude');
  teleportFolder.add(teleportState, 'lon', -180, 180, 0.0001).name('longitude');
  teleportFolder.add({
    go: () => {
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      travelTo(teleportState.lat, teleportState.lon, new THREE.Vector3(0, 800, 800), new THREE.Vector3(0, 0, 0));
    },
  }, 'go').name('Teleport');
  teleportFolder.add({
    paloAlto: () => {
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      // Re-centers to Palo Alto every time, regardless of current location —
      // PALO_ALTO_VIEW's local coordinates are only meaningful relative to
      // that origin, so skipping the re-center (as a same-space fly did)
      // landed in the wrong place whenever this was called from anywhere
      // else, like Urbana.
      travelTo(tiles.defaultLatLon.lat, tiles.defaultLatLon.lon, PALO_ALTO_VIEW.position, PALO_ALTO_VIEW.target);
    },
  }, 'paloAlto').name('Go to Palo Alto');
  teleportFolder.add({
    urbana: () => {
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      travelTo(URBANA_VIEW.lat, URBANA_VIEW.lon, URBANA_VIEW.position, URBANA_VIEW.target);
    },
  }, 'urbana').name('Go to Urbana');
  teleportFolder.add({
    fallsChurch: () => {
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      travelTo(FALLS_CHURCH_VIEW.lat, FALLS_CHURCH_VIEW.lon, FALLS_CHURCH_VIEW.position, FALLS_CHURCH_VIEW.target);
    },
  }, 'fallsChurch').name('Go to Falls Church');
  teleportFolder.add({
    chantilly: () => {
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      travelTo(CHANTILLY_VIEW.lat, CHANTILLY_VIEW.lon, CHANTILLY_VIEW.position, CHANTILLY_VIEW.target);
    },
  }, 'chantilly').name('Go to Chantilly');

  // --- Overview → local-view handoff timing (see flyTo in usMap.js and
  // travelTo's opts.startLookDown branch above) ---
  const transitionFolder = gui.addFolder('Transition Speed');
  transitionFolder.add(flyInParams, 'zoom', 14, 20.5, 0.1).name('overview zoom-in depth');
  transitionFolder.add(flyInParams, 'ms', 400, 6000, 50).name('overview zoom-in ms');
  transitionFolder.add(flyInParams, 'panMs', 100, 2000, 50).name('overview centering ms');
  // Each movement (pan/zoom, entering/leaving) picks its own curve shape
  // and its own speed through that curve independently — see
  // flightCurves.ts's movementParams and getMovementCurve.
  const movementLabels = {
    panIn: 'Pan (entering)', zoomIn: 'Zoom (entering)', zoomOut: 'Zoom (leaving)', panOut: 'Pan (leaving)',
  };
  const curveFolder = transitionFolder.addFolder('Pan/Zoom Curves');
  for (const [movement, label] of Object.entries(movementLabels)) {
    const sub = curveFolder.addFolder(label);
    sub.add(movementParams[movement], 'curve', curveOptions()).name('curve shape');
    sub.add(movementParams[movement], 'speed', 0.25, 4, 0.05).name('speed through curve');
    sub.add(movementParams[movement], 'sharpness', 1, 60, 0.5).name('sharpness (hyperbolic only)');
  }
  transitionFolder.add(handoffParams, 'startHeight', 50, 2000, 10).name('local start height');
  transitionFolder.add(handoffParams, 'descendDuration', 0.2, 3, 0.05).name('local descend (s)');
  transitionFolder.add(fxParams, 'zoomBlurStrength', 0, 1.5, 0.05).name('zoom blur');

  // --- Destination pre-render tiers (see prefetchDestinationGrid in
  // usMap.js) — how far and how gradually the pre-fetched globe imagery
  // fades from full destination detail out to the coarse whole-globe
  // fallback around it.
  const destPrefetchFolder = transitionFolder.addFolder('Destination Prefetch');
  // Four tiers, finest to coarsest — radius 0 disables a tier outright
  // (see destPrefetchParams' own comment). zoomDrop is relative to the
  // destination's own zoom, so higher = coarser/wider real-world coverage
  // for the same radius.
  [
    ['highRes', 'High-res'],
    ['medRes', 'Med-res'],
    ['lowRes', 'Low-res'],
    ['veryLowRes', 'Very-low-res'],
  ].forEach(([key, label]) => {
    const tierFolder = destPrefetchFolder.addFolder(label);
    tierFolder.add(destPrefetchParams[key], 'radius', 0, 8, 1).name('radius (0 = off)');
    tierFolder.add(destPrefetchParams[key], 'zoomDrop', 0, 12, 1).name('zoom drop');
  });
  destPrefetchFolder.add(destPrefetchParams, 'edgeFadeStrength', 0, 1, 0.05).name('edge fade');
  destPrefetchFolder.add(destPrefetchParams, 'fetchBatchSize', 1, 25, 1).name('fetch batch/frame');
  destPrefetchFolder.add(destPrefetchParams, 'buildBatchSize', 1, 25, 1).name('build batch/frame');

  // --- Preload manager (see preloadManager.js) — when hovering, clicking,
  // and idling each trigger preloading, and how much they're allowed to
  // step on each other's bandwidth.
  const preloadFolder = transitionFolder.addFolder('Preload Manager');
  preloadFolder.add(hoverParams, 'radiusPx', 10, 300, 5).name('hover radius (px)');
  preloadFolder.add(hoverParams, 'debounceMs', 0, 2000, 50).name('hover debounce (ms)');
  preloadFolder.add(preloadManager.params, 'maxConcurrentHeavy', 1, 4, 1).name('max concurrent (hover)');
  preloadFolder.add(preloadManager.params, 'heavyCooldownMs', 0, 60000, 1000).name('heavy cooldown (ms)');
  preloadFolder.add(preloadManager.params, 'clickBackoffMs', 0, 5000, 50).name('click backoff (ms)');
  preloadFolder.add(preloadManager.params, 'idleDelayMs', 0, 20000, 500).name('idle delay (ms)');
  preloadFolder.add(preloadManager.params, 'idleIntervalMs', 500, 20000, 500).name('idle interval (ms)');
  preloadFolder.add(heavyPrefetchParams, 'resolutionScale', 0.05, 1, 0.05).name('3D tile prefetch res scale');
  preloadFolder.add(heavyPrefetchParams, 'staggerMs', 0, 1000, 20).name('3D tile prefetch stagger (ms)');

  const debugFolder = gui.addFolder('Debug');
  debugFolder.add(debugState, 'x').name('local x').listen().disable();
  debugFolder.add(debugState, 'y').name('local y').listen().disable();
  debugFolder.add(debugState, 'z').name('local z').listen().disable();
  debugFolder.add(debugState, 'targetX').name('target x').listen().disable();
  debugFolder.add(debugState, 'targetY').name('target y').listen().disable();
  debugFolder.add(debugState, 'targetZ').name('target z').listen().disable();
  debugFolder.add(debugState, 'zoom').name('camera zoom').listen().disable();
  debugFolder.add(debugState, 'fov').name('camera fov').listen().disable();
  debugFolder.add(debugState, 'lat').name('latitude').listen().disable();
  debugFolder.add(debugState, 'lon').name('longitude').listen().disable();
  debugFolder.add(debugState, 'height').name('height (m)').listen().disable();
  debugFolder.add(debugState, 'lod').name('lod level (overview)').listen().disable();
  debugFolder.add({
    copy: async () => {
      const text = [
        `local: ${debugState.x.toFixed(2)}, ${debugState.y.toFixed(2)}, ${debugState.z.toFixed(2)}`,
        `target: ${debugState.targetX.toFixed(2)}, ${debugState.targetY.toFixed(2)}, ${debugState.targetZ.toFixed(2)}`,
        `zoom: ${debugState.zoom.toFixed(3)}, fov: ${debugState.fov.toFixed(2)}`,
        `lat/lon: ${debugState.lat.toFixed(6)}, ${debugState.lon.toFixed(6)}`,
        `height: ${debugState.height.toFixed(1)}m`,
        `lod: ${debugState.lod}`,
      ].join('\n');
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.warn('Clipboard write failed:', err);
      }
    },
  }, 'copy').name('Copy to Clipboard');

  // --- Movement speed ---
  const moveFolder = gui.addFolder('Movement');
  moveFolder.add(moveParams, 'speed', 10, 3000, 10).name('speed (m/s)');
  moveFolder.add(bobParams, 'enabled').name('camera bob');
  moveFolder.add(bobParams, 'pattern', BOB_PATTERNS).name('bob pattern');
  moveFolder.add(bobParams, 'periodSeconds', 0.5, 60, 0.1).name('bob speed (s/cycle)');
  moveFolder.add(bobParams, 'amount', 0, 15, 0.5).name('bob amount');
  moveFolder.add(bobParams, 'idleAmount', 0, 6, 0.2).name('idle bob amount');

  gui.controllersRecursive().forEach((c) => c.updateDisplay());
}

// Keyboard (WASD) and mouse/touch (OrbitControls) navigation are both off
// by default — a passive/ambient viewing mode until explicitly opted into
// via the ":" console's "controls" command.
let navEnabled = false;

applyPreset('clear');

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
  const resW = Math.max(64, Math.round((size.x / renderPixelatedPass.pixelSize) * resolutionScale));
  const resH = Math.max(64, Math.round((size.y / renderPixelatedPass.pixelSize) * resolutionScale));
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

// One shared scheduler for every preload trigger below — hovering near a
// marker, clicking one, and idle background warming when nothing else is
// going on (see preloadManager.js for the actual policy). "heavy" is the
// real thing (prefetchLocationHeavy above); "light" is the same low-res,
// low-stakes single-camera warm every location used to get unconditionally
// a few seconds after every page load — now only spent on whichever
// location is actually still idle-eligible, on the manager's own schedule.
const preloadManager = createPreloadManager(settings.preload);
Object.keys(LOCATION_CONFIGS).forEach((name) => {
  const cfg = LOCATION_CONFIGS[name];
  preloadManager.registerLocation(name, {
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
  applyPreset(pickWeatherFor(currentLocationName));
  autoWeatherTimer = nextWeatherInterval();
  // Every arrival lands in local view, whichever path got it here — a
  // deep link straight to a location (see syncToPath) never goes through
  // leaveOverview(), which is otherwise the only place this normally gets
  // shown, and would otherwise leave it stuck hidden with no way back to
  // the overview.
  backToEarthBtn.style.display = 'block';
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

// --- User-facing panel (bottom-right): reports weather, temperature, and
// time (converted to whichever location you're at, or world/UTC time in
// space — see updatePlayerPanelStatus), plus how fast time passes. No
// location picker — traveling is a console command (see commands/travelCommand.ts).
playerPanel = buildPlayerPanel({
  initialWeather: PRESETS[currentPresetName].label,
  initialTempF: estimatedTempF(),
  initialHour: skyParams.hour,
  initialTimeLabel: 'Local Time',
  speedOptions: TIME_SPEEDS,
  initialSpeedIndex: DEFAULT_SPEED_INDEX,
  onSpeedChange: (value) => { timeSpeed = value; },
});

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
  rain.lines.visible = visible;
  snow.points.visible = visible;
  windStreaks.mesh.visible = visible;
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
  held.clear();
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
function enterOverview(seed, { push = true } = {}) {
  // Defensive, not just the normal path in: browser back/forward can land
  // here while an overview is already mounted (e.g. going from one /world/
  // history entry straight to another) — dispose it first rather than
  // leaking the old one under a second, freshly-mounted overview.
  if (overview) { overview.dispose(); overview = null; }
  flight = null;
  held.clear();
  backToEarthBtn.style.display = 'none';
  overviewActive = true;
  setLocalViewVisible(false);
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
    onActivity: () => preloadManager.notifyActivity(),
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
        // Anticipatory — see preloadManager.js. Hovering near a marker
        // runs the same heavy preload a click does, just earlier, subject
        // to the manager's own concurrency cap/cooldown so a fast sweep
        // across several markers doesn't fire all of them at once.
        onHoverNear: () => preloadManager.requestPreload(name),
        onFlightStart: () => {
          // A click always runs immediately regardless of the manager's
          // concurrency cap — hover may already have started this, but
          // travelTo needs it regardless of whether hover got there first.
          preloadManager.requestPreload(name, { immediate: true });
          preloadManager.notifyFlightStart();
        },
        onSelect: () => {
          leaveOverview();
          travelToLocation(name, { startLookDown: true });
        },
      };
    }),
    onSkip: () => {
      leaveOverview();
      travelToLocation(LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)].name);
    },
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
// current URL already names — a location's own /world/<slug>, or the
// overview at plain /world/ — and later back/forward navigation re-syncs
// to it the same way. Always the instant teleportToLocation/enterOverview
// path, never an animated flight — browser navigation is expected to land
// immediately, not sit through the same flight a click gets.
function syncToPath() {
  const match = window.location.pathname.match(/\/world\/([^/]+)\/?$/);
  const name = match ? matchLocationName(match[1]) : undefined;
  if (name) {
    teleportToLocation(name, { push: false });
  } else {
    enterOverview(undefined, { push: false });
  }
}
window.addEventListener('popstate', syncToPath);
syncToPath();

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
  setHour: (hour) => { skyParams.hour = hour; },
  getSpeed: () => timeSpeed,
  setSpeed: (v) => { timeSpeed = v; },
  freeze: () => {
    timeFrozen = true;
    // This is the master pause, not just the clock — see the comment by
    // `timeFrozen`'s declaration — so mouse-drag orbiting (the one camera
    // input that isn't driven by the loop's own dt) needs its own explicit
    // hold here, saved to restore on "time run".
    navEnabledBeforeTimeFreeze = navEnabled;
    navEnabled = false;
    controls.enabled = false;
    held.clear();
  },
  run: () => {
    timeFrozen = false;
    navEnabled = navEnabledBeforeTimeFreeze;
    controls.enabled = navEnabled;
  },
};

const weatherControl = {
  matchPreset: matchPresetName,
  presetLabel: (key) => PRESETS[key].label,
  presetLabels: () => Object.values(PRESETS).map((p) => p.label),
  applyPreset,
  currentPresetLabel: () => PRESETS[currentPresetName].label,
  setChangeIntervalHours: (hours) => { weatherChangeIntervalHours = hours; },
  freezeAuto: () => { autoWeatherFrozen = true; },
  runAuto: () => { autoWeatherFrozen = false; autoWeatherTimer = nextWeatherInterval(); },
  graphInfo: () => {
    const graph = WEATHER_GRAPHS[currentLocationName] || WEATHER_GRAPHS.paloAlto;
    const edges = graph[currentPresetName];
    const locationLabel = LOCATION_CONFIGS[currentLocationName].label;
    const presetLabel = PRESETS[currentPresetName].label;
    if (!edges) return `${locationLabel}: "${presetLabel}" has no graph edges — next roll picks evenly from every node`;
    const total = edges.reduce((sum, [, weight]) => sum + weight, 0);
    const options = edges
      .map(([name, weight]) => `${PRESETS[name].label} ${Math.round((weight / total) * 100)}%`)
      .join(', ');
    return `${locationLabel}: ${presetLabel} -> ${options}`;
  },
  cloudFormations: () => CLOUD_FORMATIONS,
  setCloudCoverage: (v) => { cloudParams.coverage = v; },
  setCloudDensity: (v) => { cloudParams.density = v; },
  setCloudLevels: (v) => { cloudParams.levels = v; },
  setCloudFormation: (v) => { cloudParams.formation = v; },
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
    if (!navEnabled) held.clear(); // don't leave WASD keys "stuck" held when turned off
    return navEnabled;
  },
};

const debugSnapshot = {
  snapshot: () => ({
    hour: skyParams.hour, timeSpeed, currentLocationName, currentPresetName,
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
  const weatherTintArr = weatherGradePass.uniforms.tint.value;
  weatherTintArr[0] = frameTint.r; weatherTintArr[1] = frameTint.g; weatherTintArr[2] = frameTint.b;
  bloomTint.copy(WHITE).lerp(SUN_GLOW, twilight);
  const bloomTintArr = bloomPass.uniforms.tint.value;
  bloomTintArr[0] = bloomTint.r; bloomTintArr[1] = bloomTint.g; bloomTintArr[2] = bloomTint.b;
  // Lighter touch than before — cloudy days should stay cool and blue, not
  // wash all the way to flat grey.
  weatherGradePass.uniforms.desaturate.value = THREE.MathUtils.clamp(
    cloudParams.coverage * 0.22 + (stormParams.enabled ? 0.15 : 0), 0, 0.4,
  );
  weatherGradePass.uniforms.vignetteStrength.value = fxParams.vignette;

  // Earth view (the globe overview) is lit like a view from space, not a
  // ground-level sunset/sunrise — none of the above, all driven by the
  // simulated ground clock, should leak into it as a full-screen tint/
  // desaturation/vignette. Stars are forced fully on too: day/night is a
  // ground-level phenomenon that doesn't apply from space.
  if (overviewActive) {
    const t = weatherGradePass.uniforms.tint.value;
    // A touch brighter and more saturated than the raw satellite photos —
    // reads more like a vivid "postcard" globe, less like a flat scan.
    t[0] = 1.08; t[1] = 1.08; t[2] = 1.1;
    weatherGradePass.uniforms.desaturate.value = -0.22;
    weatherGradePass.uniforms.vignetteStrength.value = 0;
    const bt = bloomPass.uniforms.tint.value;
    bt[0] = 1; bt[1] = 1; bt[2] = 1;
    sky.stars.material.uniforms.opacity.value = 1;
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
    godRaysPass.enabled = false;
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

  godRaysPass.uniforms.lightPosition.value.set((sunScreenPos.x + 1) / 2, (sunScreenPos.y + 1) / 2);
  // Steeper than a straight coverage falloff (squared, not linear): this
  // pass samples toward the sun from *every* bright pixel on screen, not
  // just ones near the sun, so a bright 3D cloud anywhere in frame can
  // streak on its own — a real "clear sky with a sunbeam" look needs
  // clouds to actually be sparse, not just "coverage isn't 100%."
  const cloudDamp = (1 - cloudParams.coverage) ** 2;
  const strength =
    fxParams.godRayStrength * edgeFade * frontFade * elevationFade * cloudDamp * flightFade;
  godRaysPass.uniforms.strength.value = strength;
  // Skips the pass's full-screen draw and render-target swap entirely once
  // it has nothing to contribute (sun below the horizon, facing away, mid-
  // flight, etc.) rather than running it just to blend in zero.
  godRaysPass.enabled = strength > 0.001;
}

// Directional streak blur along the wind's screen-projected direction —
// only kicks in once wind is genuinely strong (calm/breezy days stay crisp).
const windBlurWorldDir = new THREE.Vector3();
const windBlurP1 = new THREE.Vector3();
const windBlurP2 = new THREE.Vector3();
function updateWindBlur() {
  const windRad = gust.direction * (Math.PI / 180);
  windBlurWorldDir.set(Math.cos(windRad), 0, Math.sin(windRad));
  windBlurP1.copy(camera.position).project(camera);
  windBlurP2.copy(camera.position).addScaledVector(windBlurWorldDir, 60).project(camera);

  let dx = windBlurP2.x - windBlurP1.x;
  let dy = windBlurP2.y - windBlurP1.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;

  windBlurPass.uniforms.direction.value.set(dx, dy);
  // Only the sharpest gust peaks should trigger this at all — it reads as
  // generic blur, not "wind," if it's on any more often than that.
  const windAmount = THREE.MathUtils.clamp((gust.speed - 45) / 40, 0, 1);
  const strength = windAmount * windParams.streakBlur;
  windBlurPass.uniforms.strength.value = strength;
  // Most days never cross the gust threshold at all — skip the pass's draw
  // entirely rather than running it every frame to blend in zero.
  windBlurPass.enabled = strength > 0.001;
}

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
  zoomBlurPass.uniforms.strength.value = strength * fxParams.zoomBlurStrength;
  // Skip the pass's full-screen draw entirely the rest of the time, same as
  // every other situational effect here.
  zoomBlurPass.enabled = strength > 0.001;
}

// How rough the current weather is, 0..1 — combines wind, rain, and snow
// rather than just wind, so a heavy downpour or blizzard buffets the camera
// even on days that aren't specifically windy. Read by both the shake and
// the FOV response below so they stay in lockstep with each other.
function precipitationAmounts() {
  const rainAmount = rain.params.enabled ? THREE.MathUtils.clamp(rain.params.intensity / RAIN_MAX_INTENSITY, 0, 1) : 0;
  const snowAmount = snow.params.enabled ? THREE.MathUtils.clamp(snow.params.intensity / SNOW_MAX_INTENSITY, 0, 1) : 0;
  return { rainAmount, snowAmount };
}

function weatherIntensity() {
  const windAmount = THREE.MathUtils.clamp((gust.speed - 10) / 70, 0, 1);
  const { rainAmount, snowAmount } = precipitationAmounts();
  return Math.max(windAmount, rainAmount * 0.7, snowAmount * 0.6);
}

// Subtle camera buffeting in rough weather — sum of a few uncorrelated sine
// waves reads as irregular gusting rather than a mechanical single-frequency
// wobble. Kept slow/gentle on purpose: it layers on top of the movement bob
// (a separate, independently-timed effect) and shouldn't read as the bob
// itself speeding up. Render-pose only, like the bob, so it never accumulates.
let windShakeTime = 0;
const windShakeOffset = new THREE.Vector3();
function computeWindShake(dt, intensity) {
  windShakeOffset.set(0, 0, 0);
  if (!windShakeParams.enabled || intensity <= 0) return windShakeOffset;

  windShakeTime += dt;
  const amp = intensity * windShakeParams.amount;
  windShakeOffset.x = (Math.sin(windShakeTime * 1.7) + Math.sin(windShakeTime * 0.9) * 0.5) * amp * 0.5;
  windShakeOffset.y = (Math.sin(windShakeTime * 2.3) + Math.sin(windShakeTime * 1.1) * 0.5) * amp * 0.35;
  windShakeOffset.z = (Math.sin(windShakeTime * 1.3) + Math.sin(windShakeTime * 0.7) * 0.5) * amp * 0.5;
  return windShakeOffset;
}

// A slight widening of the field of view in rough weather — reads as the
// camera bracing/being buffeted, the same instinct as flinching wider-eyed
// in a gale — plus a quick, sharp kick synced to each lightning flash (a
// thunder-jolt reflex), decaying back to the weather-driven baseline rather
// than the fixed base FOV so it doesn't fight the ambient widening.
const BASE_FOV = 60;
let fovKick = 0;
function computeFov(dt, intensity) {
  const ambientWiden = intensity * 2.5;
  fovKick = Math.max(fovKick * Math.pow(0.001, dt), flash * 4);
  return BASE_FOV + ambientWiden + fovKick;
}

// `flash` is normalized 0..1 and drives the actual visible effects (a real
// screen-wide brightening plus a bloom bump); the PointLight alone was
// nearly invisible since it sat at a fixed world position that's rarely
// anywhere near the camera/visible geometry, so it's now just a minor local
// accent that follows the camera instead of the main effect.
let lightningTimer = 3 + Math.random() * 4;
let flash = 0;
// A real strike is a stutter of 2-4 quick flickers (the main stroke plus a
// couple of dimmer restrikes a beat later), not one smooth fade — scheduling
// a short burst of pending flash-bumps sells that far better than a single
// decay ever could.
let pendingFlashes = [];
function updateLightning(dt) {
  if (stormParams.enabled) {
    lightningTimer -= dt;
    if (lightningTimer <= 0) {
      const strikeCount = 2 + Math.floor(Math.random() * 3);
      pendingFlashes = [];
      let t = 0;
      for (let i = 0; i < strikeCount; i++) {
        t += 0.03 + Math.random() * 0.12;
        pendingFlashes.push({ time: t, peak: i === 0 ? 1 : 0.4 + Math.random() * 0.5 });
      }
      lightningTimer = 4 + Math.random() * 8;
    }
  }

  for (let i = pendingFlashes.length - 1; i >= 0; i--) {
    pendingFlashes[i].time -= dt;
    if (pendingFlashes[i].time <= 0) {
      flash = Math.max(flash, pendingFlashes[i].peak);
      pendingFlashes.splice(i, 1);
    }
  }

  flash *= Math.pow(0.0005, dt);
  lightning.position.set(camera.position.x, camera.position.y + 500, camera.position.z - 200);
  lightning.intensity = flash * 20;
  weatherGradePass.uniforms.flash.value = flash * 0.6;
}

function updatePostFX(nightAmount) {
  renderer.toneMappingExposure = fxParams.exposure;
  // Extra bloom at night, on top of whatever the weather preset already
  // wants — daytime bloom is tuned around the sun, and that same modest
  // strength left stars/moon reading as small tight dots with barely any
  // halo. A wider, stronger glow specifically at night is what actually
  // sells them as bright, significant light sources instead of pinpoints.
  // Earth view uses a fixed, un-pulsing bloom instead — nightAmount is a
  // ground-clock concept that shouldn't visibly breathe in and out while
  // looking at the globe from space.
  const effectiveNightAmount = overviewActive ? 0 : nightAmount;
  bloomPass.uniforms.strength.value = fxParams.bloomStrength + flash * 1.2 + effectiveNightAmount * 0.9;
  bloomPass.uniforms.radius.value = fxParams.bloomRadius + effectiveNightAmount * 1.8;
  bloomPass.uniforms.threshold.value = fxParams.bloomThreshold;
}

// --- Resize ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
  syncTilesResolution();
});

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

  // applyMovement() moves camera.position directly every frame WASD is
  // held — fine for the ground flythrough, but during the globe overview
  // nothing else reacts to that move: usMap.js's marker <div>s are only
  // repositioned by its own wheel/drag/zoom handlers, not by this. Held
  // WASD (if navEnabled was ever toggled on) would silently drag the camera
  // away from the overview's own lat/lon/zoom pose every frame, while the
  // globe itself (rendered fresh from the real camera every frame) visibly
  // moved and the markers stayed frozen at their last computed position —
  // exactly the "ground moves, pins don't" symptom, worsening the longer
  // WASD was held, independent of anything zoom-related.
  if (!updateFlight(dt) && !overviewActive) applyMovement(dt);
  updateGust(dt);

  const hourSpeed = timeSpeed * (isDeepNight(skyParams.hour) ? DEEP_NIGHT_SPEED_MULTIPLIER : 1);
  skyParams.hour = (skyParams.hour + hourSpeed * dt) % 24;
  // skyParams.hour is one shared clock for the whole session (it never
  // resets or shifts on arrival) — treated as world/UTC time, converted to
  // whichever location you're actually standing in via its own utcOffset
  // (see LOCATION_CONFIGS), or shown as-is, labeled UTC, from space where
  // no single location's time would make sense.
  if (playerPanel) {
    if (overviewActive) {
      playerPanel.setTime(skyParams.hour, 'World Time (UTC)');
    } else {
      const utcOffset = LOCATION_CONFIGS[currentLocationName]?.utcOffset ?? 0;
      playerPanel.setTime((skyParams.hour + utcOffset + 24) % 24, 'Local Time');
    }
  }

  if (!autoWeatherFrozen) {
    autoWeatherTimer -= hourSpeed * dt; // sim hours, not real seconds — see weatherChangeIntervalHours
    if (autoWeatherTimer <= 0) {
      applyPreset(pickWeatherFor(currentLocationName));
      autoWeatherTimer = nextWeatherInterval();
    }
  }
  updatePresetTransition(dt);

  rain.params.windSpeed = gust.speed;
  rain.params.windDirection = gust.direction;
  snow.params.windSpeed = gust.speed * 0.3;
  snow.params.windDirection = gust.direction;
  windStreaks.params.windSpeed = gust.speed;
  windStreaks.params.windDirection = gust.direction;
  // setLocalViewVisible(false) sets rain.lines/snow.points/windStreaks.mesh
  // .visible = false the instant the overview opens — but each system's own
  // update() unconditionally does `mesh.visible = params.enabled` (or
  // `windSpeed > 10`) as its very first line (see weather.js), and
  // params.enabled can still be true for as long as PRESET_TRANSITION_
  // DURATION (10s) after a weather roll starts moving away from rain/snow —
  // applyPreset only flips it false at the *end* of that cross-fade. Left
  // ungated, the next call to .update() (every frame, unconditionally)
  // stomped straight back over what setLocalViewVisible just set, and kept
  // simulating/respawning particles using camera.position — now Earth-scale
  // globe coordinates instead of local ones — scattering them across
  // literally the whole visible sky. Not updating at all while in the
  // overview is what actually makes it stick, immediately, the same way
  // applyMovement/controls.update() are already skipped there.
  if (!overviewActive) {
    rain.update(dt, camera.position);
    snow.update(dt, camera.position);
    windStreaks.update(dt, camera.position);
  }

  const sunDir = updateLighting();
  updateGodRays(sunDir);
  updateWindBlur();
  updateZoomBlur();
  preloadManager.update();
  updateLightning(dt);
  const { rainAmount, snowAmount } = precipitationAmounts();
  // Same curve updateLighting() uses internally for the moon/night light
  // floor — recomputed here since that's a local inside updateLighting(),
  // not something it currently returns.
  const nightAmount = THREE.MathUtils.clamp(-sunDir.y * 5, 0, 1);
  clouds.update({
    dt,
    simTime,
    cameraPosition: camera.position,
    windSpeed: gust.speed,
    windDirection: gust.direction,
    sunColor: sun.color,
    ambientColor: frameTint,
    nightAmount,
    coverage: cloudParams.coverage,
    density: cloudParams.density,
    formation: cloudParams.formation,
    levels: cloudParams.levels,
    // Darkening/tinting is tied to actual precipitation, not coverage or
    // wind — an overcast-but-dry "Cloudy" day still reads as bright white
    // clouds — and each kind gets its own color rather than one generic
    // "storm" grey: rain, snow, and a thunderhead don't actually look alike.
    rainAmount,
    snowAmount,
    stormAmount: stormParams.enabled ? 1 : 0,
    flash,
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
    const intensity = weatherIntensity();
    renderOffset.copy(computeBob(dt)).add(computeWindShake(dt, intensity));
    camera.fov = computeFov(dt, intensity);
    camera.updateProjectionMatrix();
  }
  camera.position.add(renderOffset);

  tiles.update();
  composer.render();

  camera.fov = baseFov;
  camera.updateProjectionMatrix();
  camera.position.sub(renderOffset);

  if (stats) stats.end();
}
renderer.setAnimationLoop(tick);
