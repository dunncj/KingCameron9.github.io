// Mirrors the [locations.*] tables in settings.toml at the repo root.
export const LOCATIONS = [
  {
    slug: 'palo-alto',
    label: 'Palo Alto, CA',
    lat: 37.418084,
    lon: -122.145394,
    utcOffset: -8,
    baseTempF: 62,
  },
  {
    slug: 'urbana',
    label: 'Urbana, IL',
    lat: 40.109179,
    lon: -88.227243,
    utcOffset: -6,
    baseTempF: 54,
  },
  {
    slug: 'falls-church',
    label: 'Falls Church, VA',
    lat: 38.897236,
    lon: -77.190797,
    utcOffset: -5,
    baseTempF: 58,
  },
  {
    slug: 'chantilly',
    label: 'Chantilly, VA',
    lat: 38.873825,
    lon: -77.441261,
    utcOffset: -5,
    baseTempF: 57,
  },
];

// Kept deliberately small for now (no precipitation/storm states) — see
// db.js, which rolls the current condition per location on a random
// 15-120min timer instead of computing it fresh on every request.
export const CONDITIONS = [
  { key: 'clear', label: 'Clear', tempDeltaF: 3, icon: '01d' },
  { key: 'cloudy', label: 'Cloudy', tempDeltaF: -1, icon: '03d' },
  { key: 'lightBreeze', label: 'Light Breeze', tempDeltaF: 0, icon: '50d', windBoostMph: 6 },
];

export function findLocation(slug) {
  return LOCATIONS.find((loc) => loc.slug === slug);
}
