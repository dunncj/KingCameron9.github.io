import { Vector2 } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createShaderMaterial } from '../../shaders';
import { NEGLIGIBLE_STRENGTH } from '../negligibleStrength';

// Directional wind blur: a handful of samples smeared along the wind's
// screen-projected direction, blended back over the sharp frame. This is
// the classic "speed lines" trick for selling wind/motion in a still shot —
// strength is gated to kick in only once wind is genuinely strong.
const VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 direction;
  uniform float strength;
  varying vec2 vUv;

  const int N = 11;

  void main() {
    vec3 base = texture2D(tDiffuse, vUv).rgb;

    if (strength > 0.001) {
      vec3 sum = vec3(0.0);
      float spread = strength * 0.012;
      for (int i = 0; i < N; i++) {
        float t = (float(i) - float(N - 1) * 0.5) * spread;
        sum += texture2D(tDiffuse, vUv + direction * t).rgb;
      }
      vec3 blurred = sum / float(N);
      base = mix(base, blurred, clamp(strength, 0.0, 0.3));
    }

    gl_FragColor = vec4(base, 1.0);
  }
`;

export interface WindBlurParams {
  direction: [number, number];
  strength: number;
}

export interface WindBlurPass {
  pass: ShaderPass;
  set(params: Partial<WindBlurParams>): void;
}

export function createWindBlurPass(): WindBlurPass {
  const windBlurMaterial = createShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      direction: { value: new Vector2(1, 0) },
      strength: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });
  const pass = new ShaderPass(windBlurMaterial.material);

  // Most days never cross the gust threshold at all — skip the pass's draw
  // entirely rather than running it every frame to blend in zero.
  function set(params: Partial<WindBlurParams>) {
    windBlurMaterial.set(params);
    if (params.strength !== undefined) {
      pass.enabled = params.strength > NEGLIGIBLE_STRENGTH;
    }
  }

  return { pass, set };
}
