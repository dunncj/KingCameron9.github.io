import {
  Vector3, MathUtils, CanvasTexture, Sprite, SpriteMaterial, NormalBlending, AdditiveBlending, Color,
  BufferGeometry, BufferAttribute, Points,
} from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { createShaderMaterial, patchShaderSource } from './shaders';

const SUN_WHITE = new Color(0xffffff);
const SUN_WARM = new Color(0xff8a3d);
const MOON_COLOR = new Color(0xcfe0ff);
const STAR_WHITE = new Color(0xffffff);
const STAR_WARM = new Color(0xffd9a8);

// A soft radial gradient, not a hard-edged disc — shared by the sun and moon
// sprites. The retro pixelation pass turns any sharp edge into an ugly flat
// block, but a gradient this wide just downsamples into a chunkier (still
// round-reading) glow, the same way the bloom/god-ray passes already
// survive pixelation fine.
function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.2, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

// The moon used to share the sun's wide, formless glow texture — fine for
// the sun (which is meant to read as pure light, not a shape), but it left
// the moon looking like a blurry smudge instead of an actual body in the
// sky. This bakes a distinctly rounder, more defined disc (tighter falloff
// than the shared glow, not the razor-sharp edge the pixelation pass would
// turn into an ugly flat block) plus a few soft grey blotches suggesting
// maria/craters, wrapped in its own wider dim halo for bloom to catch.
function makeMoonTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;

  const halo = ctx.createRadialGradient(c, c, size * 0.16, c, c, c);
  halo.addColorStop(0, 'rgba(255,255,255,0.5)');
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);

  const discRadius = size * 0.3;
  const disc = ctx.createRadialGradient(c, c, 0, c, c, discRadius);
  disc.addColorStop(0, 'rgba(255,255,255,1)');
  disc.addColorStop(0.7, 'rgba(255,255,255,1)');
  disc.addColorStop(0.88, 'rgba(255,255,255,0.85)');
  disc.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(c, c, discRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, discRadius * 0.85, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalCompositeOperation = 'multiply';
  const blotches = [
    [c - discRadius * 0.3, c - discRadius * 0.25, discRadius * 0.34],
    [c + discRadius * 0.28, c + discRadius * 0.12, discRadius * 0.24],
    [c - discRadius * 0.05, c + discRadius * 0.38, discRadius * 0.2],
    [c + discRadius * 0.4, c - discRadius * 0.32, discRadius * 0.15],
  ];
  for (const [x, y, r] of blotches) {
    const spot = ctx.createRadialGradient(x, y, 0, x, y, r);
    spot.addColorStop(0, 'rgba(195,200,212,0.6)');
    spot.addColorStop(1, 'rgba(195,200,212,0)');
    ctx.fillStyle = spot;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// A small, tight dot — stars need to read as pinpoints of light, not a wide
// glow (that would just wash the whole night sky white at any density
// worth actually seeing).
function makeStarTexture() {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  // A solid core out to 70% radius (not the ~40% a "realistic" soft dot
  // would use), only falling off right at the rim — the retro pixelation
  // pass downsamples the whole frame before upscaling, and a mostly-soft
  // gradient was mostly already dim before that averaging even happened,
  // leaving stars barely visible however bright the material's own opacity
  // was pushed. A bigger solid-white area survives that averaging.
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.7, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

const SUN_SPRITE_DISTANCE = 50000;
const MOON_SPRITE_DISTANCE = 50000;
// Just inside the sky dome's own 45000 scale so stars sit on/near its
// surface rather than poking through it.
const STAR_RADIUS = 42000;
const STAR_COUNT = 15000;

// The full pool is generated once; "how starry" (starParams.density in
// main.js) just draws a shorter prefix of it each frame via setDrawRange —
// the same cheap density trick src/particles/ uses for rain/snow.
function buildStars() {
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);
  const tint = new Color();

  for (let i = 0; i < STAR_COUNT; i++) {
    // Uniform distribution across the sphere's surface (not raw lat/lon),
    // so stars don't clump toward the poles.
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const base = i * 3;
    positions[base + 0] = STAR_RADIUS * Math.sin(phi) * Math.cos(theta);
    positions[base + 1] = STAR_RADIUS * Math.cos(phi);
    positions[base + 2] = STAR_RADIUS * Math.sin(phi) * Math.sin(theta);

    // Mostly cool white, a minority noticeably warmer — real starlight
    // isn't uniform, and a little color variety reads as far less flat/
    // artificial than a single solid tint across thousands of points.
    const warmth = Math.random() < 0.15 ? Math.random() * 0.7 : 0;
    tint.copy(STAR_WHITE).lerp(STAR_WARM, warmth);
    // Magnitude variation — every star sharing one flat brightness (and,
    // until now, one flat size) was a big part of why the whole field read
    // as a uniform wash of faint specks instead of an actual night sky:
    // real stars span a huge apparent range. ~95% are the smallest possible
    // (1px) and dim; a rare few are bigger and brighter. Brightness ceiling
    // is deliberately modest (not the 2.6x tried earlier) — pushed high
    // enough to blow past a cloud's tonemapped brightness almost
    // regardless of how much the cloud actually dims it, which read as
    // clouds having no effect on stars at all.
    const isBright = Math.random() < 0.05;
    const magnitude = isBright ? MathUtils.lerp(0.6, 1, Math.random()) : Math.random() * 0.35;
    tint.multiplyScalar(MathUtils.lerp(0.06, 0.33, magnitude));
    tint.toArray(colors, base);
    sizes[i] = isBright ? MathUtils.lerp(1.4, 2, Math.random()) : 1;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('size', new BufferAttribute(sizes, 1));

  // A custom shader, not PointsMaterial — PointsMaterial only supports one
  // flat `size` for every point in the draw call, which is exactly what
  // made per-star size variation impossible before. `tint`/`opacity`
  // uniforms replace PointsMaterial's `.color`/`.opacity` API (the night
  // sky's tint-compensation and day/night fade still apply the same way,
  // just written into these instead).
  const starMaterial = createShaderMaterial({
    uniforms: {
      map: { value: makeStarTexture() },
      tint: { value: new Color(1, 1, 1) },
      opacity: { value: 0 },
    },
    vertexShader: /* glsl */`
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        // No sizeAttenuation term (no divide by -mvPosition.z): stars are
        // meant to read as fixed pinpoints regardless of camera distance,
        // not billboards that grow as the camera happens to drift toward
        // them.
        gl_PointSize = size;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D map;
      uniform vec3 tint;
      uniform float opacity;
      varying vec3 vColor;
      void main() {
        vec4 tex = texture2D(map, gl_PointCoord);
        gl_FragColor = vec4(vColor * tint * tex.rgb, tex.a * opacity);
      }
    `,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    // Additive, not alpha-blended: stars are light, not painted dots — over
    // a black night sky that looks identical, but it's what makes them
    // properly wash out against a brightening dawn sky (adding a little
    // light on top of something already bright is invisible) instead of
    // sitting on top as a stubborn, ever more visible white fleck no matter
    // how bright the backdrop behind it gets.
    blending: AdditiveBlending,
  });

  const points = new Points(geometry, starMaterial.material);
  points.frustumCulled = false;
  // Three.js sorts transparent objects back-to-front using each object's
  // *container* position, not its actual geometry — and this container's
  // position gets set to the camera's position every frame (so the huge,
  // camera-centered star sphere stays centered), which made stars look
  // like the single nearest thing in the whole scene and draw on top of
  // literally everything, clouds included. A very low explicit renderOrder
  // sidesteps that broken distance sort entirely: stars always draw first,
  // then clouds/rain/snow/etc (default renderOrder 0) draw over them.
  points.renderOrder = -10;

  // RenderPixelatedPass renders the scene a second time with a
  // MeshNormalMaterial override (for its edge-detection buffer). That
  // material expects real mesh normals/faces, which point geometry doesn't
  // have, so raw points get garbled during that pass and show up as
  // artifacts — src/particles/'s rain/snow/wind-streak particles hit the
  // exact same issue and fix it the same way (see overridePass.ts): skip
  // the draw entirely during the override pass.
  let starDrawCount = STAR_COUNT;
  points.onBeforeRender = (renderer, scene) => {
    geometry.setDrawRange(0, scene.overrideMaterial ? 0 : starDrawCount);
  };

  return {
    points,
    setDrawCount: (count) => { starDrawCount = count; },
    setUniforms: starMaterial.set,
  };
}

export function buildSky(scene) {
  const sky = new Sky();
  // Stock addon bug: the built-in cloud-color term multiplies by vSunE (a
  // raw ~0-700 sun-intensity constant that only makes sense paired with the
  // sun disc's own 19000x exposure multiplier a few lines above) times a
  // leftover 0.00002 scale, crushing every cloud pixel to near-black no
  // matter the coverage/density — the mixes just above it already produce a
  // properly-scaled ~0.3-1.9 cloud color, so drop the multiply entirely.
  sky.material.fragmentShader = patchShaderSource(sky.material.fragmentShader, [
    { find: 'cloudColor *= vSunE * 0.00002;', replace: '' },
    // The addon's cloud UV scroll (`cloudUV += time * cloudSpeed`) adds a
    // bare scalar to a vec2 — an identical offset on both axes, which is a
    // fixed 45° drift direction no matter what's actually going on. That's
    // completely disconnected from the wind direction driving the 3D cloud
    // clusters (and rain/snow/wind-streaks), so the high-altitude sky-dome
    // clouds always crawled the same diagonal while the physical clouds blew
    // wherever the wind actually pointed — one obviously fake next to the
    // other. A `windDir` uniform (radians, set from the same gust.direction
    // everything else uses) makes both layers drift together — subtracted,
    // not added: this offsets the *sample* coordinate the cloud pattern is
    // read from, and shifting where you sample from by +X moves the visible
    // pattern by -X (the same reason scrolling a background texture to the
    // right means subtracting from its U offset), the opposite of directly
    // translating an object's position the way the 3D clusters do.
    { find: 'uniform float time;', replace: 'uniform float time;\n\t\t\tuniform float windDir;' },
    { find: 'cloudUV += time * cloudSpeed;', replace: 'cloudUV -= vec2(cos(windDir), sin(windDir)) * time * cloudSpeed;' },
  ], 'Sky addon');
  sky.material.uniforms.windDir = { value: 0 };
  sky.material.needsUpdate = true;
  sky.scale.setScalar(45000);
  sky.frustumCulled = false;
  scene.add(sky);

  const uniforms = sky.material.uniforms;
  const sunDirection = new Vector3();
  const moonDirection = new Vector3();

  const glowTexture = makeGlowTexture();

  const sunSprite = new Sprite(new SpriteMaterial({
    map: glowTexture,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    // Normal blending, not additive: additive stacks straight on top of
    // whatever bloom/god-rays are already contributing at that same screen
    // position, which is exactly what made sunset overpowering again once
    // the sprite came back. Plain alpha blending paints the glow instead of
    // piling more brightness onto an already-bright area.
    blending: NormalBlending,
    opacity: 0,
    // SpriteMaterial responds to scene.fog by default — invisible for the
    // sun (daytime fog is a bright sky-ish color, so getting faded toward
    // it doesn't look obviously wrong), but this sprite sits at distance
    // 50000, past the scene's fog `far` of 40000, so it was being fully
    // replaced by the fog color regardless of its own brightness. Was the
    // exact cause of the moon rendering as a flat dark navy blob no matter
    // how bright its material.color said it should be — same bug, just
    // invisible here because the fog color happens to look plausible.
    fog: false,
  }));
  sunSprite.renderOrder = 1;
  // Sprite.scale is the quad's world-space size, not a screen-space size —
  // animated per-frame in update() below (bigger right at the horizon), this
  // is just its base/default before the first update() call.
  sunSprite.scale.setScalar(3000);
  scene.add(sunSprite);

  // Moon: its own dedicated disc+maria texture (not the sun's shared
  // formless glow — see makeMoonTexture's comment), positioned opposite the
  // sun rather than tied to a separately-tracked direction — real moon
  // phase/position isn't like this, but "opposite the sun" reads fine and
  // stays visible whenever the sun is below the horizon. Normal blending,
  // not additive, for the same reason as the sun: additive stacks straight
  // on top of whatever bloom/god-rays are already contributing at that
  // screen position, which overexposes fast — the disc's solid core
  // (alpha=1) already replaces whatever's behind it outright, so a bright
  // (>1, post-tint-compensation) color there shows fully regardless.
  const moonSprite = new Sprite(new SpriteMaterial({
    map: makeMoonTexture(),
    color: MOON_COLOR,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    opacity: 0,
    // The actual root cause of "moon isn't bright" — see the sun sprite's
    // identical fog:false comment above. This one mattered: the scene's
    // fog color is a dark navy at night, and this sprite (distance 50000,
    // past the fog's far of 40000) was being completely overridden by it,
    // rendering as a flat dark blob regardless of the boosted brightness
    // computed below.
    fog: false,
  }));
  moonSprite.renderOrder = 1;
  moonSprite.scale.setScalar(2000);
  scene.add(moonSprite);

  const { points: stars, setDrawCount: setStarDrawCount, setUniforms: setStarUniforms } = buildStars();
  scene.add(stars);
  const tintCompensation = new Color();
  const starTint = new Color();

  function update({
    elevation, azimuth, turbidity, rayleigh, mieCoefficient, mieDirectionalG,
    cloudCoverage, cloudDensity, cloudScale, cloudSpeed, windDirection = 0, time,
    starDensity = 0.6, starBrightness = 0.8, nightTint, nightBrightness = 1,
  }) {
    uniforms.turbidity.value = turbidity;
    uniforms.rayleigh.value = rayleigh;
    uniforms.mieCoefficient.value = mieCoefficient;
    uniforms.mieDirectionalG.value = mieDirectionalG;
    uniforms.cloudCoverage.value = cloudCoverage;
    uniforms.cloudDensity.value = cloudDensity;
    // Same degrees-to-radians convention clouds.js uses for the 3D clusters'
    // own wind vector — this is what keeps the two cloud layers drifting
    // the same direction instead of the sky dome ignoring wind entirely.
    uniforms.windDir.value = windDirection * (Math.PI / 180);
    uniforms.cloudScale.value = cloudScale;
    uniforms.cloudSpeed.value = cloudSpeed;
    uniforms.time.value = time;

    // showSunDisc is a boolean switch in the addon's own shader, not a
    // dimmer: the disc's edge is a fixed razor-sharp smoothstep (epsilon
    // 0.00002 in cosine-angle space) regardless of this value, so any
    // nonzero amount still draws a hard-edged shape, just dimmer — and the
    // retro pixelation pass renders any hard edge that bright as an ugly
    // flat block. Always off; the sun's visual presence comes entirely from
    // bloom/god-rays plus the sprite below (all smooth, blurred glows that
    // pixelate fine).
    uniforms.showSunDisc.value = 0;

    const phi = MathUtils.degToRad(90 - elevation);
    const theta = MathUtils.degToRad(azimuth);
    sunDirection.setFromSphericalCoords(1, phi, theta);
    uniforms.sunPosition.value.copy(sunDirection);
    moonDirection.copy(sunDirection).negate();

    const cloudFade = 1 - cloudCoverage * 0.85;

    // --- Sun --- opacity peaks right at the horizon instead of fading out
    // there: a sunset should be the *brightest*, biggest the glow ever
    // looks, not the moment it disappears. Tapers away gradually over the
    // next several degrees below the horizon rather than cutting off dead
    // at y=0.
    sunSprite.position.copy(sunDirection).multiplyScalar(SUN_SPRITE_DISTANCE);
    const dayAmount = MathUtils.clamp(sunDirection.y, 0, 1);
    const sunHorizonGlow = MathUtils.clamp(1 - Math.abs(elevation) / 10, 0, 1);
    const sunBelowFade = MathUtils.clamp((elevation + 8) / 8, 0, 1);
    sunSprite.material.opacity = Math.max(Math.sqrt(dayAmount), sunHorizonGlow) * cloudFade * sunBelowFade * 0.95;
    // A real setting sun also looks noticeably bigger near the horizon (the
    // same perceptual "moon illusion" effect) — a modest size boost sells
    // that instead of the glow just dimming in place.
    sunSprite.scale.setScalar(3000 * (1 + sunHorizonGlow * 0.6));
    const warmth = MathUtils.clamp(1 - Math.abs(Math.sin(elevation * Math.PI / 180)) * 2.2, 0, 1);
    sunSprite.material.color.copy(SUN_WHITE).lerp(SUN_WARM, warmth);

    // --- Moon --- mirrors the sun's treatment (dimmer, cooler, no color
    // shift needed since "moonlight blue-white" is already its resting
    // tint), visible whenever it's above the horizon rather than gated to a
    // fixed "it's night now" cutoff.
    moonSprite.position.copy(moonDirection).multiplyScalar(MOON_SPRITE_DISTANCE);
    const moonElevation = -elevation;
    const moonAmount = MathUtils.clamp(-sunDirection.y * 3, 0, 1);
    const moonHorizonGlow = MathUtils.clamp(1 - Math.abs(moonElevation) / 10, 0, 1);
    moonSprite.material.opacity = Math.max(moonAmount * 0.8, moonHorizonGlow * 0.6) * cloudFade;
    // Bigger than the sun's own base scale — a small, dim moon read as
    // barely there even at full opacity; a real full moon is a genuinely
    // noticeable disc, not a faint dot easy to lose in the sky, and needs
    // to clearly out-scale even the biggest "hero" stars.
    moonSprite.scale.setScalar(4800 * (1 + moonHorizonGlow * 0.3));

    // Everything past this point (the sky itself, clouds, this scene) gets
    // multiplied by a dark blue-grey night tint in post (WeatherGradeShader)
    // — fine for things that are meant to look dim and moody at night, but
    // it was crushing the moon and every star down to a faint, indistinct
    // navy smear no matter how bright their own opacity/color said they
    // should be. Dividing their base color by that same tint here cancels
    // it back out specifically for these two, so they read as genuinely
    // bright night-sky light sources instead of just another dim surface.
    if (nightTint) {
      tintCompensation.setRGB(
        MathUtils.clamp(1 / Math.max(nightTint.r, 0.001), 1, 6),
        MathUtils.clamp(1 / Math.max(nightTint.g, 0.001), 1, 6),
        MathUtils.clamp(1 / Math.max(nightTint.b, 0.001), 1, 6),
      );
    } else {
      tintCompensation.setRGB(1, 1, 1);
    }
    // The extra multiplier is the moon's own boost on top of the shared
    // tint compensation — it should read as distinctly the brightest thing
    // in the night sky, not just tied with the (now much dimmer) stars.
    // nightBrightness is a per-location dial (see main.js's
    // LOCATION_NIGHT_BRIGHTNESS) — real light pollution varies a lot by
    // where you are, and a rural sky (fewer competing lights) genuinely
    // shows a brighter, denser night sky than one washed out by a nearby
    // city's glow.
    moonSprite.material.color.copy(MOON_COLOR).multiply(tintCompensation).multiplyScalar(2.4 * nightBrightness);
    starTint.copy(tintCompensation).multiplyScalar(nightBrightness);
    setStarUniforms({ tint: starTint });

    // --- Stars --- fade in through dusk and stay out through the day. A
    // straight degrees-below-horizon ramp (not a sine curve, which is steep
    // right at the horizon and flattens out below it) so the transition
    // reads as an even, gradual fade rather than snapping in — full
    // brightness only once the sun is a full 30° below the horizon, so it
    // spans a comfortable chunk of twilight even with night sped up 3x.
    // Density and brightness are dev-configurable (main.js's starParams).
    const starVisibility = MathUtils.clamp(-elevation / 30, 0, 1);
    // Additive blending means opacity isn't capped at "fully opaque" the
    // way it would be for a normal-blended object — headroom above 1 is
    // what lets a star actually read as a bright point of light rather
    // than a flat, weak dot.
    // Ceiling raised well past a "normal" 0-1(ish) opacity range — the
    // WeatherGradeShader post-process multiplies the whole composited frame
    // by a dark blue-grey tint at night (the same color the sky itself
    // turns), which crushed even a maxed-out star down to a dim navy speck
    // no matter how bright this value was within a smaller ceiling. This
    // headroom is what lets a star punch back through that tint and still
    // read as a bright white point instead of the tint's own color.
    setStarUniforms({ opacity: starVisibility * MathUtils.clamp(starBrightness, 0, 6) * cloudFade });
    setStarDrawCount(Math.floor(STAR_COUNT * MathUtils.clamp(starDensity, 0, 1)));

    return sunDirection;
  }

  return {
    sky, sunSprite, moonSprite, stars, sunDirection, update, setStarUniforms,
  };
}
