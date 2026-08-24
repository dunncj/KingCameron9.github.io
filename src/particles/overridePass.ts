// RenderPixelatedPass renders the scene a second time with a
// MeshNormalMaterial override (for its edge-detection buffer). That
// material expects real mesh normals/faces, which particle geometry
// doesn't have, so raw points/lines/instances get garbled during that pass
// and show up as artifacts punched through the weather. Skipping the draw
// during the override pass (detected via scene.overrideMaterial) fixes it —
// particles shouldn't contribute silhouette edges anyway.
import type { LineSegments, Points, InstancedMesh, Scene, WebGLRenderer } from 'three';

type DrawRangeObject = LineSegments | Points;

// getVisibleCount is a callback, not a fixed number — density now varies
// frame to frame with weather intensity, so this needs to read the
// *current* count each time it's invoked, not one captured at setup.
export function skipDuringOverridePass(object: DrawRangeObject, getVisibleCount: () => number): void {
  object.onBeforeRender = (_renderer: WebGLRenderer, scene: Scene) => {
    object.geometry.setDrawRange(0, scene.overrideMaterial ? 0 : getVisibleCount());
  };
}

// Same idea but for InstancedMesh, which has no drawRange — `count` (read
// at draw time, same as drawRange above) does the job.
export function skipInstancedDuringOverridePass(mesh: InstancedMesh, getInstanceCount: () => number): void {
  mesh.onBeforeRender = (_renderer: WebGLRenderer, scene: Scene) => {
    mesh.count = scene.overrideMaterial ? 0 : getInstanceCount();
  };
}
