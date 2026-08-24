import { splitRest, type ArgValue, type Command } from '../devconsole';

// The unified quality dial — sets both render quality (src/quality/) and
// cache quality (src/cache/) together, since they share the same
// low/medium/high/epic tiers and asking for "epic" means everything, not
// just one half of it. Each half stays independently reachable too — the
// dev GUI's own dropdowns, and the ":cache quality <name>" console command
// — for anyone who wants to decouple them (e.g. a fast connection but a
// weak GPU).
export interface QualityControl {
  getQuality(): string;
  qualityOptions(): string[];
  setQuality(name: string): void;
}

export function buildQualityCommand(quality: QualityControl): Command {
  return {
    name: 'quality',
    description: '[<low|medium|high|epic>] — show or set overall render + cache quality',
    args: [{ type: 'rest', name: 'args', optional: true }],
    run: ([argString]: ArgValue[]) => {
      const requested = splitRest(argString as string | undefined)[0];
      if (!requested) {
        return `quality = ${quality.getQuality()} (options: ${quality.qualityOptions().join(', ')})`;
      }
      const options = quality.qualityOptions();
      const match = options.find((name) => name.toLowerCase() === requested.toLowerCase());
      if (!match) {
        throw new Error(`unknown quality "${requested}" — try: ${options.join(', ')}`);
      }
      quality.setQuality(match);
      return `quality = ${match}`;
    },
  };
}
