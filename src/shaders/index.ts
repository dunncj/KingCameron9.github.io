// The shader service: shared GLSL/material infrastructure other subsystems
// (particles, sky, clouds, and future location-specific effects) build
// their own materials on top of, rather than each hand-rolling
// ShaderMaterial construction and shader-source patching independently.
export { WRAP_FIELD_GLSL, createWrapFieldUniforms, type WrapFieldUniforms } from './wrapField.glsl';
export { patchShaderSource, type ShaderPatch } from './patchShaderSource';
export { createShaderMaterial, type ShaderMaterialDefinition, type ManagedShaderMaterial } from './material';
