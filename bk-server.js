// server.js (clean, minimal)
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import openAI from "openai";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENWEATHER_API_KEY;
const oa = new openAI({ apiKey: process.env.OPENAI_API_KEY });


// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serve your UI

if (!API_KEY || API_KEY.trim().length < 10) {
  console.error("OPENWEATHER_API_KEY missing/invalid in .env");
  process.exit(1);
}

// ------------------------------------------------------------------
// Small helpers (only what we need)
// ------------------------------------------------------------------
// city -> { lat, lon, name, country }  (returns null if not found)
async function geocode(city, API_KEY, axios) {
  const { data } = await axios.get("https://api.openweathermap.org/geo/1.0/direct", {
    params: { q: city, limit: 1, appid: API_KEY }
  });
  if (!Array.isArray(data) || data.length === 0) return null;
  const { lat, lon, name, country } = data[0];
  return { lat, lon, name, country };
}

// Next N days as YYYY-MM-DD (UTC)
function nextNDatesUTC(n) {
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
function packingAdvice(days) {
  const umbrella = days.some(d => (d.rain_mm || 0) > 0);
  const temps = days.map(d => d.temp_avg_c).filter(v => typeof v === "number");
  const mean = temps.length ? temps.reduce((a,b)=>a+b,0) / temps.length : null;
  const packing = mean == null ? "Unknown" : (mean < 8 ? "Cold" : (mean <= 24 ? "Mild" : "Hot"));
  return { umbrella, packing, mean_temp_c: mean == null ? null : +mean.toFixed(1) };
}

// thresholds (µg/m³) for a simple "Good" cutoff
const GOOD = { pm2_5: 12, pm10: 54, no2: 53, so2: 35, o3: 70, co: 4400 };

// group hourly AQ forecast by day (UTC) -> next 3 days
function summarizeAirForecast(list) {
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
          pollutant: key.toUpperCase().replace("_",""),
          value_max: +v.toFixed(1),
          good_max: GOOD[key]
        });
      }
    }

    out.push({ day, aqi_max, alerts });
  }

  return out;
}




// ------------------------------------------------------------------
// Endpoints
// ------------------------------------------------------------------
// Simple health check route
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    environment: process.env.VERCEL ? "vercel" : "local",
    timestamp: new Date().toISOString(),
  });
});

// GET /api/weather3?city=Dublin
app.get("/api/weather3", async (req, res) => {
  try {
    const city = (req.query.city || "").trim();
    if (!city) return res.status(400).json({ error: "Missing ?city" });

    const g = await geocode(city, API_KEY, axios);
    if (!g) return res.status(404).json({ error: "City not found" });

    const dates = nextNDatesUTC(3);
    const out = [];

    for (const date of dates) {
      try {
        const { data } = await axios.get("https://api.openweathermap.org/data/3.0/onecall/day_summary", {
          params: { lat: g.lat, lon: g.lon, date, units: "metric", appid: API_KEY }
        });

        // Inline mapping — no normalize() function:
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
          return res.status(s).json({
            error: "One Call 3.0 day_summary not available",
          });
        }
        // Non-fatal for a single date: still return 3 rows
        out.push({ day: date, temp_avg_c: null, wind_max_ms: 0, rain_mm: 0 });
      }
    }

    const advice = packingAdvice(out);

    res.json({
      source: "onecall_day_summary",
      city: g.name,
      country: g.country,
      forecast: out,
      ...advice
    });
  } catch (e) {
    const s = e?.response?.status;
    const d = e?.response?.data;
    res.status(s || 500).json(d || { error: e.message });
  }
});

// GET /api/air3?city=Dublin
app.get("/api/air3", async (req, res) => {
  try {
    const city = (req.query.city || "").trim();
    if (!city) return res.status(400).json({ error: "Missing ?city" });

    const g = await geocode(city, API_KEY, axios);
    if (!g) return res.status(404).json({ error: "City not found" });

    // hourly AQ forecast (free)
    const { data } = await axios.get("http://api.openweathermap.org/data/2.5/air_pollution/forecast", {
      params: { lat: g.lat, lon: g.lon, appid: API_KEY }
    });

    const forecast = summarizeAirForecast(data?.list || []);

    res.json({
      city: g.name,
      country: g.country,
      forecast // [{ day, aqi_max, alerts: [{ pollutant, value_max, good_max }, ...] }, ...]
    });
  } catch (e) {
    const s = e?.response?.status;
    const d = e?.response?.data;
    res.status(s || 500).json(d || { error: e.message });
  }
});

// autocomplete cities: GET /api/cities?q=Dub
app.get("/api/cities", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (q.length < 2) return res.json([]); // require at least 2 chars

    const { data } = await axios.get("https://api.openweathermap.org/geo/1.0/direct", {
      params: { q, limit: 5, appid: process.env.OPENWEATHER_API_KEY }
    });

    const results = data.map(c => ({
      name: c.name,
      country: c.country,
      state: c.state || "",
      label: `${c.name}${c.state ? ", " + c.state : ""}, ${c.country}`
    }));

    res.json(results);
  } catch (e) {
    console.error("[cities]", e.message);
    res.status(500).json({ error: "autocomplete failed" });
  }
});

// LLM-powered packing assistant
// GET /api/pack?city=Dublin
app.get("/api/pack", async (req, res) => {
  try {
    const city = (req.query.city || "").toString().trim();
    if (!city) return res.status(400).json({ error: "Missing ?city" });

    // 1) Fetch your existing endpoints
    const base = `http://localhost:${PORT}`;
    const [wResp, aResp] = await Promise.all([
      axios.get(`${base}/api/weather3`, { params: { city } }),
      axios.get(`${base}/api/air3`, { params: { city } }),
    ]);

    const weather3 = wResp.data;
    const air3 = aResp.data;

    // 2) Build prompt
    const prompt = {
      role: "user",
      content:
        `You are a concise travel assistant. Given the next 3 days of daily weather and air quality, ` +
        `produce a short packing checklist (6–10 items) and a short rationale. keep in mind people should have these items ` +
        `Only If air quality is very poor (AQI >3), include a precaution. Output as JSON only with keys {"checklist": string[], "notes": string}.\n\n` +
        `Weather: ${JSON.stringify(weather3)}\n\nAir: ${JSON.stringify(air3)}`
    };

    // 3) Call OpenAI
    const response = await oa.responses.create({
      model: "gpt-4o-mini",
      input: [prompt]
    });

    // 4) Clean response
    let text = response.output_text || "";
    text = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { checklist: [], notes: text };
    }

    // 5) Send clean JSON to frontend
    res.json({
      city: weather3.city,
      country: weather3.country,
      checklist: parsed.checklist || [],
      notes: parsed.notes || ""
    });

  } catch (e) {
    const s = e?.response?.status;
    const d = e?.response?.data;
    res.status(s || 500).json(d || { error: e.message });
  }
});



// ------------------------------------------------------------------
// Start server
// ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});