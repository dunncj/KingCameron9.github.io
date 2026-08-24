import type { Command } from '../devconsole';

export interface ControlsToggle {
  // Flips WASD/QE flight + mouse-drag orbiting and returns the new enabled
  // state — the "clear held keys so nothing stays stuck down" side effect
  // stays in main.js next to the `held` set it belongs to.
  toggle(): boolean;
}

export function buildControlsCommand(controls: ControlsToggle): Command {
  return {
    name: 'controls',
    description: 'toggle WASD/QE flight and mouse-drag orbiting',
    args: [],
    run: () => `controls = ${controls.toggle() ? 'on' : 'off'}`,
  };
}
