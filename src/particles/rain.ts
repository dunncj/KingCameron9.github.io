// Rain: short falling line-segment streaks, GPU-driven (see shaders/wrapField.glsl.ts)
// — each streak's position is computed on the GPU from a fixed-at-spawn
// random seed plus a shared `time` uniform, so a frame's only CPU work is a
// handful of uniform updates, never a per-particle loop or a buffer
// re-upload, regardless of how many streaks are in the pool.
import {
  BufferGeometry, BufferAttribute, Color, LineSegments, ShaderMaterial, Vector2, Vector3, Object3D,
} from 'three';
import { skipDuringOverridePass } from './overridePass';
import { WRAP_FIELD_GLSL, createWrapFieldUniforms } from '../shaders';
import { intensityToDensityFraction, intensityToOpacityFraction, intensityToSpeedScale } from './intensity';

export interface RainParams {
  enabled: boolean;
  intensity: number;
  // Derived per-frame state (see main.js's tick(), which overwrites these
  // from the current wind gust every frame) — not real settings of their
  // own, just live here so a single `params` object carries everything the
  // field needs. Optional because a fresh settings object won't have them
  // until the first tick.
  windSpeed?: number;
  windDirection?: number;
}

export interface RainOptions {
  maxCount?: number;
  fieldSize?: { x: number; y: number; z: number };
  // How far above `origin` streaks spawn/wrap from, on average — the field
  // extends further above the camera than below it (rain falls past you,
  // it doesn't hang around at your feet).
  yCenterOffset?: number;
  streakLength?: number;
  fallSpeedRange?: [number, number];
  color?: number;
  baseOpacity?: number;
  maxIntensity?: number;
  minDensityFraction?: number;
}

const RAIN_DEFAULTS: Required<RainOptions> = {
  maxCount: 22000,
  // Sized generously (world units are ~meters, camera can be anywhere from
  // a few hundred to thousands of units up) so weather reads clearly even
  // from a wide overview shot, not just up close in first-person flight.
  fieldSize: { x: 2800, y: 910, z: 2800 },
  yCenterOffset: 210, // biases the wrap band upward, roughly matching the old spawn-high/exit-low asymmetry
  streakLength: 6,
  fallSpeedRange: [90, 150],
  color: 0xd8e8ff,
  baseOpacity: 0.75,
  maxIntensity: 3, // intensity values across presets top out around 3 (Storm's heaviest)
  minDensityFraction: 0.15,
};

const VERTEX_SHADER = /* glsl */`
  ${WRAP_FIELD_GLSL}
  uniform vec2 uWind;
  uniform float uIntensityFallScale;
  uniform float uStreakLength;
  attribute vec3 aSeed;
  attribute float aFallSpeed;
  attribute float aEnd;

  void main() {
    vec3 velocity = vec3(uWind.x, -aFallSpeed * uIntensityFallScale, uWind.y);
    vec3 basePos = wrapFieldPosition(aSeed, velocity);
    vec3 dir = normalize(velocity);
    vec3 worldPos = basePos + dir * uStreakLength * aEnd;
    vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;

  void main() {
    gl_FragColor = vec4(uColor, uOpacity);
  }
`;

export interface RainField {
  object: LineSegments;
  params: RainParams;
  update(dt: number, origin: Object3D['position']): void;
}

export function createRainField(scene: { add(o: Object3D): void }, params: RainParams, options: RainOptions = {}): RainField {
  const {
    maxCount, fieldSize, yCenterOffset, streakLength, fallSpeedRange, color, baseOpacity, maxIntensity, minDensityFraction,
  } = { ...RAIN_DEFAULTS, ...options };
  const [minFallSpeed, maxFallSpeed] = fallSpeedRange;

  const vertexCount = maxCount * 2;
  const position = new Float32Array(vertexCount * 3); // required by BufferGeometry convention; the shader ignores it and computes worldPos itself
  const seed = new Float32Array(vertexCount * 3);
  const fallSpeed = new Float32Array(vertexCount);
  const end = new Float32Array(vertexCount);

  for (let i = 0; i < maxCount; i++) {
    const sx = Math.random();
    const sy = Math.random();
    const sz = Math.random();
    const speed = minFallSpeed + Math.random() * (maxFallSpeed - minFallSpeed);
    for (let v = 0; v < 2; v++) {
      const idx = i * 2 + v;
      seed[idx * 3 + 0] = sx;
      seed[idx * 3 + 1] = sy;
      seed[idx * 3 + 2] = sz;
      fallSpeed[idx] = speed;
      end[idx] = v;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new BufferAttribute(seed, 3));
  geometry.setAttribute('aFallSpeed', new BufferAttribute(fallSpeed, 1));
  geometry.setAttribute('aEnd', new BufferAttribute(end, 1));

  const fieldSizeVec = new Vector3(fieldSize.x, fieldSize.y, fieldSize.z);
  const uniforms = {
    ...createWrapFieldUniforms(fieldSizeVec, yCenterOffset),
    uWind: { value: new Vector2(0, 0) },
    uIntensityFallScale: { value: 1 },
    uStreakLength: { value: streakLength },
    uColor: { value: new Color(color) },
    uOpacity: { value: 0 },
  };

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });

  const object = new LineSegments(geometry, material);
  object.frustumCulled = false; // the wrap field always surrounds the camera; per-draw frustum math would be wasted work
  let activeCount = maxCount;
  skipDuringOverridePass(object, () => activeCount * 2);
  scene.add(object);

  // windSpeed/windDirection aren't real settings (see RainParams) — main.js's
  // tick() overwrites them every frame from the current wind gust, but they
  // need *some* value before that first frame runs.
  params.windSpeed ??= 15;
  params.windDirection ??= 45;

  let time = 0;

  function update(dt: number, origin: Object3D['position']): void {
    object.visible = params.enabled;
    if (!params.enabled) return;

    const densityFraction = intensityToDensityFraction(params.intensity, maxIntensity, minDensityFraction);
    activeCount = Math.floor(maxCount * densityFraction);
    geometry.setDrawRange(0, activeCount * 2);
    uniforms.uOpacity.value = baseOpacity * intensityToOpacityFraction(params.intensity);
    uniforms.uIntensityFallScale.value = intensityToSpeedScale(params.intensity);

    const windRad = (params.windDirection ?? 0) * (Math.PI / 180);
    const windSpeed = params.windSpeed ?? 0;
    uniforms.uWind.value.set(Math.cos(windRad) * windSpeed, Math.sin(windRad) * windSpeed);

    time += dt;
    uniforms.uTime.value = time;
    uniforms.uOrigin.value.copy(origin);
  }

  return { object, params, update };
}
