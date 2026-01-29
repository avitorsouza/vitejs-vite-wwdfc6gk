import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import { supabase } from "./supabase";
import ExcelImport from "./ExcelImport";


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

export default function AdminLiveMap() {
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
    (d.rua && d.numero && d.bairro)
);

if (valid.length === 0) {
  setGeoMsg(
    "Nenhuma entrega tem dados suficientes (rua + número + bairro ou endereco_completo)."
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
  const url = `${base}/.netlify/functions/geocode?q=${encodeURIComponent(qFinal)}`;

  const resp = await fetch(url);

  
          // Se a function não existe / deu erro, pare e mostre
          if (!resp.ok) {
            const txt = await resp.text();
            setGeoMsg(`❌ Erro na função geocode (HTTP ${resp.status}). Exemplo: ${txt.slice(0, 120)}...`);
            return;
          }
  
          const j = await resp.json();
  
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
      setGeoMsg("❌ Erro inesperado na geocodificação: " + String(e?.message || e));
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

  const label =
    !vErr && v ? `${v.name} — ${v.plate}` : "—";

  vehicleCacheRef.current.set(driverId, label);
  return label;
}
const center = useMemo(() => [-3.1190, -60.0217], []);

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
        .select("id, cliente, endereco_completo, pedido, status, photo_url, completed_at, created_at")
        .order("created_at", { ascending: false })
        .limit(50);

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
  }
)
.subscribe();
      setStatus("Ao vivo ✅");
      channelLoc = supabase
        .channel("realtime-driver-locations")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "driver_locations" },
          (payload) => {
            const row = payload.new;
            getDriverVehicleLabel(row.driver_id).then((label) => {
              setDriverVehicles((prev) => ({ ...prev, [row.driver_id]: label }));
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
            
          }
        )
        .subscribe();
    }

    init();

    return () => {
      if (channelLoc) supabase.removeChannel(channelLoc);
      if (channelDel) supabase.removeChannel(channelDel);
    };
    
  }, []);

  return (
    <div style={{ fontFamily: "Arial", padding: 16 }}>
      <h2>Painel Administrativo — Caminhões ao vivo</h2>
      <p><strong>Entregas carregadas:</strong> {deliveries?.length ?? 0}</p>
      <p><strong>Status:</strong> {status}</p>
      <ExcelImport
    onImported={async () => {
      const { data: del, error: delErr } = await supabase
        .from("deliveries")
        .select("id, cliente, endereco, status, photo_url, completed_at, created_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if (!delErr && del) setDeliveries(del);
    }}
  />
  <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
  <button onClick={geocodificarPendentes} disabled={geoBusy} style={{ padding: "10px 14px" }}>
    {geoBusy ? "Geocodificando..." : "Geocodificar endereços (OSM)"}
  </button>
  {geoMsg && <span>{geoMsg}</span>}
</div>
{geoFails.length > 0 && (
    <div style={{ marginTop: 10, padding: 10, border: "1px solid #eee", borderRadius: 10 }}>
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
      <div style={{ height: 520, borderRadius: 12, overflow: "hidden", border: "1px solid #ddd" }}>
        <MapContainer center={center} zoom={12} style={{ height: "100%", width: "100%" }}>
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
            {latestRows.map((r) => (
            <Marker key={r.driver_id} position={[r.lat, r.lng]}>
              <Popup>
                <div>
                <div><strong>Motorista:</strong> {driverNames[r.driver_id] ?? r.driver_id}</div>
                <div><strong>Veículo:</strong> {driverVehicles[r.driver_id] ?? "—"}</div>
                <div><strong>Hora:</strong> {new Date(r.created_at).toLocaleString()}</div>
                <div><strong>Velocidade:</strong> {r.speed ?? "—"}</div>
                </div>
              </Popup>
            </Marker>
          ))}
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
      <div><strong>Pedido:</strong> {d.pedido}</div>
      <div><strong>Cliente:</strong> {d.cliente}</div>
      <div><strong>Endereço:</strong> {d.endereco_completo}</div>
      <div><strong>Status:</strong> {d.status}</div>
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
