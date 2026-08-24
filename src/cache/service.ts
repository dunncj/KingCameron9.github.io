import type { CacheQualityName, CacheSettings, PreloadSettings, PrefetchSettings } from '../settings/types';
import { createPreloadScheduler, type PreloadScheduler } from './scheduler';
import { applyCacheQuality, qualityNames, resolveQuality, tilesCacheConfig } from './quality';

// The minimal shape this service actually touches on the TilesRenderer
// instance (tiles.js is plain JS, so there's no richer type to import) —
// the 3D-tiles LRU geometry/texture cache and the screen-space-error
// target that decides how aggressively it resolves detail.
export interface TilesCacheTarget {
  errorTarget: number;
  lruCache: { maxBytesSize: number; maxSize: number };
}

export interface CacheSystem extends PreloadScheduler {
  getQuality(): CacheQualityName;
  qualityOptions(): CacheQualityName[];
  setQuality(name: CacheQualityName): void;
}

// The cache/preload service: one named "quality" (low/medium/high/epic —
// see settings.toml's [cache.qualities.*]) governs how aggressively the
// site warms the 3D-tiles cache ahead of a visit — the preload scheduler's
// timing (scheduler.ts), the heavy/hover/destination-grid prefetch knobs
// (settings.prefetch.*, read directly by main.js's prefetchLocationHeavy
// and usMap.js's own prefetch code), and the 3D-tiles LRU cache itself
// (tiles.lruCache/errorTarget, otherwise hardcoded in tiles.js). Switching
// quality re-applies all of it at once, the same way a weather preset
// re-applies a whole bundle of params in one call.
export function createCacheSystem(
  tiles: TilesCacheTarget,
  prefetch: PrefetchSettings,
  preload: PreloadSettings,
  cacheSettings: CacheSettings,
): CacheSystem {
  const scheduler = createPreloadScheduler(preload);

  function applyTilesCacheConfig(name: CacheQualityName) {
    const { maxSizeMB, maxItems, errorTarget } = tilesCacheConfig(resolveQuality(cacheSettings, name));
    tiles.lruCache.maxBytesSize = maxSizeMB * 1024 * 1024;
    tiles.lruCache.maxSize = maxItems;
    tiles.errorTarget = errorTarget;
  }

  function setQuality(name: CacheQualityName) {
    cacheSettings.quality = name;
    applyCacheQuality(prefetch, preload, resolveQuality(cacheSettings, name));
    applyTilesCacheConfig(name);
  }

  // On the shipped default (quality "high"), [prefetch.*]/[preload] in
  // settings.toml already *are* the high tier's numbers — applying it here
  // too is a harmless no-op re-assignment, not a behavior change, and keeps
  // a non-default `quality` (hand-edited into settings.toml, or left over
  // from wherever this is constructed) correctly in effect from the very
  // first frame rather than only after an explicit setQuality() call.
  setQuality(cacheSettings.quality);

  return {
    ...scheduler,
    getQuality: () => cacheSettings.quality,
    qualityOptions: () => qualityNames(cacheSettings),
    setQuality,
  };
}
