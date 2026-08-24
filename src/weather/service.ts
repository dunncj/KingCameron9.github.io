import type { Camera, Fog, PointLight, Scene, Vector3 } from 'three';
import type {
  CloudSettings, WindSettings, WindShakeSettings, StormSettings, PostFxSettings, PresetSettings, WeatherGraph,
} from '../settings/types';
import {
  createRainField, createSnowField, createWindStreaks,
  type RainField, type SnowField, type WindStreaksField,
} from '../particles';
import type { PostFxService } from '../postprocessing';
import { createGustSimulator, type Gust } from './gust';
import { createPresetSystem } from './presets';
import { createLightningSimulator } from './lightning';
import { createWindBlurDriver } from './windBlur';
import { createCameraWeatherResponse, precipitationAmounts, weatherIntensity } from './cameraResponse';

export interface WeatherSystemDeps {
  scene: Scene;
  camera: Camera;
  postFx: PostFxService;
  fog: Fog;
  lightningLight: PointLight;
  rainSettings: RainField['params'];
  snowSettings: SnowField['params'];
  cloudSettings: CloudSettings;
  windSettings: WindSettings;
  windShakeSettings: WindShakeSettings;
  stormSettings: StormSettings;
  postfxSettings: PostFxSettings;
  presets: Record<string, PresetSettings>;
  weatherGraphs: Record<string, WeatherGraph>;
  cloudFormations: readonly string[];
  onPresetApplied?: (preset: PresetSettings) => void;
}

export interface CloudUpdateParams {
  windSpeed: number;
  windDirection: number;
  coverage: number;
  density: number;
  formation: string;
  levels: number;
  rainAmount: number;
  snowAmount: number;
  stormAmount: number;
  flash: number;
}

// The weather subsystem: rain/snow/wind streaks (the particles service),
// wind-driven screen blur and lightning flash (the postprocessing service),
// and the state/simulation that drives all of it (gust, presets, storm
// timing, camera response to rough weather). Sky/cloud-dome rendering and
// anything that blends weather with time-of-day lighting (god rays' cloud
// damping, the weather-grade tint) stay in main.js's orchestration layer,
// which reads this subsystem's exposed state (cloudParams, stormParams,
// getFlash()) alongside its own lighting data — those passes are genuinely
// shared between two subsystems, not owned by either alone.
export interface WeatherSystem {
  cloudParams: CloudSettings;
  windParams: WindSettings;
  windShakeParams: WindShakeSettings;
  stormParams: StormSettings;
  gust: Gust;
  rain: RainField;
  snow: SnowField;
  windStreaks: WindStreaksField;

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
  pickNextPreset(locationKey: string): string;
  graphSummary(locationKey: string, locationLabel: string): string;
  setChangeIntervalHours(hours: number): void;
  freezeAuto(): void;
  runAuto(): void;
  resetAutoRollTimer(): void;

  precipitationAmounts(): { rainAmount: number; snowAmount: number };
  weatherIntensity(): number;
  computeWindShake(dt: number, intensity: number): Vector3;
  computeFov(dt: number, intensity: number): number;
  getFlash(): number;
  cloudUpdateParams(): CloudUpdateParams;

  // Per-frame orchestration — called from main.js's tick() in this order;
  // interleaved there with lighting/flight-driven passes this subsystem
  // doesn't own, so it's exposed as focused steps rather than one opaque
  // update().
  updateGust(dt: number): void;
  tickAutoRoll(simHoursDelta: number): boolean;
  updatePresetTransition(dt: number): void;
  updateParticles(dt: number, cameraPosition: Vector3, active: boolean): void;
  updateLightning(dt: number, cameraPosition: Vector3): void;
  updateWindBlur(): void;
}

export function createWeatherSystem(deps: WeatherSystemDeps): WeatherSystem {
  const {
    scene, camera, postFx, fog, lightningLight, rainSettings, snowSettings, cloudSettings, windSettings,
    windShakeSettings, stormSettings, presets, weatherGraphs, cloudFormations, onPresetApplied,
    postfxSettings: fxParams,
  } = deps;

  const rain = createRainField(scene, rainSettings);
  const snow = createSnowField(scene, snowSettings);
  const windStreaks = createWindStreaks(scene);

  const { gust, update: updateGust } = createGustSimulator(windSettings);
  const presetSystem = createPresetSystem({
    cloudParams: cloudSettings,
    windParams: windSettings,
    stormParams: stormSettings,
    fxParams,
    fog,
    rain,
    snow,
    presets,
    weatherGraphs,
    cloudFormations,
    onPresetApplied,
  });
  const lightning = createLightningSimulator(stormSettings, lightningLight, postFx);
  const windBlur = createWindBlurDriver(camera, gust, windSettings, postFx);
  const cameraResponse = createCameraWeatherResponse(windShakeSettings);

  function updateParticles(dt: number, cameraPosition: Vector3, active: boolean) {
    rain.params.windSpeed = gust.speed;
    rain.params.windDirection = gust.direction;
    snow.params.windSpeed = gust.speed * 0.3;
    snow.params.windDirection = gust.direction;
    windStreaks.params.windSpeed = gust.speed;
    windStreaks.params.windDirection = gust.direction;
    // Left ungated (or updated while not `active`), each field's own
    // update() would keep simulating/respawning particles using
    // cameraPosition — Earth-scale globe coordinates during the overview,
    // instead of local ones — scattering them across the whole visible
    // sky. `active` (false during the globe overview) is what actually
    // stops that, the same way applyMovement/controls.update() are already
    // skipped there.
    if (!active) return;
    rain.update(dt, cameraPosition);
    snow.update(dt, cameraPosition);
    windStreaks.update(dt, cameraPosition);
  }

  function cloudUpdateParams(): CloudUpdateParams {
    const { rainAmount, snowAmount } = precipitationAmounts(rain, snow);
    return {
      windSpeed: gust.speed,
      windDirection: gust.direction,
      coverage: cloudSettings.coverage,
      density: cloudSettings.density,
      formation: cloudSettings.formation,
      levels: cloudSettings.levels,
      // Darkening/tinting is tied to actual precipitation, not coverage or
      // wind — an overcast-but-dry "Cloudy" day still reads as bright white
      // clouds — and each kind gets its own color rather than one generic
      // "storm" grey: rain, snow, and a thunderhead don't actually look
      // alike.
      rainAmount,
      snowAmount,
      stormAmount: stormSettings.enabled ? 1 : 0,
      flash: lightning.getFlash(),
    };
  }

  return {
    cloudParams: cloudSettings,
    windParams: windSettings,
    windShakeParams: windShakeSettings,
    stormParams: stormSettings,
    gust,
    rain,
    snow,
    windStreaks,

    presetOptions: presetSystem.presetOptions,
    matchPresetName: presetSystem.matchPresetName,
    presetLabel: presetSystem.presetLabel,
    presetLabels: presetSystem.presetLabels,
    getCurrentPresetName: presetSystem.getCurrentPresetName,
    tempDeltaF: presetSystem.tempDeltaF,
    cloudFormations: presetSystem.cloudFormations,
    setCloudCoverage: presetSystem.setCloudCoverage,
    setCloudDensity: presetSystem.setCloudDensity,
    setCloudLevels: presetSystem.setCloudLevels,
    setCloudFormation: presetSystem.setCloudFormation,
    applyPreset: presetSystem.applyPreset,
    pickNextPreset: presetSystem.pickNextPreset,
    graphSummary: presetSystem.graphSummary,
    setChangeIntervalHours: presetSystem.setChangeIntervalHours,
    freezeAuto: presetSystem.freezeAuto,
    runAuto: presetSystem.runAuto,
    resetAutoRollTimer: presetSystem.resetAutoRollTimer,

    precipitationAmounts: () => precipitationAmounts(rain, snow),
    weatherIntensity: () => weatherIntensity(gust, rain, snow),
    computeWindShake: cameraResponse.computeWindShake,
    computeFov: (dt, intensity) => cameraResponse.computeFov(dt, intensity, lightning.getFlash()),
    getFlash: lightning.getFlash,
    cloudUpdateParams,

    updateGust,
    tickAutoRoll: presetSystem.tickAutoRoll,
    updatePresetTransition: presetSystem.updatePresetTransition,
    updateParticles,
    updateLightning: lightning.update,
    updateWindBlur: windBlur.update,
  };
}
