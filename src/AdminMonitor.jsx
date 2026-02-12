import { useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
} from "react-leaflet";
import { supabase } from "./supabase";
import ExcelImport from "./ExcelImport";
import ManualRoutePlanner from "./ManualRoutePlanner";

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
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeMsg, setRouteMsg] = useState("");
  const [vehicles, setVehicles] = useState([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState("");

  // ===== Polyline Google (rota nas ruas) =====
  const [routeLine, setRouteLine] = useState([]); // array de [lat,lng]
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

  async function drawRoutePolyline(routeId) {
    try {
      setRouteLineMsg("Desenhando rota (ruas)...");
      setRouteLine([]);

      // 1) pega depot_address da rota
      const { data: routeRow, error: rErr } = await supabase
        .from("routes")
        .select("id, depot_address")
        .eq("id", routeId)
        .single();

      if (rErr || !routeRow?.id) {
        setRouteLineMsg(
          "Erro ao buscar rota: " + (rErr?.message || "sem rota"),
        );
        return;
      }

      // 2) pega paradas + lat/lng na ordem atual
      const { data: stops, error: sErr } = await supabase
        .from("route_stops")
        .select("stop_order, deliveries:delivery_id (id, lat, lng)")
        .eq("route_id", routeId)
        .order("stop_order", { ascending: true });

      if (sErr) {
        setRouteLineMsg("Erro ao buscar paradas: " + sErr.message);
        return;
      }

      const points = (stops || [])
        .map((x) => x?.deliveries)
        .filter(
          (d) => d?.id && Number.isFinite(d?.lat) && Number.isFinite(d?.lng),
        )
        .map((d) => ({ id: d.id, lat: d.lat, lng: d.lng }));

      if (points.length < 2) {
        setRouteLineMsg("Rota precisa de pelo menos 2 paradas com lat/lng.");
        return;
      }

      // 3) chama backend para obter polyline real (sem re-otimizar aqui)
      const resp = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stops: points,
          depot_address: routeRow.depot_address || null,
          optimize: false, // desenhar no order atual do banco
        }),
      });

      const j = await resp.json().catch(() => null);
      if (!resp.ok || !j?.polyline) {
        setRouteLineMsg(
          "Falha ao gerar polyline: " + (j?.error || "erro desconhecido"),
        );
        return;
      }

      const coords = decodePolyline(j.polyline);
      setRouteLine(coords);
      setRouteLineMsg(coords.length ? "" : "Polyline vazia.");
    } catch (e) {
      setRouteLineMsg("Erro inesperado: " + String(e?.message || e));
    }
  }

  async function geocodificarPendentes() {
    setGeoMsg("");
    setGeoBusy(true);

    try {
      // 1) pega entregas sem lat/lng
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
      // 🔎 filtra apenas entregas com dados mínimos para geocodificar
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
          // rate limit (respeito ao Nominatim)
          await new Promise((r) => setTimeout(r, 1100));

          const rua = String(d.rua || "").trim();
          const numero = String(d.numero || "").trim();
          const bairro = String(d.bairro || "").trim();
          const cidade = String(d.cidade || "Manaus").trim() || "Manaus";
          const estado = String(d.estado || "AM").trim() || "AM";

          // se já tiver endereco_completo, usa ele; senão monta na hora
          let qBase = String(d.endereco_completo || "").trim();

          if (!qBase) {
            qBase = [rua, numero, bairro, `${cidade} - ${estado}`, "Brasil"]
              .filter(Boolean)
              .join(", ");
          }

          const q = qBase.replace(/\s+/g, " ").trim();
          const qFinal = /manaus/i.test(q) ? q : `${q}, Manaus - AM, Brasil`;

          const base = import.meta.env.VITE_FUNCTIONS_BASE || "";
          const url = `/api/geocode?q=${encodeURIComponent(qFinal)}`;

          const resp = await fetch(url);

          // Se a function não existe / deu erro, pare e mostre
          if (!resp.ok) {
            const txt = await resp.text();
            setGeoMsg(
              `❌ Erro na função geocode (HTTP ${resp.status}). Exemplo: ${txt.slice(0, 120)}...`,
            );
            return;
          }

          const raw = await resp.text();
          let j = null;

          try {
            j = raw ? JSON.parse(raw) : null;
          } catch (e) {
            setRouteMsg(
              `❌ Resposta não-JSON do servidor (HTTP ${resp.status}). Exemplo: ${raw.slice(0, 160)}...`,
            );
            return;
          }

          if (!j) {
            setRouteMsg(`❌ Resposta vazia do servidor (HTTP ${resp.status}).`);
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

          if (upErr) {
            fail++;
          } else {
            ok++;
          }
        } catch (e) {
          fail++;
        }
      }
      setGeoFails(fails);
      setGeoMsg(`✅ Geocodificação finalizada: ${ok} ok, ${fail} falhas.`);
    } catch (e) {
      setGeoMsg(
        "❌ Erro inesperado na geocodificação: " + String(e?.message || e),
      );
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
  async function desenharRotaAtivaDoVeiculo() {
    try {
      setRouteLineMsg("");
      setRouteLine([]);

      if (!selectedVehicleId) {
        setRouteLineMsg("Selecione um veículo.");
        return;
      }

      // pega rota ativa do veículo
      const { data: r, error: rErr } = await supabase
        .from("routes")
        .select("id, status, created_at")
        .eq("vehicle_id", selectedVehicleId)
        .eq("status", "ativa")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (rErr || !r?.id) {
        setRouteLineMsg("Nenhuma rota ativa encontrada para este veículo.");
        return;
      }

      await drawRoutePolyline(r.id);
    } catch (e) {
      setRouteLineMsg("Erro inesperado: " + String(e?.message || e));
    }
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
        .order("created_at", { ascending: false })
        .limit(500);

      if (error) {
        setStatus("Erro: " + error.message);
        return;
      }

      setLatestRows(groupLatestByDriver(data));
      for (const row of groupLatestByDriver(data)) {
        getDriverVehicleLabel(row.driver_id).then((label) => {
          setDriverVehicles((prev) => ({ ...prev, [row.driver_id]: label }));
        });
      }
      for (const row of groupLatestByDriver(data)) {
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
      // carregar veículos para gerar rota
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
  // quando a polyline mudar, limpa mensagem
  useEffect(() => {
    if (routeLine && routeLine.length > 0) {
      setRouteLineMsg("");
    }
  }, [routeLine]);

  async function gerarRotaOtimizada() {
    try {
      setRouteMsg("");
      setRouteBusy(true);

      if (!selectedVehicleId) {
        setRouteMsg("Selecione um veículo.");
        return;
      }

      // 1) pegar entregas pendentes com lat/lng
      const { data: pend, error: pendErr } = await supabase
        .from("deliveries")
        .select("id, pedido, cliente, endereco_completo, lat, lng, status")
        .in("status", ["em_rota", "pendente"])
        .not("lat", "is", null)
        .not("lng", "is", null)
        .order("created_at", { ascending: true })
        .limit(20);

      if (pendErr) {
        setRouteMsg("Erro buscando entregas: " + pendErr.message);
        return;
      }
      if (!pend || pend.length < 2) {
        setRouteMsg(
          "Precisa de pelo menos 2 entregas pendentes geocodificadas.",
        );
        return;
      }

      // 2) chamar API do servidor para otimizar
      const depot = { lat: -3.119, lng: -60.0217 }; // centro aproximado (depois refinamos para o endereço exato)
      const stops = pend.map((d) => ({ id: d.id, lat: d.lat, lng: d.lng }));

      const resp = await fetch("/api/optimize-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depot, stops }),
      });

      const j = await resp.json();
      if (!j?.ok) {
        setRouteMsg("Falha ao otimizar: " + (j?.status || "erro"));
        return;
      }

      // 3) criar rota no banco
      const depotAddress = "Av. Tefé, 2840 - Japiim, Manaus - AM";
      const { data: routeRow, error: rErr } = await supabase
        .from("routes")
        .insert([
          { vehicle_id: selectedVehicleId, depot_address: depotAddress },
        ])
        .select("*")
        .single();

      if (rErr || !routeRow?.id) {
        setRouteMsg("Erro criando rota: " + (rErr?.message || "desconhecido"));
        return;
      }

      // 4) inserir paradas ordenadas
      const stopsRows = j.ordered.map((s) => ({
        route_id: routeRow.id,
        delivery_id: s.id,
        stop_order: s.stop_order,
        eta_seconds: s.eta_seconds ?? null,
        leg_seconds: s.leg_seconds ?? null,
      }));

      const { error: sErr } = await supabase
        .from("route_stops")
        .insert(stopsRows);
      if (sErr) {
        setRouteMsg("Erro salvando paradas: " + sErr.message);
        return;
      }

      setRouteMsg(`✅ Rota criada e otimizada! (${stopsRows.length} paradas)`);
    } catch (e) {
      setRouteMsg("Erro inesperado: " + String(e?.message || e));
    } finally {
      setRouteBusy(false);
    }
  }

  return (
    <div style={{ fontFamily: "Arial", padding: 16 }}>
      <h2>Painel Administrativo — Caminhões ao vivo</h2>
      <p>
        <strong>Entregas carregadas:</strong> {deliveries?.length ?? 0}
      </p>
      <p>
        <strong>Status:</strong> {status}
      </p>
      <ExcelImport
        onImported={async () => {
          const { data: del, error: delErr } = await supabase
            .from("deliveries")
            .select(
              "id, pedido, cliente, endereco_completo, status, photo_url, completed_at, created_at",
            )
            .order("created_at", { ascending: false })
            .limit(50);

          if (!delErr && del) setDeliveries(del);
        }}
      />
      <div style={{ marginTop: 12 }}>
        <ManualRoutePlanner
          onRouteCreated={async () => {
            const { data: del, error: delErr } = await supabase
              .from("deliveries")
              .select(
                "id, pedido, cliente, endereco_completo, status, photo_url, completed_at, created_at",
              )
              .order("created_at", { ascending: false })
              .limit(50);

            if (!delErr && del) setDeliveries(del);
          }}
        />
      </div>

      <div
        style={{
          marginTop: 10,
          padding: 12,
          border: "1px solid #ddd",
          borderRadius: 12,
        }}
      >
        <h3>Gerar rota (otimizada)</h3>

        <div style={{ display: "grid", gap: 10 }}>
          <label>
            <div style={{ fontSize: 13, opacity: 0.8 }}>Veículo</div>
            <select
              value={selectedVehicleId}
              onChange={(e) => setSelectedVehicleId(e.target.value)}
              style={{ width: "100%", padding: 10, borderRadius: 10 }}
            >
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {v.plate}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={desenharRotaAtivaDoVeiculo}
            disabled={routeBusy}
            style={{ padding: "12px 14px", borderRadius: 12, fontWeight: 800 }}
          >
            Desenhar rota no mapa (rota ativa)
          </button>

          {routeLineMsg && (
            <div style={{ fontSize: 13, opacity: 0.85 }}>{routeLineMsg}</div>
          )}

          {routeMsg && <div>{routeMsg}</div>}
        </div>
      </div>

      <div
        style={{
          marginTop: 10,
          display: "flex",
          gap: 10,
          alignItems: "center",
        }}
      >
        <button
          onClick={geocodificarPendentes}
          disabled={geoBusy}
          style={{ padding: "10px 14px" }}
        >
          {geoBusy ? "Geocodificando..." : "Geocodificar endereços (OSM)"}
        </button>
        {geoMsg && <span>{geoMsg}</span>}
      </div>
      {geoFails.length > 0 && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            border: "1px solid #eee",
            borderRadius: 10,
          }}
        >
          <strong>Falharam ({geoFails.length}):</strong>
          <ul>
            {geoFails.map((f, i) => (
              <li key={i}>{f.endereco}</li>
            ))}
          </ul>
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            Dica: acrescente número, bairro e “Manaus - AM, Brasil”.
          </div>
        </div>
      )}
      <div
        style={{
          height: 520,
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid #ddd",
        }}
      >
        <MapContainer
          center={center}
          zoom={12}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
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
          {/* ===== POLYLINE (rota real nas ruas) ===== */}
          {routeLine && routeLine.length > 0 && (
            <Polyline
              positions={routeLine}
              pathOptions={{ weight: 5, opacity: 0.9 }}
            />
          )}
        </MapContainer>
      </div>
      <hr style={{ margin: "16px 0" }} />

      <h3>Entregas (últimas 50)</h3>

      <div style={{ display: "grid", gap: 10 }}>
        {deliveries.map((d) => (
          <div
            key={d.id}
            style={{
              border: "1px solid #ddd",
              borderRadius: 10,
              padding: 12,
            }}
          >
            <div>
              <strong>Pedido:</strong> {d.pedido}
            </div>
            <div>
              <strong>Cliente:</strong> {d.cliente}
            </div>
            <div>
              <strong>Endereço:</strong> {d.endereco_completo}
            </div>
            <div>
              <strong>Status:</strong> {d.status}
            </div>
            <div>
              <strong>Concluída:</strong>{" "}
              {d.completed_at ? new Date(d.completed_at).toLocaleString() : "—"}
            </div>

            {d.photo_url ? (
              <a href={d.photo_url} target="_blank" rel="noreferrer">
                Abrir foto
              </a>
            ) : (
              <div style={{ opacity: 0.7 }}>Sem foto</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
