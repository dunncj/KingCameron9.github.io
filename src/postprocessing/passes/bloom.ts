import { Vector2 } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createShaderMaterial } from '../../shaders';

// Self-contained bloom: extract bright pixels and blur them with a small
// grid kernel, all in one pass. Not used: UnrealBloomPass — its render()
// writes its composited result directly into the composer's `readBuffer`
// instead of the `writeBuffer` it's handed (verified by reading its source),
// an unusual convention that corrupted the whole frame to solid black
// whenever the view was sky-dominated (looking steeply up, or at the sun),
// reproducibly and independent of its own strength/threshold settings.
// This follows the plain tDiffuse-in/writeBuffer-out contract every other
// pass here uses, so it doesn't depend on EffectComposer's buffer swapping
// working around that quirk.
const VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 resolution;
  uniform float threshold;
  uniform float strength;
  uniform float radius;
  // Tints the glow itself (not the base image) — during golden hour this
  // is what actually makes the sun's halo read as warm/orange instead of
  // white, since the Preetham sky's own disc color stays fairly neutral.
  uniform vec3 tint;
  varying vec2 vUv;

  vec3 bright(vec2 uv) {
    // Clamp before extracting brightness: the sky shader is raw,
    // untonemapped HDR (a custom ShaderMaterial, so renderer.toneMapping
    // never touches it) and can produce enormous values around the sun at
    // low elevation. Feeding that straight into the blur let one very hot
    // pixel balloon into a soft white dome covering half the screen —
    // capping the input keeps a bright sky bright without letting it run
    // away.
    vec3 c = min(texture2D(tDiffuse, uv).rgb, vec3(3.0));
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    return c * smoothstep(threshold, threshold + 0.3, lum);
  }

  void main() {
    vec3 base = texture2D(tDiffuse, vUv).rgb;

    vec3 sum = vec3(0.0);
    float total = 0.0;
    vec2 texel = radius / resolution;

    for (int x = -2; x <= 2; x++) {
      for (int y = -2; y <= 2; y++) {
        float w = exp(-float(x * x + y * y) / 4.0);
        sum += bright(vUv + vec2(float(x), float(y)) * texel) * w;
        total += w;
      }
    }

    vec3 bloomColor = sum / max(total, 0.0001);
    gl_FragColor = vec4(base + bloomColor * tint * strength, 1.0);
  }
`;

export interface BloomParams {
  strength: number;
  radius: number;
  threshold: number;
  tint: [number, number, number];
  resolution: [number, number];
}

export interface BloomPass {
  pass: ShaderPass;
  set(params: Partial<BloomParams>): void;
}

export function createBloomPass(): BloomPass {
  const bloomMaterial = createShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      resolution: { value: new Vector2(1, 1) },
      threshold: { value: 0.85 },
      strength: { value: 0.4 },
      radius: { value: 2.2 },
      tint: { value: [1, 1, 1] },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });
  const pass = new ShaderPass(bloomMaterial.material);
  return { pass, set: bloomMaterial.set };
}
