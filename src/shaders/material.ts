import { ShaderMaterial, type Blending, type Side } from 'three';

type UniformMap = Record<string, { value: unknown }>;

export interface ShaderMaterialDefinition<U extends UniformMap> {
  uniforms: U;
  vertexShader: string;
  fragmentShader: string;
  transparent?: boolean;
  depthWrite?: boolean;
  depthTest?: boolean;
  vertexColors?: boolean;
  side?: Side;
  blending?: Blending;
}

export interface ManagedShaderMaterial<U extends UniformMap> {
  material: ShaderMaterial;
  uniforms: U;
  // Every subsystem currently driving these materials per-frame (sky's sun
  // direction, clouds' fog color, a future location tint) was writing
  // straight into `material.uniforms.x.value` by hand — fine for a scalar,
  // but easy to get subtly wrong for a Vector/Color uniform (replacing the
  // object reference instead of mutating it breaks anything that cached
  // the old reference). `set()` picks the right one automatically: a
  // Vector3/Color instance is copied in, a plain array is spread through
  // `.set(...)`, anything else (numbers, textures) replaces `.value`
  // directly.
  set(values: Partial<{ [K in keyof U]: U[K]['value'] }>): void;
}

function assignUniformValue(uniform: { value: unknown }, next: unknown): void {
  const current = uniform.value as { copy?: (v: unknown) => void; set?: (...args: unknown[]) => void } | null;
  if (current && typeof current === 'object' && !Array.isArray(next) && typeof current.copy === 'function' && next && typeof next === 'object') {
    current.copy(next);
    return;
  }
  if (current && typeof current === 'object' && Array.isArray(next) && typeof current.set === 'function') {
    current.set(...(next as number[]));
    return;
  }
  uniform.value = next;
}

// Thin wrapper around THREE.ShaderMaterial — construction stays plain
// (uniforms/shaders/options in, one call), the only thing this actually
// adds is the `set()` ergonomics above and a consistent creation shape
// every subsystem (particles, sky, clouds, a future location effect) can
// share instead of hand-rolling `new THREE.ShaderMaterial({...})` and its
// own bespoke per-frame uniform-poking code each time.
export function createShaderMaterial<U extends UniformMap>(
  definition: ShaderMaterialDefinition<U>,
): ManagedShaderMaterial<U> {
  const { uniforms, ...materialOptions } = definition;
  const material = new ShaderMaterial({ uniforms, ...materialOptions });

  return {
    material,
    uniforms,
    set(values) {
      for (const key of Object.keys(values) as (keyof U)[]) {
        const next = values[key];
        if (next === undefined) continue;
        assignUniformValue(uniforms[key], next);
      }
    },
  };
}
