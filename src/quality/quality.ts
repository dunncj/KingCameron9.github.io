import type { CacheQualityName, RenderQualitySettings, RenderSettings } from '../settings/types';

export function resolveRenderQuality(
  render: RenderSettings,
  name: CacheQualityName = render.quality,
): RenderQualitySettings {
  const tier = render.qualities[name];
  if (!tier) throw new Error(`unknown render quality "${name}" — no [render.qualities.${name}] table`);
  return tier;
}

export function renderQualityNames(render: RenderSettings): CacheQualityName[] {
  return Object.keys(render.qualities) as CacheQualityName[];
}
