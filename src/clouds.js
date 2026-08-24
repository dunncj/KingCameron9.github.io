import * as THREE from 'three';
import { createShaderMaterial } from './shaders';

// A soft, irregular cumulus silhouette baked from a handful of overlapping
// blurred blobs rather than one perfect circle — a single puff needs to
// already read as an organic cloud shape, not a glowing dot, since several
// of these overlap to build one cluster.
function makeCloudTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;

  function blob(x, y, r) {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  blob(c, c, size * 0.42);
  blob(c - size * 0.22, c + size * 0.1, size * 0.28);
  blob(c + size * 0.24, c + size * 0.08, size * 0.3);
  blob(c - size * 0.04, c - size * 0.18, size * 0.27);
  blob(c + size * 0.1, c - size * 0.15, size * 0.22);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// Clusters (not individual puffs) are the unit of coverage/wind/recycling —
// a "cloud" is several puffs moving and fading in together, not independent
// specks, and coverage trims whole clusters so cutting it down never leaves
// a visibly amputated half-cloud behind.
const CLUSTER_COUNT = 70;
const PUFFS_PER_CLUSTER = 11;
const TOTAL_PUFFS = CLUSTER_COUNT * PUFFS_PER_CLUSTER;
// A circular field around the camera, not a square one — recycling checks
// straight-line distance, and the "fade into haze" band below is defined as
// an outer ring of this same circle, so both line up naturally.
const FIELD_RADIUS = 4200;
const CLUSTER_RADIUS_MIN = 300;
const CLUSTER_RADIUS_MAX = 560;
// Even a single named (non-"mixed") formation rolls a wildcard shape at
// this rate — a whole sky of e.g. Storm's "towering" formation with zero
// variation reads as repeated copies of one cloud, not a real sky, no
// matter how randomized each copy's exact stretch/size is within that one
// formation's ranges.
const WILDCARD_FORMATION_CHANCE = 0.3;
// New/departing clusters fade into this color rather than popping in solid
// or vanishing outright — an outer ring of the field, not the whole thing,
// so most of what's actually on screen (the middle of the field) stays
// fully rendered rather than constantly washed toward this tint.
const FOG_NEAR = FIELD_RADIUS * 0.62;
// Just *inside* the recycle radius (below), not past it — a cluster needs
// to already be fully alpha-faded to 0 by the time it actually gets
// recycled, or the reposition-to-the-opposite-edge reads as a visible pop
// for however much opacity was still left.
const FOG_FAR = FIELD_RADIUS * 0.97;
// New clusters spawn in an arc facing upwind and drift in on the wind,
// rather than popping into existence anywhere in the field including right
// in front of the camera.
const SPAWN_ARC = Math.PI * 0.7;
// How long a freshly (re)spawned cluster takes to grow from nothing to full
// size (and, symmetrically, how long a cluster that just fell out of
// coverage takes to shrink back to nothing) — the fade-in-from-distance
// above sells "emerging from haze", this sells "forming"/"unforming", and
// together neither a wind-recycled cloud nor one that appears because
// coverage just increased pops in abruptly. Matches main.js's
// PRESET_TRANSITION_DURATION so a whole weather cycle — fog, wind, bloom,
// rain/snow, and the clouds themselves — settles on the same 10-second
// timeline instead of the clouds visibly lagging behind everything else.
const SPAWN_GROW_SECONDS = 10;

// Named cluster "personalities" — each is a range of shape parameters, not
// a fixed shape, so picking one still gives varied-looking clouds rather
// than identical copies. "mixed" (used by weather presets that want a
// naturally varied sky) has each cluster independently roll one of the
// other five, rather than every cloud in the sky sharing one silhouette.
const FORMATIONS = {
  puffy: { stretchMin: 0.7, stretchMax: 1.6, vertMin: 0.7, vertMax: 1.3, scaleMin: 300, scaleMax: 760 },
  towering: { stretchMin: 0.5, stretchMax: 1.0, vertMin: 1.6, vertMax: 2.6, scaleMin: 380, scaleMax: 900 },
  streaky: { stretchMin: 2.2, stretchMax: 4.5, vertMin: 0.2, vertMax: 0.4, scaleMin: 220, scaleMax: 480 },
  flat: { stretchMin: 1.6, stretchMax: 3.0, vertMin: 0.2, vertMax: 0.4, scaleMin: 360, scaleMax: 760 },
  scattered: { stretchMin: 0.7, stretchMax: 1.3, vertMin: 0.55, vertMax: 0.9, scaleMin: 260, scaleMax: 500 },
};
const FORMATION_NAMES = Object.keys(FORMATIONS);
export const CLOUD_FORMATIONS = [...FORMATION_NAMES, 'mixed'];

// Altitude bands for multi-level skies — index 0 is lowest, spaced widely
// apart on purpose. Packed too close together, every band's own internal
// vertical spread overlapped into one thick smear filling a narrow strip
// of the screen instead of actually dressing the whole sky, top included.
// Real low clouds are puffy and voluminous; real high clouds are thin,
// pale, and stretched out no matter what's actually happening weather-wise
// below them, which is why level bias (below) pushes shape toward
// "streaky" as it climbs regardless of the chosen formation.
const LEVEL_ALTITUDE = [950, 1950, 3300];
// Widened a good deal — plenty of presets only ever use a single level
// (cloudLevels: 1), and at the old, narrower spread every cluster in those
// presets sat within ~280 units of the exact same altitude, reading as one
// flat layer instead of clouds actually at different heights.
const LEVEL_SPREAD = [550, 600, 550];

// Which level a cluster belongs to is a fixed, evenly-interleaved pattern
// keyed by index — not proportional slicing (e.g. "first 65% of indices are
// level 0") — because coverage only ever activates a *prefix* of cluster
// indices, and a low-coverage preset would otherwise activate nothing but
// level-0 clusters, leaving the upper sky completely empty. Interleaving
// means even a small active prefix still gets a representative mix.
// Weighted toward the low band regardless of level count — that's the
// primary weather layer; higher bands are thinner filler, not equal peers.
const LEVEL_PATTERNS = {
  1: [0],
  2: [0, 0, 1, 0, 0, 1, 0, 1],
  3: [0, 1, 0, 2, 1, 0, 0, 1, 0, 2, 0, 1],
};

function levelForCluster(c, levels) {
  const pattern = LEVEL_PATTERNS[levels] || LEVEL_PATTERNS[1];
  return pattern[c % pattern.length];
}

// instanceMatrix/instanceColor aren't declared here — three.js injects both
// automatically for an InstancedMesh (instanceMatrix always; instanceColor
// once `setColorAt` has been called), into any material including a raw
// ShaderMaterial like this one. Fog here is deliberately *not* wired to
// three.js's automatic per-scene fog (`material.fog = true` would pull in
// the scene's actual fog.near/fog.far, which for several presets — Storm,
// Blizzard — starts within a couple thousand units and would wash every
// cloud toward a flat haze color almost immediately). `fogNear`/`fogFar`
// here are the fixed, generous `FOG_NEAR`/`FOG_FAR` constants above instead,
// set once and never touched by weather.
const CLOUD_VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  varying vec3 vInstanceColor;
  varying float vFogDepth;
  void main() {
    vUv = uv;
    vInstanceColor = instanceColor;
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vFogDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const CLOUD_FRAGMENT_SHADER = /* glsl */`
  uniform sampler2D map;
  uniform float opacity;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying vec2 vUv;
  varying vec3 vInstanceColor;
  varying float vFogDepth;
  void main() {
    vec4 tex = texture2D(map, vUv);
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    vec3 color = mix(vInstanceColor, fogColor, fogFactor);
    gl_FragColor = vec4(color, tex.a * opacity * (1.0 - fogFactor));
  }
`;

// Neutral greys only in the base shading — no blue anywhere in it. An
// earlier version tinted the underside toward a blue-grey "shadow" color
// and multiplied the whole puff by the scene's (often blue) ambient tint,
// which read as a distinct blue fringe around every cloud rather than a
// shadow. Precipitation types get their own distinct colors rather than
// one generic "storm" grey for all of them — real rain clouds, snow
// clouds, and thunderheads don't actually look alike.
const RAIN_GREY = new THREE.Color(0x5a6270);
const SNOW_LIGHT = new THREE.Color(0xdce1e8);
// Was 0x34363f (RGB ~0.20-0.25) lerped in at 0.8 — a real thunderhead is
// dramatic and moody, not literally near-black; that combination crushed
// storm clouds down to something that read as smoke/smog rather than
// cloud. Lighter slate grey, blended in less aggressively below.
const STORM_DARK = new THREE.Color(0x5c6170);

export function buildClouds(scene, initialPosition = new THREE.Vector3()) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const cloudMaterial = createShaderMaterial({
    uniforms: {
      map: { value: makeCloudTexture() },
      opacity: { value: 0.85 },
      fogColor: { value: new THREE.Color() },
      fogNear: { value: FOG_NEAR },
      fogFar: { value: FOG_FAR },
    },
    vertexShader: CLOUD_VERTEX_SHADER,
    fragmentShader: CLOUD_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.InstancedMesh(geometry, cloudMaterial.material, TOTAL_PUFFS);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // RenderPixelatedPass draws the whole scene a second time every frame
  // with every material swapped for MeshNormalMaterial, to build a normal
  // buffer it uses for edge detection. A billboard always faces the camera
  // dead-on, so its normal is nearly pure view-space Z — which the
  // standard normal-to-color encoding renders as almost solid blue — and
  // the sky behind a cloud has a completely different normal, so the pass
  // sees a sharp discontinuity and draws a hard (blocky, since it's
  // computed at the pixelation pass's low internal resolution) blue edge
  // exactly along each cloud's silhouette. rain/snow/wind-streaks hit the
  // same category of problem (no usable normal at all, for a different
  // reason) and fix it the same way: make the object invisible
  // specifically during that one override pass.
  let visibleCount = 0;
  mesh.onBeforeRender = (renderer, scene) => {
    mesh.count = scene.overrideMaterial ? 0 : visibleCount;
  };

  // Per-cluster state. Per-puff local offsets/scale/height-bias are fixed
  // at spawn and never change relative to their cluster; only the cluster
  // center moves (wind) and a per-cluster grow-in factor scales the whole
  // group up from nothing.
  const clusterPos = [];
  const clusterLevel = new Int32Array(CLUSTER_COUNT);
  const clusterSpeedFactor = new Float32Array(CLUSTER_COUNT).fill(1);
  const clusterSpawnTime = new Float32Array(CLUSTER_COUNT).fill(-SPAWN_GROW_SECONDS);
  // -Infinity = not despawning (either active, or already fully gone and
  // excluded from the draw range). Set to the sim time a cluster fell out
  // of the active range (coverage decreased) so it can keep rendering —
  // shrinking down to nothing — instead of just vanishing that same frame.
  const clusterDespawnTime = new Float32Array(CLUSTER_COUNT).fill(-Infinity);
  const puffLocal = []; // Vector3 offset from cluster center, per puff
  const puffScale = new Float32Array(TOTAL_PUFFS);
  const puffHeightBias = new Float32Array(TOTAL_PUFFS); // 0 (underside) .. 1 (crown)
  const puffSeed = new Float32Array(TOTAL_PUFFS);
  // Fixed per-puff so it doesn't jitter frame to frame — see its use in
  // renderCluster below.
  const puffYawJitter = new Float32Array(TOTAL_PUFFS);

  // Shape only — a cluster's internal puff arrangement, independent of
  // where its center actually sits in the world. `levels` is how many
  // altitude bands are in play right now, used only to decide which band
  // (and how much "thin out at altitude" bias) this cluster gets.
  function buildClusterShape(c, formationName, levels) {
    const level = levelForCluster(c, Math.max(1, Math.min(3, levels)));
    clusterLevel[c] = level;
    const levelFrac = levels > 1 ? level / (levels - 1) : 0; // 0 low .. 1 high
    // Every cluster drifting at exactly the same rate looked mechanical —
    // real cloud layers don't all move in lockstep even in one uniform
    // wind. Rolled fresh each time a cluster (re)forms, not just once, so
    // recycled/newly-active clusters keep getting fresh variety too.
    clusterSpeedFactor[c] = 0.6 + Math.random() * 0.9;

    const rollWildcard = formationName !== 'mixed' && Math.random() < WILDCARD_FORMATION_CHANCE;
    const pickedName = (formationName === 'mixed' || rollWildcard)
      ? FORMATION_NAMES[Math.floor(Math.random() * FORMATION_NAMES.length)]
      : formationName;
    const shape = FORMATIONS[pickedName] || FORMATIONS.puffy;

    const radius = CLUSTER_RADIUS_MIN + Math.random() * (CLUSTER_RADIUS_MAX - CLUSTER_RADIUS_MIN);
    // Higher levels drift toward flatter, more stretched, smaller shapes —
    // real high clouds are thin and wispy no matter what's happening in
    // the formation picked below.
    const altitudeThin = THREE.MathUtils.lerp(1, 2.4, levelFrac);
    const altitudeFlatten = THREE.MathUtils.lerp(1, 0.4, levelFrac);
    const altitudeShrink = THREE.MathUtils.lerp(1, 0.65, levelFrac);
    const stretch = THREE.MathUtils.lerp(shape.stretchMin, shape.stretchMax, Math.random()) * altitudeThin;
    const stretchAngle = Math.random() * Math.PI * 2;
    const cosA = Math.cos(stretchAngle);
    const sinA = Math.sin(stretchAngle);
    const verticalSpread = radius * THREE.MathUtils.lerp(shape.vertMin, shape.vertMax, Math.random()) * altitudeFlatten;

    for (let p = 0; p < PUFFS_PER_CLUSTER; p++) {
      const i = c * PUFFS_PER_CLUSTER + p;
      const angle = Math.random() * Math.PI * 2;
      // Biased toward the center for a denser core with a wispier fringe,
      // rather than an even ring of puffs with a hollow middle.
      const rFrac = Math.pow(Math.random(), 0.7);
      const r = rFrac * radius;
      const localX = Math.cos(angle) * r;
      const localZ = Math.sin(angle) * r * stretch;
      const y = (Math.random() - 0.5) * verticalSpread;
      puffLocal[i] = new THREE.Vector3(
        localX * cosA - localZ * sinA,
        y,
        localX * sinA + localZ * cosA,
      );
      // Big anchor puffs in the core, smaller wisps toward the rim — reads
      // as an actual formation with a dense body instead of a scatter of
      // same-sized balls.
      const rimSize = THREE.MathUtils.lerp(shape.scaleMax, shape.scaleMin, rFrac);
      puffScale[i] = rimSize * (0.75 + Math.random() * 0.5) * altitudeShrink;
      puffHeightBias[i] = THREE.MathUtils.clamp(y / verticalSpread + 0.5, 0, 1);
      puffSeed[i] = Math.random() * 100;
      // ±15° around the pure horizontal-facing angle — a puff whose facing
      // is locked exactly onto the camera reads as a paper cutout the
      // instant you notice the whole cluster snapping in unison as you
      // move; this small per-puff offset keeps that from ever being
      // perfectly synchronized without adding enough tilt to look wrong.
      puffYawJitter[i] = (Math.random() - 0.5) * THREE.MathUtils.degToRad(15);
    }
  }

  // Initial population only — scattered anywhere across the whole field so
  // there's already a sky full of (already fully-grown — see
  // clusterSpawnTime's initial fill above) clouds on first load, not an
  // empty one that only fills in once wind has had time to carry clusters
  // in, or that visibly grows in unison right as the page loads.
  function scatterClusterPosition(c, origin) {
    const level = clusterLevel[c];
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * FIELD_RADIUS;
    clusterPos[c].set(
      origin.x + Math.cos(angle) * dist,
      LEVEL_ALTITUDE[level] + (Math.random() - 0.5) * LEVEL_SPREAD[level],
      origin.z + Math.sin(angle) * dist,
    );
  }

  // Runtime (re)spawn: an arc facing upwind, at/near the fog-fade ring, so
  // a cluster drifts in out of the haze on the wind and visibly grows in
  // (see clusterSpawnTime) instead of appearing solid, full-size, in front
  // of the camera, out of nowhere.
  function respawnClusterPosition(c, origin, windAngleRad, simTime) {
    const level = clusterLevel[c];
    const upwind = windAngleRad + Math.PI;
    const angle = upwind + (Math.random() - 0.5) * SPAWN_ARC;
    const dist = FIELD_RADIUS * (0.82 + Math.random() * 0.16);
    clusterPos[c].set(
      origin.x + Math.cos(angle) * dist,
      LEVEL_ALTITUDE[level] + (Math.random() - 0.5) * LEVEL_SPREAD[level],
      origin.z + Math.sin(angle) * dist,
    );
    clusterSpawnTime[c] = simTime;
  }

  for (let c = 0; c < CLUSTER_COUNT; c++) {
    clusterPos.push(new THREE.Vector3());
    buildClusterShape(c, 'puffy', 1);
    // Relative to wherever the camera actually starts, not world origin —
    // those can be thousands of units apart (HOME_VIEW isn't anywhere near
    // local (0,0,0)), which left the initial field poorly centered on the
    // one place it's guaranteed to be looked at right away.
    scatterClusterPosition(c, initialPosition);
  }

  const dummy = new THREE.Object3D();
  const worldPos = new THREE.Vector3();
  const UP_AXIS = new THREE.Vector3(0, 1, 0);
  const puffColor = new THREE.Color();
  let activeClusters = CLUSTER_COUNT;
  // So a coverage increase mid-session grows newly-included clusters in
  // from the edge too, exactly like a wind-recycled one, instead of just
  // un-hiding whatever stale position/shape they last had.
  let previousActiveClusters = CLUSTER_COUNT;
  // The initial population loop above already scattered every cluster as
  // "fully grown" (see its own comment) and nothing has actually been drawn
  // yet (visibleCount starts at 0) — so the very first update() call must
  // not treat clusters beyond the first coverage's target as "despawning
  // from full visibility," or a low initial coverage (e.g. loading directly
  // into Clear) would fade out dozens of clusters that were never visible
  // in the first place, a big spurious flash of cloud right on load.
  let hasRenderedOnce = false;

  // opts: { dt, simTime, cameraPosition, windSpeed, windDirection, sunColor,
  //   ambientColor, coverage, density, formation, levels (1-3), rainAmount,
  //   snowAmount, stormAmount (each 0-1), flash (0-1) } —
  // coverage/density/formation/levels are read straight from main.js's
  // cloudParams so the 2D sky-dome clouds and these 3D ones are always in
  // sync rather than tracking two separate copies of "how cloudy."
  function update(opts) {
    const {
      dt, simTime, cameraPosition, windSpeed, windDirection,
      sunColor, ambientColor, nightAmount, coverage, density, formation, levels,
      rainAmount, snowAmount, stormAmount, flash,
      // Render-quality lever (see src/quality/) — scales how many of the
      // CLUSTER_COUNT instances a given coverage is even allowed to reach,
      // on top of (not instead of) coverage's own share. 1 = no reduction.
      activeFraction = 1,
    } = opts;
    // Clouds are lit (0.5-0.82 base, before any tint) the same regardless of
    // time of day otherwise — against a properly dark night sky that reads
    // as far too bright/visible. Dimmed here rather than folded into the
    // 0.5 floor above so a lightning flash (added after this, in
    // renderCluster) can still punch through at full strength at night.
    const nightDim = THREE.MathUtils.lerp(1, 0.35, THREE.MathUtils.clamp(nightAmount ?? 0, 0, 1));

    // Raised to a power > 1 so low coverage (Clear's 0.08, Breezy's 0.2)
    // drops off much faster than a straight linear split of 70 clusters
    // would — 8% of 70 is still 6 whole cluster formations, plainly visible
    // clumps on a "Clear" day. This keeps the high end (Overcast/Storm)
    // close to full while making light weather read as genuinely light.
    const targetActive = Math.round(
      CLUSTER_COUNT * THREE.MathUtils.clamp(coverage, 0, 1) ** 1.6 * THREE.MathUtils.clamp(activeFraction, 0, 1),
    );
    // Lower ceiling than density alone would suggest — solid/opaque clouds
    // at max density read as too prominent/heavy in daylight; capping well
    // under fully opaque keeps even a dense sky looking like cloud, not a
    // wall. But at night that same low ceiling meant a "thick" cloud still
    // let 40%+ of an extremely bright (additive, well over 1.0) star or the
    // moon punch straight through it — a cloud that visibly can't actually
    // hide anything behind it reads as fake. Boosting the ceiling with
    // nightAmount fixes that without touching the daytime look at all
    // (boost is exactly 1 at nightAmount 0).
    const nightOpacityBoost = THREE.MathUtils.lerp(1, 1.8, THREE.MathUtils.clamp(nightAmount ?? 0, 0, 1));
    cloudMaterial.set({
      opacity: THREE.MathUtils.clamp(
        (THREE.MathUtils.clamp(density, 0, 1) * 0.55 + 0.08) * nightOpacityBoost,
        0, 0.97,
      ),
      fogColor: ambientColor,
    });
    // Thinner-looking puffs at low density, not just fewer/dimmer ones —
    // otherwise light-weather clusters were built from the exact same puff
    // sizes as a thick overcast ceiling and just looked like a sparser
    // version of the same heavy cloud instead of genuinely wispy.
    const densityScale = THREE.MathUtils.lerp(0.55, 1, THREE.MathUtils.clamp(density, 0, 1));

    // A flat base speed plus a moderate wind scaling, not a straight
    // windSpeed multiplier — at the old 0.6x, even a calm 6 mph preset only
    // drifted 3.6 units/sec, imperceptible against a 300-560 unit-wide
    // cluster (it'd take minutes to visibly move its own width). This base
    // speed alone covers a cluster's width in well under half a minute even
    // in dead calm, and wind still visibly speeds that up without making an
    // extreme preset (95 mph) send clusters flying unrealistically fast.
    const windRad = windDirection * (Math.PI / 180);
    const driftSpeed = 22 + windSpeed * 1.1;
    const windX = Math.cos(windRad) * driftSpeed;
    const windZ = Math.sin(windRad) * driftSpeed;

    // Coverage just dropped — the clusters that fell out of the active
    // range start shrinking instead of vanishing outright (see the fading
    // tail below). Coverage rising back over a still-fading index cancels
    // its fade; the growth branch below then treats it as newly active.
    if (hasRenderedOnce) {
      for (let c = targetActive; c < previousActiveClusters; c++) {
        if (clusterDespawnTime[c] === -Infinity) clusterDespawnTime[c] = simTime;
      }
      for (let c = previousActiveClusters; c < targetActive; c++) {
        clusterDespawnTime[c] = -Infinity;
      }
    }
    hasRenderedOnce = true;

    function renderCluster(c, pos, scaleMultiplier) {
      for (let p = 0; p < PUFFS_PER_CLUSTER; p++) {
        const i = c * PUFFS_PER_CLUSTER + p;
        // A gentle, wind-scaled bob — clouds roil visibly in a gale and
        // sit nearly still on a calm day, rather than always drifting at
        // one fixed idle rate regardless of weather.
        const bob = Math.sin(simTime * 0.35 + puffSeed[i]) * windSpeed * 0.35;
        worldPos.copy(pos).add(puffLocal[i]);
        worldPos.y += bob;

        dummy.position.copy(worldPos);
        // Cylindrical (yaw-only) billboard, not a full camera-facing one —
        // a puff that also tilts to match the camera's pitch visibly
        // rotates out of vertical the instant you look up or down at it,
        // which reads as a flat card rather than a solid shape in the sky.
        // Locking rotation to the horizontal angle toward the camera (plus
        // this puff's own small fixed jitter) keeps every puff standing
        // upright no matter where the camera is looking.
        const yaw = Math.atan2(cameraPosition.x - worldPos.x, cameraPosition.z - worldPos.z) + puffYawJitter[i];
        dummy.quaternion.setFromAxisAngle(UP_AXIS, yaw);
        dummy.scale.setScalar(puffScale[i] * scaleMultiplier);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        // Top-lit, underside-shadowed (kept bright even at the bottom —
        // 0.62 floor, not 0) for a dimensional look without ever going dark
        // on a plain dry, cloudy day. Crown allowed a bit past 1.0 (a real
        // sunlit puff top can read brighter than the base "white") for
        // actual contrast against the underside instead of everything
        // sitting in a flat, muddy 0.5-0.82 band that read as smog more
        // than cloud. A touch of the scene's ambient/sun color so clouds
        // belong to the moment's lighting. Real greying is reserved for
        // actual precipitation, and it's distinct per kind — rain, snow,
        // and a storm's ceiling don't actually look alike — and a
        // lightning flash still kicks them bright regardless.
        const lit = THREE.MathUtils.lerp(0.62, 1.05, puffHeightBias[i]);
        puffColor.setScalar(lit);
        puffColor.lerp(ambientColor, 0.18);
        puffColor.lerp(sunColor, puffHeightBias[i] * 0.25);
        puffColor.lerp(RAIN_GREY, THREE.MathUtils.clamp(rainAmount, 0, 1) * 0.7);
        puffColor.lerp(SNOW_LIGHT, THREE.MathUtils.clamp(snowAmount, 0, 1) * 0.35);
        // Was 0.8 — even with the lighter STORM_DARK above, blending 80% of
        // the way there flattened all the top-lit/underside contrast right
        // back out. 0.45 still reads as a distinctly darker, moodier storm
        // ceiling without erasing the shape.
        puffColor.lerp(STORM_DARK, THREE.MathUtils.clamp(stormAmount, 0, 1) * 0.45);
        puffColor.multiplyScalar(nightDim);
        puffColor.offsetHSL(0, 0, flash * 0.5);
        mesh.setColorAt(i, puffColor);
      }
    }

    for (let c = 0; c < targetActive; c++) {
      // A coverage increase just brought this cluster into the active
      // range — give it a fresh shape/position/grow-in exactly like a
      // wind-recycled one rather than snapping in wherever it last was.
      if (c >= previousActiveClusters) {
        buildClusterShape(c, formation, levels);
        respawnClusterPosition(c, cameraPosition, windRad, simTime);
      }

      const pos = clusterPos[c];
      pos.x += windX * dt * clusterSpeedFactor[c];
      pos.z += windZ * dt * clusterSpeedFactor[c];
      if (Math.hypot(pos.x - cameraPosition.x, pos.z - cameraPosition.z) > FIELD_RADIUS) {
        buildClusterShape(c, formation, levels);
        respawnClusterPosition(c, cameraPosition, windRad, simTime);
      }

      const growFactor = THREE.MathUtils.smoothstep(simTime - clusterSpawnTime[c], 0, SPAWN_GROW_SECONDS);
      renderCluster(c, pos, growFactor * densityScale);
    }

    // Fading tail: clusters that just fell out of the active range keep
    // rendering — frozen in place, shrinking toward nothing — instead of
    // being cut from the draw range mid-shape the instant coverage drops.
    let fadeUpper = targetActive;
    for (let c = targetActive; c < CLUSTER_COUNT; c++) {
      if (clusterDespawnTime[c] === -Infinity) continue;
      const elapsed = simTime - clusterDespawnTime[c];
      if (elapsed >= SPAWN_GROW_SECONDS) {
        clusterDespawnTime[c] = -Infinity; // fully shrunk — excluded from now on
        continue;
      }
      const fadeFactor = 1 - THREE.MathUtils.smoothstep(elapsed, 0, SPAWN_GROW_SECONDS);
      renderCluster(c, clusterPos[c], fadeFactor * densityScale);
      fadeUpper = c + 1;
    }

    activeClusters = targetActive;
    visibleCount = fadeUpper * PUFFS_PER_CLUSTER;
    previousActiveClusters = activeClusters;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  // For a hard cut to somewhere far away (a location teleport) — without
  // this the whole field stays centered on wherever it was before the
  // jump, and could take a while to organically drift back into place
  // around the camera's new position via ordinary wind recycling. Existing
  // puff shapes are kept (only repositioned) and already fully grown, since
  // arriving somewhere new should show clouds immediately, not have them
  // grow in from nothing right as you land.
  function recenter(position) {
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      scatterClusterPosition(c, position);
      clusterSpawnTime[c] = -SPAWN_GROW_SECONDS;
      // Cancel any in-progress shrink-out — a cluster that was fading away
      // at the old location should just be gone, not keep fading at the
      // new one (or reappear fully grown if coverage drops it again later).
      clusterDespawnTime[c] = -Infinity;
    }
  }

  return { mesh, update, recenter };
}
