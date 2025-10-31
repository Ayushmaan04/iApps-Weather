import axios from "axios";
import OpenAI from "openai";
import { geocode, fetchDailySummaries, summarizeAirForecast } from "./_lib.js";

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.OPENWEATHER_API_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const city = (req.query?.city || "").toString().trim();
    if (!city) return res.status(400).json({ error: "Missing ?city" });
    if (!API_KEY || API_KEY.trim().length < 10) {
      return res.status(500).json({ error: "OPENWEATHER_API_KEY missing/invalid" });
    }
    if (!OPENAI_API_KEY || OPENAI_API_KEY.trim().length < 10) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing/invalid" });
    }

    const g = await geocode(city, API_KEY);
    if (!g) return res.status(404).json({ error: "City not found" });

    // Compute weather + air locally (don’t re-fetch our own endpoints)
    const forecast = await fetchDailySummaries(g.lat, g.lon, API_KEY);
    const weather3 = {
      city: g.name,
      country: g.country,
      forecast
    };

    const { data } = await axios.get(
      "http://api.openweathermap.org/data/2.5/air_pollution/forecast",
      { params: { lat: g.lat, lon: g.lon, appid: API_KEY } }
    );
    const air3 = {
      city: g.name,
      country: g.country,
      forecast: summarizeAirForecast(data?.list || [])
    };

    // LLM
    const oa = new OpenAI({ apiKey: OPENAI_API_KEY });
    const prompt = {
      role: "user",
      content:
        `You are a concise travel assistant. Given the next 3 days of daily weather and air quality, ` +
        `produce a short packing checklist (6–10 items) and a short rationale. keep in mind people should have these items ` +
        `Only If air quality is very poor (AQI >3), include a precaution. Output as JSON only with keys {"checklist": string[], "notes": string}.\n\n` +
        `Weather: ${JSON.stringify(weather3)}\n\nAir: ${JSON.stringify(air3)}`
    };

    const response = await oa.responses.create({
      model: "gpt-4o-mini",
      input: [prompt]
    });

    let text = response.output_text || "";
    text = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { checklist: [], notes: text };
    }

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
}

