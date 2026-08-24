import * as THREE from 'three';

// RenderPixelatedPass renders the scene a second time with a MeshNormalMaterial
// override (for its edge-detection buffer). That material expects real mesh
// normals/faces, which particle geometry doesn't have, so raw points/lines get
// garbled during that pass and show up as artifacts punched through the rain.
// Skipping the draw during the override pass (detected via scene.overrideMaterial)
// fixes it — particles shouldn't contribute silhouette edges anyway.
// getVertexCount is a callback, not a fixed number — the active draw range
// now varies frame to frame with weather intensity (density, not just
// opacity/speed, scales with how heavy the weather is), so this needs to
// read the *current* count each time it's invoked, not one captured at
// setup.
function skipDuringOverridePass(object, getVertexCount) {
  object.onBeforeRender = (renderer, scene) => {
    object.geometry.setDrawRange(0, scene.overrideMaterial ? 0 : getVertexCount());
  };
}

// Same idea as skipDuringOverridePass but for InstancedMesh, which has no
// drawRange — `count` (read at draw time, same as drawRange) does the job.
function skipInstancedDuringOverridePass(mesh, getInstanceCount) {
  mesh.onBeforeRender = (renderer, scene) => {
    mesh.count = scene.overrideMaterial ? 0 : getInstanceCount();
  };
}

function makeSoftCircleTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// A soft, tapered elongated streak (bright center band, fading to nothing
// at both the leading/trailing ends and the top/bottom edges). Mapping this
// onto a stretched quad is what actually reads as a "streak" — round dots
// on a stretched quad still look like a row of dots, not a smear.
function makeSoftStreakTexture() {
  const w = 128;
  const h = 32;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const hGrad = ctx.createLinearGradient(0, 0, w, 0);
  hGrad.addColorStop(0, 'rgba(255,255,255,0)');
  hGrad.addColorStop(0.12, 'rgba(255,255,255,0.15)');
  hGrad.addColorStop(0.45, 'rgba(255,255,255,1)');
  hGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hGrad;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'destination-in';
  const vGrad = ctx.createLinearGradient(0, 0, 0, h);
  vGrad.addColorStop(0, 'rgba(255,255,255,0)');
  vGrad.addColorStop(0.5, 'rgba(255,255,255,1)');
  vGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = vGrad;
  ctx.fillRect(0, 0, w, h);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// Sized generously (world units are ~meters, camera can be anywhere from a
// few hundred to thousands of units up) so weather reads clearly even from
// a wide overview shot, not just up close in first-person flight.
const FIELD = { x: 1400, y: 700, z: 1400 };
const STREAK = 6;

// Intensity now drives actual particle *density*, not just fall speed and
// opacity — a light drizzle and a downpour used to look identical apart
// from being faster/more opaque, which reads as "the same rain, dialed,"
// not two different storms. The full pool is allocated once up front, but
// only the first `activeCount` segments are drawn (via setDrawRange) *and*
// simulated each frame — the rest sit frozen and untouched until intensity
// rises enough to draw them back in, so a light preset costs the CPU/GPU
// roughly what it used to while a max-intensity storm can actually fill
// the sky.
const RAIN_MIN_DENSITY = 0.15;
// Intensity values across presets top out around 3 (Storm's heaviest); this
// is the intensity at which density reaches the full pool.
export const RAIN_MAX_INTENSITY = 3;

// `params` (RainSettings — see settings/types.ts) supplies the two real,
// user-tunable fields (enabled, intensity); windSpeed/windDirection live on
// the same object purely as derived per-frame state main.js's tick()
// overwrites every frame from the current wind gust (see main.js), not
// settings of their own.
export function buildRain(scene, params, maxCount = 22000) {
  const positions = new Float32Array(maxCount * 2 * 3);
  const fallSpeed = new Float32Array(maxCount);
  const dir = new THREE.Vector3();

  function respawn(i, origin, windX, windZ) {
    const x = origin.x + (Math.random() - 0.5) * FIELD.x * 2;
    const y = origin.y + FIELD.y * (0.6 + Math.random() * 0.4);
    const z = origin.z + (Math.random() - 0.5) * FIELD.z * 2;
    const speed = 90 + Math.random() * 60;
    fallSpeed[i] = speed;

    dir.set(windX, -speed, windZ).normalize();
    const base = i * 6;
    positions[base + 0] = x;
    positions[base + 1] = y;
    positions[base + 2] = z;
    positions[base + 3] = x + dir.x * STREAK;
    positions[base + 4] = y + dir.y * STREAK;
    positions[base + 5] = z + dir.z * STREAK;
  }

  for (let i = 0; i < maxCount; i++) respawn(i, new THREE.Vector3(), 0, 0);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute('position', posAttr);

  const material = new THREE.LineBasicMaterial({
    color: 0xd8e8ff,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  let activeCount = maxCount;
  skipDuringOverridePass(lines, () => activeCount * 2);
  scene.add(lines);

  // windSpeed/windDirection aren't part of RainSettings (see settings.toml)
  // — main.js's tick() overwrites them every frame from the current wind
  // gust, but they need *some* value before that first frame runs.
  params.windSpeed ??= 15;
  params.windDirection ??= 45;

  function update(dt, origin) {
    lines.visible = params.enabled;
    if (!params.enabled) return;

    const densityFraction = THREE.MathUtils.clamp(params.intensity / RAIN_MAX_INTENSITY, RAIN_MIN_DENSITY, 1);
    activeCount = Math.floor(maxCount * densityFraction);
    geometry.setDrawRange(0, activeCount * 2);

    // Below 1, intensity also fades visual opacity (not just fall speed) —
    // lets a weather transition fade rain in/out instead of snapping it on.
    // At/above 1 it's full opacity, same as before.
    material.opacity = 0.75 * THREE.MathUtils.clamp(params.intensity, 0, 1);

    const windRad = params.windDirection * (Math.PI / 180);
    const windX = Math.cos(windRad) * params.windSpeed;
    const windZ = Math.sin(windRad) * params.windSpeed;

    for (let i = 0; i < activeCount; i++) {
      const dy = -fallSpeed[i] * Math.max(params.intensity, 0.2) * dt;
      const dx = windX * dt;
      const dz = windZ * dt;

      const base = i * 6;
      positions[base + 0] += dx;
      positions[base + 1] += dy;
      positions[base + 2] += dz;
      positions[base + 3] += dx;
      positions[base + 4] += dy;
      positions[base + 5] += dz;

      const x = positions[base + 0];
      const y = positions[base + 1];
      const z = positions[base + 2];
      if (
        y < origin.y - FIELD.y * 0.3 ||
        Math.abs(x - origin.x) > FIELD.x ||
        Math.abs(z - origin.z) > FIELD.z
      ) {
        respawn(i, origin, windX, windZ);
      }
    }

    posAttr.needsUpdate = true;
  }

  return { lines, params, update };
}

// PointsMaterial with sizeAttenuation scales a sprite's screen size roughly
// by 1/distance-to-camera — with no minimum enforced, a flake that respawns
// or drifts within a unit or two of the camera balloons to cover a huge
// fraction of the screen (a single fragment-shaded quad that size is real
// fill-rate cost, not just a visual glitch). Re-rolling the XZ offset until
// it clears a modest radius keeps that from happening without thinning out
// the "flying through snow" look up close.
const SNOW_MIN_DIST = 20;
const SNOW_MIN_DENSITY = 0.15;
// Snow intensity tops out at 3 (Blizzard) across presets.
export const SNOW_MAX_INTENSITY = 3;

// `params` (SnowSettings — see settings/types.ts) supplies enabled/
// intensity; windSpeed/windDirection are derived per-frame state, same as
// buildRain's own params — see its comment.
export function buildSnow(scene, params, maxCount = 13000) {
  const positions = new Float32Array(maxCount * 3);
  const fallSpeed = new Float32Array(maxCount);
  const swayPhase = new Float32Array(maxCount);
  const swayAmp = new Float32Array(maxCount);

  function respawn(i, origin) {
    const base = i * 3;
    let dx;
    let dz;
    do {
      dx = (Math.random() - 0.5) * FIELD.x * 2;
      dz = (Math.random() - 0.5) * FIELD.z * 2;
    } while (Math.hypot(dx, dz) < SNOW_MIN_DIST);
    positions[base + 0] = origin.x + dx;
    positions[base + 1] = origin.y + FIELD.y * (0.6 + Math.random() * 0.4);
    positions[base + 2] = origin.z + dz;
    fallSpeed[i] = 10 + Math.random() * 12;
    swayPhase[i] = Math.random() * Math.PI * 2;
    swayAmp[i] = 4 + Math.random() * 10;
  }

  for (let i = 0; i < maxCount; i++) respawn(i, new THREE.Vector3());

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute('position', posAttr);

  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.4, // world units — 7 rendered flakes the size of a rooftop
    map: makeSoftCircleTexture(),
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  let activeCount = maxCount;
  skipDuringOverridePass(points, () => activeCount);
  scene.add(points);

  params.windSpeed ??= 4;
  params.windDirection ??= 45;
  let time = 0;

  function update(dt, origin) {
    points.visible = params.enabled;
    if (!params.enabled) return;

    const densityFraction = THREE.MathUtils.clamp(params.intensity / SNOW_MAX_INTENSITY, SNOW_MIN_DENSITY, 1);
    activeCount = Math.floor(maxCount * densityFraction);
    geometry.setDrawRange(0, activeCount);

    // Same reasoning as rain: below 1, intensity fades visual opacity (for
    // smooth weather transitions) while fall speed keeps a sane minimum.
    material.opacity = 0.9 * THREE.MathUtils.clamp(params.intensity, 0, 1);

    time += dt;
    const windRad = params.windDirection * (Math.PI / 180);
    const windX = Math.cos(windRad) * params.windSpeed;
    const windZ = Math.sin(windRad) * params.windSpeed;

    for (let i = 0; i < activeCount; i++) {
      const base = i * 3;
      const sway = Math.sin(time * 0.6 + swayPhase[i]) * swayAmp[i] * dt;

      positions[base + 0] += windX * dt + sway;
      positions[base + 1] -= fallSpeed[i] * Math.max(params.intensity, 0.2) * dt;
      positions[base + 2] += windZ * dt;

      const x = positions[base + 0];
      const y = positions[base + 1];
      const z = positions[base + 2];
      if (
        y < origin.y - FIELD.y * 0.3 ||
        Math.abs(x - origin.x) > FIELD.x ||
        Math.abs(z - origin.z) > FIELD.z
      ) {
        respawn(i, origin);
      }
    }

    posAttr.needsUpdate = true;
  }

  return { points, params, update };
}

// Wind wisps: long curved ribbons that flutter as they travel, not straight
// rigid quads — a flat instanced plane can only ever look like a plank
// gliding through the air, no matter how it's textured. Each ribbon is a
// multi-segment strip whose vertices get displaced sideways by a per-instance
// sine wave (phase/amplitude/frequency randomized at spawn) in the vertex
// shader, animated by a shared time uniform — GPU-cheap (one InstancedMesh,
// one draw call) but reads as genuinely bending, wisping motion instead of a
// row of gliding bars. Kept far from the camera (an annulus, not a ball
// centered on it) so these read as a distant atmospheric cue, not something
// in your face. All of them track the current gust direction closely (only
// a few degrees of jitter) so a field of them reads as one coherent wind,
// not scattered debris.
const STREAK_FIELD = { x: 1000, y: 400, z: 1000 };
const STREAK_MIN_DIST = 250;
const STREAK_BASE_WIDTH = 3;
// windSpeed at/above which the streak field is fully dense and fully wide —
// past this (Heavy Wind, Blizzard territory) it's already maxed out rather
// than continuing to scale without bound.
const STREAK_MAX_WIND = 90;
const WISP_SEGMENTS = 16;

// A flat strip along local X (length axis, -0.5..0.5) with enough segments
// to carry a smooth bend; local Z is the width axis, matching the streak
// texture's orientation.
function makeWispGeometry() {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i <= WISP_SEGMENTS; i++) {
    const u = i / WISP_SEGMENTS;
    const x = u - 0.5;
    positions.push(x, 0, -0.5, x, 0, 0.5);
    uvs.push(u, 0, u, 1);
  }
  for (let i = 0; i < WISP_SEGMENTS; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

const WISP_VERTEX_SHADER = /* glsl */`
  uniform float time;
  attribute float phase;
  attribute float amplitude;
  attribute float freq;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec3 pos = position;
    // Tapered toward both ends so the wisp's anchor points stay put while
    // the middle flutters freely — a real streamer bends most in the middle.
    float taper = sin(uv.x * 3.14159265);
    float bend = sin(uv.x * freq * 6.28318 + phase + time * 2.2) * amplitude * taper;
    pos.y += bend;
    pos.z += bend * 0.55;
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const WISP_FRAGMENT_SHADER = /* glsl */`
  uniform sampler2D map;
  uniform vec3 color;
  uniform float opacity;
  varying vec2 vUv;

  void main() {
    vec4 tex = texture2D(map, vUv);
    gl_FragColor = vec4(color * tex.rgb, tex.a * opacity);
  }
`;

export function buildWindStreaks(scene, maxCount = 220) {
  const dirX = new Float32Array(maxCount);
  const dirZ = new Float32Array(maxCount);
  const speed = new Float32Array(maxCount);
  const posX = new Float32Array(maxCount);
  const posY = new Float32Array(maxCount);
  const posZ = new Float32Array(maxCount);
  const length = new Float32Array(maxCount);

  const geometry = makeWispGeometry();
  const phaseAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1);
  const ampAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1);
  const freqAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1);
  geometry.setAttribute('phase', phaseAttr);
  geometry.setAttribute('amplitude', ampAttr);
  geometry.setAttribute('freq', freqAttr);

  function respawn(i, origin, gustDirX, gustDirZ) {
    const angle = Math.atan2(gustDirZ, gustDirX) + (Math.random() - 0.5) * (16 * Math.PI / 180);
    dirX[i] = Math.cos(angle);
    dirZ[i] = Math.sin(angle);
    speed[i] = 70 + Math.random() * 90;
    // Notably longer than a subtle atmospheric hint — these should read as
    // real sweeping wisps of air, not short dashes.
    length[i] = 55 + Math.random() * 75;
    phaseAttr.array[i] = Math.random() * Math.PI * 2;
    ampAttr.array[i] = 0.06 + Math.random() * 0.1;
    freqAttr.array[i] = 1 + Math.random() * 1.5;
    phaseAttr.needsUpdate = true;
    ampAttr.needsUpdate = true;
    freqAttr.needsUpdate = true;

    let ox;
    let oz;
    let dist;
    do {
      ox = (Math.random() - 0.5) * STREAK_FIELD.x * 2;
      oz = (Math.random() - 0.5) * STREAK_FIELD.z * 2;
      dist = Math.hypot(ox, oz);
    } while (dist < STREAK_MIN_DIST);

    posX[i] = origin.x + ox;
    posY[i] = origin.y + (Math.random() - 0.5) * STREAK_FIELD.y;
    posZ[i] = origin.z + oz;
  }

  for (let i = 0; i < maxCount; i++) respawn(i, new THREE.Vector3(), 1, 0);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: makeSoftStreakTexture() },
      color: { value: new THREE.Color(0xdce8ff) },
      opacity: { value: 0 },
      time: { value: 0 },
    },
    vertexShader: WISP_VERTEX_SHADER,
    fragmentShader: WISP_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, maxCount);
  mesh.frustumCulled = false;
  let activeCount = maxCount;
  skipInstancedDuringOverridePass(mesh, () => activeCount);
  scene.add(mesh);

  const dummy = new THREE.Object3D();
  const axisX = new THREE.Vector3(1, 0, 0);
  const dirVec = new THREE.Vector3();

  function writeInstance(i, widthScale) {
    dirVec.set(dirX[i], 0, dirZ[i]);
    dummy.position.set(
      posX[i] - dirX[i] * length[i] * 0.5,
      posY[i],
      posZ[i] - dirZ[i] * length[i] * 0.5,
    );
    dummy.quaternion.setFromUnitVectors(axisX, dirVec);
    dummy.scale.set(length[i], 1, STREAK_BASE_WIDTH * widthScale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }

  for (let i = 0; i < maxCount; i++) writeInstance(i, 1);
  mesh.instanceMatrix.needsUpdate = true;

  const params = { windSpeed: 0, windDirection: 0 };
  let time = 0;
  // A slow, layered surge independent of the shared gust system — real wind
  // doesn't glide at one constant speed, it swells and lulls. Kept local to
  // the wisps themselves so it doesn't also drag cloud speed/camera shake
  // around with it.
  let surgePhase = Math.random() * 100;

  function update(dt, origin) {
    const visible = params.windSpeed > 10;
    mesh.visible = visible;
    if (!visible) return;

    time += dt;
    material.uniforms.time.value = time;
    surgePhase += dt;
    const surge = 1 + Math.sin(surgePhase * 0.35) * 0.35 + Math.sin(surgePhase * 0.11 + 2.0) * 0.25;

    // How far into the 10..STREAK_MAX_WIND range the current wind sits —
    // drives density, width, and opacity ceiling together so a full gale
    // reads as dramatically more streaked-up than a breeze, not just faster.
    const windFraction = THREE.MathUtils.clamp((params.windSpeed - 10) / (STREAK_MAX_WIND - 10), 0, 1);
    activeCount = Math.max(1, Math.floor(maxCount * THREE.MathUtils.lerp(0.12, 1, windFraction)));

    // Wind itself is invisible — this should read as a soft, faint
    // suggestion of motion at low speeds, though a real gale earns a
    // stronger presence than the old flat 0.3 ceiling allowed.
    material.uniforms.opacity.value = THREE.MathUtils.lerp(0.12, 0.5, windFraction);
    const widthScale = THREE.MathUtils.lerp(1, 2.2, windFraction);

    const windRad = params.windDirection * (Math.PI / 180);
    const gustDirX = Math.cos(windRad);
    const gustDirZ = Math.sin(windRad);
    const speedScale = (params.windSpeed / 35) * surge;

    for (let i = 0; i < activeCount; i++) {
      const move = speed[i] * speedScale * dt;
      posX[i] += dirX[i] * move;
      posZ[i] += dirZ[i] * move;

      const distFromCam = Math.hypot(posX[i] - origin.x, posZ[i] - origin.z);
      if (distFromCam > STREAK_FIELD.x || distFromCam < STREAK_MIN_DIST * 0.6) {
        respawn(i, origin, gustDirX, gustDirZ);
      }
      writeInstance(i, widthScale);
    }

    mesh.instanceMatrix.needsUpdate = true;
  }

  return { mesh, params, update };
}
