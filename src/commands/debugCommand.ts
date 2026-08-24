import type { Command } from '../devconsole';

export interface DebugSnapshot {
  snapshot(): Record<string, unknown>;
}

export function buildDebugCommand(debug: DebugSnapshot): Command {
  return {
    name: 'debug',
    description: 'dump current sky/time state to the console',
    args: [],
    run: () => JSON.stringify(debug.snapshot()),
  };
}
