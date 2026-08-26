import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createScrollVelocity } from './scrollVelocity';
import type { CameraScrollSettings, CameraMoveSettings } from '../settings/types';

// Owns every raw-input → camera-motion path for the ground/local view: WASD
// fly movement (previously loose `held`/`applyMovement` state in main.js)
// and wheel-driven exit-to-overview (new). A factory function, not a class
// — see devconsole/commands for the same pattern elsewhere in this
// codebase.
//
// Wheel input is deliberately NOT gated behind the WASD/drag-orbit
// "controls" toggle (isNavEnabled) the way WASD is — it's meant to always
// work, the same way scrolling a page always works regardless of what else
// is turned on. OrbitControls' own built-in wheel-zoom is disabled (see
// main.js, `controls.enableZoom = false`) so there's exactly one thing
// responding to wheel input, not two fighting over it.
//
// No free dolly-zoom range here at all — this is the innermost tier of the
// landing/world/ground scroll hierarchy (see usMap.js's own WORLD_ZOOM_IN_
// LIMIT for the middle tier), so there's nowhere further "in" to scroll to.
// Scrolling in is simply a no-op (WASD is how you actually get closer to
// something on the ground); scrolling out, sustained past exitOverscroll,
// hands off to the globe overview — the same reverse-flight the "Earth
// View" button triggers.
const KEY_MAP: Record<string, 'forward' | 'back' | 'left' | 'right' | 'up' | 'down'> = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  KeyE: 'up', KeyQ: 'down', Space: 'up', ShiftLeft: 'down',
};

export interface LocalCameraControlDeps {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  moveParams: CameraMoveSettings;
  scrollParams: CameraScrollSettings;
  isNavEnabled(): boolean;
  // False during the globe overview (and mid-flight) — this module only
  // owns the camera while the ground view is actually showing, and the
  // wheel listener stays attached the whole time (window-level, always on)
  // so it needs its own way to no-op rather than accumulate velocity nobody
  // asked for and unleash it as a jump whenever the ground view comes back.
  isLocalViewActive(): boolean;
  // Sustained scroll-out (past exitOverscroll — see applyScrollZoom) hands
  // off to the globe overview — the same reverse-flight the "Earth View"
  // button triggers.
  onExitToOverview(): void;
}

export interface LocalCameraControl {
  // Called once per frame while the ground view owns the camera (i.e. not
  // during a flight animation or the globe overview) — applies WASD
  // movement and wheel-zoom, and checks the scroll-past-the-edge exit.
  update(dt: number): void;
  // True while any WASD key is held — used by the flight state machine
  // (user input cancels an in-progress auto-travel) and the camera bob
  // (bob damps toward "moving" amplitude while WASD is held).
  isMoving(): boolean;
  // Drop every held WASD key without waiting for keyup — needed wherever a
  // flight/mode change interrupts input mid-press (time freeze, nav toggled
  // off, a travel starting) so a key doesn't stay "stuck" held.
  clearHeldKeys(): void;
  dispose(): void;
}

export function createLocalCameraControl(deps: LocalCameraControlDeps): LocalCameraControl {
  const {
    camera, controls, moveParams, scrollParams, isNavEnabled, isLocalViewActive, onExitToOverview,
  } = deps;

  const held = new Set<'forward' | 'back' | 'left' | 'right' | 'up' | 'down'>();
  const scroll = createScrollVelocity({
    sensitivity: scrollParams.sensitivity,
    damping: scrollParams.damping,
    maxSpeed: scrollParams.maxSpeed,
  });
  // Accumulated sustained scroll-out — resets the instant the wheel isn't
  // actively pushing outward, so a single wayward scroll tick can't slowly
  // leak toward triggering an exit over unrelated frames.
  let overscroll = 0;

  function onKeyDown(e: KeyboardEvent): void {
    const dir = KEY_MAP[e.code];
    if (isNavEnabled() && dir) held.add(dir);
  }
  function onKeyUp(e: KeyboardEvent): void {
    const dir = KEY_MAP[e.code];
    if (dir) held.delete(dir);
  }
  function onWheel(e: WheelEvent): void {
    if (!isLocalViewActive()) return; // let the overview/flight own wheel input instead
    e.preventDefault();
    scroll.addImpulse(e.deltaY);
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('wheel', onWheel, { passive: false });

  const moveForward = new THREE.Vector3();
  const moveRight = new THREE.Vector3();
  function applyMovement(dt: number): void {
    if (held.size === 0) return;
    const speed = moveParams.speed * dt;
    camera.getWorldDirection(moveForward);
    moveForward.y = 0;
    moveForward.normalize();
    moveRight.crossVectors(moveForward, camera.up).normalize();

    const delta = new THREE.Vector3();
    if (held.has('forward')) delta.addScaledVector(moveForward, speed);
    if (held.has('back')) delta.addScaledVector(moveForward, -speed);
    if (held.has('right')) delta.addScaledVector(moveRight, speed);
    if (held.has('left')) delta.addScaledVector(moveRight, -speed);
    if (held.has('up')) delta.y += speed;
    if (held.has('down')) delta.y -= speed;

    camera.position.add(delta);
    controls.target.add(delta);
  }

  function applyScrollZoom(dt: number): void {
    const applied = scroll.update(dt);
    // Positive deltaY (scrolling "down"/toward you) is scroll-OUT —
    // matching the natural page-scroll and OrbitControls' native
    // wheel-zoom direction. Scroll-IN (applied <= 0) is simply a no-op:
    // no free dolly-zoom range exists here at all (see this file's own
    // top comment) — nothing to trigger, nothing to move.
    if (applied <= 0) {
      overscroll = 0;
      return;
    }
    overscroll += applied;
    if (overscroll >= scrollParams.exitOverscroll) {
      overscroll = 0;
      scroll.reset();
      onExitToOverview();
    }
  }

  return {
    update(dt: number): void {
      applyMovement(dt);
      applyScrollZoom(dt);
    },
    isMoving: () => held.size > 0,
    clearHeldKeys: () => held.clear(),
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('wheel', onWheel);
    },
  };
}
