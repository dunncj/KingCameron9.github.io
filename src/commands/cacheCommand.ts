import { splitRest, type ArgValue, type Command } from '../devconsole';

// What "cache" needs from main.js's cache system (see src/cache/) —
// current/available quality tiers and the switch itself. Deliberately just
// this one dial: every individual knob a tier bundles (preload timing,
// prefetch resolution, the 3D-tiles LRU size) is already reachable through
// the generic "settings set cache.qualities.<tier>.<field> <value>"
// path if someone wants to hand-tune one, same as any other setting.
export interface CacheControl {
  getQuality(): string;
  qualityOptions(): string[];
  setQuality(name: string): void;
}

export function buildCacheCommand(cache: CacheControl): Command {
  return {
    name: 'cache',
    description: 'quality [<low|medium|high|epic>] — show or set how aggressively tiles/preloading cache',
    args: [{ type: 'rest', name: 'args', optional: true }],
    run: ([argString]: ArgValue[]) => {
      const parts = splitRest(argString as string | undefined);
      const action = (parts[0] || '').toLowerCase();

      if (action !== 'quality') {
        throw new Error(`<action> should be "quality" — got "${parts[0] || ''}"`);
      }

      const requested = parts[1];
      if (!requested) {
        return `cache quality = ${cache.getQuality()} (options: ${cache.qualityOptions().join(', ')})`;
      }
      const options = cache.qualityOptions();
      const match = options.find((name) => name.toLowerCase() === requested.toLowerCase());
      if (!match) {
        throw new Error(`unknown cache quality "${requested}" — try: ${options.join(', ')}`);
      }
      cache.setQuality(match);
      return `cache quality = ${match}`;
    },
  };
}
