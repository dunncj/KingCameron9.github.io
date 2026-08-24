import { MathUtils } from 'three';
import type { WindSettings } from '../settings/types';

// windParams is the base/average value the GUI/console controls; `gust` is
// the effective, continuously-fluctuating value everything actually renders
// with — real wind isn't constant, it surges, dies down, and swings
// direction over time.
export interface Gust {
  speed: number;
  direction: number;
}

export interface GustSimulator {
  gust: Gust;
  update(dt: number): void;
}

export function createGustSimulator(windParams: WindSettings): GustSimulator {
  const gust: Gust = { speed: windParams.speed, direction: windParams.direction };
  let gustPhase = 0;

  function update(dt: number) {
    gustPhase += dt;
    // Mismatched, slow periods read as organic gusting rather than a fixed
    // value or per-frame jitter — no RNG needed, just uncorrelated sines.
    const speedWobble =
      Math.sin(gustPhase * 0.09) * 0.5 +
      Math.sin(gustPhase * 0.033 + 1.7) * 0.35 +
      Math.sin(gustPhase * 0.021 + 4.1) * 0.25;
    const dirWobble =
      Math.sin(gustPhase * 0.015 + 2.3) * 0.6 +
      Math.sin(gustPhase * 0.028 + 5.5) * 0.4;

    const speedMultiplier = MathUtils.clamp(1 + speedWobble, 0.1, 1.8);
    gust.speed = windParams.speed * speedMultiplier;
    // Was *40 (up to ±40°) — barely noticeable at a calm preset's low speed,
    // but the exact same swing at a windy preset's much higher speed made
    // clouds/rain/streaks visibly change direction hard enough to read as
    // "the wind direction just changed" during a weather transition, when
    // really it was always doing this and speed just made it obvious. A
    // much smaller swing keeps direction feeling stable across every preset.
    gust.direction = windParams.direction + dirWobble * 12;
  }

  return { gust, update };
}
