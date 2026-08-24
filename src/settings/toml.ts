// Thin wrapper around smol-toml — the only file in the app that imports it,
// so swapping TOML libraries later (or dropping TOML entirely) touches one
// file, not every call site.
import { parse, stringify } from 'smol-toml';
import type { PlainRecord } from './paths';

export function parseToml(text: string): PlainRecord {
  return parse(text) as PlainRecord;
}

export function toToml(data: PlainRecord): string {
  return stringify(data);
}
