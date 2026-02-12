// server.cjs
const express = require("express");
const path = require("path");

// ---- fetch compat (Heroku/Node) ----
// Node 18+ tem fetch global. Se não tiver, você pode instalar node-fetch@2.
let fetchFn = global.fetch;
if (!fetchFn) {
  // npm i node-fetch@2
  // fetchFn = require("node-fetch");
  throw new Error(
    "fetch não disponível. Use Node 18+ no Heroku (recomendado) ou instale node-fetch@2.",
  );
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

// =========================================================
// API: HEALTHCHECK
// =========================================================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// =========================================================
// API: GEOCODE (Google)
// GET /api/geocode?q=...
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

    // ajuda a puxar p/ AM/BR
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
// Helpers (shared between /api/optimize and /api/route)
// =========================================================
function normalizeStops(stops) {
  const points = (Array.isArray(stops) ? stops : [])
    .filter(
      (s) => s && s.id && Number.isFinite(s.lat) && Number.isFinite(s.lng),
    )
    .map((s) => ({
      id: s.id,
      lat: s.lat,
      lng: s.lng,
      loc: `${s.lat},${s.lng}`,
    }));

  return points;
}

function hasDepotAddress(depot_address) {
  return Boolean(depot_address && String(depot_address).trim());
}

// =========================================================
// API: OPTIMIZE (Google Directions)
// POST /api/optimize
// body: { depot_address?: string, stops: [{id, lat, lng}, ...] }
// returns: { order: [id1, id2, ...] }
// =========================================================
app.post("/api/optimize", async (req, res) => {
  try {
    const { stops, depot_address } = req.body || {};

    if (!Array.isArray(stops) || stops.length < 2) {
      return res.status(400).json({ error: "Precisa de pelo menos 2 paradas" });
    }

    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res
        .status(500)
        .json({ error: "GOOGLE_MAPS_API_KEY não configurada" });
    }

    const points = normalizeStops(stops);
    if (points.length < 2) {
      return res.status(400).json({ error: "Paradas sem lat/lng suficiente" });
    }

    const useDepot = hasDepotAddress(depot_address);
    const origin = useDepot ? String(depot_address).trim() : points[0].loc;
    const destination = origin;

    // waypoints: com depot = todos; sem depot = exceto primeira
    const wpList = useDepot
      ? points.map((p) => p.loc)
      : points.slice(1).map((p) => p.loc);
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

    // waypoint_order refere-se ao wpList (sem o "optimize:true|")
    const waypointOrder = j.routes?.[0]?.waypoint_order || [];

    const orderedIds = waypointOrder
      .map((idx) => {
        const p = useDepot ? points[idx] : points[idx + 1];
        return p?.id;
      })
      .filter(Boolean);

    // sem depot: primeira parada fixa (points[0]) entra antes
    if (!useDepot) orderedIds.unshift(points[0].id);

    return res.json({ order: orderedIds });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// =========================================================
// API: ROUTE (Polyline real + legs)
// POST /api/route
// body: { depot_address?: string, stops: [{id, lat, lng}], optimize?: boolean }
// returns: { polyline, legs, orderedIds? }
// =========================================================
app.post("/api/route", async (req, res) => {
  try {
    const { stops, depot_address, optimize } = req.body || {};

    if (!Array.isArray(stops) || stops.length < 2) {
      return res.status(400).json({ error: "Precisa de pelo menos 2 paradas" });
    }

    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res
        .status(500)
        .json({ error: "GOOGLE_MAPS_API_KEY não configurada" });
    }

    const points = normalizeStops(stops);
    if (points.length < 2) {
      return res.status(400).json({ error: "Paradas sem lat/lng suficiente" });
    }

    const useDepot = hasDepotAddress(depot_address);
    const origin = useDepot ? String(depot_address).trim() : points[0].loc;
    const destination = origin;

    // waypoints
    const wpList = useDepot
      ? points.map((p) => p.loc)
      : points.slice(1).map((p) => p.loc);
    const wpPrefix = optimize ? "optimize:true|" : "";
    const waypointsParam = `${wpPrefix}${wpList.join("|")}`;

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

    const route0 = j.routes?.[0];
    const polyline = route0?.overview_polyline?.points || null;

    const legs = (route0?.legs || []).map((l) => ({
      distance_text: l?.distance?.text || null,
      distance_value: l?.distance?.value || null,
      duration_text: l?.duration?.text || null,
      duration_value: l?.duration?.value || null,
      start_address: l?.start_address || null,
      end_address: l?.end_address || null,
    }));

    let orderedIds = null;
    if (optimize) {
      const waypointOrder = route0?.waypoint_order || [];
      orderedIds = waypointOrder
        .map((idx) => {
          const p = useDepot ? points[idx] : points[idx + 1];
          return p?.id;
        })
        .filter(Boolean);

      if (!useDepot) orderedIds.unshift(points[0].id);
    }

    return res.json({ polyline, legs, orderedIds });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// =========================================================
// Static (Vite build) + SPA fallback
// =========================================================
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

// SPA fallback (React Router / refresh não quebra)
// ⚠️ Express 5: NÃO usar app.get("*")
app.use((req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
