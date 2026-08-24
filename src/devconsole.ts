// A tiny vim/quake-style command line, entirely hidden — no button, no
// hint anywhere. Press ":" to open it, type a command, Enter runs it and
// closes the line immediately (like vim's command line) rather than
// hanging around waiting for another command. The result (or, just as
// visibly, an error) shows as a toast in the same spot instead of only
// going to devtools console, so a mistake is never silent. Up/Down cycle
// through history while typing.
const STYLE = /* css */`
  .devconsole {
    position: fixed;
    left: 0;
    bottom: 0;
    width: 100%;
    z-index: 2000;
    font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(10, 10, 14, 0.85);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border-top: 1px solid rgba(255, 255, 255, 0.15);
    padding: 6px 10px;
    display: flex;
    align-items: center;
    gap: 6px;
    color: #d6e8ff;
  }
  .devconsole input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: inherit;
    font: inherit;
  }
  .devconsole-toast {
    text-align: right;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .devconsole-toast.devconsole-error {
    color: #ff8a8a;
  }
`;

function injectStyleOnce(): void {
  if (document.getElementById('devconsole-style')) return;
  const styleEl = document.createElement('style');
  styleEl.id = 'devconsole-style';
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);
}

// A command's `args` schema is a discriminated union on `type` — every arg
// gets validated here, once, before any command body ever runs, so bad
// input fails loudly and specifically instead of silently producing NaN
// that only breaks something several layers away (a shader uniform, a
// WebGL draw call).
export interface NumberArgSpec {
  type: 'number';
  name: string;
  min?: number;
  max?: number;
  optional?: boolean;
  default?: number;
}

export interface EnumArgSpec {
  type: 'enum';
  name: string;
  values: readonly string[];
  optional?: boolean;
  default?: string;
}

// A single trailing string, already space-joined by run() — the escape
// hatch a command reaches for when its own sub-arguments (a nested action,
// a free-form name) don't fit this flat schema; see splitRest below.
export interface RestArgSpec {
  type: 'rest';
  name: string;
  optional?: boolean;
  default?: string;
}

export type ArgSpec = NumberArgSpec | EnumArgSpec | RestArgSpec;

export type ArgValue = string | number | undefined;

export interface Command {
  name: string;
  description: string;
  args: readonly ArgSpec[];
  run(values: ArgValue[]): string | void | Promise<string | void>;
}

// Exported so a command's own `run()` can validate a value it parses itself
// (e.g. a sub-argument whose meaning depends on an earlier "mode" arg,
// which the flat schema above can't express) with the exact same rules —
// and the exact same clear failure — as a normal schema-declared number.
export function parseNumber(raw: string | undefined, label: string, min?: number, max?: number): number {
  if (raw === undefined || raw === '') throw new Error(`missing <${label}>`);
  const n = parseFloat(raw);
  if (Number.isNaN(n)) throw new Error(`<${label}> should be a number, got "${raw}"`);
  if (min !== undefined && n < min) throw new Error(`<${label}> should be >= ${min}`);
  if (max !== undefined && n > max) throw new Error(`<${label}> should be <= ${max}`);
  return n;
}

// The `{name:'args', type:'rest'}` + manual re-split idiom every
// subcommand-style command (weather/travel/settings) used to repeat
// individually — one shared helper instead, so "unknown <action>" error
// messages and the lowercasing rule stay consistent everywhere they're used.
export function splitRest(raw: string | undefined): string[] {
  return (raw || '').split(/\s+/).filter(Boolean);
}

function parseArg(raw: string | undefined, spec: ArgSpec): ArgValue {
  if (raw === undefined || raw === '') {
    if (spec.optional) return spec.default;
    throw new Error(`missing <${spec.name}>`);
  }
  if (spec.type === 'number') return parseNumber(raw, spec.name, spec.min, spec.max);
  if (spec.type === 'enum') {
    if (!spec.values.includes(raw)) {
      throw new Error(`<${spec.name}> should be one of: ${spec.values.join(', ')} — got "${raw}"`);
    }
    return raw;
  }
  return raw; // 'rest' — a single trailing string, already space-joined by run()
}

function usageOf(cmd: Command): string {
  const argStr = cmd.args.map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`)).join(' ');
  return argStr ? `${cmd.name} ${argStr}` : cmd.name;
}

const TOAST_DURATION_MS = 3500;
const TOAST_ERROR_DURATION_MS = 6000;

// run() may be async and may return a string to show as feedback, or throw
// an Error whose message gets shown alongside the command's usage line.
export function buildDevConsole(commandList: Command[]): void {
  injectStyleOnce();

  const commands = new Map(commandList.map((c) => [c.name, c]));
  commands.set('help', {
    name: 'help',
    description: 'list every command',
    args: [],
    run: () => commandList.map((c) => `${usageOf(c)} — ${c.description}`).join('\n'),
  });

  const history: string[] = [];
  let historyIndex = 0;
  let inputBar: HTMLDivElement | null = null;
  let input: HTMLInputElement | null = null;
  let toast: HTMLDivElement | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function closeInput(): void {
    if (!inputBar) return;
    inputBar.remove();
    inputBar = null;
    input = null;
  }

  function showToast(text: string, isError: boolean): void {
    clearTimeout(toastTimer);
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'devconsole devconsole-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.toggle('devconsole-error', isError);
    toastTimer = setTimeout(() => {
      toast?.remove();
      toast = null;
    }, isError ? TOAST_ERROR_DURATION_MS : TOAST_DURATION_MS);
  }

  async function run(line: string): Promise<void> {
    const [rawName, ...rest] = line.split(/\s+/);
    const name = (rawName || '').toLowerCase();
    const cmd = commands.get(name);
    if (!cmd) {
      showToast(`unknown command "${name}" — try "help"`, true);
      return;
    }

    try {
      const values: ArgValue[] = [];
      let idx = 0;
      for (const spec of cmd.args) {
        let raw: string | undefined;
        if (spec.type === 'rest') {
          raw = rest.slice(idx).join(' ') || undefined;
          idx = rest.length;
        } else {
          raw = rest[idx];
          idx += 1;
        }
        values.push(parseArg(raw, spec));
      }
      const result = await cmd.run(values);
      showToast(result || `${name}: ok`, false);
    } catch (err) {
      showToast(`${usageOf(cmd)} — ${(err as Error).message}`, true);
    }
  }

  function openInput(): void {
    if (inputBar) {
      input?.focus();
      return;
    }
    inputBar = document.createElement('div');
    inputBar.className = 'devconsole';

    const prompt = document.createElement('span');
    prompt.textContent = ':';
    input = document.createElement('input');
    input.autocomplete = 'off';
    input.spellcheck = false;

    inputBar.appendChild(prompt);
    inputBar.appendChild(input);
    document.body.appendChild(inputBar);
    input.focus();

    input.addEventListener('keydown', (e) => {
      // Stops WASD/QE movement (and anything else listening on window) from
      // also reacting while a command is being typed.
      e.stopPropagation();
      if (e.key === 'Escape') {
        closeInput();
      } else if (e.key === 'Enter') {
        const line = input!.value.trim();
        closeInput(); // exits immediately, like vim's command line — never lingers
        if (line) {
          history.push(line);
          historyIndex = history.length;
          run(line);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (historyIndex > 0) {
          historyIndex -= 1;
          input!.value = history[historyIndex] ?? '';
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex < history.length - 1) {
          historyIndex += 1;
          input!.value = history[historyIndex] ?? '';
        } else {
          historyIndex = history.length;
          input!.value = '';
        }
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (!inputBar && e.key === ':') {
      e.preventDefault();
      openInput();
    }
  });
}
