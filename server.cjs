// server.cjs
const express = require("express");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// fetch compat
let fetchFn = global.fetch;
if (!fetchFn) {
  throw new Error("fetch não disponível. Use Node 18+.");
}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "2mb" }));

// Supabase admin client (bypassa RLS usando SERVICE ROLE)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "⚠️ Falta SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY nas Config Vars.",
  );
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// =========================================================
// API: HEALTH
// =========================================================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// =========================================================
// API: ADMIN LINK DRIVER <-> VEHICLE
// POST /api/admin/link-driver
// body: { driver_id, vehicle_id }
// =========================================================
app.post("/api/admin/link-driver", async (req, res) => {
  try {
    const { driver_id, vehicle_id } = req.body || {};

    if (!driver_id) {
      return res.status(400).json({ error: "driver_id obrigatorio" });
    }
    if (!vehicle_id) {
      return res.status(400).json({ error: "vehicle_id obrigatorio" });
    }

    // Remove vinculos atuais do motorista e do veiculo para manter 1:1.
    const { error: delDriverErr } = await supabaseAdmin
      .from("driver_vehicle")
      .delete()
      .eq("driver_id", driver_id);

    if (delDriverErr) {
      return res.status(400).json({
        error: "Falha ao remover vinculo anterior do motorista",
        details: delDriverErr.message,
      });
    }

    const { error: delVehicleErr } = await supabaseAdmin
      .from("driver_vehicle")
      .delete()
      .eq("vehicle_id", vehicle_id);

    if (delVehicleErr) {
      return res.status(400).json({
        error: "Falha ao remover vinculo anterior do veiculo",
        details: delVehicleErr.message,
      });
    }

    const { error: insErr } = await supabaseAdmin
      .from("driver_vehicle")
      .insert([{ driver_id, vehicle_id }]);

    if (insErr) {
      return res.status(400).json({
        error: "Falha ao criar vinculo",
        details: insErr.message,
      });
    }

    return res.json({ ok: true, driver_id, vehicle_id });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
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
        .json({ error: "GOOGLE_MAPS_API_KEY não configurada." });
    }

    const q = String(qRaw).replace(/\s+/g, " ").trim();
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

    if (data.status !== "OK" || !data.results?.length) {
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
// Helpers
// =========================================================
function normalizeStops(stops) {
  return (Array.isArray(stops) ? stops : [])
    .filter(
      (s) => s && s.id && Number.isFinite(s.lat) && Number.isFinite(s.lng),
    )
    .map((s) => ({
      id: s.id,
      lat: s.lat,
      lng: s.lng,
      loc: `${s.lat},${s.lng}`,
    }));
}

function hasDepotAddress(depot_address) {
  return Boolean(depot_address && String(depot_address).trim());
}

// =========================================================
// API: OPTIMIZE (Google Directions) -> retorna order [delivery_id...]
// POST /api/optimize
// body: { depot_address?: string, stops: [{id, lat, lng}, ...] }
// =========================================================
app.post("/api/optimize", async (req, res) => {
  try {
    const { stops, depot_address } = req.body || {};

    if (!Array.isArray(stops) || stops.length < 2) {
      return res.status(400).json({ error: "Precisa de pelo menos 2 paradas" });
    }

    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key)
      return res
        .status(500)
        .json({ error: "GOOGLE_MAPS_API_KEY não configurada" });

    const points = normalizeStops(stops);
    if (points.length < 2)
      return res.status(400).json({ error: "Paradas sem lat/lng suficiente" });

    const useDepot = hasDepotAddress(depot_address);
    const origin = useDepot ? String(depot_address).trim() : points[0].loc;
    const destination = origin;

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
      return res
        .status(400)
        .json({ error: j.status, details: j.error_message || null });
    }

    const waypointOrder = j.routes?.[0]?.waypoint_order || [];
    const orderedIds = waypointOrder
      .map((idx) => (useDepot ? points[idx] : points[idx + 1])?.id)
      .filter(Boolean);

    if (!useDepot) orderedIds.unshift(points[0].id);

    return res.json({ order: orderedIds });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// =========================================================
// API: ROUTE (Polyline real)
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
    if (!key)
      return res
        .status(500)
        .json({ error: "GOOGLE_MAPS_API_KEY não configurada" });

    const points = normalizeStops(stops);
    if (points.length < 2)
      return res.status(400).json({ error: "Paradas sem lat/lng suficiente" });

    const useDepot = hasDepotAddress(depot_address);
    const origin = useDepot ? String(depot_address).trim() : points[0].loc;
    const destination = origin;

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
      return res
        .status(400)
        .json({ error: j.status, details: j.error_message || null });
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
        .map((idx) => (useDepot ? points[idx] : points[idx + 1])?.id)
        .filter(Boolean);
      if (!useDepot) orderedIds.unshift(points[0].id);
    }

    return res.json({ polyline, legs, orderedIds });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// =========================================================
// API: CREATE ROUTE (por rota: driver + vehicle)
// POST /api/routes/create
// body: { vehicle_id, driver_id, depot_address?, delivery_ids: [] }
// =========================================================
app.post("/api/routes/create", async (req, res) => {
  try {
    const { vehicle_id, driver_id, depot_address, delivery_ids } =
      req.body || {};

    if (!vehicle_id)
      return res.status(400).json({ error: "vehicle_id obrigatório" });
    if (!driver_id)
      return res.status(400).json({ error: "driver_id obrigatório" });
    if (!Array.isArray(delivery_ids) || delivery_ids.length < 2) {
      return res
        .status(400)
        .json({ error: "delivery_ids precisa ter pelo menos 2 itens" });
    }

    // 1) cria rota
    const { data: routeRow, error: rErr } = await supabaseAdmin
      .from("routes")
      .insert([
        {
          vehicle_id,
          driver_id,
          depot_address: depot_address || null,
          status: "ativa",
        },
      ])
      .select("id")
      .single();

    if (rErr || !routeRow?.id) {
      return res
        .status(400)
        .json({ error: "Falha ao criar rota", details: rErr?.message || null });
    }

    const route_id = routeRow.id;

    // 2) cria paradas (ordem inicial 1..N)
    const stopsRows = delivery_ids.map((delivery_id, idx) => ({
      route_id,
      delivery_id,
      stop_order: idx + 1,
      eta_seconds: null,
      leg_seconds: null,
    }));

    const { error: sErr } = await supabaseAdmin
      .from("route_stops")
      .insert(stopsRows);
    if (sErr) {
      return res
        .status(400)
        .json({ error: "Falha ao inserir route_stops", details: sErr.message });
    }

    // 3) seta deliveries como "em_rota" (ATENÇÃO: seu CHECK precisa permitir esse status)
    const { error: dErr } = await supabaseAdmin
      .from("deliveries")
      .update({ status: "em_rota" })
      .in("id", delivery_ids);

    if (dErr) {
      return res.status(400).json({
        error: "Rota criada, mas falhou ao atualizar entregas",
        details: dErr.message,
        route_id,
      });
    }

    return res.json({ ok: true, route_id });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// =========================================================
// API: OPTIMIZE ROUTE (reordena stop_order com função SQL)
// POST /api/routes/:routeId/optimize
// =========================================================
app.post("/api/routes/:routeId/optimize", async (req, res) => {
  try {
    const routeId = req.params.routeId;

    // 1) pega rota
    const { data: routeRow, error: rErr } = await supabaseAdmin
      .from("routes")
      .select("id, depot_address")
      .eq("id", routeId)
      .single();

    if (rErr || !routeRow?.id) {
      return res
        .status(404)
        .json({ error: "Rota não encontrada", details: rErr?.message || null });
    }

    // 2) pega stops na ordem atual
    const { data: stops, error: sErr } = await supabaseAdmin
      .from("route_stops")
      .select("stop_order, deliveries:delivery_id (id, lat, lng)")
      .eq("route_id", routeId)
      .order("stop_order", { ascending: true });

    if (sErr)
      return res
        .status(400)
        .json({ error: "Erro ao buscar paradas", details: sErr.message });

    const points = (stops || [])
      .map((x) => x?.deliveries)
      .filter((d) => d?.id && Number.isFinite(d.lat) && Number.isFinite(d.lng))
      .map((d) => ({ id: d.id, lat: d.lat, lng: d.lng }));

    if (points.length < 2)
      return res
        .status(400)
        .json({ error: "Rota precisa de 2+ paradas com lat/lng" });

    // 3) chama /api/optimize internamente
    const optResp = await fetchFn(`http://127.0.0.1:${PORT}/api/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stops: points,
        depot_address: routeRow.depot_address || null,
      }),
    });

    const optJson = await optResp.json().catch(() => null);
    if (!optResp.ok || !optJson?.order?.length) {
      return res
        .status(400)
        .json({ error: "Falha ao otimizar", details: optJson?.error || null });
    }

    const orderedDeliveryIds = optJson.order;

    // 4) reordena no banco usando função SQL (sem colisão)
    const { error: rpcErr } = await supabaseAdmin.rpc("reorder_route_stops", {
      p_route_id: routeId,
      p_ordered_delivery_ids: orderedDeliveryIds,
    });

    if (rpcErr) {
      return res
        .status(400)
        .json({ error: "Falha ao reordenar", details: rpcErr.message });
    }

    return res.json({ ok: true, route_id: routeId, order: orderedDeliveryIds });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// =========================================================
// Static (Vite build) + SPA fallback
// =========================================================
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));
app.use((req, res) => res.sendFile(path.join(distPath, "index.html")));

app.listen(PORT, () => console.log("Server running on port", PORT));
