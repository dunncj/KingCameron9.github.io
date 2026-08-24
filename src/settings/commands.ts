// The ":settings" devconsole command — see devconsole.js for the command
// shape this returns (`{ name, description, args, run }`) and main.js for
// where it's registered alongside the rest of the command list.
// A factory function, not a class: `buildSettingsCommand(guiControl)`
// closes over the one thing it needs from the outside world (a way to
// show/hide the dev GUI) and returns a single plain command object.
import {
  getSetting, setSetting, resetSetting, listSettingPaths, listSettingChildren, exportSettingsToml, exportSettingsJson,
} from './store';

// show/hide/toggle are async — the dev GUI (lil-gui + stats.module) is
// built lazily on first use (see initDevGui in main.js), so the very first
// "settings menu show" needs to await that before it can actually show
// anything.
export interface GuiControl {
  show(): Promise<void>;
  hide(): Promise<void>;
  toggle(): Promise<void>;
  isVisible(): boolean;
}

const SUBCOMMANDS = ['menu', 'set', 'get', 'list', 'reset', 'export', 'copy'];

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// "settings list [prefix]" — with no prefix (or one that resolves to a
// small group), print every leaf under it with its current value; with a
// short/empty prefix that resolves to a *large* group, print just the
// child names instead (a table of contents to drill into) rather than
// dumping the whole tree — settings.toml has well over a hundred leaves
// once presets/locations/weatherGraphs are counted, more than a single
// toast line is meant to hold at once.
const LIST_LEAF_LIMIT = 20;

function runList(prefix: string | undefined): string {
  const leaves = listSettingPaths(prefix);
  if (leaves.length <= LIST_LEAF_LIMIT) {
    return leaves.map(([path, value]) => `${path} = ${formatValue(value)}`).join('\n');
  }
  const children = listSettingChildren(prefix);
  const base = prefix ? `${prefix}.` : '';
  return [
    `${leaves.length} settings under "${prefix || '(root)'}" — narrow the prefix, or drill into one of:`,
    ...children.map((name) => `${base}${name}`),
  ].join('\n');
}

async function runExport(format: string | undefined): Promise<string> {
  const fmt = format === 'json' ? 'json' : 'toml';
  const text = fmt === 'json' ? exportSettingsJson() : exportSettingsToml();
  // eslint-disable-next-line no-console
  console.log(text);
  try {
    await navigator.clipboard.writeText(text);
    return `current settings copied to clipboard as ${fmt} (also logged to console)`;
  } catch {
    return `current settings logged to console as ${fmt} (clipboard write failed)`;
  }
}

export function buildSettingsCommand(gui: GuiControl) {
  return {
    name: 'settings',
    description: `menu show|hide|toggle, set <path> <value>, get <path>, list [prefix], reset [path], copy/export [toml|json]`,
    args: [{ name: 'args', type: 'rest' as const }],
    run: async ([argString]: [string | undefined]) => {
      const parts = (argString || '').split(/\s+/).filter(Boolean);
      const action = (parts[0] || '').toLowerCase();

      if (action === 'menu') {
        const mode = (parts[1] || '').toLowerCase();
        if (mode === 'show') await gui.show();
        else if (mode === 'hide') await gui.hide();
        else if (mode === 'toggle' || mode === '') await gui.toggle();
        else throw new Error(`settings menu <mode> should be show, hide, or toggle — got "${mode}"`);
        return `menu = ${gui.isVisible() ? 'on' : 'off'}`;
      }

      if (action === 'set') {
        const path = parts[1];
        const value = parts.slice(2).join(' ');
        if (!path) throw new Error('missing <path>');
        const applied = setSetting(path, value);
        return `${path} = ${formatValue(applied)}`;
      }

      if (action === 'get') {
        const path = parts[1];
        if (!path) throw new Error('missing <path>');
        return `${path} = ${formatValue(getSetting(path))}`;
      }

      if (action === 'list') {
        return runList(parts[1]);
      }

      if (action === 'reset') {
        resetSetting(parts[1]);
        return parts[1] ? `${parts[1]} reset to default` : 'all settings reset to defaults';
      }

      // "copy" is just a friendlier name for the same clipboard-copying
      // behavior "export" already has — both exist since either one is a
      // reasonable thing to type first.
      if (action === 'export' || action === 'copy') {
        return runExport(parts[1]);
      }

      throw new Error(`<action> should be one of: ${SUBCOMMANDS.join(', ')} — got "${parts[0] || ''}"`);
    },
  };
}
