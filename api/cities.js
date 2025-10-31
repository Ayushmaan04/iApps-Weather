import axios from "axios";

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.OPENWEATHER_API_KEY;
    const q = (req.query?.q || "").toString().trim();
    if (q.length < 2) return res.json([]);
    if (!API_KEY || API_KEY.trim().length < 10) {
      return res.status(500).json({ error: "OPENWEATHER_API_KEY missing/invalid" });
    }

    const { data } = await axios.get(
      "https://api.openweathermap.org/geo/1.0/direct",
      { params: { q, limit: 5, appid: API_KEY } }
    );

    const results = (data || []).map(c => ({
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
}

