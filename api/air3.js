import axios from "axios";
import { geocode, summarizeAirForecast } from "./_lib.js";

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

    const { data } = await axios.get(
      "http://api.openweathermap.org/data/2.5/air_pollution/forecast",
      { params: { lat: g.lat, lon: g.lon, appid: API_KEY } }
    );

    const forecast = summarizeAirForecast(data?.list || []);

    res.json({ city: g.name, country: g.country, forecast });
  } catch (e) {
    const s = e?.response?.status;
    const d = e?.response?.data;
    res.status(s || 500).json(d || { error: e.message });
  }
}

