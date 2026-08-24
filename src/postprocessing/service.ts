import type { Camera, Scene, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createPixelationPass, type PixelationPass } from './passes/pixelation';
import { createGodRaysPass, type GodRaysPass } from './passes/godRays';
import { createBloomPass, type BloomPass } from './passes/bloom';
import { createWeatherGradePass, type WeatherGradePass } from './passes/weatherGrade';
import { createWindBlurPass, type WindBlurPass } from './passes/windBlur';
import { createZoomBlurPass, type ZoomBlurPass } from './passes/zoomBlur';

export interface PostFxService {
  composer: EffectComposer;
  pixelation: PixelationPass;
  godRays: GodRaysPass;
  bloom: BloomPass;
  weatherGrade: WeatherGradePass;
  windBlur: WindBlurPass;
  zoomBlur: ZoomBlurPass;
  // Tone-mapping exposure lives on the renderer, not a pass — but it's a
  // final-image grading knob same as everything else here, and this
  // service already owns the renderer reference for render()/resize(), so
  // callers (weather, the dev GUI) get one consistent surface instead of
  // reaching past the service to poke the renderer directly.
  setExposure(exposure: number): void;
  resize(width: number, height: number): void;
  render(): void;
}

// The postprocessing service: owns the full screen-space effect pipeline
// weather/location/flight code drives to sell rain haze, sunbeams, wind
// gusts, camera-shake blur, storm grading, and the retro-pixelated look —
// in that sense the screen-space counterpart to src/particles/ (rain/snow/
// wind are *in* the scene; these passes are full-frame effects layered on
// top of whatever the scene rendered). Every pass is itself built from a
// managed ShaderMaterial via the shader service (see src/shaders/), so
// this module owns pipeline order/wiring, not shader plumbing.
export function createPostFxService(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  pixelSize = 3,
): PostFxService {
  const composer = new EffectComposer(renderer);

  const pixelation = createPixelationPass(scene, camera, pixelSize);
  composer.addPass(pixelation.pass);

  const godRays = createGodRaysPass();
  composer.addPass(godRays.pass);

  const bloom = createBloomPass();
  bloom.set({ resolution: [window.innerWidth, window.innerHeight] });
  composer.addPass(bloom.pass);

  const weatherGrade = createWeatherGradePass();
  composer.addPass(weatherGrade.pass);

  const windBlur = createWindBlurPass();
  composer.addPass(windBlur.pass);

  const zoomBlur = createZoomBlurPass();
  composer.addPass(zoomBlur.pass);

  composer.addPass(new OutputPass());

  return {
    composer,
    pixelation,
    godRays,
    bloom,
    weatherGrade,
    windBlur,
    zoomBlur,
    setExposure(exposure) {
      renderer.toneMappingExposure = exposure;
    },
    resize(width, height) {
      composer.setSize(width, height);
      // Bloom's blur kernel is expressed in pixels (`radius / resolution`
      // in its shader) — it needs the current canvas size to keep that
      // radius reading as a consistent screen-space blur amount rather
      // than silently changing scale whenever the window resizes.
      bloom.set({ resolution: [width, height] });
    },
    render() {
      composer.render();
    },
  };
}
