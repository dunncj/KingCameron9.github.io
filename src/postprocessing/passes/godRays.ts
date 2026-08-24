import { Vector2 } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createShaderMaterial } from '../../shaders';
import { NEGLIGIBLE_STRENGTH } from '../negligibleStrength';

// Cheap "poor man's" god rays: radially samples the already-rendered frame
// toward the sun's screen position, keeping only the bright pixels (sky/sun
// disc) via a subtractive threshold so buildings don't smear into streaks.
const VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 lightPosition;
  uniform float exposure;
  uniform float decay;
  uniform float density;
  uniform float weight;
  uniform float threshold;
  uniform float strength;
  varying vec2 vUv;

  const int NUM_SAMPLES = 60;

  void main() {
    vec3 base = texture2D(tDiffuse, vUv).rgb;

    if (strength > 0.001) {
      vec2 texCoord = vUv;
      vec2 deltaTexCoord = (texCoord - lightPosition) * (density / float(NUM_SAMPLES));
      float illuminationDecay = 1.0;
      vec3 accum = vec3(0.0);

      for (int i = 0; i < NUM_SAMPLES; i++) {
        texCoord -= deltaTexCoord;
        vec3 samp = max(texture2D(tDiffuse, texCoord).rgb - vec3(threshold), 0.0);
        accum += samp * illuminationDecay * weight;
        illuminationDecay *= decay;
      }

      base += accum * exposure * strength;
    }

    gl_FragColor = vec4(base, 1.0);
  }
`;

export interface GodRaysParams {
  lightPosition: [number, number];
  exposure: number;
  decay: number;
  density: number;
  weight: number;
  threshold: number;
  strength: number;
}

export interface GodRaysPass {
  pass: ShaderPass;
  set(params: Partial<GodRaysParams>): void;
}

export function createGodRaysPass(): GodRaysPass {
  const godRaysMaterial = createShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      lightPosition: { value: new Vector2(0.5, 0.5) },
      exposure: { value: 0.22 },
      decay: { value: 0.96 },
      density: { value: 0.9 },
      weight: { value: 0.4 },
      threshold: { value: 0.6 },
      strength: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });
  const pass = new ShaderPass(godRaysMaterial.material);

  // Skips the pass's full-screen draw and render-target swap entirely once
  // it has nothing to contribute (sun below the horizon, facing away, mid-
  // flight, etc.) rather than running it just to blend in zero.
  function set(params: Partial<GodRaysParams>) {
    godRaysMaterial.set(params);
    if (params.strength !== undefined) {
      pass.enabled = params.strength > NEGLIGIBLE_STRENGTH;
    }
  }

  return { pass, set };
}
