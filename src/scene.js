import * as THREE from 'three';

export function buildScene() {
  const scene = new THREE.Scene();
  // The Sky dome (added separately) provides the visible backdrop; this only
  // shows through in the rare gap before it loads.
  scene.background = new THREE.Color(0x111122);

  // Linear fog (not FogExp2): the world here is real-scale meters (camera
  // sits hundreds to thousands of units out), where exponential density
  // blows up to near-total whiteout at those distances for any density
  // worth calling "fog." Near/far in meters is far easier to reason about.
  const fog = new THREE.Fog(0x111122, 2000, 40000);
  scene.fog = fog;

  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(ambient);

  const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3a3a30, 0.6);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff5e0, 2);
  sun.position.set(1, 1, 0.5).normalize();
  scene.add(sun);

  // Cool, dim counterpart to `sun` — real moonlight is sunlight reflected
  // off the moon, so it reads as a soft blue-white rather than the sun's
  // warm tone. Positioned/faded from main.js, roughly opposite the sun so
  // it rises as the sun sets.
  const moon = new THREE.DirectionalLight(0x8fb0ff, 0);
  moon.position.set(-1, 1, -0.5).normalize();
  scene.add(moon);

  // Brief bright flashes during storms; intensity is animated from main.js.
  const lightning = new THREE.PointLight(0xcfe0ff, 0, 6000, 1.3);
  lightning.position.set(0, 500, -200);
  scene.add(lightning);

  return { scene, fog, ambient, hemi, sun, moon, lightning };
}
