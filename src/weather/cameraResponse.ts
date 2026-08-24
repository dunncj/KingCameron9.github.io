import { MathUtils, Vector3 } from 'three';
import type { WindShakeSettings } from '../settings/types';
import { RAIN_MAX_INTENSITY, SNOW_MAX_INTENSITY, type RainField, type SnowField } from '../particles';
import type { Gust } from './gust';

// How rough the current weather is, 0..1 — combines wind, rain, and snow
// rather than just wind, so a heavy downpour or blizzard buffets the camera
// even on days that aren't specifically windy. Read by both the shake and
// the FOV response below so they stay in lockstep with each other.
export function precipitationAmounts(rain: RainField, snow: SnowField) {
  const rainAmount = rain.params.enabled ? MathUtils.clamp(rain.params.intensity / RAIN_MAX_INTENSITY, 0, 1) : 0;
  const snowAmount = snow.params.enabled ? MathUtils.clamp(snow.params.intensity / SNOW_MAX_INTENSITY, 0, 1) : 0;
  return { rainAmount, snowAmount };
}

export function weatherIntensity(gust: Gust, rain: RainField, snow: SnowField): number {
  const windAmount = MathUtils.clamp((gust.speed - 10) / 70, 0, 1);
  const { rainAmount, snowAmount } = precipitationAmounts(rain, snow);
  return Math.max(windAmount, rainAmount * 0.7, snowAmount * 0.6);
}

const BASE_FOV = 60;

export interface CameraWeatherResponse {
  // Subtle camera buffeting in rough weather — sum of a few uncorrelated
  // sine waves reads as irregular gusting rather than a mechanical single-
  // frequency wobble. Kept slow/gentle on purpose: it layers on top of the
  // movement bob (a separate, independently-timed effect) and shouldn't
  // read as the bob itself speeding up. Render-pose only, like the bob, so
  // it never accumulates.
  computeWindShake(dt: number, intensity: number): Vector3;
  // A slight widening of the field of view in rough weather — reads as the
  // camera bracing/being buffeted, the same instinct as flinching wider-
  // eyed in a gale — plus a quick, sharp kick synced to each lightning
  // flash (a thunder-jolt reflex), decaying back to the weather-driven
  // baseline rather than the fixed base FOV so it doesn't fight the
  // ambient widening.
  computeFov(dt: number, intensity: number, flash: number): number;
}

export function createCameraWeatherResponse(windShakeParams: WindShakeSettings): CameraWeatherResponse {
  let windShakeTime = 0;
  const windShakeOffset = new Vector3();
  let fovKick = 0;

  function computeWindShake(dt: number, intensity: number): Vector3 {
    windShakeOffset.set(0, 0, 0);
    if (!windShakeParams.enabled || intensity <= 0) return windShakeOffset;

    windShakeTime += dt;
    const amp = intensity * windShakeParams.amount;
    windShakeOffset.x = (Math.sin(windShakeTime * 1.7) + Math.sin(windShakeTime * 0.9) * 0.5) * amp * 0.5;
    windShakeOffset.y = (Math.sin(windShakeTime * 2.3) + Math.sin(windShakeTime * 1.1) * 0.5) * amp * 0.35;
    windShakeOffset.z = (Math.sin(windShakeTime * 1.3) + Math.sin(windShakeTime * 0.7) * 0.5) * amp * 0.5;
    return windShakeOffset;
  }

  function computeFov(dt: number, intensity: number, flash: number): number {
    const ambientWiden = intensity * 2.5;
    fovKick = Math.max(fovKick * Math.pow(0.001, dt), flash * 4);
    return BASE_FOV + ambientWiden + fovKick;
  }

  return { computeWindShake, computeFov };
}
