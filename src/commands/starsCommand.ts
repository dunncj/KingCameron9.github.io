import { parseNumber, type ArgValue, type Command } from '../devconsole';

export interface StarsControl {
  setDensity(v: number): void;
  setBrightness(v: number): void;
}

export function buildStarsCommand(stars: StarsControl): Command {
  return {
    name: 'stars',
    description: 'density <0-1> or brightness <0-2>',
    args: [
      { type: 'enum', name: 'action', values: ['density', 'brightness'] },
      { type: 'rest', name: 'value' },
    ],
    run: ([action, value]: ArgValue[]) => {
      if (action === 'density') {
        const v = parseNumber(value as string | undefined, 'density', 0, 1);
        stars.setDensity(v);
        return `stars density = ${v}`;
      }
      const v = parseNumber(value as string | undefined, 'brightness', 0, 6);
      stars.setBrightness(v);
      return `stars brightness = ${v}`;
    },
  };
}
