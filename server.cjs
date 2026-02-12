// server.cjs
const express = require("express");
const path = require("path");

// ---- fetch compat (Heroku/Node) ----
// Node 18+ tem fetch global, mas deixamos um fallback seguro.
let fetchFn = global.fetch;
if (!fetchFn) {
  // Se seu ambiente for Node < 18, instale: npm i node-fetch@2
  // e descomente abaixo:
  // fetchFn = require("node-fetch");
  throw new Error(
    "fetch não disponível. Use Node 18+ no Heroku (recomendado) ou instale node-fetch@2.",
  );
}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "1mb" }));

// =========================================================
// API: GEOCODE (Google)
// =========================================================
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

    const resp = await fetchFn(url);
    const data = await resp.json();

    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      return res.json({
        found: false,
        source: "google",
        status: data.status,
        query: q,
        error_message: data.error_message || null,
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

// =========================================================
// API: OPTIMIZE (Google Directions)
// - recebe: { depot_address?: string, stops: [{id, lat, lng}, ...] }
// - retorna: { order: [id1, id2, ...] }
// =========================================================
app.post("/api/optimize", async (req, res) => {
  try {
    const { stops, depot_address } = req.body;

    if (!Array.isArray(stops) || stops.length < 2) {
      return res.status(400).json({ error: "Precisa de pelo menos 2 paradas" });
    }

    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res
        .status(500)
        .json({ error: "GOOGLE_MAPS_API_KEY não configurada" });
    }

    // Monta pontos como "lat,lng"
    const points = stops
      .filter(
        (s) => s && s.id && Number.isFinite(s.lat) && Number.isFinite(s.lng),
      )
      .map((s) => ({ id: s.id, loc: `${s.lat},${s.lng}` }));

    if (points.length < 2) {
      return res.status(400).json({ error: "Paradas sem lat/lng suficiente" });
    }

    // Se você passou depot_address, usamos como origem/destino.
    // Senão, usamos a 1ª parada como origem/destino (circuito).
    const useDepot = Boolean(depot_address && String(depot_address).trim());
    const origin = useDepot ? String(depot_address).trim() : points[0].loc;

    const destination = origin;

    // Waypoints = todas as paradas se tiver depot, senão (exceto a 1ª)
    const wpList = useDepot
      ? points.map((p) => p.loc)
      : points.slice(1).map((p) => p.loc);

    // Se tiver só 1 waypoint (caso points.length === 2 e sem depot), ok.
    const waypointsParam = `optimize:true|${wpList.join("|")}`;

    const url =
      `https://maps.googleapis.com/maps/api/directions/json?` +
      `origin=${encodeURIComponent(origin)}` +
      `&destination=${encodeURIComponent(destination)}` +
      `&waypoints=${encodeURIComponent(waypointsParam)}` +
      `&key=${encodeURIComponent(key)}`;

    const r = await fetchFn(url);
    const j = await r.json();

    if (j.status !== "OK") {
      return res.status(400).json({
        error: j.status,
        details: j.error_message || null,
      });
    }

    // waypoint_order refere-se à lista wpList
    // Precisamos traduzir isso para ids.
    const orderedIds = (j.routes?.[0]?.waypoint_order || [])
      .map((idx) => {
        const p = useDepot ? points[idx] : points[idx + 1];
        return p?.id;
      })
      .filter(Boolean);

    // Se NÃO tem depot, a primeira parada fixa (points[0]) entra antes
    if (!useDepot) orderedIds.unshift(points[0].id);

    return res.json({ order: orderedIds });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// =========================================================
// Static (Vite build) + SPA fallback
// =========================================================
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

// IMPORTANTE: não interceptar /api/*
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API route not found" });
  }
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
