import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

function wazeUrlFromLatLng(lat, lng) {
  // Abre o Waze diretamente navegando para coordenadas
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}
export default function DriverTracker() {
  const [currentStop, setCurrentStop] = useState(null);
  const [stops, setStops] = useState([]);
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
    let alive = true;
  
    async function loadStops() {
      setStopsMsg("Carregando entregas...");
      const { data, error } = await supabase
        .from("deliveries")
        .select("id, pedido, cliente, endereco_completo, lat, lng, status")
        .eq("status", "pendente")
        .not("lat", "is", null)
        .not("lng", "is", null)
        .order("created_at", { ascending: true })
        .limit(50);
  
      if (!alive) return;
  
      if (error) {
        setStopsMsg("Erro ao carregar entregas: " + error.message);
        setStops([]);
        return;
      }
  
      setStops(data || []);
      const first = (data || [])[0] || null;
      setCurrentStop(first);
      setStopsMsg(data?.length ? "" : "Nenhuma entrega pendente encontrada.");
    }
  
    loadStops();
  
    return () => {
      alive = false;
    };
  }, []);
  async function reloadStops() {
    setStopsMsg("Carregando entregas...");
    const { data, error } = await supabase
      .from("deliveries")
      .select("id, pedido, cliente, endereco_completo, lat, lng, status")
      .eq("status", "pendente")
      .not("lat", "is", null)
      .not("lng", "is", null)
      .order("created_at", { ascending: true })
      .limit(50);
  
    if (error) {
      setStopsMsg("Erro ao carregar entregas: " + error.message);
      setStops([]);
      setCurrentStop(null);
      return;
    }
  
    setStops(data || []);
    setStopsMsg(data?.length ? "" : "Nenhuma entrega pendente encontrada.");
    setCurrentStop((data || [])[0] || null);
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
  
    await reloadStops();
  }
  
  return (
    <div style={{ fontFamily: "Arial", padding: 16, maxWidth: 520 }}>
      <h2>Motorista — Rastreamento</h2>

      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        <button onClick={startTracking} style={{ padding: "10px 14px" }}>
          Iniciar GPS
        </button>
        <button onClick={stopTracking} style={{ padding: "10px 14px" }}>
          Parar
        </button>
        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
  <button
    style={{ padding: "10px 14px", fontWeight: 700 }}
    disabled={!currentStop}
    onClick={openNextInWaze}
  >
    Ir para a próxima (Waze)
  </button>

  <button
    style={{ padding: "10px 14px" }}
    disabled={!currentStop}
    onClick={concluirEntregaAtual}
  >
    Concluir entrega atual
  </button>

  <button style={{ padding: "10px 14px" }} onClick={reloadStops}>
    Recarregar lista
  </button>
</div>

{currentStop && (
  <div style={{ marginTop: 10, padding: 12, border: "1px solid #eee", borderRadius: 12 }}>
    <div style={{ fontWeight: 700 }}>Entrega atual</div>
    <div><strong>Pedido:</strong> {currentStop.pedido ?? "—"}</div>
    <div><strong>Cliente:</strong> {currentStop.cliente ?? "—"}</div>
    <div><strong>Endereço:</strong> {currentStop.endereco_completo ?? "—"}</div>
  </div>
)}
      
        <div style={{ marginTop: 16, border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
  <h3>Entregas do dia</h3>

  {stopsMsg && <p>{stopsMsg}</p>}

  {stops.length > 0 && (
    <div style={{ display: "grid", gap: 10 }}>
      {stops.map((s, idx) => (
        <div key={s.id} style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 700 }}>Parada {idx + 1}</div>
          <div><strong>Pedido:</strong> {s.pedido ?? "—"}</div>
          <div><strong>Cliente:</strong> {s.cliente ?? "—"}</div>
          <div><strong>Endereço:</strong> {s.endereco_completo ?? "—"}</div>

          <button
            style={{ marginTop: 10, padding: "10px 14px" }}
            onClick={() => window.open(wazeUrlFromLatLng(s.lat, s.lng), "_blank")}
          >
            Abrir no Waze
          </button>
        </div>
      ))}
    </div>
  )}
</div>

      </div>

      <p style={{ marginTop: 12 }}>
        <strong>Status:</strong> {status}
      </p>
      <p>
        <strong>Último envio:</strong> {lastSent ?? "—"}
      </p>
      <hr style={{ margin: "16px 0" }} />

<h3>Entrega (teste)</h3>

<label style={{ display: "block", marginBottom: 6 }}>
  Status da entrega:
</label>
<select
  value={deliveryStatus}
  onChange={(e) => setDeliveryStatus(e.target.value)}
  style={{ padding: 10, width: "100%", marginBottom: 10 }}
>
  <option value="entregue">Entregue</option>
  <option value="falhou">Não entregue (falhou)</option>
  <option value="reagendado">Reagendado</option>
</select>

<label style={{ display: "block", marginBottom: 6 }}>
  Foto do recebimento:
</label>
<input
  type="file"
  accept="image/*"
  capture="environment"
  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
  style={{ marginBottom: 10 }}
/>

<button onClick={enviarFotoEStatus} style={{ padding: "10px 14px" }}>
  Enviar foto + status
</button>

{uploadMsg && <p style={{ marginTop: 10 }}>{uploadMsg}</p>}

    </div>
  );
}
