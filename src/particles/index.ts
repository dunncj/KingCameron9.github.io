// Public API for the particle system — everything outside this folder
// should import from here, not from the individual field modules, so the
// internal file layout can keep changing without touching call sites.
export { createRainField, type RainField, type RainParams, type RainOptions } from './rain';
export { createSnowField, type SnowField, type SnowParams, type SnowOptions } from './snow';
export {
  createWindStreaks, type WindStreaksField, type WindStreaksParams, type WindStreaksOptions,
} from './windStreaks';

// Default max-intensity ceilings (see intensity.ts) — presets top out
// around these values; exported so callers normalizing a raw intensity
// into a 0..1 fraction (e.g. driving a post-fx amount) don't have to
// hardcode the same number a field's own options already default to.
export const RAIN_MAX_INTENSITY = 3;
export const SNOW_MAX_INTENSITY = 3;

// Shared building blocks — exported so a future particle type (embers,
// falling leaves, dust motes, ...) can be composed from the same pieces
// rain/snow/wind already use, without duplicating them.
export { createSoftCircleTexture, createSoftStreakTexture } from './textures';
export { skipDuringOverridePass, skipInstancedDuringOverridePass } from './overridePass';
export { intensityToDensityFraction, intensityToOpacityFraction, intensityToSpeedScale } from './intensity';
export { WRAP_FIELD_GLSL, createWrapFieldUniforms, type WrapFieldUniforms } from './wrapField.glsl';
