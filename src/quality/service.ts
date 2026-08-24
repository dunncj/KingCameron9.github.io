import type { WebGLRenderer } from 'three';
import type {
  CacheQualityName, PixelArtSettings, RenderQualitySettings, RenderSettings, StarSettings,
} from '../settings/types';
import type { PostFxService } from '../postprocessing';
import { resolveRenderQuality, renderQualityNames } from './quality';

export interface RenderQualitySystemDeps {
  renderer: WebGLRenderer;
  postFx: PostFxService;
  pixelArt: PixelArtSettings;
  stars: StarSettings;
  render: RenderSettings;
  // Re-derives everything downstream of devicePixelRatio (renderer size,
  // the composer, tile LOD resolution) — main.js already needs this exact
  // sequence for the window 'resize' listener; the quality system reuses
  // it instead of duplicating it, since a devicePixelRatio change is, as
  // far as the renderer's concerned, indistinguishable from a resize.
  onResize(): void;
}

export interface RenderQualitySystem {
  getQuality(): CacheQualityName;
  qualityOptions(): CacheQualityName[];
  setQuality(name: CacheQualityName): void;
  // Read each frame by main.js's tick() to feed clouds.update()/rain.snow/
  // windStreaks' params — see settings.toml's [render] comment for why
  // these three (and not pixelSize/devicePixelRatio) are pull-based:
  // they scale a value already being recomputed every frame anyway, so
  // there's no separate "apply" step to run on switch.
  cloudActiveFraction(): number;
  precipitationDensityScale(): number;
  windStreaksDensityScale(): number;
}

// The render-quality service: how much rendering cost the site is allowed
// to spend, as one low/medium/high/epic dial (the counterpart to the cache
// service's cache-quality dial — see src/cache/). Two kinds of knob:
// "static" ones (pixelation size, devicePixelRatio cap, star density/
// brightness) get pushed onto the renderer/postFx/settings objects once,
// right here, whenever quality changes; "pull" ones (cloud/particle
// density scales) just sit in settings.render for main.js's tick() to read
// fresh every frame — see cloudActiveFraction etc. above.
export function createRenderQualitySystem(deps: RenderQualitySystemDeps): RenderQualitySystem {
  const { renderer, postFx, pixelArt, stars, render, onResize } = deps;
  let current: RenderQualitySettings = resolveRenderQuality(render);

  function applyStatic(tier: RenderQualitySettings) {
    pixelArt.pixelSize = tier.pixelSize;
    postFx.pixelation.set({ pixelSize: tier.pixelSize });
    stars.density = tier.starDensity;
    stars.brightness = tier.starBrightness;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.devicePixelRatioCap));
    onResize();
  }

  function setQuality(name: CacheQualityName) {
    render.quality = name;
    current = resolveRenderQuality(render, name);
    applyStatic(current);
  }

  // On the shipped default (quality "high"), this is a harmless no-op
  // re-application of numbers already in effect — same reasoning as the
  // cache service's own construction-time setQuality() call.
  applyStatic(current);

  return {
    getQuality: () => render.quality,
    qualityOptions: () => renderQualityNames(render),
    setQuality,
    cloudActiveFraction: () => current.cloudActiveFraction,
    precipitationDensityScale: () => current.precipitationDensityScale,
    windStreaksDensityScale: () => current.windStreaksDensityScale,
  };
}
