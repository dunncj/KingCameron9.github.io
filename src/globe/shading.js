// All three globe layers (base globe, whole-globe entry detail, dynamic
// close-up grid) are concentric spheres centered at the scene origin with no
// transform of their own, so a vertex's raw object-space `position` already
// equals its outward surface normal once normalized — no separate normal
// attribute needed. Injected into each layer's otherwise-plain
// MeshBasicMaterial to give the flat, evenly-lit satellite photo some of the
// depth a real lit sphere has: a soft view-fixed "terminator" (so it reads
// as a lit ball no matter how the globe is panned/rotated, like Google
// Earth's own space view) plus a thin Fresnel rim light standing the globe
// out from the black background — plus a per-provider color grade (see
// mapProviders.js's own colorGrade) closing the visual gap between
// providers before either of those effects run.
import { patchShaderSource } from '../shaders';
import { activeProvider } from './provider';

// toFixed guarantees a decimal point (GLSL ES rejects a bare integer
// literal like `1` where a float is expected).
const glslFloat = (n) => n.toFixed(4);

// Builds the GLSL for activeProvider.colorGrade (mapProviders.js) once at
// module load — a small photographic grading pipeline (white balance ->
// exposure/contrast -> per-hue-range HSL pushes -> a shadow-only lift on
// the raw blue channel), in that order, each stage only emitted when it's
// not a no-op so an identity provider (Google) pays nothing for stages it
// doesn't use rather than running through five inert matrix ops per pixel.
// See mapProviders.js's own colorGrade comment for what each field means
// and where the numbers came from.
function buildColorGradeGLSL(grade) {
  const stages = [];
  const [wbR, wbG, wbB] = grade.whiteBalance;
  if (wbR !== 1 || wbG !== 1 || wbB !== 1) {
    stages.push(`diffuseColor.rgb *= vec3(${glslFloat(wbR)}, ${glslFloat(wbG)}, ${glslFloat(wbB)});`);
  }
  if (grade.exposure !== 1) {
    stages.push(`diffuseColor.rgb *= ${glslFloat(grade.exposure)};`);
  }
  if (grade.contrast !== 1) {
    stages.push(`diffuseColor.rgb = (diffuseColor.rgb - 0.5) * ${glslFloat(grade.contrast)} + 0.5;`);
  }
  if (grade.hslBands.length > 0) {
    // lumShift is optional (omitted by every current band — see
    // mapProviders.js's own comment on why a uniform per-band lightness
    // lift isn't the right tool) — defaults to 0, a no-op mix.
    const bandStages = grade.hslBands.map(({
      hue, width, hueShift, satShift, lumShift = 0,
    }) => `
      {
        float w = 1.0 - smoothstep(0.0, ${glslFloat(width)}, hueDist(hsl.x, ${glslFloat(hue)}));
        hsl.x = mod(hsl.x + ${glslFloat(hueShift)} * w, 360.0);
        hsl.y = clamp(hsl.y * mix(1.0, 1.0 + ${glslFloat(satShift)}, w), 0.0, 1.0);
        hsl.z = mix(hsl.z, 1.0, ${glslFloat(lumShift)} * w);
      }`).join('\n');
    stages.push(`
      {
        vec3 hsl = rgb2hsl(clamp(diffuseColor.rgb, 0.0, 1.0));
        ${bandStages}
        diffuseColor.rgb = hsl2rgb(hsl);
      }`);
  }
  if (grade.blueShadowLift !== 0) {
    // Approximates a tone-curve shadow lift on the raw blue channel — the
    // fix for water dark enough to have no real hue/saturation for the
    // HSL bands above to grab onto (see mapProviders.js's own comment on
    // why this exists: real imagery reading as near-black/near-colorless,
    // e.g. the Great Lakes on Esri). 0.4 is where the lift fades to zero
    // ("easing back to normal by midtones").
    stages.push(`
      diffuseColor.b += ${glslFloat(grade.blueShadowLift)} * (1.0 - smoothstep(0.0, 0.4, diffuseColor.b));`);
  }
  return stages.join('\n');
}

const colorGradeGLSL = buildColorGradeGLSL(activeProvider.colorGrade);
// rgb2hsl/hsl2rgb/hueDist are only referenced when at least one hslBand
// exists — cheap either way (a handful of scalar ops, never called if
// unused), so always defined rather than conditionally, to keep this
// simple.
const HSL_GLSL_HELPERS = `
vec3 rgb2hsl(vec3 c) {
  float maxc = max(max(c.r, c.g), c.b);
  float minc = min(min(c.r, c.g), c.b);
  float l = (maxc + minc) * 0.5;
  float d = maxc - minc;
  float h = 0.0;
  float s = 0.0;
  if (d > 0.00001) {
    s = d / (1.0 - abs(2.0 * l - 1.0));
    if (maxc == c.r) { h = mod((c.g - c.b) / d, 6.0); }
    else if (maxc == c.g) { h = (c.b - c.r) / d + 2.0; }
    else { h = (c.r - c.g) / d + 4.0; }
    h *= 60.0;
    if (h < 0.0) { h += 360.0; }
  }
  return vec3(h, s, l);
}
vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x; float s = hsl.y; float l = hsl.z;
  float c = (1.0 - abs(2.0 * l - 1.0)) * s;
  float x = c * (1.0 - abs(mod(h / 60.0, 2.0) - 1.0));
  float m = l - c * 0.5;
  vec3 rgb;
  if (h < 60.0) { rgb = vec3(c, x, 0.0); }
  else if (h < 120.0) { rgb = vec3(x, c, 0.0); }
  else if (h < 180.0) { rgb = vec3(0.0, c, x); }
  else if (h < 240.0) { rgb = vec3(0.0, x, c); }
  else if (h < 300.0) { rgb = vec3(x, 0.0, c); }
  else { rgb = vec3(c, 0.0, x); }
  return rgb + m;
}
float hueDist(float h1, float h2) {
  float d = abs(h1 - h2);
  return min(d, 360.0 - d);
}`;

// minLight (default 0.38, every existing caller's unchanged behavior) is
// how dark the "unlit hemisphere" side gets multiplied down to — see
// globeBase.js's own comment on why the polar cap/ring materials pass a
// much higher floor: real Arctic Ocean imagery is already dark navy, and
// the default 0.38 floor compounds with that (and with a darkening
// colorGrade, e.g. Esri's) to crush it to near-black on screen — visually
// indistinguishable from a rendering gap even though real imagery is
// genuinely there. A brighter floor only matters where content is already
// dark to begin with (open ocean); it's invisible everywhere else content
// is mid-to-bright already, so this costs nothing for the rest of the
// globe.
export function applyGlobeShading(material, minLight = 0.38) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = patchShaderSource(shader.vertexShader, [
      { find: '#include <common>', replace: '#include <common>\nvarying vec3 vNormalView;' },
      {
        find: '#include <begin_vertex>',
        replace: '#include <begin_vertex>\nvNormalView = normalize(mat3(modelViewMatrix) * normalize(position));',
      },
    ], 'globe shading (vertex)');
    shader.fragmentShader = patchShaderSource(shader.fragmentShader, [
      { find: '#include <common>', replace: `#include <common>\nvarying vec3 vNormalView;\n${HSL_GLSL_HELPERS}` },
      {
        find: '#include <map_fragment>',
        replace: `#include <map_fragment>
        {
          // Per-provider color grade (see mapProviders.js's colorGrade and
          // buildColorGradeGLSL above) — identity for Google (what this
          // scene's own lighting/rim below was tuned against); a small
          // grading pipeline for Esri, closing the gap to Google's look.
          ${colorGradeGLSL}
          // Fixed in view space (not world space) so the "sunlit" side always
          // faces the same on-screen direction regardless of how far the
          // globe has been panned/rotated — an unlit hemisphere always
          // shades in toward the same corner, exactly like Google Earth's.
          float ndl = dot(vNormalView, normalize(vec3(-0.35, 0.45, 0.75)));
          float lit = smoothstep(-0.15, 0.35, ndl);
          diffuseColor.rgb *= mix(${glslFloat(minLight)}, 1.05, lit);
          float rim = pow(1.0 - clamp(vNormalView.z, 0.0, 1.0), 3.0);
          diffuseColor.rgb += vec3(0.5, 0.72, 1.0) * rim * 0.5;
        }`,
      },
    ], 'globe shading (fragment)');
  };
  material.needsUpdate = true;
}
