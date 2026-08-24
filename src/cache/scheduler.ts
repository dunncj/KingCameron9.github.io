import type { PreloadSettings } from '../settings/types';

// One scheduler for every "load this before it's needed" trigger the
// overview and its markers have — hovering near a marker, actually clicking
// one, and idle background warming when nothing else is going on — so they
// share a single dedupe/concurrency policy instead of three independent,
// uncoordinated triggers competing for the same network. Deliberately
// transport-agnostic: it knows nothing about DOM events, markers, or what
// "heavy"/"light" actually fetch — callers register a name with two
// callbacks and call requestPreload/notifyActivity/notifyFlightStart/update
// at the right moments (see usMap.js's hover handling and main.js's
// wiring). `params` is settings.preload itself — a live reference, so a
// quality-tier switch (see quality.ts) that rewrites its fields takes
// effect on the very next call, and the dev GUI's sliders bind to the same
// object.
interface LocationJobs {
  heavy: () => void;
  light: () => void;
}

export interface PreloadScheduler {
  params: PreloadSettings;
  registerLocation(name: string, jobs: LocationJobs): void;
  requestPreload(name: string, options?: { immediate?: boolean }): void;
  notifyActivity(): void;
  notifyFlightStart(): void;
  update(now?: number): void;
  reset(): void;
}

export function createPreloadScheduler(params: PreloadSettings): PreloadScheduler {
  const locations = new Map<string, LocationJobs>();
  const heavyState = new Map<string, number>(); // name -> last-run timestamp
  const lightDone = new Set<string>();
  let activeHeavyCount = 0;
  let lastActivityAt = 0;
  let lastFlightAt = 0;
  let lastIdleFireAt = 0;
  let idleCursor = 0;

  function registerLocation(name: string, jobs: LocationJobs) {
    locations.set(name, jobs);
  }

  // immediate: true bypasses the concurrency cap and cooldown entirely — a
  // click is definitive intent, not a maybe, and travelTo needs this
  // location's tiles regardless of whatever else happens to be in flight.
  // Hover calls this without immediate, so a fast mouse sweep across
  // several markers doesn't fire a heavy job for every single one.
  function requestPreload(name: string, { immediate = false }: { immediate?: boolean } = {}) {
    const entry = locations.get(name);
    if (!entry) return;
    const now = performance.now();
    if (!immediate) {
      const last = heavyState.get(name);
      if (last !== undefined && now - last < params.heavyCooldownMs) return;
      if (activeHeavyCount >= params.maxConcurrentHeavy) return;
    }
    heavyState.set(name, now);
    if (!immediate) {
      activeHeavyCount += 1;
      // The fetches inside are fire-and-forget (Image()/temp cameras) —
      // there's no real completion signal to await here, so the
      // concurrency slot just frees itself after a fixed delay instead of
      // tracking every individual request's lifetime.
      setTimeout(() => { activeHeavyCount = Math.max(0, activeHeavyCount - 1); }, 1500);
    }
    entry.heavy();
  }

  // Anything indicating the user is actively engaged (mouse moving, a
  // marker click, panning/zooming) — resets the idle clock so background
  // light-preloading backs off while there's real interaction to prioritize
  // instead of competing with it for bandwidth.
  function notifyActivity() {
    lastActivityAt = performance.now();
  }

  // A location was actually clicked and travelTo is (or is about to be)
  // underway — on top of counting as activity, this also holds idle
  // preloading of OTHER locations off for clickBackoffMs, so the just-
  // clicked destination's own fetches (already fired via requestPreload's
  // immediate path) don't have to share the network with something merely
  // speculative.
  function notifyFlightStart() {
    const now = performance.now();
    lastActivityAt = now;
    lastFlightAt = now;
  }

  // Call once per frame (or on any reasonably tight interval) — cheap when
  // there's nothing to do, which is most of the time.
  function update(now: number = performance.now()) {
    if (now - lastFlightAt < params.clickBackoffMs) return;
    if (now - lastActivityAt < params.idleDelayMs) return;
    if (now - lastIdleFireAt < params.idleIntervalMs) return;
    const names = Array.from(locations.keys());
    if (names.length === 0) return;
    for (let i = 0; i < names.length; i++) {
      const idx = (idleCursor + i) % names.length;
      const name = names[idx];
      if (name === undefined || lightDone.has(name)) continue;
      lightDone.add(name);
      idleCursor = (idx + 1) % names.length;
      lastIdleFireAt = now;
      locations.get(name)?.light();
      return;
    }
    // Every registered location has already had its idle light pass —
    // nothing left to do until reset() (a fresh page load, effectively).
  }

  function reset() {
    heavyState.clear();
    lightDone.clear();
    activeHeavyCount = 0;
    idleCursor = 0;
  }

  return {
    params,
    registerLocation,
    requestPreload,
    notifyActivity,
    notifyFlightStart,
    update,
    reset,
  };
}
