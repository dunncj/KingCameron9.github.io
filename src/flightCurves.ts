// Per-movement curve settings for the overview's flyTo (entering local
// view) / flyOut (leaving it) — see usMap.js. Four movements, each
// independently configurable: which named curve shapes it (curveRegistrar,
// see curves.ts) and how fast it travels through that curve (withSpeed).
// Defaults live in settings.toml now (see [transitions.movements.*]) —
// this module just points at that branch of the central store instead of
// declaring its own.
import { curveRegistrar, withSpeed, type Curve } from './curves';
import { settings } from './settings/store';
import type { MovementCurveSettings } from './settings/types';

export type MovementName = 'panIn' | 'zoomIn' | 'zoomOut' | 'panOut';

export type MovementSetting = MovementCurveSettings;

// `movementParams.panIn` *is* `settings.transitions.movements.panIn` — same
// object reference, not a copy — so the dev-GUI (bound to movementParams,
// see main.js) and the ":settings set transitions.movements.panIn.speed 2"
// console command both end up changing the exact same field.
export const movementParams: Record<MovementName, MovementSetting> = settings.transitions.movements;

// Resolves one movement's current settings into a single callable Curve —
// call this once per flight (not per frame; see flyTo/flyOut in usMap.js)
// and reuse the result for that flight's whole rAF loop, the same way
// flyInParams' own fields are snapshotted once at flight-start rather than
// re-read live (mid-flight retuning shouldn't change what a flight already
// in progress is easing toward).
export function getMovementCurve(movement: MovementName): Curve {
  const setting = movementParams[movement];
  const shape = curveRegistrar.create(setting.curve, { sharpness: setting.sharpness });
  return withSpeed(shape, setting.speed);
}

// { <curve's display label>: <curve's registry name> } — the shape lil-gui
// wants for a dropdown (see main.js). Built fresh from whatever's
// registered, so a curve added later in curves.ts shows up automatically
// without this file needing to know its name.
export function curveOptions(): Record<string, string> {
  const options: Record<string, string> = {};
  for (const descriptor of curveRegistrar.list()) {
    options[descriptor.label] = descriptor.name;
  }
  return options;
}
