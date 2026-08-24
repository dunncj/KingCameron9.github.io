import {
  parseNumber, splitRest, type ArgValue, type Command,
} from '../devconsole';

// What "weather" needs from main.js — preset lookup/apply, the auto-roll
// timer's ephemeral state, graph inspection, and the cloud-shape knobs.
// graphInfo() stays a single pre-formatted string rather than raw graph
// data: the weighted-percentage formatting is domain logic that already
// lives next to WEATHER_GRAPHS/PRESETS in main.js, not something this
// command should re-derive.
export interface WeatherControl {
  matchPreset(name: string): string | undefined;
  presetLabel(key: string): string;
  presetLabels(): string[];
  applyPreset(name: string): void;
  currentPresetLabel(): string;
  setChangeIntervalHours(hours: number): void;
  freezeAuto(): void;
  runAuto(): void;
  graphInfo(): string;
  cloudFormations(): readonly string[];
  setCloudCoverage(v: number): void;
  setCloudDensity(v: number): void;
  setCloudLevels(v: number): void;
  setCloudFormation(v: string): void;
}

const CLOUD_SETTINGS = ['coverage', 'density', 'levels', 'formation'];

export function buildWeatherCommand(weather: WeatherControl): Command {
  return {
    name: 'weather',
    description: 'set <preset>, speed <hours>, freeze, run, graph, or clouds <setting> <value> (coverage/density/levels/formation)',
    // Deliberately not the enum/number schema "time" uses — "set" takes a
    // free-form, multi-word preset name ("Heavy Snow") and "clouds" takes
    // its own nested action+value, neither of which fits a flat schema —
    // this command parses and validates its own sub-arguments instead.
    args: [{ type: 'rest', name: 'args' }],
    run: ([argString]: ArgValue[]) => {
      const parts = splitRest(argString as string | undefined);
      const action = (parts[0] || '').toLowerCase();

      if (action === 'set') {
        const name = parts.slice(1).join(' ');
        const match = weather.matchPreset(name);
        if (!match) {
          throw new Error(`unknown preset "${name}" — try: ${weather.presetLabels().join(', ')}`);
        }
        weather.applyPreset(match);
        return `weather = ${weather.presetLabel(match)}`;
      }
      if (action === 'speed') {
        const hours = parseNumber(parts[1], 'hours', 0.1, 100);
        weather.setChangeIntervalHours(hours);
        return `weather changes roughly every ${hours} sim hours`;
      }
      if (action === 'freeze') {
        weather.freezeAuto();
        return `weather = frozen on ${weather.currentPresetLabel()}`;
      }
      if (action === 'run') {
        weather.runAuto();
        return 'weather = auto-changing again';
      }
      if (action === 'graph') {
        return weather.graphInfo();
      }
      if (action === 'clouds') {
        const setting = parts[1];
        const value = parts[2];
        if (setting === 'coverage') {
          const v = parseNumber(value, 'coverage', 0, 1);
          weather.setCloudCoverage(v);
          return `clouds coverage = ${v}`;
        }
        if (setting === 'density') {
          const v = parseNumber(value, 'density', 0, 1);
          weather.setCloudDensity(v);
          return `clouds density = ${v}`;
        }
        if (setting === 'levels') {
          const v = Math.round(parseNumber(value, 'levels', 1, 3));
          weather.setCloudLevels(v);
          return `clouds levels = ${v}`;
        }
        if (setting === 'formation') {
          if (!value || !weather.cloudFormations().includes(value)) {
            throw new Error(`formation should be one of: ${weather.cloudFormations().join(', ')} — got "${value || ''}"`);
          }
          weather.setCloudFormation(value);
          return `clouds formation = ${value}`;
        }
        throw new Error(`unknown "clouds" setting "${setting || ''}" — try: ${CLOUD_SETTINGS.join(', ')}`);
      }
      throw new Error(`<action> should be one of: set, speed, freeze, run, graph, clouds — got "${parts[0] || ''}"`);
    },
  };
}
