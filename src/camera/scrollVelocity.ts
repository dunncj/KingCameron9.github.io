// A shared "flick and glide" primitive for wheel-driven camera motion: raw
// wheel events are bursty and vary wildly in deltaY per tick/device, so
// applying them 1:1 to zoom/distance every event reads as a stepped snap
// rather than a scroll. Instead, each event nudges a velocity value, and
// that velocity is what actually gets applied per frame, decaying
// exponentially toward zero — one wheel flick keeps gliding for a beat
// instead of stopping the instant the wheel does. Used by both the globe
// overview's zoom (see usMap.js) and the local view's dolly-zoom (see
// localCameraControl.ts) so the momentum feel — and the tuning — is one
// implementation, not two copies with slightly different math.
export interface ScrollVelocityParams {
  // How much one wheel event's deltaY contributes to velocity. Bigger =
  // snappier response to a single flick.
  sensitivity: number;
  // Per-second exponential decay rate — how fast velocity bleeds off once
  // the wheel stops. Bigger = stops sooner.
  damping: number;
  // Hard clamp on |velocity|, so one unusually large deltaY (a fast
  // trackpad fling, a laptop's non-standard wheel scaling) can't send the
  // camera flying past every intermediate frame in one jump.
  maxSpeed: number;
}

export interface ScrollVelocity {
  // Feed a raw wheel event's deltaY in here — does not apply anything
  // itself, just accumulates.
  addImpulse(deltaY: number): void;
  // Call once per frame. Returns the delta to apply *this frame* (already
  // dt-scaled) and decays the underlying velocity for next time.
  update(dt: number): number;
  reset(): void;
}

// Below this, decayed velocity is indistinguishable from zero but would
// otherwise coast forever in floating point — snap it off instead of
// leaving a frame's worth of imperceptible, pointless work every tick.
const REST_EPSILON = 1e-4;

export function createScrollVelocity(params: ScrollVelocityParams): ScrollVelocity {
  let velocity = 0;

  return {
    addImpulse(deltaY: number): void {
      const next = velocity + deltaY * params.sensitivity;
      velocity = Math.min(params.maxSpeed, Math.max(-params.maxSpeed, next));
    },
    update(dt: number): number {
      const applied = velocity * dt;
      velocity *= Math.exp(-params.damping * dt);
      if (Math.abs(velocity) < REST_EPSILON) velocity = 0;
      return applied;
    },
    reset(): void {
      velocity = 0;
    },
  };
}
