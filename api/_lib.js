import axios from "axios";

// city -> { lat, lon, name, country }  (returns null if not found)
export async function geocode(city, API_KEY) {
  const { data } = await axios.get(
    "https://api.openweathermap.org/geo/1.0/direct",
    { params: { q: city, limit: 1, appid: API_KEY } }
  );
  if (!Array.isArray(data) || data.length === 0) return null;
  const { lat, lon, name, country } = data[0];
  return { lat, lon, name, country };
}

// Next N days as YYYY-MM-DD (UTC)
export function nextNDatesUTC(n) {
  const out = [];
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

// Simple umbrella/packing from a multi-day list
export function packingAdvice(days) {
  const umbrella = days.some(d => (d.rain_mm || 0) > 0);
  const temps = days.map(d => d.temp_avg_c).filter(v => typeof v === "number");
  const mean = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
  const packing =
    mean == null ? "Unknown" : mean < 8 ? "Cold" : mean <= 24 ? "Mild" : "Hot";
  return { umbrella, packing, mean_temp_c: mean == null ? null : +mean.toFixed(1) };
}

// thresholds (µg/m³) for a simple "Good" cutoff
export const GOOD = { pm2_5: 12, pm10: 54, no2: 53, so2: 35, o3: 70, co: 4400 };

// group hourly AQ forecast by day (UTC) -> next 3 days
export function summarizeAirForecast(list) {
  const byDay = {};
  for (const item of list || []) {
    const day = new Date(item.dt * 1000).toISOString().slice(0, 10); // YYYY-MM-DD UTC
    byDay[day] ||= { aqi: [], comps: [] };
    byDay[day].aqi.push(item?.main?.aqi ?? 1);
    if (item?.components) byDay[day].comps.push(item.components);
  }

  const days = Object.keys(byDay).sort().slice(0, 3); // next 3 days
  const out = [];

  for (const day of days) {
    const aqi_max = Math.max(...byDay[day].aqi);

    // per-pollutant max over that day’s hours
    const maxComp = {};
    for (const c of byDay[day].comps) {
      for (const key of Object.keys(GOOD)) {
        const v = c[key];
        if (typeof v === "number") {
          maxComp[key] = Math.max(maxComp[key] ?? -Infinity, v);
        }
      }
    }

    // build alerts for pollutants breaching "Good"
    const alerts = [];
    for (const key of Object.keys(GOOD)) {
      const v = maxComp[key];
      if (typeof v === "number" && v > GOOD[key]) {
        alerts.push({
          pollutant: key.toUpperCase().replace("_", ""),
          value_max: +v.toFixed(1),
          good_max: GOOD[key]
        });
      }
    }

    out.push({ day, aqi_max, alerts });
  }

  return out;
}

export async function fetchDailySummaries(lat, lon, API_KEY) {
  const dates = nextNDatesUTC(3);
  const out = [];
  for (const date of dates) {
    try {
      const { data } = await axios.get(
        "https://api.openweathermap.org/data/3.0/onecall/day_summary",
        { params: { lat, lon, date, units: "metric", appid: API_KEY } }
      );

      const tempAvg =
        data?.temperature?.day ??
        data?.temperature?.average ??
        ((data?.temperature?.min + data?.temperature?.max) / 2) ?? null;

      const windMax =
        data?.wind?.max?.speed ??
        data?.wind?.max_speed ??
        data?.wind_speed_max ??
        data?.wind_speed ?? 0;

      const rainTotal =
        data?.precipitation?.total ??
        data?.rain?.total ??
        data?.rain ?? 0;

      out.push({
        day: date,
        temp_avg_c: tempAvg != null ? +Number(tempAvg).toFixed(1) : null,
        wind_max_ms: +Number(windMax || 0).toFixed(1),
        rain_mm: +Number(rainTotal || 0).toFixed(1),
      });
    } catch (e) {
      const s = e?.response?.status;
      if (s === 401 || s === 403) {
        const err = new Error("One Call 3.0 day_summary not available");
        err.status = s;
        throw err;
      }
      out.push({ day: date, temp_avg_c: null, wind_max_ms: 0, rain_mm: 0 });
    }
  }
  return out;
}

