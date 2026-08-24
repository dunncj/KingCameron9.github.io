import { MathUtils, Vector3 } from 'three';
import type { Camera } from 'three';
import type { WindSettings } from '../settings/types';
import type { PostFxService } from '../postprocessing';
import type { Gust } from './gust';

// Directional streak blur along the wind's screen-projected direction —
// only kicks in once wind is genuinely strong (calm/breezy days stay
// crisp). Purely a function of wind + camera orientation, so it lives here
// rather than in the postprocessing service itself, which knows nothing
// about wind.
export interface WindBlurDriver {
  update(): void;
}

export function createWindBlurDriver(
  camera: Camera,
  gust: Gust,
  windParams: WindSettings,
  postFx: PostFxService,
): WindBlurDriver {
  const worldDir = new Vector3();
  const p1 = new Vector3();
  const p2 = new Vector3();

  function update() {
    const windRad = gust.direction * (Math.PI / 180);
    worldDir.set(Math.cos(windRad), 0, Math.sin(windRad));
    p1.copy(camera.position).project(camera);
    p2.copy(camera.position).addScaledVector(worldDir, 60).project(camera);

    let dx = p2.x - p1.x;
    let dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;

    // Only the sharpest gust peaks should trigger this at all — it reads as
    // generic blur, not "wind," if it's on any more often than that.
    const windAmount = MathUtils.clamp((gust.speed - 45) / 40, 0, 1);
    const strength = windAmount * windParams.streakBlur;
    // Most days never cross the gust threshold at all — the postprocessing
    // service itself skips the pass's draw entirely once strength is
    // negligible, rather than running it every frame to blend in zero.
    postFx.windBlur.set({ direction: [dx, dy], strength });
  }

  return { update };
}
