// The full shape of settings.toml (see that file at the repo root) and of
// the live, mutable settings tree it seeds (see store.ts). Every leaf name
// here is a plain identifier (camelCase, no spaces) — that's what makes a
// dot path like "stars.brightness" a valid, unambiguous thing to type into
// the ":settings" console command (see commands.ts) without any quoting.
// Composed from small per-domain interfaces rather than one flat blob, so
// each domain reads the same shape its own module already expects.

export interface SkySettings {
  hour: number;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
}

export interface StarSettings {
  density: number;
  brightness: number;
}

export interface CloudSettings {
  coverage: number;
  density: number;
  scale: number;
  speed: number;
  formation: string;
  levels: number;
}

export interface RainSettings {
  enabled: boolean;
  intensity: number;
}

export interface SnowSettings {
  enabled: boolean;
  intensity: number;
}

export interface WindShakeSettings {
  enabled: boolean;
  amount: number;
}

export interface WindSettings {
  speed: number;
  direction: number;
  streakBlur: number;
  shake: WindShakeSettings;
}

export interface StormSettings {
  enabled: boolean; // GUI shows this as "lightning" — it's the storm/lightning-accent toggle
}

export interface PostFxSettings {
  exposure: number;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  godRayStrength: number;
  vignette: number;
  zoomBlurStrength: number;
}

export interface PixelArtSettings {
  pixelSize: number;
  normalEdgeStrength: number;
  depthEdgeStrength: number;
}

export interface CameraMoveSettings {
  speed: number;
}

export interface CameraBobSettings {
  enabled: boolean;
  pattern: string;
  periodSeconds: number;
  amount: number;
  idleAmount: number;
}

export interface CameraSettings {
  move: CameraMoveSettings;
  bob: CameraBobSettings;
}

export interface HandoffSettings {
  startHeight: number;
  descendDuration: number;
}

export interface FlyInSettings {
  zoom: number;
  ms: number;
  panMs: number;
}

// One entry per curve.ts's MovementName ('panIn' | 'zoomIn' | 'zoomOut' |
// 'panOut') — see flightCurves.ts, which now just re-exports this branch of
// the store instead of declaring its own defaults.
export interface MovementCurveSettings {
  curve: string;
  speed: number;
  sharpness: number;
}

export interface TransitionSettings {
  handoff: HandoffSettings;
  flyIn: FlyInSettings;
  movements: {
    panIn: MovementCurveSettings;
    zoomIn: MovementCurveSettings;
    zoomOut: MovementCurveSettings;
    panOut: MovementCurveSettings;
  };
}

export interface PrefetchTierSettings {
  radius: number;
  zoomDrop: number;
}

export interface DestPrefetchSettings {
  highRes: PrefetchTierSettings;
  medRes: PrefetchTierSettings;
  lowRes: PrefetchTierSettings;
  veryLowRes: PrefetchTierSettings;
  edgeFadeStrength: number;
  fetchBatchSize: number;
  buildBatchSize: number;
}

export interface HeavyPrefetchSettings {
  resolutionScale: number;
  wideResW: number;
  wideResH: number;
  durationMs: number;
  staggerMs: number;
}

export interface HoverSettings {
  radiusPx: number;
  debounceMs: number;
}

export interface PrefetchSettings {
  dest: DestPrefetchSettings;
  heavy: HeavyPrefetchSettings;
  hover: HoverSettings;
}

export interface PreloadSettings {
  clickBackoffMs: number;
  idleDelayMs: number;
  idleIntervalMs: number;
  maxConcurrentHeavy: number;
  heavyCooldownMs: number;
}

// One named bundle covering every cache/preload knob — everything in
// PrefetchSettings and PreloadSettings, plus the 3D-tiles LRU cache (not
// otherwise part of the settings tree; see src/cache/quality.ts's own
// comment for why). "high" is the shipped default and *is* what
// settings.toml's [prefetch]/[preload] tables already contain — the other
// three tiers scale every knob up or down from there.
export interface CacheQualitySettings {
  // preload scheduler (see src/cache/scheduler.ts)
  clickBackoffMs: number;
  idleDelayMs: number;
  idleIntervalMs: number;
  maxConcurrentHeavy: number;
  heavyCooldownMs: number;
  // heavy (click-triggered) 3D-tile prefetch
  heavyResolutionScale: number;
  heavyWideResW: number;
  heavyWideResH: number;
  heavyDurationMs: number;
  heavyStaggerMs: number;
  // hover-triggered preload distance/debounce
  hoverRadiusPx: number;
  hoverDebounceMs: number;
  // globe overview's destination satellite-image grid prefetch
  destHighRes: PrefetchTierSettings;
  destMedRes: PrefetchTierSettings;
  destLowRes: PrefetchTierSettings;
  destVeryLowRes: PrefetchTierSettings;
  destEdgeFadeStrength: number;
  destFetchBatchSize: number;
  destBuildBatchSize: number;
  // 3D-tiles LRU geometry cache (see tiles.js's buildTiles)
  tilesMaxSizeMB: number;
  tilesMaxItems: number;
  tilesErrorTarget: number;
}

export type CacheQualityName = 'low' | 'medium' | 'high' | 'epic';

export interface CacheSettings {
  quality: CacheQualityName;
  qualities: Record<CacheQualityName, CacheQualitySettings>;
}

// A saved camera pose at a real-world lat/lon. position/target start as
// plain {x,y,z} data here (TOML has no "point" type) — main.js upgrades
// each one to a real THREE.Vector3 once, right after the store loads (see
// its own comment), which is a transparent swap: a Vector3 still has plain
// writable x/y/z fields, so "locations.paloAlto.position.x" keeps working
// as a settings path either way.
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface LocationSettings {
  label: string;
  slug: string;
  lat: number;
  lon: number;
  utcOffset: number;
  baseTempF: number;
  nightBrightness: number;
  position: Point3;
  target: Point3;
}

// One weighted transition graph per location — WEATHER_GRAPHS' old shape,
// just keyed by the same camelCase preset keys as `presets` below instead
// of their display strings. [presetKey, weight][] edges out of each node;
// a node with no entry here just falls back to an even pick (see
// pickWeatherFor in main.js).
export type WeatherGraph = Record<string, [string, number][]>;

export interface PresetSettings {
  label: string;
  coverage: number;
  density: number;
  fogNear: number;
  fogFar: number;
  rain: boolean;
  rainIntensity: number;
  snow: boolean;
  snowIntensity: number;
  wind: number;
  storm: boolean;
  bloom: number;
  godray: number;
  cloudFormation: string;
  cloudLevels: number;
  tempDeltaF: number;
}

export interface Settings {
  sky: SkySettings;
  stars: StarSettings;
  clouds: CloudSettings;
  rain: RainSettings;
  snow: SnowSettings;
  wind: WindSettings;
  storm: StormSettings;
  postfx: PostFxSettings;
  pixelArt: PixelArtSettings;
  camera: CameraSettings;
  transitions: TransitionSettings;
  prefetch: PrefetchSettings;
  preload: PreloadSettings;
  cache: CacheSettings;
  locations: Record<string, LocationSettings>;
  presets: Record<string, PresetSettings>;
  weatherGraphs: Record<string, WeatherGraph>;
}
