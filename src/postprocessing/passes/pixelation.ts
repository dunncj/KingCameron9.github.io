import type { Camera, Scene } from 'three';
import { RenderPixelatedPass } from 'three/addons/postprocessing/RenderPixelatedPass.js';

// Not a custom shader like the other passes — RenderPixelatedPass is a
// three.js addon that renders the scene directly at a fraction of the
// resolution, so this wrapper is just a thin `set()` over its own
// pixelSize/edge-strength API for a consistent shape with every other pass
// in the composer.
export interface PixelationParams {
  pixelSize: number;
  normalEdgeStrength: number;
  depthEdgeStrength: number;
}

export interface PixelationPass {
  pass: RenderPixelatedPass;
  set(params: Partial<PixelationParams>): void;
}

export function createPixelationPass(scene: Scene, camera: Camera, pixelSize = 3): PixelationPass {
  const pass = new RenderPixelatedPass(pixelSize, scene, camera);

  function set(params: Partial<PixelationParams>) {
    if (params.pixelSize !== undefined) pass.setPixelSize(params.pixelSize);
    if (params.normalEdgeStrength !== undefined) pass.normalEdgeStrength = params.normalEdgeStrength;
    if (params.depthEdgeStrength !== undefined) pass.depthEdgeStrength = params.depthEdgeStrength;
  }

  return { pass, set };
}
