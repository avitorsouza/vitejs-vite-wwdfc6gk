import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

function wazeUrlFromLatLng(lat, lng) {
  // Abre o Waze diretamente navegando para coordenadas
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}
export default function DriverTracker() {
  // ✅ NÃO abre aba em branco agora.
// Vamos tentar abrir o Waze depois, e só usar fallback se necessário.
 let preOpened = null;

  const [tracking, setTracking] = useState(false);
  const [user, setUser] = useState(null);
  const [currentStop, setCurrentStop] = useState(null);
  const [stops, setStops] = useState([]);
  const [isWide, setIsWide] = useState(window.innerWidth >= 900);
  const [stopsMsg, setStopsMsg] = useState("Carregando entregas...");
  const [status, setStatus] = useState("Parado");
  const [lastSent, setLastSent] = useState(null);
  const watchIdRef = useRef(null);
  const sendingRef = useRef(false);
  const DELIVERY_ID_TESTE = "c3d97c6e-0929-4771-a6ad-3178a4f270ad";
  const BUCKET_FOTOS = "foto-do-recebimento";

  const [deliveryStatus, setDeliveryStatus] = useState("entregue");
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadMsg, setUploadMsg] = useState("");


  const SEND_EVERY_MS = 15000;
  const lastSendAtRef = useRef(0);

  async function sendLocation({ lat, lng, speed, heading }) {
    if (sendingRef.current) return;
    sendingRef.current = true;

    try {
      const { data: auth } = await supabase.auth.getUser();
      const user = auth?.user;
      if (!user) {
        setStatus("Erro: não logado");
        return;
      }

      const payload = {
        driver_id: user.id,
        vehicle_id: null,
        lat,
        lng,
        speed: speed ?? null,
        heading: heading ?? null,
      };

      const { error } = await supabase.from("driver_locations").insert(payload);
      if (error) {
        setStatus("Erro ao enviar: " + error.message);
        return;
      }

      setLastSent(new Date().toLocaleTimeString());
      setStatus("Enviando ao vivo ✅");
    } finally {
      sendingRef.current = false;
    }
  }

  function startTracking() {
    if (!navigator.geolocation) {
      setStatus("Seu celular/navegador não suporta GPS");
      return;
    }

    setStatus("Pedindo permissão de localização...");

    watchIdRef.current = navigator.geolocation.watchPosition(
      async (pos) => {
        const now = Date.now();
        if (now - lastSendAtRef.current < SEND_EVERY_MS) return;
        lastSendAtRef.current = now;

        await sendLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          speed: pos.coords.speed,
          heading: pos.coords.heading,
        });
      },
      (err) => setStatus("Erro GPS: " + err.message),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  }

  function stopTracking() {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setStatus("Parado");
  }
  async function enviarFotoEStatus() {
    setUploadMsg("");
  
    if (!selectedFile) {
      setUploadMsg("Selecione uma foto primeiro.");
      return;
    }
  
    try {
      const { data: auth } = await supabase.auth.getUser();
      const user = auth?.user;
      if (!user) {
        setUploadMsg("Erro: não logado.");
        return;
      }
  
      const ext = selectedFile.name.split(".").pop() || "jpg";
      // caminho: entrega / timestamp_usuario.ext
      const filePath = `${DELIVERY_ID_TESTE}/${Date.now()}_${user.id}.${ext}`;
  
      // 1) Upload da foto
      const { error: upErr } = await supabase.storage
        .from(BUCKET_FOTOS)
        .upload(filePath, selectedFile, { upsert: false });
  
      if (upErr) {
        setUploadMsg("Erro ao enviar foto: " + upErr.message);
        return;
      }
  
      // 2) URL pública
      const { data: pub } = supabase.storage
        .from(BUCKET_FOTOS)
        .getPublicUrl(filePath);
  
      const photoUrl = pub?.publicUrl;
  
      // 3) Atualizar entrega
      const { error: dbErr } = await supabase
        .from("deliveries")
        .update({
          status: deliveryStatus,
          photo_url: photoUrl,
          completed_at:
            deliveryStatus === "entregue"
              ? new Date().toISOString()
              : null,
        })
        .eq("id", DELIVERY_ID_TESTE);
  
      if (dbErr) {
        setUploadMsg("Erro ao salvar no banco: " + dbErr.message);
        return;
      }
  
      setUploadMsg("✅ Foto e status enviados com sucesso!");
      setSelectedFile(null);
    } catch (e) {
      setUploadMsg("Erro inesperado: " + String(e?.message || e));
    }
  }
  
  useEffect(() => () => stopTracking(), []);
  useEffect(() => {
  function onResize() {
    setIsWide(window.innerWidth >= 900);
  }
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}, []);

  useEffect(() => {
  function onResize() {
    setIsWide(window.innerWidth >= 900);
  }
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}, []);

  useEffect(() => {
  let alive = true;

  async function loadAuth() {
    const { data: sess } = await supabase.auth.getSession();
    if (!alive) return;
    setUser(sess?.session?.user || null);
  }

  loadAuth();

  const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
    setUser(session?.user || null);
  });

  return () => {
    alive = false;
    sub?.subscription?.unsubscribe?.();
  };
}, []);

useEffect(() => {
  let alive = true;

  async function loadStops() {
    if (!user?.id) {
      setStopsMsg("Carregando usuário...");
      return;
    }

    setStopsMsg("Carregando entregas...");

    // 1) descobrir veículo do motorista logado
    const { data: link, error: linkErr } = await supabase
      .from("driver_vehicle")
      .select("vehicle_id")
      .eq("driver_id", user.id)
      .single();

    if (linkErr || !link?.vehicle_id) {
      setStopsMsg("Seu usuário não está vinculado a um veículo.");
      setStops([]);
      setCurrentStop(null);
      return;
    }

    // 2) pegar a rota ativa
    const { data: r, error: rErr } = await supabase
      .from("routes")
      .select("id")
      .eq("vehicle_id", link.vehicle_id)
      .eq("status", "ativa")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (rErr || !r?.id) {
      setStopsMsg("Nenhuma rota ativa encontrada.");
      setStops([]);
      setCurrentStop(null);
      return;
    }

    // 3) buscar paradas
    const { data, error } = await supabase
      .from("route_stops")
      .select(`
        stop_order,
        deliveries:delivery_id (
          id, pedido, cliente, endereco_completo, lat, lng, status
        )
      `)
      .eq("route_id", r.id)
      .order("stop_order", { ascending: true });

    if (!alive) return;

    if (error) {
      setStopsMsg("Erro ao carregar rota: " + error.message);
      setStops([]);
      setCurrentStop(null);
      return;
    }

    const stopsList = (data || [])
      .map((x) => ({
        ...x.deliveries,
        stop_order: x.stop_order,
      }))
      .filter((d) => d?.status === "pendente");

    setStops(stopsList);
    setCurrentStop(stopsList[0] || null);
    setStopsMsg(stopsList.length ? "" : "Nenhuma entrega pendente.");
  }

  loadStops();

  return () => {
    alive = false;
  };

}, [user]);
async function reloadStops() {
    if (!user?.id) {
    setStopsMsg("Carregando usuário...");
    setStops([]);
    setCurrentStop(null);
    return null;
  }

  setStopsMsg("Carregando entregas...");

  // 1) descobrir veículo do motorista logado
  const { data: link, error: linkErr } = await supabase
    .from("driver_vehicle")
    .select("vehicle_id")
    .eq("driver_id", user.id)
    .single();

  if (linkErr || !link?.vehicle_id) {
    setStopsMsg("Seu usuário não está vinculado a um veículo.");
    setStops([]);
    setCurrentStop(null);
    return null;
  }

  // 2) pegar a rota ativa desse veículo (mais recente)
  const { data: r, error: rErr } = await supabase
    .from("routes")
    .select("id, status, created_at")
    .eq("vehicle_id", link.vehicle_id)
    .eq("status", "ativa")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (rErr || !r?.id) {
    setStopsMsg("Nenhuma rota ativa encontrada para seu veículo.");
    setStops([]);
    setCurrentStop(null);
    return null;
  }

  // 3) buscar paradas ordenadas + entrega vinculada
  const { data, error } = await supabase
    .from("route_stops")
    .select(`
      stop_order,
      eta_seconds,
      leg_seconds,
      deliveries:delivery_id (
        id, pedido, cliente, endereco_completo, lat, lng, status
      )
    `)
    .eq("route_id", r.id)
    .order("stop_order", { ascending: true });

  if (error) {
    setStopsMsg("Erro ao carregar rota: " + error.message);
    setStops([]);
    setCurrentStop(null);
    return null;
  }

  // 4) transformar no formato do driver e filtrar só pendentes
  const stopsList = (data || [])
    .map((x) => ({
      ...x.deliveries,
      stop_order: x.stop_order,
      eta_seconds: x.eta_seconds,
      leg_seconds: x.leg_seconds,
    }))
    .filter((d) => d?.status === "pendente" && Number.isFinite(d.lat) && Number.isFinite(d.lng));

  setStops(stopsList);
  setStopsMsg(stopsList.length ? "" : "Nenhuma parada pendente na rota.");

  const next = stopsList[0] || null;
  setCurrentStop(next);

  return next; // ✅ importante
}

function openInWazeFromStop(stop) {
  if (!stop) return;
  const url = wazeUrlFromLatLng(stop.lat, stop.lng);

  // ✅ sempre na mesma aba (não cria aba em branco)
  window.location.assign(url);
}

  function openNextInWaze() {
    if (!currentStop) return;
    window.open(wazeUrlFromLatLng(currentStop.lat, currentStop.lng), "_blank");
  }
  
async function concluirEntregaAtual() {
  if (!currentStop) return;

  const { error } = await supabase
    .from("deliveries")
    .update({ status: "entregue", completed_at: new Date().toISOString() })
    .eq("id", currentStop.id);

  if (error) {
    setStopsMsg("Erro ao concluir entrega: " + error.message);
    return;
  }

  const next = await reloadStops();

  if (!next) {
    setStopsMsg("✅ Entrega concluída. Não há próxima parada pendente.");
    return;
  }

  openInWazeFromStop(next);
}

  
    return (
  <div
    style={{
      fontFamily: "Arial",
      padding: 12,
      width: "100%",
      maxWidth: 980,
      margin: "0 auto",
      boxSizing: "border-box",
      overflowX: "hidden",
    }}
  >
    <h2 style={{ margin: 0 }}>Motorista — Rota do Dia</h2>

    {/* Status / Info */}
    <div
      style={{
        marginTop: 10,
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        padding: 12,
        background: "#fff",
        boxShadow: "0 1px 8px rgba(0,0,0,0.06)",
      }}
    >
      <div style={{ display: "grid", gap: 6 }}>
        <div>
          <strong>Status:</strong> {status}
        </div>
        <div>
          <strong>Último envio:</strong> {lastSent ?? "—"}
        </div>
        {stopsMsg && (
          <div style={{ padding: 10, borderRadius: 12, background: "#f9fafb" }}>
            {stopsMsg}
          </div>
        )}
      </div>
    </div>

    {/* GRID: mobile 1 coluna | desktop 2 colunas */}
    <div
      style={{
        marginTop: 12,
        display: "grid",
        gridTemplateColumns: isWide ? "1.15fr 0.85fr" : "1fr",
        gap: 12,
      }}
    >
      {/* COLUNA 1 — Ações + Entrega Atual + Upload */}
      <div style={{ display: "grid", gap: 12 }}>
        {/* Ações */}
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 12,
            background: "#fff",
            boxShadow: "0 1px 8px rgba(0,0,0,0.06)",
          }}
        >
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Ações</div>
          <button
  style={{
    marginTop: 10,
    padding: "14px 12px",
    width: "100%",
    borderRadius: 12,
    fontWeight: 900,
  }}
  disabled={!currentStop}
  onClick={() => openInWazeFromStop(currentStop)}
>
  Abrir no Waze (entrega atual)
</button>


          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <button
              onClick={startTracking}
              style={{ padding: "14px 12px", borderRadius: 12, fontWeight: 800 }}
            >
              Iniciar GPS
            </button>
            <button
              onClick={stopTracking}
              style={{ padding: "14px 12px", borderRadius: 12, fontWeight: 800 }}
            >
              Parar
            </button>
          </div>

          <button
            style={{
              marginTop: 10,
              padding: "14px 12px",
              width: "100%",
              borderRadius: 12,
              fontWeight: 900,
            }}
            disabled={!currentStop}
            onClick={openNextInWaze}
          >
            Ir para a próxima (Waze)
          </button>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
            <button
              style={{ padding: "14px 12px", borderRadius: 12, fontWeight: 800 }}
              disabled={!currentStop}
              onClick={concluirEntregaAtual}
            >
              Concluir entrega
            </button>

            <button
              style={{ padding: "14px 12px", borderRadius: 12, fontWeight: 800 }}
              onClick={reloadStops}
            >
              Recarregar lista
            </button>
          </div>
        </div>

        {/* Entrega Atual */}
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 12,
            background: "#fff",
            boxShadow: "0 1px 8px rgba(0,0,0,0.06)",
            wordBreak: "break-word",
          }}
        >
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Entrega atual</div>
          {currentStop?.stop_order != null && (
  <div style={{ marginBottom: 8, opacity: 0.75 }}>
    Parada #{currentStop.stop_order} • Restantes: {stops.length}
  </div>
)}
          {!currentStop ? (
            <div style={{ opacity: 0.8 }}>Nenhuma entrega selecionada ainda.</div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              <div>
                <strong>Pedido:</strong> {currentStop.pedido ?? "—"}
              </div>
              <div>
                <strong>Cliente:</strong> {currentStop.cliente ?? "—"}
              </div>
              <div>
                <strong>Endereço:</strong> {currentStop.endereco_completo ?? "—"}
              </div>
              <button
  style={{
    marginTop: 10,
    padding: "14px 12px",
    width: "100%",
    borderRadius: 12,
    fontWeight: 900,
  }}
  disabled={!currentStop}
  onClick={() => openInWazeFromStop(currentStop)}
>
  Abrir no Waze (entrega atual)
</button>

            </div>
          )}
        </div>

        {/* Upload (teste) */}
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 12,
            background: "#fff",
            boxShadow: "0 1px 8px rgba(0,0,0,0.06)",
          }}
        >
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Entrega (teste)</div>

          <label style={{ display: "block", marginBottom: 6 }}>Status da entrega:</label>
          <select
            value={deliveryStatus}
            onChange={(e) => setDeliveryStatus(e.target.value)}
            style={{ padding: 12, width: "100%", borderRadius: 12, marginBottom: 10 }}
          >
            <option value="entregue">Entregue</option>
            <option value="falhou">Não entregue (falhou)</option>
            <option value="reagendado">Reagendado</option>
          </select>

          <label style={{ display: "block", marginBottom: 6 }}>Foto do recebimento:</label>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
            style={{ width: "100%", marginBottom: 10 }}
          />

          <button
            onClick={enviarFotoEStatus}
            style={{ padding: "14px 12px", width: "100%", borderRadius: 12, fontWeight: 900 }}
          >
            Enviar foto + status
          </button>

          {uploadMsg && <p style={{ marginTop: 10 }}>{uploadMsg}</p>}
        </div>
      </div>

      {/* COLUNA 2 — Lista de Entregas */}
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 14,
          padding: 12,
          background: "#fff",
          boxShadow: "0 1px 8px rgba(0,0,0,0.06)",
        }}
      >
        <div style={{ fontWeight: 800, marginBottom: 10 }}>Entregas do dia</div>

        {stops.length === 0 ? (
          <div style={{ opacity: 0.8 }}>Sem entregas carregadas.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {stops.map((s, idx) => (
              <div
                key={s.id}
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 14,
                  padding: 12,
                  background: "#fff",
                  wordBreak: "break-word",
                }}
              >
                <div style={{ fontWeight: 800 }}>Parada {idx + 1}</div>
                <div>
                  <strong>Pedido:</strong> {s.pedido ?? "—"}
                </div>
                <div>
                  <strong>Cliente:</strong> {s.cliente ?? "—"}
                </div>
                <div>
                  <strong>Endereço:</strong> {s.endereco_completo ?? "—"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  </div>
);
}
