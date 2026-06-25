// weather.js
// Pulls real outdoor conditions from Open-Meteo (free, no API key, CORS-open).
// Falls back to a synthetic British-summer day if the network is unavailable
// so the game is always playable offline.

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

// A believable hot-ish UK summer day used when offline.
function fallback() {
  const hours = [];
  for (let h = 0; h < 24; h++) {
    // crude diurnal curve peaking ~16:00
    const t = 16 + 9 * Math.sin(((h - 9) / 24) * Math.PI * 2);
    hours.push(Math.round(t * 10) / 10);
  }
  const now = new Date();
  return {
    place: 'London (offline estimate)',
    latitude: 51.51,
    longitude: -0.13,
    current: hours[now.getHours()],
    isDay: now.getHours() >= 6 && now.getHours() < 21 ? 1 : 0,
    hourly: hours,
    offline: true,
  };
}

export async function geocode(name) {
  const url = `${GEOCODE}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('geocode failed');
  const data = await res.json();
  if (!data.results || !data.results.length) throw new Error('place not found');
  const r = data.results[0];
  return {
    name: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
    latitude: r.latitude,
    longitude: r.longitude,
  };
}

function fetchTimeout(url, ms = 6000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

export async function fetchWeather({ latitude = 51.51, longitude = -0.13, place = 'London, UK' } = {}) {
  try {
    const url = `${FORECAST}?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,is_day,relative_humidity_2m,wind_speed_10m` +
      `&hourly=temperature_2m&forecast_days=1&timezone=auto`;
    const res = await fetchTimeout(url);
    if (!res.ok) throw new Error('forecast failed');
    const data = await res.json();
    const hourly = (data.hourly?.temperature_2m || []).slice(0, 24);
    return {
      place,
      latitude,
      longitude,
      current: data.current?.temperature_2m ?? 22,
      isDay: data.current?.is_day ?? 1,
      humidity: data.current?.relative_humidity_2m ?? 50,
      wind: data.current?.wind_speed_10m ?? 5,
      hourly: hourly.length === 24 ? hourly : fallback().hourly,
      offline: false,
    };
  } catch (e) {
    console.warn('[weather] using offline fallback:', e.message);
    return fallback();
  }
}
