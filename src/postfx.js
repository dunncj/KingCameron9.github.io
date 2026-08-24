import { Vector2 } from 'three';

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
export const BloomShader = {
  name: 'BloomShader',
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new Vector2(1, 1) },
    threshold: { value: 0.85 },
    strength: { value: 0.4 },
    radius: { value: 2.2 },
    // Tints the glow itself (not the base image) — during golden hour this
    // is what actually makes the sun's halo read as warm/orange instead of
    // white, since the Preetham sky's own disc color stays fairly neutral.
    tint: { value: [1, 1, 1] },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float threshold;
    uniform float strength;
    uniform float radius;
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
  `,
};

// Directional wind blur: a handful of samples smeared along the wind's
// screen-projected direction, blended back over the sharp frame. This is
// the classic "speed lines" trick for selling wind/motion in a still shot —
// strength is gated to kick in only once wind is genuinely strong.
export const WindBlurShader = {
  name: 'WindBlurShader',
  uniforms: {
    tDiffuse: { value: null },
    direction: { value: new Vector2(1, 0) },
    strength: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
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
  `,
};

// Cheap "poor man's" god rays: radially samples the already-rendered frame
// toward the sun's screen position, keeping only the bright pixels (sky/sun
// disc) via a subtractive threshold so buildings don't smear into streaks.
export const GodRaysShader = {
  name: 'GodRaysShader',
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
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
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
  `,
};

// Radial "hyperspace" blur: samples pulled inward toward `center`, more
// so farther from it — sells a fast dolly/zoom the way real motion blur
// would, and as a side effect smears over whatever's actually on screen,
// which is exactly what's wanted while diving through the overview's own
// zoom-in or the ground-level handoff descend: neither one is meant to be
// examined frame-by-frame, and both can have a moment of genuinely coarse
// or still-loading detail (a satellite patch not yet refined, 3D tiles not
// yet streamed in) that this hides rather than holds still on screen.
export const ZoomBlurShader = {
  name: 'ZoomBlurShader',
  uniforms: {
    tDiffuse: { value: null },
    center: { value: new Vector2(0.5, 0.5) },
    strength: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
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
  `,
};

// Final look-dev pass: weather tint/desaturation, vignette. No grain — it
// was tried (twice) and repeatedly came back looking like a dirty film
// texture once combined with the retro pixelation pass, so it's gone
// rather than defaulted-off-but-still-lurking.
export const WeatherGradeShader = {
  name: 'WeatherGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    tint: { value: [1, 1, 1] },
    vignetteStrength: { value: 0.35 },
    desaturate: { value: 0 },
    flash: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
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
  `,
};
