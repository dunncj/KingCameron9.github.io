import { createServer } from 'node:http';
import { LOCATIONS, CONDITIONS, findLocation } from './locations.js';

const PORT = process.env.PORT || 4000;

// Small deterministic hash so the "current" condition for a location stays
// stable within an hour instead of flipping on every request, without
// needing any real weather source or stored state.
function seededPick(list, seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return list[hash % list.length];
}

function exampleWeatherFor(location) {
  const hourBucket = Math.floor(Date.now() / (1000 * 60 * 60));
  const condition = seededPick(CONDITIONS, `${location.slug}-${hourBucket}`);
  const jitter = seededPick([-2, -1, 0, 1, 2], `${location.slug}-${hourBucket}-jitter`);

  return {
    location: location.label,
    slug: location.slug,
    lat: location.lat,
    lon: location.lon,
    condition: condition.label,
    conditionKey: condition.key,
    icon: condition.icon,
    tempF: location.baseTempF + condition.tempDeltaF + jitter,
    humidityPct: 40 + Math.abs(condition.tempDeltaF) * 4,
    windMph: 5 + Math.abs(condition.tempDeltaF),
    windDirectionDeg: (hourBucket * 37) % 360,
    observedAt: new Date().toISOString(),
    source: 'example-data',
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

const routes = {
  '/api/locations': (req, res) => {
    sendJson(res, 200, LOCATIONS.map(({ slug, label, lat, lon, utcOffset }) => (
      { slug, label, lat, lon, utcOffset }
    )));
  },
  '/api/weather': (req, res) => {
    sendJson(res, 200, LOCATIONS.map(exampleWeatherFor));
  },
};

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    res.end();
    return;
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/' || pathname === '') {
    sendJson(res, 200, {
      name: 'weather-api',
      description: 'Example weather data for the locations shown on the website.',
      endpoints: [
        'GET /api/locations',
        'GET /api/weather',
        'GET /api/weather/:slug',
      ],
    });
    return;
  }

  if (routes[pathname]) {
    routes[pathname](req, res);
    return;
  }

  const weatherMatch = pathname.match(/^\/api\/weather\/([\w-]+)$/);
  if (weatherMatch) {
    const location = findLocation(weatherMatch[1]);
    if (!location) {
      sendJson(res, 404, { error: `Unknown location "${weatherMatch[1]}"` });
      return;
    }
    sendJson(res, 200, exampleWeatherFor(location));
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`weather-api listening on http://localhost:${PORT}`);
});
