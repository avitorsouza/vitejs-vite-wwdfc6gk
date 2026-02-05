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
      return res.status(400).json({ error: "Parâmetro q (endereço) é obrigatório." });
    }

    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res.status(500).json({ error: "GOOGLE_MAPS_API_KEY não configurada no Heroku." });
    }

    const q = String(qRaw).replace(/\s+/g, " ").trim();

    // ajuda a “puxar” para AM/BR (opcional)
    const components = "country:BR|administrative_area:AM";

    const url =
      "https://maps.googleapis.com/maps/api/geocode/json" +
      "?address=" + encodeURIComponent(q) +
      "&components=" + encodeURIComponent(components) +
      "&key=" + encodeURIComponent(key);

    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      return res.json({ found: false, source: "google", status: data.status, query: q });
    }

    const r = data.results[0];
    const loc = r.geometry?.location;

    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      return res.json({ found: false, source: "google", status: "NO_LOCATION", query: q });
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
app.post("/api/optimize-route", async (req, res) => {
  try {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) return res.status(500).json({ error: "GOOGLE_MAPS_API_KEY não configurada." });

    const depot = req.body?.depot; // { lat, lng }
    const stops = req.body?.stops; // [{ id, lat, lng }]

    if (!depot || !Number.isFinite(depot.lat) || !Number.isFinite(depot.lng)) {
      return res.status(400).json({ error: "depot inválido. Use {lat,lng}." });
    }
    if (!Array.isArray(stops) || stops.length < 2) {
      return res.status(400).json({ error: "stops inválido. Envie ao menos 2 paradas." });
    }

    // Google Directions: optimize:true
    const origin = `${depot.lat},${depot.lng}`;
    const destination = `${depot.lat},${depot.lng}`;

    const waypoints = "optimize:true|" + stops.map(s => `${s.lat},${s.lng}`).join("|");

    const url =
      "https://maps.googleapis.com/maps/api/directions/json" +
      "?origin=" + encodeURIComponent(origin) +
      "&destination=" + encodeURIComponent(destination) +
      "&waypoints=" + encodeURIComponent(waypoints) +
      "&mode=driving" +
      "&language=pt-BR" +
      "&region=br" +
      "&key=" + encodeURIComponent(key);

    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== "OK" || !data.routes?.[0]) {
      return res.status(200).json({ ok: false, status: data.status, error_message: data.error_message || null });
    }

    const route = data.routes[0];
    const order = route.waypoint_order || []; // array de índices

    // legs: origin->stop1, stop1->stop2, ..., last->destination
    const legs = route.legs || [];

    // Converte para lista ordenada de stops
    const orderedStops = order.map((idx) => stops[idx]);

    // estimativas: legs[0] é até primeiro stop, legs[1] até segundo, ...
    // vamos guardar leg_seconds e eta acumulado
    let acc = 0;
    const enriched = orderedStops.map((s, i) => {
      const legSec = legs[i]?.duration?.value ?? null;
      if (Number.isFinite(legSec)) acc += legSec;
      return { ...s, stop_order: i + 1, leg_seconds: legSec, eta_seconds: Number.isFinite(acc) ? acc : null };
    });

    return res.json({
      ok: true,
      ordered: enriched,
      summary: {
        total_seconds: route.legs?.reduce((sum, l) => sum + (l?.duration?.value || 0), 0) || null,
        total_meters: route.legs?.reduce((sum, l) => sum + (l?.distance?.value || 0), 0) || null,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
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
