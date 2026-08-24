import { MathUtils, type Fog } from 'three';
import type {
  CloudSettings, WindSettings, StormSettings, PostFxSettings, PresetSettings, WeatherGraph,
} from '../settings/types';
import type { RainField, SnowField } from '../particles';

export interface PresetTransition {
  t: number;
  from: {
    coverage: number; density: number; fogNear: number; fogFar: number; windSpeed: number;
    bloomStrength: number; godRayStrength: number; rainIntensity: number; snowIntensity: number;
  };
  to: PresetTransition['from'];
  targetRainEnabled: boolean;
  targetSnowEnabled: boolean;
}

// Weather presets cross-fade rather than snap: capture where every affected
// param currently sits, where the new preset wants it, and ease between the
// two over a few seconds each frame. Rain/snow specifically fade via
// `intensity` (particles/intensity.ts scales opacity by it below 1), and
// get switched on immediately / off only once the fade-out finishes, so the
// particles are actually visible while fading rather than popping in/out at
// full or zero opacity.
// Matches clouds.js's SPAWN_GROW_SECONDS — every part of a weather change
// (fog/wind/bloom/rain/snow crossfade here, cloud cluster grow-in/shrink-out
// there) targets the same 10 seconds so a weather cycle reads as one
// unified transition instead of some parts finishing well before others.
const PRESET_TRANSITION_DURATION = 10;

export interface PresetSystemDeps {
  cloudParams: CloudSettings;
  windParams: WindSettings;
  stormParams: StormSettings;
  fxParams: PostFxSettings;
  fog: Fog;
  rain: RainField;
  snow: SnowField;
  presets: Record<string, PresetSettings>;
  weatherGraphs: Record<string, WeatherGraph>;
  cloudFormations: readonly string[];
  // GUI-refresh / player-panel side effects live outside the weather
  // subsystem's own concerns — the caller supplies this hook instead.
  onPresetApplied?: (preset: PresetSettings) => void;
}

export interface PresetSystem {
  presetOptions(): Record<string, string>;
  matchPresetName(raw: string): string | undefined;
  presetLabel(key: string): string;
  presetLabels(): string[];
  getCurrentPresetName(): string;
  tempDeltaF(): number;
  cloudFormations(): readonly string[];
  setCloudCoverage(v: number): void;
  setCloudDensity(v: number): void;
  setCloudLevels(v: number): void;
  setCloudFormation(v: string): void;
  applyPreset(name: string): void;
  updatePresetTransition(dt: number): void;
  pickNextPreset(locationKey: string): string;
  pickLiveWeather(locationKey: string): string;
  graphSummary(locationKey: string, locationLabel: string): string;
  tickAutoRoll(simHoursDelta: number): boolean;
  resetAutoRollTimer(): void;
  setChangeIntervalHours(hours: number): void;
  freezeAuto(): void;
  runAuto(): void;
}

export function createPresetSystem(deps: PresetSystemDeps): PresetSystem {
  const {
    cloudParams, windParams, stormParams, fxParams, fog, rain, snow, presets, weatherGraphs,
    cloudFormations, onPresetApplied,
  } = deps;

  let currentPresetName = 'clear';
  let presetTransition: PresetTransition | null = null;
  // The very first call (module init, always 'clear') has nothing real to
  // cross-fade *from* — "from" would just be particles/scene.js's raw
  // constructor defaults, which were never actually shown on screen. Cross-
  // fading from them anyway is exactly why rain (and to a lesser extent,
  // clouds) could briefly appear on load before settling to Clear: the
  // system was fading out a "rain" that only existed as an uninitialized
  // default, never as something actually rendered.
  let hasAppliedFirstPreset = false;

  // Sim hours between automatic weather rolls, not real seconds — ties how
  // often weather changes to the world's own clock (including night running
  // faster) instead of a real-world timer that kept rolling regardless of
  // how fast or slow time was actually passing.
  let weatherChangeIntervalHours = 10;
  let autoWeatherFrozen = false;
  let autoWeatherTimer = weatherChangeIntervalHours;
  // A little randomness so rolls don't happen on an eerily exact metronome.
  function nextWeatherInterval() {
    return weatherChangeIntervalHours * (0.8 + Math.random() * 0.4);
  }

  // { <preset's display label>: <preset's settings key> } — the shape
  // lil-gui wants for a dropdown, same pattern as flightCurves.ts's
  // curveOptions.
  function presetOptions(): Record<string, string> {
    const options: Record<string, string> = {};
    for (const [key, preset] of Object.entries(presets)) options[preset.label] = key;
    return options;
  }

  // Resolves free-form console input (either a preset's key or its display
  // label, case-insensitively — "Partly Cloudy" and "partlyCloudy" both
  // work) to its settings key, or undefined if nothing matches.
  function matchPresetName(raw: string): string | undefined {
    const needle = raw.toLowerCase();
    const found = Object.entries(presets).find(
      ([key, preset]) => key.toLowerCase() === needle || preset.label.toLowerCase() === needle,
    );
    return found?.[0];
  }

  function applyPreset(name: string) {
    const p = presets[name];
    if (!p) throw new Error(`unknown weather preset "${name}"`);
    currentPresetName = name;
    const targetRainEnabled = p.rain;
    const targetSnowEnabled = p.snow;

    if (!hasAppliedFirstPreset) {
      hasAppliedFirstPreset = true;
      cloudParams.coverage = p.coverage;
      cloudParams.density = p.density;
      fog.near = p.fogNear;
      fog.far = p.fogFar;
      windParams.speed = p.wind;
      fxParams.bloomStrength = p.bloom;
      fxParams.godRayStrength = p.godray;
      rain.params.enabled = targetRainEnabled;
      rain.params.intensity = targetRainEnabled ? (p.rainIntensity ?? 1) : 0;
      snow.params.enabled = targetSnowEnabled;
      snow.params.intensity = targetSnowEnabled ? (p.snowIntensity ?? 1) : 0;
      stormParams.enabled = p.storm;
      cloudParams.formation = p.cloudFormation;
      cloudParams.levels = p.cloudLevels;
      onPresetApplied?.(p);
      return;
    }

    presetTransition = {
      t: 0,
      from: {
        coverage: cloudParams.coverage,
        density: cloudParams.density,
        fogNear: fog.near,
        fogFar: fog.far,
        windSpeed: windParams.speed,
        bloomStrength: fxParams.bloomStrength,
        godRayStrength: fxParams.godRayStrength,
        rainIntensity: rain.params.enabled ? rain.params.intensity : 0,
        snowIntensity: snow.params.enabled ? snow.params.intensity : 0,
      },
      to: {
        coverage: p.coverage,
        density: p.density,
        fogNear: p.fogNear,
        fogFar: p.fogFar,
        windSpeed: p.wind,
        bloomStrength: p.bloom,
        godRayStrength: p.godray,
        rainIntensity: targetRainEnabled ? (p.rainIntensity ?? 1) : 0,
        snowIntensity: targetSnowEnabled ? (p.snowIntensity ?? 1) : 0,
      },
      targetRainEnabled,
      targetSnowEnabled,
    };

    if (targetRainEnabled) rain.params.enabled = true;
    if (targetSnowEnabled) snow.params.enabled = true;
    // Lightning is an occasional event/accent, not a continuous base visual
    // — nothing to usefully cross-fade, so this just switches on/off
    // directly.
    stormParams.enabled = p.storm;
    // Also set directly, not cross-faded — a discrete "personality" swap
    // isn't something that can be smoothly interpolated the way a number
    // can. New shapes only actually roll out gradually anyway, as clusters
    // naturally drift out and respawn with the new formation — see
    // clouds.js.
    cloudParams.formation = p.cloudFormation;
    cloudParams.levels = p.cloudLevels;

    onPresetApplied?.(p);
  }

  function updatePresetTransition(dt: number) {
    if (!presetTransition) return;
    presetTransition.t += dt;
    const raw = Math.min(presetTransition.t / PRESET_TRANSITION_DURATION, 1);
    const k = raw * raw * (3 - 2 * raw); // smoothstep ease
    const { from, to } = presetTransition;

    cloudParams.coverage = MathUtils.lerp(from.coverage, to.coverage, k);
    cloudParams.density = MathUtils.lerp(from.density, to.density, k);
    fog.near = MathUtils.lerp(from.fogNear, to.fogNear, k);
    fog.far = MathUtils.lerp(from.fogFar, to.fogFar, k);
    windParams.speed = MathUtils.lerp(from.windSpeed, to.windSpeed, k);
    fxParams.bloomStrength = MathUtils.lerp(from.bloomStrength, to.bloomStrength, k);
    fxParams.godRayStrength = MathUtils.lerp(from.godRayStrength, to.godRayStrength, k);
    rain.params.intensity = MathUtils.lerp(from.rainIntensity, to.rainIntensity, k);
    snow.params.intensity = MathUtils.lerp(from.snowIntensity, to.snowIntensity, k);

    if (raw >= 1) {
      rain.params.enabled = presetTransition.targetRainEnabled;
      snow.params.enabled = presetTransition.targetSnowEnabled;
      presetTransition = null;
    }
  }

  function requirePreset(key: string): PresetSettings {
    const p = presets[key];
    if (!p) throw new Error(`unknown weather preset "${key}"`);
    return p;
  }

  function resolveGraph(locationKey: string): WeatherGraph {
    const graph = weatherGraphs[locationKey] ?? weatherGraphs.paloAlto;
    if (!graph) throw new Error(`no weather graph for "${locationKey}" and no paloAlto fallback`);
    return graph;
  }

  // Weighted walk along the current location's graph from wherever the
  // weather is now. If the current preset isn't a node in this location's
  // graph at all (e.g. it was set manually via the console to something
  // this location doesn't normally roll), fall back to an even pick across
  // every node in the graph rather than getting stuck.
  function pickNextPreset(locationKey: string): string {
    const graph = resolveGraph(locationKey);
    const edges = graph[currentPresetName];
    const options = edges && edges.length
      ? edges
      : Object.keys(graph).filter((name) => name !== currentPresetName).map((name): [string, number] => [name, 1]);
    const total = options.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = Math.random() * total;
    for (const [name, weight] of options) {
      roll -= weight;
      if (roll <= 0) return name;
    }
    return options[options.length - 1]?.[0] ?? currentPresetName;
  }

  // "Live" mode (see main.js's timeMode) wants a plausible weather pick for
  // *right now*, not a random walk from wherever the sim last left off —
  // deterministic per location+real-hour (same hash approach as
  // weather-api/server.js's exampleWeatherFor) so it reads as "today's
  // weather" rather than re-rolling on every reload within the same hour,
  // while still only ever picking something that location's own graph
  // considers plausible (Palo Alto never lands on snow, Urbana can).
  function pickLiveWeather(locationKey: string): string {
    const graph = resolveGraph(locationKey);
    const keys = Object.keys(graph);
    const hourBucket = Math.floor(Date.now() / (1000 * 60 * 60));
    const seed = `${locationKey}-${hourBucket}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    return keys[hash % keys.length] ?? currentPresetName;
  }

  function graphSummary(locationKey: string, locationLabel: string): string {
    const graph = resolveGraph(locationKey);
    const edges = graph[currentPresetName];
    const presetLabel = requirePreset(currentPresetName).label;
    if (!edges) return `${locationLabel}: "${presetLabel}" has no graph edges — next roll picks evenly from every node`;
    const total = edges.reduce((sum, [, weight]) => sum + weight, 0);
    const options = edges
      .map(([name, weight]) => `${requirePreset(name).label} ${Math.round((weight / total) * 100)}%`)
      .join(', ');
    return `${locationLabel}: ${presetLabel} -> ${options}`;
  }

  function tickAutoRoll(simHoursDelta: number): boolean {
    if (autoWeatherFrozen) return false;
    autoWeatherTimer -= simHoursDelta;
    if (autoWeatherTimer > 0) return false;
    autoWeatherTimer = nextWeatherInterval();
    return true;
  }

  return {
    presetOptions,
    matchPresetName,
    presetLabel: (key) => requirePreset(key).label,
    presetLabels: () => Object.values(presets).map((p) => p.label),
    getCurrentPresetName: () => currentPresetName,
    tempDeltaF: () => presets[currentPresetName]?.tempDeltaF ?? 0,
    cloudFormations: () => cloudFormations,
    setCloudCoverage: (v) => { cloudParams.coverage = v; },
    setCloudDensity: (v) => { cloudParams.density = v; },
    setCloudLevels: (v) => { cloudParams.levels = v; },
    setCloudFormation: (v) => { cloudParams.formation = v; },
    applyPreset,
    updatePresetTransition,
    pickNextPreset,
    pickLiveWeather,
    graphSummary,
    tickAutoRoll,
    resetAutoRollTimer: () => { autoWeatherTimer = nextWeatherInterval(); },
    setChangeIntervalHours: (hours) => { weatherChangeIntervalHours = hours; },
    freezeAuto: () => { autoWeatherFrozen = true; },
    runAuto: () => { autoWeatherFrozen = false; autoWeatherTimer = nextWeatherInterval(); },
  };
}
