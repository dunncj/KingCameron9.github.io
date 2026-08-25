import * as THREE from 'three';

// The lil-gui dev control panel (opened via the hidden ":" console's
// "settings menu" command, or the "Menu" button — see main.js's own
// setGuiVisible/initDevGui) — built once, on first use, since lil-gui/
// stats.module are dev-only tools nobody who never opens the menu should
// pay to download or construct. Pulled out of main.js as its own module for
// the same reason src/commands/ already splits each console command into
// its own file: this is the same kind of "developer control surface"
// concern, just not yet split out — everything it needs (every params
// object, a handful of small callbacks) is passed in via `ctx` rather than
// closed over directly, so it has no dependency on main.js's own module-
// level state beyond what's explicitly handed to it here.
export async function buildDevGui(ctx) {
  const {
    exportSettingsToml, renderQuality, qualityControl, weather, skyParams, starParams, cloudParams,
    rain, snow, windParams, windShakeParams, stormParams, fxParams, settingsPixelArt, postFx,
    tiles, camera, travelTo, paloAltoView, urbanaView, fallsChurchView, chantillyView,
    flyInParams, overviewStartParams, tilesParams, providers, movementParams, curveOptions,
    handoffParams, destPrefetchParams, cache, cacheControl, hoverParams, heavyPrefetchParams,
    debugState, settingsCameraMove, bobParams, bobPatterns, settingsCameraScroll,
    onManualHourChange, refreshGui,
  } = ctx;

  const [{ default: GUI }, { default: Stats }] = await Promise.all([
    import('lil-gui'),
    import('three/addons/libs/stats.module.js'),
  ]);

  const stats = new Stats();
  stats.dom.style.top = '8px';
  stats.dom.style.left = 'auto';
  stats.dom.style.right = '8px';
  document.body.appendChild(stats.dom);

  const gui = new GUI();
  // lil-gui defaults to the top-right corner — move it to the left instead.
  gui.domElement.style.right = 'auto';
  gui.domElement.style.left = '8px';

  // Everything below is one branch or another of the same centralized
  // settings tree (see settings/store.ts) — this button copies the whole
  // thing out in one shot, in the same TOML shape settings.toml itself
  // uses, so a session of GUI tweaking can be pasted straight back in to
  // make it the new defaults (see also the ":settings copy" console
  // command, which does the same thing).
  gui.add({
    copySettings: async () => {
      try {
        await navigator.clipboard.writeText(exportSettingsToml());
      } catch (err) {
        console.warn('Clipboard write failed:', err);
      }
    },
  }, 'copySettings').name('Copy All Settings');

  // The unified dial (see src/quality/ and src/cache/, and the ":quality"
  // console command) — sets render + cache quality together. The
  // per-quality-system dropdowns further down (Cache & Preload's own
  // "quality", and Pixel Art's below) stay independently settable for
  // decoupling the two.
  gui.add({ quality: renderQuality.getQuality() }, 'quality', renderQuality.qualityOptions())
    .name('Quality (render + cache)').onChange(qualityControl.setQuality);

  const weatherFolder = gui.addFolder('Weather Preset');
  weatherFolder.add({ preset: 'clear' }, 'preset', weather.presetOptions()).name('preset').onChange(weather.applyPreset);

  const skyFolder = gui.addFolder('Sky & Time');
  // Dragging this only to have live mode overwrite it next frame would read
  // as broken, so touching it kicks the sim out of live mode the same way
  // the console's "time set" does (see main.js's clockControl.setHour) —
  // onManualHourChange is that same bare "flip the mode flag" behavior,
  // not the full setTimeMode(): by the time this fires, lil-gui has already
  // written the slider's new value into skyParams.hour, and setTimeMode's
  // own hour-conversion math would corrupt that just-set value.
  skyFolder.add(skyParams, 'hour', 0, 24, 0.05).name('time of day').onChange(onManualHourChange);
  skyFolder.add(skyParams, 'turbidity', 1, 20, 0.1);
  skyFolder.add(skyParams, 'rayleigh', 0, 0.5, 0.005);
  skyFolder.add(skyParams, 'mieCoefficient', 0, 0.02, 0.0005);
  skyFolder.add(skyParams, 'mieDirectionalG', 0, 0.99, 0.01);

  const cloudFolder = gui.addFolder('Clouds');
  cloudFolder.add(cloudParams, 'coverage', 0, 1, 0.01);
  cloudFolder.add(cloudParams, 'density', 0, 1, 0.01);
  cloudFolder.add(cloudParams, 'scale', 0.0001, 0.003, 0.0001);
  cloudFolder.add(cloudParams, 'speed', 0, 0.001, 0.00001);

  const starFolder = gui.addFolder('Stars');
  starFolder.add(starParams, 'density', 0, 1, 0.01).name('how starry');
  starFolder.add(starParams, 'brightness', 0, 6, 0.01);

  const rainFolder = gui.addFolder('Rain');
  rainFolder.add(rain.params, 'enabled').name('rain');
  rainFolder.add(rain.params, 'intensity', 0, 3, 0.1);

  const snowFolder = gui.addFolder('Snow');
  snowFolder.add(snow.params, 'enabled').name('snow');
  snowFolder.add(snow.params, 'intensity', 0, 3, 0.1);

  const windFolder = gui.addFolder('Wind');
  windFolder.add(windParams, 'speed', 0).step(1); // no upper bound — drag or type past 80
  windFolder.add(windParams, 'direction', 0, 360, 1);
  windFolder.add(windParams, 'streakBlur', 0, 1, 0.05).name('wind streak blur');
  windFolder.add(windShakeParams, 'enabled').name('weather camera shake');
  windFolder.add(windShakeParams, 'amount', 0, 3, 0.1).name('shake amount');

  const stormFolder = gui.addFolder('Storm');
  stormFolder.add(stormParams, 'enabled').name('lightning');

  const fxFolder = gui.addFolder('Post FX');
  fxFolder.add(fxParams, 'exposure', 0, 2.5, 0.01);
  fxFolder.add(fxParams, 'bloomStrength', 0, 3, 0.01).name('bloom strength');
  fxFolder.add(fxParams, 'bloomRadius', 0, 6, 0.05).name('bloom radius');
  fxFolder.add(fxParams, 'bloomThreshold', 0, 1.5, 0.01).name('bloom threshold');
  fxFolder.add(fxParams, 'godRayStrength', 0, 2, 0.01).name('god rays');
  fxFolder.add(fxParams, 'vignette', 0, 1.5, 0.01);

  const pixelFolder = gui.addFolder('Pixel Art');
  pixelFolder.close();
  // Render-quality-only switch (see src/quality/) — unlike the top-level
  // "Quality" dropdown, this leaves cache quality alone.
  pixelFolder.add({ quality: renderQuality.getQuality() }, 'quality', renderQuality.qualityOptions())
    .name('render quality').onChange((v) => { renderQuality.setQuality(v); refreshGui(); });
  // Bound to settings.pixelArt (not the pass directly) so
  // ":settings set pixelArt.pixelSize 5" and this slider both drive the
  // same value — onChange pushes it into the actual pass, which doesn't
  // read live from a params object the way sky/fx do.
  pixelFolder.add(settingsPixelArt, 'pixelSize', 1, 16, 1).onChange((v) => postFx.pixelation.set({ pixelSize: v }));
  pixelFolder.add(settingsPixelArt, 'normalEdgeStrength', 0, 2, 0.05).onChange((v) => {
    postFx.pixelation.set({ normalEdgeStrength: v });
  });
  pixelFolder.add(settingsPixelArt, 'depthEdgeStrength', 0, 1, 0.05).onChange((v) => {
    postFx.pixelation.set({ depthEdgeStrength: v });
  });

  // --- Teleport UI (lat/lon coordinates) ---
  const teleportState = { lat: tiles.defaultLatLon.lat, lon: tiles.defaultLatLon.lon };
  const teleportFolder = gui.addFolder('Teleport');
  teleportFolder.add(teleportState, 'lat', -90, 90, 0.0001).name('latitude');
  teleportFolder.add(teleportState, 'lon', -180, 180, 0.0001).name('longitude');
  teleportFolder.add({
    go: () => {
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      travelTo(teleportState.lat, teleportState.lon, new THREE.Vector3(0, 800, 800), new THREE.Vector3(0, 0, 0));
    },
  }, 'go').name('Teleport');
  teleportFolder.add({
    paloAlto: () => {
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      // Re-centers to Palo Alto every time, regardless of current location —
      // paloAltoView's local coordinates are only meaningful relative to
      // that origin, so skipping the re-center (as a same-space fly did)
      // landed in the wrong place whenever this was called from anywhere
      // else, like Urbana.
      travelTo(tiles.defaultLatLon.lat, tiles.defaultLatLon.lon, paloAltoView.position, paloAltoView.target);
    },
  }, 'paloAlto').name('Go to Palo Alto');
  teleportFolder.add({
    urbana: () => {
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      travelTo(urbanaView.lat, urbanaView.lon, urbanaView.position, urbanaView.target);
    },
  }, 'urbana').name('Go to Urbana');
  teleportFolder.add({
    fallsChurch: () => {
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      travelTo(fallsChurchView.lat, fallsChurchView.lon, fallsChurchView.position, fallsChurchView.target);
    },
  }, 'fallsChurch').name('Go to Falls Church');
  teleportFolder.add({
    chantilly: () => {
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      travelTo(chantillyView.lat, chantillyView.lon, chantillyView.position, chantillyView.target);
    },
  }, 'chantilly').name('Go to Chantilly');

  // --- Overview → local-view handoff timing (see flyTo in usMap.js and
  // travelTo's opts.startLookDown branch in main.js) ---
  const transitionFolder = gui.addFolder('Transition Speed');
  transitionFolder.add(flyInParams, 'zoom', 14, 20.5, 0.1).name('overview zoom-in depth');
  transitionFolder.add(flyInParams, 'ms', 400, 6000, 50).name('overview zoom-in ms');
  transitionFolder.add(flyInParams, 'panMs', 100, 2000, 50).name('overview centering ms');
  // Only affects the *next* fresh mount (see mountUSOverview's own
  // comment) — dragging these while already inside the overview won't
  // visibly move anything until you leave and come back.
  transitionFolder.add(overviewStartParams, 'tiltDeg', -30, 30, 1).name('overview start tilt (deg)');
  transitionFolder.add(overviewStartParams, 'zoomBoost', -2, 4, 0.1).name('overview start zoom boost');
  // usMap.js reads settings.tiles.provider once at module load (the
  // persistent whole-globe/US-region layers are built once and cached for
  // the app's whole lifetime — see settings.toml's own comment on why), so
  // there's no live code path to re-fetch everything under a new provider
  // mid-session — picking a new one here reloads the page, same as editing
  // settings.toml's provider line and refreshing would. The localStorage
  // write is what makes the reload actually land on the new pick instead
  // of snapping back to settings.toml's value — see usMap.js's own comment
  // on providerOverride, the only reason this key exists.
  transitionFolder.add(tilesParams, 'provider', Object.keys(providers))
    .name('tile provider (reloads)')
    .onChange((value) => {
      try {
        localStorage.setItem('tilesProviderOverride', value);
      } catch {
        // Private-browsing/storage-blocked — reload will just fall back to settings.toml's value.
      }
      window.location.reload();
    });
  // Higher = sharper globe imagery at the same camera zoom, more/heavier
  // Static Maps requests — see fetchZoomFor in usMap.js and settings.toml's
  // own comment on tiles.lodBias.
  transitionFolder.add(tilesParams, 'lodBias', -3, 3, 0.1).name('globe tile sharpness');
  // Only affects the *next* fresh mount — see fetchZoomFor's own comment on
  // why this is separate from lodBias above (that layer covers the whole
  // sphere, so a shared bias would multiply into a much bigger jump in
  // tile count). Also shrinks how much of the frame the whole-globe
  // layer's baked-in Google attribution watermark visibly covers, by
  // splitting the same area across more, smaller tiles.
  transitionFolder.add(tilesParams, 'wholeGlobeLodBoost', 0, 3, 0.5).name('whole-globe sharpness (mount)');
  // Each movement (pan/zoom, entering/leaving) picks its own curve shape
  // and its own speed through that curve independently — see
  // flightCurves.ts's movementParams and getMovementCurve.
  const movementLabels = {
    panIn: 'Pan (entering)', zoomIn: 'Zoom (entering)', zoomOut: 'Zoom (leaving)', panOut: 'Pan (leaving)',
  };
  const curveFolder = transitionFolder.addFolder('Pan/Zoom Curves');
  for (const [movement, label] of Object.entries(movementLabels)) {
    const sub = curveFolder.addFolder(label);
    sub.add(movementParams[movement], 'curve', curveOptions()).name('curve shape');
    sub.add(movementParams[movement], 'speed', 0.25, 4, 0.05).name('speed through curve');
    sub.add(movementParams[movement], 'sharpness', 1, 60, 0.5).name('sharpness (hyperbolic only)');
  }
  transitionFolder.add(handoffParams, 'startHeight', 50, 2000, 10).name('local start height');
  transitionFolder.add(handoffParams, 'descendDuration', 0.2, 3, 0.05).name('local descend (s)');
  transitionFolder.add(fxParams, 'zoomBlurStrength', 0, 1.5, 0.05).name('zoom blur');

  // --- Destination pre-render tiers (see prefetchDestinationGrid in
  // usMap.js) — how far and how gradually the pre-fetched globe imagery
  // fades from full destination detail out to the coarse whole-globe
  // fallback around it.
  const destPrefetchFolder = transitionFolder.addFolder('Destination Prefetch');
  // Four tiers, finest to coarsest — radius 0 disables a tier outright
  // (see destPrefetchParams' own comment). zoomDrop is relative to the
  // destination's own zoom, so higher = coarser/wider real-world coverage
  // for the same radius.
  [
    ['highRes', 'High-res'],
    ['medRes', 'Med-res'],
    ['lowRes', 'Low-res'],
    ['veryLowRes', 'Very-low-res'],
  ].forEach(([key, label]) => {
    const tierFolder = destPrefetchFolder.addFolder(label);
    tierFolder.add(destPrefetchParams[key], 'radius', 0, 8, 1).name('radius (0 = off)');
    tierFolder.add(destPrefetchParams[key], 'zoomDrop', 0, 12, 1).name('zoom drop');
  });
  destPrefetchFolder.add(destPrefetchParams, 'edgeFadeStrength', 0, 1, 0.05).name('edge fade');
  destPrefetchFolder.add(destPrefetchParams, 'fetchBatchSize', 1, 25, 1).name('fetch batch/frame');
  destPrefetchFolder.add(destPrefetchParams, 'buildBatchSize', 1, 25, 1).name('build batch/frame');

  // --- Cache & preload (see src/cache/) — one quality tier governs how
  // aggressively hovering, clicking, and idling each trigger preloading
  // (and how much they're allowed to step on each other's bandwidth), plus
  // the 3D-tiles LRU cache itself; the sliders below let a single knob be
  // fine-tuned live on top of whichever tier is currently active.
  const preloadFolder = transitionFolder.addFolder('Cache & Preload');
  preloadFolder.add({ quality: cache.getQuality() }, 'quality', cache.qualityOptions())
    .name('quality').onChange(cacheControl.setQuality);
  preloadFolder.add(hoverParams, 'radiusPx', 10, 300, 5).name('hover radius (px)');
  preloadFolder.add(hoverParams, 'debounceMs', 0, 2000, 50).name('hover debounce (ms)');
  preloadFolder.add(cache.params, 'maxConcurrentHeavy', 1, 4, 1).name('max concurrent (hover)');
  preloadFolder.add(cache.params, 'heavyCooldownMs', 0, 60000, 1000).name('heavy cooldown (ms)');
  preloadFolder.add(cache.params, 'clickBackoffMs', 0, 5000, 50).name('click backoff (ms)');
  preloadFolder.add(cache.params, 'idleDelayMs', 0, 20000, 500).name('idle delay (ms)');
  preloadFolder.add(cache.params, 'idleIntervalMs', 500, 20000, 500).name('idle interval (ms)');
  preloadFolder.add(heavyPrefetchParams, 'resolutionScale', 0.05, 1, 0.05).name('3D tile prefetch res scale');
  preloadFolder.add(heavyPrefetchParams, 'staggerMs', 0, 1000, 20).name('3D tile prefetch stagger (ms)');

  const debugFolder = gui.addFolder('Debug');
  debugFolder.add(debugState, 'x').name('local x').listen().disable();
  debugFolder.add(debugState, 'y').name('local y').listen().disable();
  debugFolder.add(debugState, 'z').name('local z').listen().disable();
  debugFolder.add(debugState, 'targetX').name('target x').listen().disable();
  debugFolder.add(debugState, 'targetY').name('target y').listen().disable();
  debugFolder.add(debugState, 'targetZ').name('target z').listen().disable();
  debugFolder.add(debugState, 'zoom').name('camera zoom').listen().disable();
  debugFolder.add(debugState, 'fov').name('camera fov').listen().disable();
  debugFolder.add(debugState, 'lat').name('latitude').listen().disable();
  debugFolder.add(debugState, 'lon').name('longitude').listen().disable();
  debugFolder.add(debugState, 'height').name('height (m)').listen().disable();
  debugFolder.add(debugState, 'lod').name('lod level (overview)').listen().disable();
  debugFolder.add({
    copy: async () => {
      const text = [
        `local: ${debugState.x.toFixed(2)}, ${debugState.y.toFixed(2)}, ${debugState.z.toFixed(2)}`,
        `target: ${debugState.targetX.toFixed(2)}, ${debugState.targetY.toFixed(2)}, ${debugState.targetZ.toFixed(2)}`,
        `zoom: ${debugState.zoom.toFixed(3)}, fov: ${debugState.fov.toFixed(2)}`,
        `lat/lon: ${debugState.lat.toFixed(6)}, ${debugState.lon.toFixed(6)}`,
        `height: ${debugState.height.toFixed(1)}m`,
        `lod: ${debugState.lod}`,
      ].join('\n');
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.warn('Clipboard write failed:', err);
      }
    },
  }, 'copy').name('Copy to Clipboard');

  // --- Movement speed ---
  const moveFolder = gui.addFolder('Movement');
  moveFolder.add(settingsCameraMove, 'speed', 10, 3000, 10).name('speed (m/s)');
  moveFolder.add(bobParams, 'enabled').name('camera bob');
  moveFolder.add(bobParams, 'pattern', bobPatterns).name('bob pattern');
  moveFolder.add(bobParams, 'periodSeconds', 0.5, 60, 0.1).name('bob speed (s/cycle)');
  moveFolder.add(bobParams, 'amount', 0, 15, 0.5).name('bob amount');
  moveFolder.add(bobParams, 'idleAmount', 0, 6, 0.2).name('idle bob amount');

  const scrollFolder = gui.addFolder('Scroll Zoom');
  scrollFolder.add(settingsCameraScroll, 'sensitivity', 0.1, 10, 0.1).name('sensitivity');
  scrollFolder.add(settingsCameraScroll, 'damping', 0.5, 20, 0.5).name('damping');
  scrollFolder.add(settingsCameraScroll, 'maxSpeed', 200, 20000, 100).name('max speed');
  scrollFolder.add(settingsCameraScroll, 'exitOverscroll', 200, 10000, 100).name('exit-to-earth overscroll');

  gui.controllersRecursive().forEach((c) => c.updateDisplay());

  return { gui, stats };
}
