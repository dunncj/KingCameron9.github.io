// Public API for the weather subsystem — everything outside this folder
// should import from here, not from individual modules, so the internal
// file layout can keep changing without touching call sites. Built on the
// particles service (rain/snow/wind streaks) and the postprocessing
// service (wind blur, lightning flash) — see service.ts's own comment for
// where the boundary sits with main.js's lighting/flight orchestration.
export { createWeatherSystem, type WeatherSystem, type WeatherSystemDeps, type CloudUpdateParams } from './service';
export type { Gust } from './gust';
export type { PresetTransition } from './presets';
