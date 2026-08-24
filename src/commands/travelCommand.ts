import { splitRest, type ArgValue, type Command } from '../devconsole';

// Replaces the old separate "location" (instant only) and "traveler"
// (animated only) commands — both just resolved a slug and called one of
// two travel functions, so they were two thin, near-identical wrappers
// around the same lookup instead of one command with a mode. "go"/"goto"
// are accepted as synonyms since either reads naturally after "travel".
export interface TravelControl {
  slugs(): string[];
  matchLocation(slug: string): string | undefined;
  label(key: string): string;
  travelAnimated(key: string): void;
  teleportInstant(key: string): void;
}

const GO_ACTIONS = ['go', 'goto'];

export function buildTravelCommand(travel: TravelControl): Command {
  return {
    name: 'travel',
    description: 'go <slug> flies there with the climb/descend animation (goto is an alias); instant <slug> teleports with no animation; list shows available slugs',
    args: [{ type: 'rest', name: 'args' }],
    run: ([argString]: ArgValue[]) => {
      const parts = splitRest(argString as string | undefined);
      const action = (parts[0] || '').toLowerCase();

      if (action === 'list') return travel.slugs().join(', ');

      if (GO_ACTIONS.includes(action) || action === 'instant') {
        const slug = parts[1];
        const match = travel.matchLocation(slug || '');
        if (!match) throw new Error(`unknown location "${slug || ''}" — try: ${travel.slugs().join(', ')}`);
        if (action === 'instant') {
          travel.teleportInstant(match);
          return `location = ${travel.label(match)} (instant)`;
        }
        travel.travelAnimated(match);
        return `traveling to ${travel.label(match)}`;
      }

      throw new Error(`<action> should be one of: go, instant, list — got "${parts[0] || ''}"`);
    },
  };
}
