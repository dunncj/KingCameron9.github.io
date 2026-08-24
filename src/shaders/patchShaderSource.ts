// Both sky.js (patching the three.js Sky addon's baked shader) and
// usMap.js's applyGlobeShading (patching MeshBasicMaterial via
// onBeforeCompile) inject snippets into third-party GLSL source the same
// way: a chain of exact-string `.replace()` calls. Centralizing that chain
// here does two things a bare `.replace()` chain can't on its own: it
// reports which patches actually landed, and — the real payoff — it warns
// when one doesn't, instead of silently no-op'ing. An upstream three.js
// bump that reflows the Sky addon's shader source (or any change to
// three's own MeshBasicMaterial template chunks) would otherwise make a
// patch quietly stop applying, with no error and no clue why the visual
// it was supposed to add just isn't there anymore.
export interface ShaderPatch {
  find: string;
  replace: string;
}

export function patchShaderSource(source: string, patches: ShaderPatch[], label = 'shader'): string {
  let patched = source;
  for (const { find, replace } of patches) {
    if (!patched.includes(find)) {
      console.warn(
        `[shaders] ${label}: patch target not found, skipped — "${find.slice(0, 60)}"`,
      );
      continue;
    }
    patched = patched.replace(find, replace);
  }
  return patched;
}
