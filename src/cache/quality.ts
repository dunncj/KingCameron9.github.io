import type {
  CacheQualityName, CacheQualitySettings, CacheSettings, PreloadSettings, PrefetchSettings,
} from '../settings/types';

// The 3D-tiles LRU cache (tiles.lruCache.maxBytesSize/maxSize, tiles.
// errorTarget — see tiles.js's buildTiles) isn't part of the settings tree
// at all; it lives directly on the TilesRenderer instance, which only
// exists once main.js constructs it. A quality tier still needs to carry
// those numbers (they're as central to "cache quality" as anything else
// here), so this module separates "what a tier says" (pure data,
// CacheQualitySettings) from "where each piece goes" — applyCacheQuality
// writes the settings-tree portion; the tiles-cache portion is applied
// directly to the `tiles` object by the caller (see service.ts).
export interface TilesCacheConfig {
  maxSizeMB: number;
  maxItems: number;
  errorTarget: number;
}

export function resolveQuality(cache: CacheSettings, name: CacheQualityName = cache.quality): CacheQualitySettings {
  const tier = cache.qualities[name];
  if (!tier) throw new Error(`unknown cache quality "${name}" — no [cache.qualities.${name}] table`);
  return tier;
}

export function qualityNames(cache: CacheSettings): CacheQualityName[] {
  return Object.keys(cache.qualities) as CacheQualityName[];
}

// Writes a tier's numbers onto the live prefetch/preload settings objects
// in place (same object references — every existing GUI slider and console
// command bound to settings.prefetch.*/settings.preload keeps working
// unchanged; see main.js and usMap.js) rather than replacing them, mirroring
// how a weather preset re-applies onto settings.clouds/settings.wind/etc.
export function applyCacheQuality(prefetch: PrefetchSettings, preload: PreloadSettings, tier: CacheQualitySettings): void {
  preload.clickBackoffMs = tier.clickBackoffMs;
  preload.idleDelayMs = tier.idleDelayMs;
  preload.idleIntervalMs = tier.idleIntervalMs;
  preload.maxConcurrentHeavy = tier.maxConcurrentHeavy;
  preload.heavyCooldownMs = tier.heavyCooldownMs;

  prefetch.heavy.resolutionScale = tier.heavyResolutionScale;
  prefetch.heavy.wideResW = tier.heavyWideResW;
  prefetch.heavy.wideResH = tier.heavyWideResH;
  prefetch.heavy.durationMs = tier.heavyDurationMs;
  prefetch.heavy.staggerMs = tier.heavyStaggerMs;

  prefetch.hover.radiusPx = tier.hoverRadiusPx;
  prefetch.hover.debounceMs = tier.hoverDebounceMs;

  prefetch.dest.highRes.radius = tier.destHighRes.radius;
  prefetch.dest.highRes.zoomDrop = tier.destHighRes.zoomDrop;
  prefetch.dest.medRes.radius = tier.destMedRes.radius;
  prefetch.dest.medRes.zoomDrop = tier.destMedRes.zoomDrop;
  prefetch.dest.lowRes.radius = tier.destLowRes.radius;
  prefetch.dest.lowRes.zoomDrop = tier.destLowRes.zoomDrop;
  prefetch.dest.veryLowRes.radius = tier.destVeryLowRes.radius;
  prefetch.dest.veryLowRes.zoomDrop = tier.destVeryLowRes.zoomDrop;
  prefetch.dest.edgeFadeStrength = tier.destEdgeFadeStrength;
  prefetch.dest.fetchBatchSize = tier.destFetchBatchSize;
  prefetch.dest.buildBatchSize = tier.destBuildBatchSize;
}

export function tilesCacheConfig(tier: CacheQualitySettings): TilesCacheConfig {
  return { maxSizeMB: tier.tilesMaxSizeMB, maxItems: tier.tilesMaxItems, errorTarget: tier.tilesErrorTarget };
}
