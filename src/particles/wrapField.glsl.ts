// The core trick behind rain/snow's performance: instead of a CPU loop that
// advances every particle's position each frame and re-uploads the whole
// buffer to the GPU (`BufferAttribute.needsUpdate = true` on 10,000+
// vertices, every frame), each particle's position is computed *on the GPU*
// from a fixed-at-spawn random seed plus a single shared `time` uniform —
// so the only thing that changes per frame is a handful of uniforms, not a
// vertex buffer.
//
// wrapFieldPosition(seed, velocity) returns a position that appears to fall
// (or drift) forever: `seed * fieldSize + velocity * time` grows without
// bound, and `mod(..., fieldSize)` wraps it back into one tile-sized box
// centered on `origin` — so a particle exits the bottom of the field and
// reappears at the top on the very next frame, with no branching, no
// respawn logic, and no CPU involvement at all. As `origin` (the camera
// position) moves, the whole wrapped field rigidly follows it, which is
// exactly the "always surrounds the viewer" behavior the old CPU respawn-
// near-camera logic was aiming for.
//
// uYCenterOffset biases the vertical wrap band upward (particles spawn from
// above and fall through/below the camera, not centered on it) — the GLSL
// equivalent of the old code's asymmetric spawn-height/exit-height bounds.
export const WRAP_FIELD_GLSL = /* glsl */`
  uniform float uTime;
  uniform vec3 uOrigin;
  uniform vec3 uFieldSize;
  uniform float uYCenterOffset;

  vec3 wrapFieldPosition(vec3 seed, vec3 velocity) {
    vec3 unwrapped = seed * uFieldSize + velocity * uTime;
    vec3 center = uOrigin + vec3(0.0, uYCenterOffset, 0.0);
    vec3 relative = mod(unwrapped - center + uFieldSize * 0.5, uFieldSize) - uFieldSize * 0.5;
    return center + relative;
  }
`;

import { Vector3 } from 'three';

export interface WrapFieldUniforms {
  uTime: { value: number };
  uOrigin: { value: Vector3 };
  uFieldSize: { value: Vector3 };
  uYCenterOffset: { value: number };
}

export function createWrapFieldUniforms(fieldSize: Vector3, yCenterOffset: number): WrapFieldUniforms {
  return {
    uTime: { value: 0 },
    uOrigin: { value: new Vector3(0, 0, 0) },
    uFieldSize: { value: fieldSize },
    uYCenterOffset: { value: yCenterOffset },
  };
}
