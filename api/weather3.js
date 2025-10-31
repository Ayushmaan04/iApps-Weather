import axios from "axios";
import { geocode, fetchDailySummaries, packingAdvice } from "./_lib.js";

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.OPENWEATHER_API_KEY;
    const city = (req.query?.city || "").toString().trim();
    if (!city) return res.status(400).json({ error: "Missing ?city" });
    if (!API_KEY || API_KEY.trim().length < 10) {
      return res.status(500).json({ error: "OPENWEATHER_API_KEY missing/invalid" });
    }

    const g = await geocode(city, API_KEY);
    if (!g) return res.status(404).json({ error: "City not found" });

    let forecast;
    try {
      forecast = await fetchDailySummaries(g.lat, g.lon, API_KEY);
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }

    const advice = packingAdvice(forecast);

    res.json({
      source: "onecall_day_summary",
      city: g.name,
      country: g.country,
      forecast,
      ...advice,
    });
  } catch (e) {
    const s = e?.response?.status;
    const d = e?.response?.data;
    res.status(s || 500).json(d || { error: e.message });
  }
}

