import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createShaderMaterial } from '../../shaders';

// Final look-dev pass: weather tint/desaturation, vignette. No grain — it
// was tried (twice) and repeatedly came back looking like a dirty film
// texture once combined with the retro pixelation pass, so it's gone
// rather than defaulted-off-but-still-lurking.
const VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec3 tint;
  uniform float vignetteStrength;
  uniform float desaturate;
  uniform float flash;
  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;
    vec3 color = texture2D(tDiffuse, uv).rgb;
    color *= tint;

    // Negative desaturate extrapolates past the source color instead of
    // toward it — a cheap saturation boost (used by the globe overview)
    // using the same mix the ground-level weather grading already does.
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(color, vec3(lum), clamp(desaturate, -1.0, 1.0));

    vec2 vc = uv - 0.5;
    float vig = 1.0 - dot(vc, vc) * vignetteStrength;
    color *= clamp(vig, 0.0, 1.0);

    // Hard safety net: no pixel should reach a blinding, screen-dominating
    // white regardless of what fed it — sun disc, bloom, god rays all
    // compound, and capping any one of them individually isn't reliable.
    // Applied before the lightning flash so a strike can still punch
    // through brighter — that's meant to be a jolt, not clamped away.
    color = min(color, vec3(1.7));

    color += vec3(1.0, 0.98, 0.92) * flash;

    gl_FragColor = vec4(color, 1.0);
  }
`;

export interface WeatherGradeParams {
  tint: [number, number, number];
  vignetteStrength: number;
  desaturate: number;
  flash: number;
}

export interface WeatherGradePass {
  pass: ShaderPass;
  set(params: Partial<WeatherGradeParams>): void;
}

export function createWeatherGradePass(): WeatherGradePass {
  const weatherGradeMaterial = createShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      tint: { value: [1, 1, 1] },
      vignetteStrength: { value: 0.35 },
      desaturate: { value: 0 },
      flash: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });
  const pass = new ShaderPass(weatherGradeMaterial.material);
  return { pass, set: weatherGradeMaterial.set };
}
