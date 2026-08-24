import { Vector2 } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createShaderMaterial } from '../../shaders';
import { NEGLIGIBLE_STRENGTH } from '../negligibleStrength';

// Radial "hyperspace" blur: samples pulled inward toward `center`, more
// so farther from it — sells a fast dolly/zoom the way real motion blur
// would, and as a side effect smears over whatever's actually on screen,
// which is exactly what's wanted while diving through the overview's own
// zoom-in or the ground-level handoff descend: neither one is meant to be
// examined frame-by-frame, and both can have a moment of genuinely coarse
// or still-loading detail (a satellite patch not yet refined, 3D tiles not
// yet streamed in) that this hides rather than holds still on screen.
const VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 center;
  uniform float strength;
  varying vec2 vUv;

  const int N = 12;

  void main() {
    vec3 base = texture2D(tDiffuse, vUv).rgb;

    if (strength > 0.001) {
      vec2 toCenter = center - vUv;
      vec3 sum = vec3(0.0);
      float totalWeight = 0.0;
      for (int i = 0; i < N; i++) {
        float t = float(i) / float(N - 1);
        vec2 offset = toCenter * t * strength * 0.5;
        float w = 1.0 - t * 0.5;
        sum += texture2D(tDiffuse, vUv + offset).rgb * w;
        totalWeight += w;
      }
      vec3 blurred = sum / totalWeight;
      base = mix(base, blurred, clamp(strength, 0.0, 0.85));
    }

    gl_FragColor = vec4(base, 1.0);
  }
`;

export interface ZoomBlurParams {
  center: [number, number];
  strength: number;
}

export interface ZoomBlurPass {
  pass: ShaderPass;
  set(params: Partial<ZoomBlurParams>): void;
}

export function createZoomBlurPass(): ZoomBlurPass {
  const zoomBlurMaterial = createShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      center: { value: new Vector2(0.5, 0.5) },
      strength: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });
  const pass = new ShaderPass(zoomBlurMaterial.material);

  // Skip the pass's full-screen draw entirely the rest of the time, same as
  // every other situational effect here. Gated on the actual value fed to
  // the shader (post any caller-side scaling, e.g. by a user fxParams
  // multiplier) rather than a separate pre-scale strength, so a pass never
  // stays enabled purely because its own strength multiplier happens to be
  // tuned near zero.
  function set(params: Partial<ZoomBlurParams>) {
    zoomBlurMaterial.set(params);
    if (params.strength !== undefined) {
      pass.enabled = params.strength > NEGLIGIBLE_STRENGTH;
    }
  }

  return { pass, set };
}
