import { createServer } from 'node:http';
import { LOCATIONS, CONDITIONS, findLocation } from './locations.js';
import { currentState } from './db.js';

const PORT = process.env.PORT || 4000;

function exampleWeatherFor(location) {
  const state = currentState(location.slug);
  const condition = CONDITIONS.find((c) => c.key === state.conditionKey);

  return {
    location: location.label,
    slug: location.slug,
    lat: location.lat,
    lon: location.lon,
    condition: condition.label,
    conditionKey: condition.key,
    icon: condition.icon,
    tempF: location.baseTempF + condition.tempDeltaF + state.tempJitter,
    humidityPct: 40 + Math.abs(condition.tempDeltaF) * 4,
    windMph: 5 + Math.abs(condition.tempDeltaF) + (condition.windBoostMph || 0),
    windDirectionDeg: state.windDirDeg,
    observedAt: state.updatedAt,
    changesAt: state.nextChangeAt,
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
