// Which satellite-imagery source the globe overview is actually using —
// resolved once, here, at module load (not live-swappable mid-session; see
// settings.toml's own comment on why) so every other globe/ module and
// usMap.js itself can just import activeProvider directly instead of each
// re-deriving it.
import { settings } from '../settings/store';
import { PROVIDERS, DEFAULT_PROVIDER_ID } from '../mapProviders';

// A settings.toml edit takes a rebuild to reach the shipped site, but the
// dev-GUI's "tile provider (reloads)" dropdown (see main.js) needs its pick
// to actually survive the page reload it triggers — settings.toml's own
// value is otherwise all that's read here, and a plain in-memory write to
// tilesParams.provider is gone the instant the page reloads. This
// localStorage override is that one dropdown's only reason to exist; it
// takes priority over settings.toml precisely so picking a provider from
// the menu keeps working across reloads without a real persistence layer.
let providerOverride = null;
try {
  providerOverride = localStorage.getItem('tilesProviderOverride');
} catch {
  // Private-browsing/storage-blocked — falls through to settings.toml's own value.
}
// The active satellite-imagery source — settings.tiles.provider (see
// settings.toml's own comment) picked once at module load, not
// live-swappable mid-session. Every fetch function in globe/ builds its URL
// through activeProvider.buildTileUrl instead of a hardcoded Google
// template — see mapProviders.js for what makes that swap work cleanly:
// this app's own cell grid is edge-aligned to cellPx/2^z world-units, so a
// provider whose cellPx matches its own native tile size (Esri: 256) gets
// its own tile x/y for free from this app's own ix/iy, no separate lat/lon
// conversion or tile-stitching needed.
export const activeProvider = PROVIDERS[providerOverride] ?? PROVIDERS[settings.tiles.provider] ?? PROVIDERS[DEFAULT_PROVIDER_ID];
// Keeps the GUI dropdown (bound to tilesParams.provider, i.e. this same
// settings.tiles object) showing whichever provider is actually active,
// override included, rather than settings.toml's original value.
settings.tiles.provider = activeProvider.id;
export const REQUEST_SIZE = activeProvider.cellPx; // one cell's request size, in pixels per axis — provider-specific (see mapProviders.js)
export const REQUEST_SCALE = activeProvider.scale; // pixel density multiplier — same geo coverage, sharper texture where the provider supports it
