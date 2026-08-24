// Wind wisps: long curved ribbons that flutter as they travel, not straight
// rigid quads — a flat instanced plane can only ever look like a plank
// gliding through the air, no matter how it's textured. Each ribbon is a
// multi-segment strip whose vertices get displaced sideways by a
// per-instance sine wave (phase/amplitude/frequency randomized at spawn),
// GPU-driven the same way as rain.ts/snow.ts (see shaders/wrapField.glsl.ts): each
// wisp's drift position comes from a fixed-at-spawn seed plus shared `time`/
// `wind` uniforms, so there's no per-frame CPU loop and no per-frame
// instance-matrix re-upload — orientation, bend, and drift all live in the
// vertex shader instead. Kept far from the camera (an annulus, not a ball
// centered on it) so these read as a distant atmospheric cue, not something
// in your face.
import {
  BufferGeometry, Float32BufferAttribute, InstancedBufferAttribute, InstancedMesh, ShaderMaterial, Color, MathUtils,
  Vector2, Vector3, Object3D, DoubleSide,
} from 'three';
import { skipInstancedDuringOverridePass } from './overridePass';
import { WRAP_FIELD_GLSL, createWrapFieldUniforms } from '../shaders';
import { createSoftStreakTexture } from './textures';

export interface WindStreaksParams {
  windSpeed: number;
  windDirection: number;
}

export interface WindStreaksOptions {
  maxCount?: number;
  fieldRadius?: number;
  minRadius?: number;
  segments?: number;
  baseWidth?: number;
  lengthRange?: [number, number];
  driftSpeedRange?: [number, number];
  angleJitterDeg?: number;
  color?: number;
  // Wind speed at/above which the streak field is fully dense and fully
  // wide — past this (Heavy Wind, Blizzard territory) it's already maxed
  // out rather than continuing to scale without bound.
  maxWindSpeed?: number;
  minVisibleWindSpeed?: number;
}

const WIND_STREAKS_DEFAULTS: Required<WindStreaksOptions> = {
  maxCount: 220,
  fieldRadius: 1000,
  minRadius: 250,
  segments: 16,
  baseWidth: 3,
  lengthRange: [55, 130],
  driftSpeedRange: [70, 160],
  angleJitterDeg: 16,
  color: 0xdce8ff,
  maxWindSpeed: 90,
  minVisibleWindSpeed: 10,
};

// A flat strip along local X (length axis, -0.5..0.5) with enough segments
// to carry a smooth bend; local Z is the width axis, matching the streak
// texture's orientation.
function createWispGeometry(segments: number): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const x = u - 0.5;
    positions.push(x, 0, -0.5, x, 0, 0.5);
    uvs.push(u, 0, u, 1);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

const VERTEX_SHADER = /* glsl */`
  ${WRAP_FIELD_GLSL}
  uniform vec2 uWind;
  uniform float uSurge;
  uniform float uBaseWidth;
  uniform float uWidthScale;
  attribute vec3 aSeed;
  attribute float aDriftSpeed;
  attribute float aLength;
  attribute float aAngleJitter;
  attribute float aPhase;
  attribute float aAmplitude;
  attribute float aFrequency;
  varying vec2 vUv;

  void main() {
    vUv = uv;

    float angle = atan(uWind.y, uWind.x) + aAngleJitter;
    vec2 dir = vec2(cos(angle), sin(angle));
    vec3 velocity = vec3(dir.x, 0.0, dir.y) * aDriftSpeed * uSurge;
    vec3 center = wrapFieldPosition(aSeed, velocity);

    // Tapered toward both ends so the wisp's anchor points stay put while
    // the middle flutters freely — a real streamer bends most in the middle.
    float taper = sin(uv.x * 3.14159265);
    float bend = sin(uv.x * aFrequency * 6.28318 + aPhase + uTime * 2.2) * aAmplitude * taper;

    // Local strip space: x spans [-length, 0] (the wisp trails behind
    // center, its leading point), z is width, y carries the bend.
    vec3 local = vec3((position.x - 0.5) * aLength, bend, position.z * uBaseWidth * uWidthScale + bend * 0.55);
    vec3 rotated = vec3(local.x * dir.x - local.z * dir.y, local.y, local.x * dir.y + local.z * dir.x);

    vec3 worldPos = center + rotated;
    vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    gl_FragColor = vec4(uColor * tex.rgb, tex.a * uOpacity);
  }
`;

export interface WindStreaksField {
  object: InstancedMesh;
  params: WindStreaksParams;
  update(dt: number, origin: Object3D['position']): void;
}

export function createWindStreaks(
  scene: { add(o: Object3D): void },
  params: WindStreaksParams = { windSpeed: 0, windDirection: 0 },
  options: WindStreaksOptions = {},
): WindStreaksField {
  const {
    maxCount, fieldRadius, minRadius, segments, baseWidth, lengthRange, driftSpeedRange, angleJitterDeg, color,
    maxWindSpeed, minVisibleWindSpeed,
  } = { ...WIND_STREAKS_DEFAULTS, ...options };
  const [minLength, maxLength] = lengthRange;
  const [minDrift, maxDrift] = driftSpeedRange;
  const angleJitterRad = angleJitterDeg * (Math.PI / 180);

  const geometry = createWispGeometry(segments);
  const seed = new Float32Array(maxCount * 3);
  const driftSpeed = new Float32Array(maxCount);
  const length = new Float32Array(maxCount);
  const angleJitter = new Float32Array(maxCount);
  const phase = new Float32Array(maxCount);
  const amplitude = new Float32Array(maxCount);
  const frequency = new Float32Array(maxCount);

  // Each instance's XZ seed is rejection-sampled so wisps start spread
  // across an annulus (not a disc centered on the camera) — see
  // fieldRadius/minRadius. The Y seed stays a plain uniform sample; wisps
  // don't need a biased vertical band the way rain/snow do.
  for (let i = 0; i < maxCount; i++) {
    let sx: number;
    let sz: number;
    do {
      sx = Math.random();
      sz = Math.random();
    } while (Math.hypot(sx - 0.5, sz - 0.5) * 2 * fieldRadius < minRadius);
    seed[i * 3 + 0] = sx;
    seed[i * 3 + 1] = Math.random();
    seed[i * 3 + 2] = sz;
    driftSpeed[i] = minDrift + Math.random() * (maxDrift - minDrift);
    length[i] = minLength + Math.random() * (maxLength - minLength);
    angleJitter[i] = (Math.random() - 0.5) * 2 * angleJitterRad;
    phase[i] = Math.random() * Math.PI * 2;
    amplitude[i] = 0.06 + Math.random() * 0.1;
    frequency[i] = 1 + Math.random() * 1.5;
  }

  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seed, 3));
  geometry.setAttribute('aDriftSpeed', new InstancedBufferAttribute(driftSpeed, 1));
  geometry.setAttribute('aLength', new InstancedBufferAttribute(length, 1));
  geometry.setAttribute('aAngleJitter', new InstancedBufferAttribute(angleJitter, 1));
  geometry.setAttribute('aPhase', new InstancedBufferAttribute(phase, 1));
  geometry.setAttribute('aAmplitude', new InstancedBufferAttribute(amplitude, 1));
  geometry.setAttribute('aFrequency', new InstancedBufferAttribute(frequency, 1));

  const fieldSizeVec = new Vector3(fieldRadius * 2, 400, fieldRadius * 2);
  const uniforms = {
    ...createWrapFieldUniforms(fieldSizeVec, 0),
    uWind: { value: new Vector2(1, 0) },
    uSurge: { value: 1 },
    uBaseWidth: { value: baseWidth },
    uWidthScale: { value: 1 },
    uMap: { value: createSoftStreakTexture() },
    uColor: { value: new Color(color) },
    uOpacity: { value: 0 },
  };

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  const object = new InstancedMesh(geometry, material, maxCount);
  object.frustumCulled = false;
  let activeCount = maxCount;
  skipInstancedDuringOverridePass(object, () => activeCount);
  scene.add(object);

  let time = 0;
  // A slow, layered surge independent of the shared gust system — real wind
  // doesn't glide at one constant speed, it swells and lulls. Kept local to
  // the wisps themselves so it doesn't also drag cloud speed/camera shake
  // around with it.
  let surgePhase = Math.random() * 100;

  function update(dt: number, origin: Object3D['position']): void {
    const visible = params.windSpeed > minVisibleWindSpeed;
    object.visible = visible;
    if (!visible) return;

    time += dt;
    surgePhase += dt;
    const surge = 1 + Math.sin(surgePhase * 0.35) * 0.35 + Math.sin(surgePhase * 0.11 + 2.0) * 0.25;

    // How far into the minVisibleWindSpeed..maxWindSpeed range the current
    // wind sits — drives density, width, and opacity ceiling together so a
    // full gale reads as dramatically more streaked-up than a breeze, not
    // just faster.
    const windFraction = MathUtils.clamp(
      (params.windSpeed - minVisibleWindSpeed) / (maxWindSpeed - minVisibleWindSpeed),
      0,
      1,
    );
    activeCount = Math.max(1, Math.floor(maxCount * MathUtils.lerp(0.12, 1, windFraction)));

    // Wind itself is invisible — this should read as a soft, faint
    // suggestion of motion at low speeds, though a real gale earns a
    // stronger presence than a flat ceiling would allow.
    uniforms.uOpacity.value = MathUtils.lerp(0.12, 0.5, windFraction);
    uniforms.uWidthScale.value = MathUtils.lerp(1, 2.2, windFraction);
    uniforms.uSurge.value = surge;

    const windRad = params.windDirection * (Math.PI / 180);
    uniforms.uWind.value.set(Math.cos(windRad), Math.sin(windRad));

    uniforms.uTime.value = time;
    uniforms.uOrigin.value.copy(origin);
  }

  return { object, params, update };
}
