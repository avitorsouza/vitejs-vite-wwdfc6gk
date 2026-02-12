const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "1mb" }));

// ---- API: geocode (Google) ----
app.get("/api/geocode", async (req, res) => {
  try {
    const qRaw = req.query.q;
    if (!qRaw || String(qRaw).trim().length < 3) {
      return res
        .status(400)
        .json({ error: "Parâmetro q (endereço) é obrigatório." });
    }

    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res
        .status(500)
        .json({ error: "GOOGLE_MAPS_API_KEY não configurada no Heroku." });
    }

    const q = String(qRaw).replace(/\s+/g, " ").trim();

    // ajuda a “puxar” para AM/BR (opcional)
    const components = "country:BR|administrative_area:AM";

    const url =
      "https://maps.googleapis.com/maps/api/geocode/json" +
      "?address=" +
      encodeURIComponent(q) +
      "&components=" +
      encodeURIComponent(components) +
      "&key=" +
      encodeURIComponent(key);

    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      return res.json({
        found: false,
        source: "google",
        status: data.status,
        query: q,
      });
    }

    const r = data.results[0];
    const loc = r.geometry?.location;

    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      return res.json({
        found: false,
        source: "google",
        status: "NO_LOCATION",
        query: q,
      });
    }

    return res.json({
      found: true,
      lat: loc.lat,
      lng: loc.lng,
      source: "google",
      query: q,
      formatted_address: r.formatted_address,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});
app.post("/api/optimize", async (req, res) => {
  try {
    const { stops } = req.body;

    if (!stops?.length) {
      return res.status(400).json({ error: "Sem paradas" });
    }

    const key = process.env.GOOGLE_MAPS_API_KEY;

    const origin = `${stops[0].lat},${stops[0].lng}`;
    const destination = origin;

    const waypoints = stops
      .slice(1)
      .map((s) => `${s.lat},${s.lng}`)
      .join("|");

    const url =
      `https://maps.googleapis.com/maps/api/directions/json?` +
      `origin=${origin}&destination=${destination}` +
      `&waypoints=optimize:true|${waypoints}` +
      `&key=${key}`;

    const r = await fetch(url);
    const j = await r.json();

    if (j.status !== "OK") {
      return res.status(400).json({ error: j.status });
    }

    const order = j.routes[0].waypoint_order.map((i) => stops[i + 1].id);
    order.unshift(stops[0].id);

    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Static (Vite build) ----
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

// SPA fallback (React Router / refresh não quebra)
app.use((req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
