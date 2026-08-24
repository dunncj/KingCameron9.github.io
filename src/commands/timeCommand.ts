import { parseNumber, type ArgValue, type Command } from '../devconsole';

// What "time" needs from main.js — the sim clock's ephemeral runtime state
// (current hour, speed, frozen/running), not anything that lives in
// settings.toml. A factory function closing over these, not a class: the
// command itself is just a plain object built once.
export interface ClockControl {
  getHour(): number;
  setHour(hour: number): void;
  getSpeed(): number;
  setSpeed(hoursPerSec: number): void;
  freeze(): void;
  run(): void;
}

export function buildTimeCommand(clock: ClockControl): Command {
  return {
    name: 'time',
    description: 'control the day-night clock: "set <hour>", "speed <hoursPerSec>", "freeze", "run"',
    args: [
      { type: 'enum', name: 'action', values: ['set', 'speed', 'freeze', 'run'] },
      { type: 'rest', name: 'value', optional: true },
    ],
    run: ([action, value]: ArgValue[]) => {
      if (action === 'set') {
        const hour = parseNumber(value as string | undefined, 'hour', 0, 24);
        clock.setHour(hour % 24);
        return `hour = ${clock.getHour().toFixed(2)}`;
      }
      if (action === 'speed') {
        const speed = parseNumber(value as string | undefined, 'hoursPerSec', 0.001);
        clock.setSpeed(speed);
        return `timeSpeed = ${clock.getSpeed()}`;
      }
      if (action === 'freeze') {
        clock.freeze();
        return 'time = frozen (whole simulation paused)';
      }
      // action === 'run'
      clock.run();
      return 'time = running';
    },
  };
}
