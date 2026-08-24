// Generic dot-path traversal over a plain nested object tree — the
// mechanism behind "settings set stars.brightness 100" (see commands.ts)
// and behind every domain reading its own branch out of the store (see
// store.ts). Pure functions operating on whatever object you hand them;
// nothing here knows about Settings specifically, so the same code works
// for the live tree, the frozen defaults snapshot, or a test fixture.

export type PlainRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function splitPath(path: string): string[] {
  const segments = path.split('.').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error(`empty settings path`);
  return segments;
}

// Walks to the *parent* of the path's final segment, returning both — every
// caller below needs the parent (to read or assign the leaf) plus the leaf
// key itself, so this is the one place that actually walks the tree.
function walkToParent(root: PlainRecord, segments: string[]): { parent: PlainRecord; key: string } {
  // splitPath guarantees at least one segment; .entries() (unlike raw index
  // access) stays properly typed under noUncheckedIndexedAccess, so this
  // needs no non-null assertions to convince TS the last segment exists.
  const key = segments[segments.length - 1] ?? '';
  let node: unknown = root;
  for (const [i, segment] of segments.slice(0, -1).entries()) {
    if (!isPlainObject(node) || !(segment in node)) {
      throw new Error(`no such setting "${segments.slice(0, i + 1).join('.')}"`);
    }
    node = node[segment];
  }
  if (!isPlainObject(node)) {
    throw new Error(`"${segments.slice(0, -1).join('.')}" is not a settings group`);
  }
  return { parent: node, key };
}

export function hasPath(root: PlainRecord, path: string): boolean {
  try {
    const { parent, key } = walkToParent(root, splitPath(path));
    return key in parent;
  } catch {
    return false;
  }
}

export function getPath(root: PlainRecord, path: string): unknown {
  const { parent, key } = walkToParent(root, splitPath(path));
  if (!(key in parent)) throw new Error(`no such setting "${path}"`);
  return parent[key];
}

// Only assigns *leaf* (non-object) values — deliberately refuses to
// overwrite a whole settings group with e.g. a string (see commands.ts,
// which is the only normal caller and relies on this to fail loudly rather
// than silently corrupt a subtree's shape). `value`'s type isn't checked
// against the existing leaf's type here — callers that care (commands.ts)
// do that themselves, since only they know how to report a good error.
export function setPath(root: PlainRecord, path: string, value: unknown): void {
  const { parent, key } = walkToParent(root, splitPath(path));
  if (!(key in parent)) throw new Error(`no such setting "${path}"`);
  if (isPlainObject(parent[key]) && isPlainObject(value)) {
    throw new Error(`"${path}" is a settings group, not a single value — set one of its own fields instead`);
  }
  parent[key] = value;
}

// Every leaf path under `root` (optionally scoped to a prefix), each paired
// with its current value — what "settings list" walks to print (see
// commands.ts). Order follows each object's own key order (TOML preserves
// declaration order, and so does JS for string keys), not sorted, so
// related settings stay grouped the way settings.toml wrote them.
export function listLeafPaths(root: PlainRecord, prefix = ''): [string, unknown][] {
  const start = prefix ? getPath(root, prefix) : root;
  const startPath = prefix;
  const out: [string, unknown][] = [];

  function walk(node: unknown, path: string) {
    if (isPlainObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        walk(value, path ? `${path}.${key}` : key);
      }
    } else {
      out.push([path, node]);
    }
  }

  walk(start, startPath);
  return out;
}

// The names one level below `prefix` (top-level domain names when prefix is
// empty) — used by "settings list" with no/short prefix so it shows a
// table of contents to drill into instead of dumping every leaf in the
// whole tree at once (see commands.ts).
export function listChildren(root: PlainRecord, prefix = ''): string[] {
  const node = prefix ? getPath(root, prefix) : root;
  if (!isPlainObject(node)) throw new Error(`"${prefix}" is a single value, not a settings group`);
  return Object.keys(node);
}
