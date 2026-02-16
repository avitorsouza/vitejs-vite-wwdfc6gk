import AdminRoutesSummary from "./AdminRoutesSummary";
import DriverVehicleLinker from "./DriverVehicleLinker";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
} from "react-leaflet";
import { supabase } from "./supabase";

function groupLatestByDriver(rows) {
  const map = new Map();
  for (const r of rows) {
    const existing = map.get(r.driver_id);
    if (!existing) map.set(r.driver_id, r);
    else {
      const t1 = new Date(existing.created_at).getTime();
      const t2 = new Date(r.created_at).getTime();
      if (t2 > t1) map.set(r.driver_id, r);
    }
  }
  return Array.from(map.values());
}

export default function AdminMonitor() {
  const [latestRows, setLatestRows] = useState([]);
  const [status, setStatus] = useState("Carregando...");
  const [driverNames, setDriverNames] = useState({});
  const nameCacheRef = useRef(new Map());
  const [driverVehicles, setDriverVehicles] = useState({});
  const vehicleCacheRef = useRef(new Map());

  const [deliveries, setDeliveries] = useState([]);
  const [geoMsg, setGeoMsg] = useState("");
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoFails, setGeoFails] = useState([]);

  const [routeMsg, setRouteMsg] = useState("");
  const [vehicles, setVehicles] = useState([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState("");

  // ===== POLYLINES DAS ROTAS ATIVAS (cores diferentes) =====
  const [activeRouteLines, setActiveRouteLines] = useState([]);
  const [routeLineMsg, setRouteLineMsg] = useState("");

  function decodePolyline(encoded) {
    if (!encoded) return [];
    let index = 0,
      lat = 0,
      lng = 0;
    const coordinates = [];

    while (index < encoded.length) {
      let b,
        shift = 0,
        result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlat = result & 1 ? ~(result >> 1) : result >> 1;
      lat += dlat;

      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlng = result & 1 ? ~(result >> 1) : result >> 1;
      lng += dlng;

      coordinates.push([lat / 1e5, lng / 1e5]);
    }
    return coordinates;
  }

  const ROUTE_COLORS = [
    "#2563eb",
    "#16a34a",
    "#dc2626",
    "#9333ea",
    "#ea580c",
    "#0891b2",
    "#ca8a04",
    "#4f46e5",
    "#059669",
    "#be123c",
  ];

  function colorForIndex(i) {
    return ROUTE_COLORS[i % ROUTE_COLORS.length];
  }

  async function loadAllActiveRoutesPolylines() {
    try {
      setRouteLineMsg("Desenhando rotas ativas (ruas)...");
      setActiveRouteLines([]);

      // 1) rotas ativas + veículo
      const { data: routes, error: rErr } = await supabase
        .from("routes")
        .select(
          "id, depot_address, vehicle_id, created_at, vehicles:vehicle_id (name, plate)",
        )
        .eq("status", "ativa")
        .order("created_at", { ascending: false })
        .limit(50);

      if (rErr) {
        setRouteLineMsg("Erro ao buscar rotas ativas: " + rErr.message);
        return;
      }

      if (!routes || routes.length === 0) {
        setRouteLineMsg("Nenhuma rota ativa para desenhar.");
        return;
      }

      // 2) paradas dessas rotas
      const routeIds = routes.map((r) => r.id);

      const { data: stops, error: sErr } = await supabase
        .from("route_stops")
        .select("route_id, stop_order, deliveries:delivery_id (id, lat, lng)")
        .in("route_id", routeIds)
        .order("stop_order", { ascending: true })
        .limit(10000);

      if (sErr) {
        setRouteLineMsg("Erro ao buscar paradas: " + sErr.message);
        return;
      }

      // 3) agrupar por route_id
      const byRoute = new Map();
      for (const r of routes) byRoute.set(r.id, []);
      for (const s of stops || []) {
        const d = s?.deliveries;
        if (!d?.id || !Number.isFinite(d.lat) || !Number.isFinite(d.lng))
          continue;
        if (!byRoute.has(s.route_id)) byRoute.set(s.route_id, []);
        byRoute.get(s.route_id).push({
          id: d.id,
          lat: d.lat,
          lng: d.lng,
          stop_order: s.stop_order,
        });
      }

      // 4) gerar polyline real via /api/route
      const lines = [];
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        const points = (byRoute.get(r.id) || []).sort(
          (a, b) => (a.stop_order ?? 0) - (b.stop_order ?? 0),
        );

        if (points.length < 2) continue;

        const resp = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stops: points.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng })),
            depot_address: r.depot_address || null,
            optimize: false, // desenha exatamente na ordem do banco
          }),
        });

        const j = await resp.json().catch(() => null);
        if (!resp.ok || !j?.polyline) continue;

        const coords = decodePolyline(j.polyline);
        if (!coords.length) continue;

        const vehicleLabel = r?.vehicles
          ? `${r.vehicles.name ?? "Veículo"} — ${r.vehicles.plate ?? "—"}`
          : `Veículo ${r.vehicle_id}`;

        lines.push({
          routeId: r.id,
          vehicleLabel,
          coords,
          color: colorForIndex(i),
        });
      }

      setActiveRouteLines(lines);
      setRouteLineMsg(
        lines.length ? "" : "Não consegui gerar polyline para as rotas ativas.",
      );
    } catch (e) {
      setRouteLineMsg(
        "Erro inesperado ao desenhar rotas: " + String(e?.message || e),
      );
    }
  }

  async function geocodificarPendentes() {
    setGeoMsg("");
    setGeoBusy(true);

    try {
      const { data: list, error } = await supabase
        .from("deliveries")
        .select("id, rua, numero, bairro, cidade, estado, endereco_completo")
        .is("lat", null)
        .limit(30);

      if (error) {
        setGeoMsg("Erro buscando pendentes: " + error.message);
        return;
      }

      if (!list || list.length === 0) {
        setGeoMsg("✅ Nenhuma entrega pendente para geocodificar.");
        return;
      }

      const valid = list.filter(
        (d) =>
          (d.endereco_completo && String(d.endereco_completo).trim()) ||
          (d.rua && d.numero && d.bairro),
      );

      if (valid.length === 0) {
        setGeoMsg(
          "Nenhuma entrega tem dados suficientes (rua + número + bairro ou endereco_completo).",
        );
        return;
      }

      let ok = 0;
      let fail = 0;
      const fails = [];

      for (const d of valid) {
        try {
          await new Promise((r) => setTimeout(r, 1100));

          const rua = String(d.rua || "").trim();
          const numero = String(d.numero || "").trim();
          const bairro = String(d.bairro || "").trim();
          const cidade = String(d.cidade || "Manaus").trim() || "Manaus";
          const estado = String(d.estado || "AM").trim() || "AM";

          let qBase = String(d.endereco_completo || "").trim();
          if (!qBase) {
            qBase = [rua, numero, bairro, `${cidade} - ${estado}`, "Brasil"]
              .filter(Boolean)
              .join(", ");
          }

          const q = qBase.replace(/\s+/g, " ").trim();
          const qFinal = /manaus/i.test(q) ? q : `${q}, Manaus - AM, Brasil`;

          const url = `/api/geocode?q=${encodeURIComponent(qFinal)}`;
          const resp = await fetch(url);

          if (!resp.ok) {
            const txt = await resp.text();
            setGeoMsg(
              `❌ Erro na função geocode (HTTP ${resp.status}). Exemplo: ${txt.slice(
                0,
                120,
              )}...`,
            );
            return;
          }

          const raw = await resp.text();
          let j = null;
          try {
            j = raw ? JSON.parse(raw) : null;
          } catch (e) {
            setGeoMsg(
              `❌ Resposta não-JSON do servidor (HTTP ${resp.status}). Exemplo: ${raw.slice(
                0,
                160,
              )}...`,
            );
            return;
          }

          if (!j?.found || !Number.isFinite(j.lat) || !Number.isFinite(j.lng)) {
            fail++;
            fails.push({ endereco: qFinal });
            continue;
          }

          const { error: upErr } = await supabase
            .from("deliveries")
            .update({ lat: j.lat, lng: j.lng })
            .eq("id", d.id);

          if (upErr) fail++;
          else ok++;
        } catch (e) {
          fail++;
        }
      }

      setGeoFails(fails);
      setGeoMsg(`✅ Geocodificação finalizada: ${ok} ok, ${fail} falhas.`);
    } catch (e) {
      setGeoMsg("❌ Erro inesperado: " + String(e?.message || e));
    } finally {
      setGeoBusy(false);
    }
  }

  async function getDriverName(driverId) {
    const cached = nameCacheRef.current.get(driverId);
    if (cached) return cached;

    const { data, error } = await supabase
      .from("profiles")
      .select("name")
      .eq("id", driverId)
      .single();

    const name = !error && data?.name ? data.name : driverId;
    nameCacheRef.current.set(driverId, name);
    return name;
  }

  async function getDriverVehicleLabel(driverId) {
    const cached = vehicleCacheRef.current.get(driverId);
    if (cached) return cached;

    const { data: link, error: linkErr } = await supabase
      .from("driver_vehicle")
      .select("vehicle_id")
      .eq("driver_id", driverId)
      .single();

    if (linkErr || !link?.vehicle_id) {
      const fallback = "—";
      vehicleCacheRef.current.set(driverId, fallback);
      return fallback;
    }

    const { data: v, error: vErr } = await supabase
      .from("vehicles")
      .select("name, plate")
      .eq("id", link.vehicle_id)
      .single();

    const label = !vErr && v ? `${v.name} — ${v.plate}` : "—";
    vehicleCacheRef.current.set(driverId, label);
    return label;
  }

  const center = useMemo(() => [-3.119, -60.0217], []);

  useEffect(() => {
    let channelLoc;
    let channelDel;

    async function init() {
      setStatus("Buscando últimas posições...");

      const { data, error } = await supabase
        .from("driver_locations")
        .select("*")
        .limit(500);

      if (error) {
        setStatus("Erro: " + error.message);
        return;
      }

      const latest = groupLatestByDriver(data || []);
      setLatestRows(latest);

      for (const row of latest) {
        getDriverVehicleLabel(row.driver_id).then((label) => {
          setDriverVehicles((prev) => ({ ...prev, [row.driver_id]: label }));
        });
        getDriverName(row.driver_id).then((name) => {
          setDriverNames((prev) => ({ ...prev, [row.driver_id]: name }));
        });
      }

      const { data: del, error: delErr } = await supabase
        .from("deliveries")
        .select(
          "id, cliente, endereco_completo, pedido, status, photo_url, completed_at, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(200);

      if (!delErr && del) setDeliveries(del);

      channelDel = supabase
        .channel("realtime-deliveries")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "deliveries" },
          (payload) => {
            const row = payload.new;
            setDeliveries((prev) => {
              const idx = prev.findIndex((d) => d.id === row.id);
              if (idx !== -1) {
                const copy = [...prev];
                copy[idx] = row;
                return copy;
              }
              return [row, ...prev];
            });
          },
        )
        .subscribe();

      const { data: vs, error: vsErr } = await supabase
        .from("vehicles")
        .select("id, name, plate")
        .order("name", { ascending: true });

      if (!vsErr && vs) {
        setVehicles(vs);
        if (vs[0]?.id) setSelectedVehicleId(vs[0].id);
      }

      setStatus("Ao vivo ✅");

      channelLoc = supabase
        .channel("realtime-driver-locations")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "driver_locations" },
          (payload) => {
            const row = payload.new;

            getDriverVehicleLabel(row.driver_id).then((label) => {
              setDriverVehicles((prev) => ({
                ...prev,
                [row.driver_id]: label,
              }));
            });

            setLatestRows((prev) => {
              const copy = [...prev];
              const idx = copy.findIndex((x) => x.driver_id === row.driver_id);
              if (idx === -1) return [row, ...copy];
              copy[idx] = row;
              return copy;
            });

            getDriverName(row.driver_id).then((name) => {
              setDriverNames((prev) => ({ ...prev, [row.driver_id]: name }));
            });
          },
        )
        .subscribe();
    }

    init();

    return () => {
      if (channelLoc) supabase.removeChannel(channelLoc);
      if (channelDel) supabase.removeChannel(channelDel);
    };
  }, []);

  // desenhar rotas ativas automaticamente
  useEffect(() => {
    loadAllActiveRoutesPolylines();
    const t = setInterval(loadAllActiveRoutesPolylines, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ fontFamily: "Arial", padding: 16 }}>
      <h2 style={{ margin: 0 }}>Monitor — Rotas ativas no mapa</h2>

      {/* Resumo — Entregas por caminhão (rotas ativas) */}
      <div style={{ marginTop: 12 }}>
        <AdminRoutesSummary />
      </div>

      {/* MAPA */}
      <div
        style={{
          marginTop: 12,
          height: 620,
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid #ddd",
        }}
      >
        <DriverVehicleLinker />
        <MapContainer
          center={center}
          zoom={12}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {/* Polylines das rotas ativas */}
          {activeRouteLines.map((r) => (
            <Polyline
              key={r.routeId}
              positions={r.coords}
              pathOptions={{ color: r.color, weight: 5, opacity: 0.85 }}
            >
              <Popup>
                <div style={{ fontWeight: 900 }}>Rota ativa</div>
                <div>
                  <strong>Veículo:</strong> {r.vehicleLabel}
                </div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>
                  <strong>ID:</strong> {r.routeId}
                </div>
              </Popup>
            </Polyline>
          ))}

          {/* Marcadores dos motoristas */}
          {latestRows.map((r) => (
            <Marker key={r.driver_id} position={[r.lat, r.lng]}>
              <Popup>
                <div>
                  <div>
                    <strong>Motorista:</strong>{" "}
                    {driverNames[r.driver_id] ?? r.driver_id}
                  </div>
                  <div>
                    <strong>Veículo:</strong>{" "}
                    {driverVehicles[r.driver_id] ?? "—"}
                  </div>
                  <div>
                    <strong>Hora:</strong>{" "}
                    {new Date(r.created_at).toLocaleString()}
                  </div>
                  <div>
                    <strong>Velocidade:</strong> {r.speed ?? "—"}
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {routeLineMsg && (
        <div style={{ marginTop: 10, opacity: 0.85 }}>{routeLineMsg}</div>
      )}
    </div>
  );
}
