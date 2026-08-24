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

export const CONDITIONS = [
  { key: 'clear', label: 'Clear', tempDeltaF: 4, icon: '01d' },
  { key: 'partlyCloudy', label: 'Partly Cloudy', tempDeltaF: 1, icon: '02d' },
  { key: 'cloudy', label: 'Cloudy', tempDeltaF: -1, icon: '03d' },
  { key: 'overcast', label: 'Overcast', tempDeltaF: -3, icon: '04d' },
  { key: 'showers', label: 'Showers', tempDeltaF: -4, icon: '09d' },
  { key: 'rain', label: 'Rain', tempDeltaF: -5, icon: '10d' },
  { key: 'thunderstorm', label: 'Thunderstorm', tempDeltaF: -6, icon: '11d' },
  { key: 'snow', label: 'Snow', tempDeltaF: -10, icon: '13d' },
];

export function findLocation(slug) {
  return LOCATIONS.find((loc) => loc.slug === slug);
}
