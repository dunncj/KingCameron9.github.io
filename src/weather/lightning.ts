import type { PointLight, Vector3 } from 'three';
import type { StormSettings } from '../settings/types';
import type { PostFxService } from '../postprocessing';

// `flash` is normalized 0..1 and drives the actual visible effects (a real
// screen-wide brightening plus a bloom bump, via the postprocessing
// service's weatherGrade pass); the PointLight alone is nearly invisible
// since it sits at a fixed-ish world position that's rarely anywhere near
// the camera/visible geometry, so it's just a minor local accent that
// follows the camera instead of the main effect.
interface PendingFlash {
  time: number;
  peak: number;
}

export interface LightningSimulator {
  update(dt: number, cameraPosition: Vector3): void;
  getFlash(): number;
}

export function createLightningSimulator(
  stormParams: StormSettings,
  lightningLight: PointLight,
  postFx: PostFxService,
): LightningSimulator {
  let lightningTimer = 3 + Math.random() * 4;
  let flash = 0;
  // A real strike is a stutter of 2-4 quick flickers (the main stroke plus a
  // couple of dimmer restrikes a beat later), not one smooth fade —
  // scheduling a short burst of pending flash-bumps sells that far better
  // than a single decay ever could.
  let pendingFlashes: PendingFlash[] = [];

  function update(dt: number, cameraPosition: Vector3) {
    if (stormParams.enabled) {
      lightningTimer -= dt;
      if (lightningTimer <= 0) {
        const strikeCount = 2 + Math.floor(Math.random() * 3);
        pendingFlashes = [];
        let t = 0;
        for (let i = 0; i < strikeCount; i++) {
          t += 0.03 + Math.random() * 0.12;
          pendingFlashes.push({ time: t, peak: i === 0 ? 1 : 0.4 + Math.random() * 0.5 });
        }
        lightningTimer = 4 + Math.random() * 8;
      }
    }

    for (let i = pendingFlashes.length - 1; i >= 0; i--) {
      const pending = pendingFlashes[i];
      if (!pending) continue;
      pending.time -= dt;
      if (pending.time <= 0) {
        flash = Math.max(flash, pending.peak);
        pendingFlashes.splice(i, 1);
      }
    }

    flash *= Math.pow(0.0005, dt);
    lightningLight.position.set(cameraPosition.x, cameraPosition.y + 500, cameraPosition.z - 200);
    lightningLight.intensity = flash * 20;
    postFx.weatherGrade.set({ flash: flash * 0.6 });
  }

  return { update, getFlash: () => flash };
}
