// The single centralized settings store — every params object the app used
// to declare separately (sky, weather, clouds, post-fx, camera, transition
// curves, prefetch, preload, locations, weather presets/graphs) now lives
// as one branch of this tree, seeded from settings.toml at the repo root.
// A closure-based module, not a class: the tree and the functions that
// operate on it are just values, built once when this module first loads.
import defaultsText from '../../settings.toml?raw';
import { parseToml, toToml } from './toml';
import {
  getPath, setPath, hasPath, listLeafPaths, listChildren, type PlainRecord,
} from './paths';
import type { Settings } from './types';

const REQUIRED_TOP_LEVEL: (keyof Settings)[] = [
  'sky', 'stars', 'clouds', 'rain', 'snow', 'wind', 'storm', 'postfx', 'pixelArt',
  'camera', 'transitions', 'prefetch', 'preload', 'cache', 'render', 'locations', 'presets', 'weatherGraphs',
];

function loadDefaults(): Settings {
  const parsed = parseToml(defaultsText);
  const missing = REQUIRED_TOP_LEVEL.filter((key) => !(key in parsed));
  if (missing.length > 0) {
    throw new Error(`settings.toml is missing top-level table(s): ${missing.join(', ')}`);
  }
  return parsed as unknown as Settings;
}

// Parsed once, then structuredClone'd apart from `settings` below — frozen
// in spirit (never mutated) even though nothing enforces that at the type
// level, since it's only ever read by resetSetting/exportSettings.
const defaults: Settings = loadDefaults();

// The live, mutable tree every domain in the app reads and writes through —
// e.g. main.js's `skyParams` is just `settings.sky`, not a copy, so a GUI
// slider bound to skyParams.hour and a `settings set sky.hour 18` command
// both end up changing the exact same field.
export const settings: Settings = structuredClone(defaults);

export function getSetting(path: string): unknown {
  return getPath(settings as unknown as PlainRecord, path);
}

// Coerces `raw` (always a string — this is meant for the console command,
// see commands.ts) to match the existing leaf's type before assigning, so
// "settings set wind.speed 12" doesn't quietly turn a number into the
// string "12". Throws a clear error on a type mismatch or an unknown path,
// same philosophy as devconsole's own parseNumber.
export function setSetting(path: string, raw: string): unknown {
  const current = getPath(settings as unknown as PlainRecord, path);
  let value: unknown;
  if (typeof current === 'number') {
    value = Number(raw);
    if (Number.isNaN(value)) throw new Error(`"${path}" is a number — got "${raw}"`);
  } else if (typeof current === 'boolean') {
    if (raw !== 'true' && raw !== 'false') throw new Error(`"${path}" is a boolean — got "${raw}" (use true/false)`);
    value = raw === 'true';
  } else {
    value = raw; // string leaf (curve names, cloud formation, labels, slugs, ...)
  }
  setPath(settings as unknown as PlainRecord, path, value);
  return value;
}

// Resets one path back to its settings.toml value, or the *entire* tree
// when called with no path. Resetting a whole settings group (e.g.
// "clouds", not "clouds.coverage") restores every field under it.
export function resetSetting(path?: string): void {
  if (!path) {
    Object.assign(settings, structuredClone(defaults));
    return;
  }
  const defaultValue = getPath(defaults as unknown as PlainRecord, path);
  setPath(settings as unknown as PlainRecord, path, structuredClone(defaultValue));
}

export function hasSettingPath(path: string): boolean {
  return hasPath(settings as unknown as PlainRecord, path);
}

export function listSettingPaths(prefix?: string): [string, unknown][] {
  return listLeafPaths(settings as unknown as PlainRecord, prefix);
}

export function listSettingChildren(prefix?: string): string[] {
  return listChildren(settings as unknown as PlainRecord, prefix);
}

// The live tree, serialized back to TOML — good enough to paste straight
// back into settings.toml to make a tweaked-at-runtime value the new
// default (see commands.ts' "settings export"), which is the whole reason
// this lives in TOML instead of hardcoded JS in the first place.
export function exportSettingsToml(): string {
  return toToml(settings as unknown as PlainRecord);
}

export function exportSettingsJson(): string {
  return JSON.stringify(settings, null, 2);
}
