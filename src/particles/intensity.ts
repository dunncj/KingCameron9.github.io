// How a weather intensity value (0..maxIntensity, e.g. RAIN_MAX_INTENSITY)
// maps to visible particle density and opacity — extracted once here
// instead of copy-pasted per field, so a third particle type (or a tweak to
// how "light vs heavy" should read) only needs to change in one place.
import { MathUtils } from 'three';

// Below minDensityFraction, a field would draw too few particles to read as
// weather at all — clamping the floor means even the lightest non-zero
// intensity still looks like *something*, while density keeps scaling up
// smoothly to the full pool as intensity approaches maxIntensity.
export function intensityToDensityFraction(intensity: number, maxIntensity: number, minDensityFraction: number): number {
  return MathUtils.clamp(intensity / maxIntensity, minDensityFraction, 1);
}

// Opacity fades in below intensity 1 (so a weather transition can cross-fade
// a preset in/out smoothly) and holds at full above it — density is what
// keeps scaling past that point, not opacity.
export function intensityToOpacityFraction(intensity: number): number {
  return MathUtils.clamp(intensity, 0, 1);
}

// Fall/drift speed shouldn't drop to zero just because intensity is low —
// a light drizzle still falls at a normal speed, it's just sparser. This
// floor keeps per-particle motion from crawling to a stop.
export function intensityToSpeedScale(intensity: number, minSpeedScale = 0.2): number {
  return Math.max(intensity, minSpeedScale);
}
