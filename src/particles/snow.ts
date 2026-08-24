// Snow: drifting, swaying point sprites — same GPU-driven wrap-field
// technique as rain.ts (see shaders/wrapField.glsl.ts), so a frame's only CPU work
// is a handful of uniform updates regardless of pool size.
import {
  BufferGeometry, BufferAttribute, Color, Points, ShaderMaterial, Vector2, Vector3, Object3D,
} from 'three';
import { skipDuringOverridePass } from './overridePass';
import { WRAP_FIELD_GLSL, createWrapFieldUniforms } from '../shaders';
import { intensityToDensityFraction, intensityToOpacityFraction, intensityToSpeedScale } from './intensity';
import { createSoftCircleTexture } from './textures';

export interface SnowParams {
  enabled: boolean;
  intensity: number;
  // Derived per-frame state (see main.js's tick()) — see RainParams' own
  // comment, same reasoning.
  windSpeed?: number;
  windDirection?: number;
  // Render-quality lever (see src/quality/) — see RainParams' own comment.
  densityScale?: number;
}

export interface SnowOptions {
  maxCount?: number;
  fieldSize?: { x: number; y: number; z: number };
  yCenterOffset?: number;
  fallSpeedRange?: [number, number];
  swayAmplitudeRange?: [number, number];
  size?: number;
  color?: number;
  baseOpacity?: number;
  maxIntensity?: number;
  minDensityFraction?: number;
}

const SNOW_DEFAULTS: Required<SnowOptions> = {
  maxCount: 13000,
  fieldSize: { x: 2800, y: 910, z: 2800 },
  yCenterOffset: 210,
  fallSpeedRange: [10, 22],
  swayAmplitudeRange: [4, 14],
  size: 1.4, // world units — a rendered flake roughly the size of a rooftop, matching the old default
  color: 0xffffff,
  baseOpacity: 0.9,
  maxIntensity: 3, // snow intensity tops out at 3 (Blizzard) across presets
  minDensityFraction: 0.15,
};

// Approximates THREE's own PointsMaterial sizeAttenuation formula (perspective
// size falloff) closely enough to read correctly — a custom ShaderMaterial
// has to do this by hand since it isn't PointsMaterial. The 300.0 constant
// is a tuned-by-eye scale, same approach commonly used in raw-shader point
// sprite examples.
const VERTEX_SHADER = /* glsl */`
  ${WRAP_FIELD_GLSL}
  uniform vec2 uWind;
  uniform float uIntensityFallScale;
  uniform float uSize;
  attribute vec3 aSeed;
  attribute float aFallSpeed;
  attribute float aSwayPhase;
  attribute float aSwayAmp;

  void main() {
    vec3 velocity = vec3(uWind.x, -aFallSpeed * uIntensityFallScale, uWind.y);
    vec3 basePos = wrapFieldPosition(aSeed, velocity);
    float sway = sin(uTime * 0.6 + aSwayPhase) * aSwayAmp;
    vec3 worldPos = basePos + vec3(sway, 0.0, 0.0);

    vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = uSize * (300.0 / -mvPosition.z);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uOpacity;

  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(uColor * tex.rgb, tex.a * uOpacity);
  }
`;

export interface SnowField {
  object: Points;
  params: SnowParams;
  update(dt: number, origin: Object3D['position']): void;
}

export function createSnowField(scene: { add(o: Object3D): void }, params: SnowParams, options: SnowOptions = {}): SnowField {
  const {
    maxCount, fieldSize, yCenterOffset, fallSpeedRange, swayAmplitudeRange, size, color, baseOpacity, maxIntensity, minDensityFraction,
  } = { ...SNOW_DEFAULTS, ...options };
  const [minFallSpeed, maxFallSpeed] = fallSpeedRange;
  const [minSway, maxSway] = swayAmplitudeRange;

  const position = new Float32Array(maxCount * 3); // required by BufferGeometry convention; the shader ignores it and computes worldPos itself
  const seed = new Float32Array(maxCount * 3);
  const fallSpeed = new Float32Array(maxCount);
  const swayPhase = new Float32Array(maxCount);
  const swayAmp = new Float32Array(maxCount);

  for (let i = 0; i < maxCount; i++) {
    seed[i * 3 + 0] = Math.random();
    seed[i * 3 + 1] = Math.random();
    seed[i * 3 + 2] = Math.random();
    fallSpeed[i] = minFallSpeed + Math.random() * (maxFallSpeed - minFallSpeed);
    swayPhase[i] = Math.random() * Math.PI * 2;
    swayAmp[i] = minSway + Math.random() * (maxSway - minSway);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new BufferAttribute(seed, 3));
  geometry.setAttribute('aFallSpeed', new BufferAttribute(fallSpeed, 1));
  geometry.setAttribute('aSwayPhase', new BufferAttribute(swayPhase, 1));
  geometry.setAttribute('aSwayAmp', new BufferAttribute(swayAmp, 1));

  const fieldSizeVec = new Vector3(fieldSize.x, fieldSize.y, fieldSize.z);
  const uniforms = {
    ...createWrapFieldUniforms(fieldSizeVec, yCenterOffset),
    uWind: { value: new Vector2(0, 0) },
    uIntensityFallScale: { value: 1 },
    uSize: { value: size },
    uMap: { value: createSoftCircleTexture() },
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

  const object = new Points(geometry, material);
  object.frustumCulled = false;
  let activeCount = maxCount;
  skipDuringOverridePass(object, () => activeCount);
  scene.add(object);

  params.windSpeed ??= 4;
  params.windDirection ??= 45;

  let time = 0;

  function update(dt: number, origin: Object3D['position']): void {
    object.visible = params.enabled;
    if (!params.enabled) return;

    const densityFraction = intensityToDensityFraction(params.intensity, maxIntensity, minDensityFraction);
    activeCount = Math.floor(maxCount * densityFraction * (params.densityScale ?? 1));
    geometry.setDrawRange(0, activeCount);
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
