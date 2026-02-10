import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";

/**
 * DriverTracker.jsx
 * - Tela principal: mostra entrega atual + ações
 * - Tela exclusiva de conclusão: status + foto + enviar
 * - Após enviar: volta pra principal, recarrega paradas e abre Waze da próxima
 */

function wazeUrlFromLatLng(lat, lng) {
  // Link universal do Waze
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}

function openInWazeFromStop(stop) {
  if (!stop) return;
  const url = wazeUrlFromLatLng(stop.lat, stop.lng);

  // abre na mesma aba (evita “aba branca” criada pelo nosso código)
  window.location.assign(url);
}

export default function DriverTracker() {
  // ---- auth / user
  const [user, setUser] = useState(null);

  // ---- gps tracking
  const [status, setStatus] = useState("Parado");
  const [lastSent, setLastSent] = useState(null);
  const watchIdRef = useRef(null);

  // ---- rota/paradas
  const [stops, setStops] = useState([]);
  const [currentStop, setCurrentStop] = useState(null);
  const [stopsMsg, setStopsMsg] = useState("Carregando entregas...");

  // ---- tela exclusiva de conclusão
  const [showFinish, setShowFinish] = useState(false);
  const [deliveryStatus, setDeliveryStatus] = useState("entregue");
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadMsg, setUploadMsg] = useState("");

  const centerName = useMemo(() => "Motorista — Rota do Dia", []);

  // 1) Carregar usuário logado
  useEffect(() => {
    let alive = true;

    supabase.auth.getUser().then(({ data, error }) => {
      if (!alive) return;
      if (error) {
        setUser(null);
        setStopsMsg("Erro ao carregar usuário: " + error.message);
        return;
      }
      setUser(data?.user || null);
    });

    return () => {
      alive = false;
    };
  }, []);

  // 2) Carregar paradas ao ter user
  useEffect(() => {
    if (!user?.id) {
      setStopsMsg("Carregando usuário...");
      return;
    }
    loadStops();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // 3) Para GPS quando sair da tela
  useEffect(() => {
    return () => stopTracking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadStops() {
    await reloadStops();
  }

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

    // 2) pegar rota ativa
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

    // 3) buscar paradas + entrega vinculada
    const { data, error } = await supabase
      .from("route_stops")
      .select(
        `
        stop_order,
        eta_seconds,
        leg_seconds,
        deliveries:delivery_id (
          id, pedido, cliente, endereco_completo, lat, lng, status
        )
      `,
      )
      .eq("route_id", r.id)
      .order("stop_order", { ascending: true });

    if (error) {
      setStopsMsg("Erro ao carregar rota: " + error.message);
      setStops([]);
      setCurrentStop(null);
      return null;
    }

    // 4) formato final + filtrar pendentes com lat/lng
    const stopsList = (data || [])
      .map((x) => ({
        ...x.deliveries,
        stop_order: x.stop_order,
        eta_seconds: x.eta_seconds,
        leg_seconds: x.leg_seconds,
      }))
      .filter(
        (d) =>
          d?.status === "pendente" &&
          Number.isFinite(d.lat) &&
          Number.isFinite(d.lng),
      );

    setStops(stopsList);
    setStopsMsg(stopsList.length ? "" : "Nenhuma parada pendente na rota.");
    const next = stopsList[0] || null;
    setCurrentStop(next);
    return next;
  }

  // ---- GPS
  async function sendLocation(lat, lng, speed) {
    if (!user?.id) return;
    const { error } = await supabase.from("driver_locations").insert([
      {
        driver_id: user.id,
        lat,
        lng,
        speed: Number.isFinite(speed) ? speed : null,
      },
    ]);

    if (error) {
      // não travar a UI por erro intermitente
      console.warn("Erro enviando local:", error.message);
      return;
    }

    setLastSent(new Date().toLocaleString());
  }

  function startTracking() {
    if (!navigator.geolocation) {
      setStatus("Geolocalização não suportada.");
      return;
    }

    if (watchIdRef.current != null) {
      setStatus("GPS já está ativo.");
      return;
    }

    setStatus("Rastreando...");
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, speed } = pos.coords;
        sendLocation(latitude, longitude, speed);
      },
      (err) => {
        setStatus("Erro GPS: " + err.message);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );

    watchIdRef.current = id;
  }

  function stopTracking() {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setStatus("Parado");
  }

  // ---- Conclusão (tela exclusiva)
  async function enviarFotoEStatus() {
    try {
      setUploadMsg("");

      if (!currentStop?.id) {
        setUploadMsg("Nenhuma entrega atual para concluir.");
        return false;
      }

      if (!selectedFile) {
        setUploadMsg("Selecione uma foto antes de enviar.");
        return false;
      }

      // Bucket do Supabase Storage (ajuste se o seu tiver outro nome)
      const BUCKET =
        import.meta.env.VITE_RECEIPT_BUCKET || "foto-do-recebimento";

      const ext = (selectedFile.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${currentStop.id}/${Date.now()}.${ext}`;

      // Upload
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, selectedFile, {
          cacheControl: "3600",
          upsert: true,
        });

      if (upErr) {
        setUploadMsg("Erro ao enviar foto: " + upErr.message);
        return false;
      }

      // Pegar URL pública
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      const photoUrl = pub?.publicUrl || null;

      // Atualizar entrega
      const { error: updErr } = await supabase
        .from("deliveries")
        .update({
          status: deliveryStatus,
          photo_url: photoUrl,
          completed_at: new Date().toISOString(),
        })
        .eq("id", currentStop.id);

      if (updErr) {
        setUploadMsg("Erro ao salvar status: " + updErr.message);
        return false;
      }

      setUploadMsg("✅ Enviado com sucesso!");
      setSelectedFile(null);
      return true;
    } catch (e) {
      setUploadMsg("Erro inesperado: " + String(e?.message || e));
      return false;
    }
  }

  // =========================================================
  //  TELA EXCLUSIVA: CONCLUIR ENTREGA
  // =========================================================
  if (showFinish) {
    return (
      <div
        style={{
          fontFamily: "Arial",
          padding: 12,
          width: "100%",
          maxWidth: 520,
          margin: "0 auto",
          boxSizing: "border-box",
        }}
      >
        <h2 style={{ margin: 0 }}>Concluir entrega</h2>

        <div
          style={{
            marginTop: 12,
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 12,
            background: "#fff",
            boxShadow: "0 1px 8px rgba(0,0,0,0.06)",
            wordBreak: "break-word",
          }}
        >
          {currentStop ? (
            <>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>
                Entrega atual
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <div>
                  <strong>Pedido:</strong> {currentStop.pedido ?? "—"}
                </div>
                <div>
                  <strong>Cliente:</strong> {currentStop.cliente ?? "—"}
                </div>
                <div>
                  <strong>Endereço:</strong>{" "}
                  {currentStop.endereco_completo ?? "—"}
                </div>
              </div>
            </>
          ) : (
            <div style={{ opacity: 0.8 }}>Nenhuma entrega atual.</div>
          )}
        </div>

        <div
          style={{
            marginTop: 12,
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 12,
            background: "#fff",
            boxShadow: "0 1px 8px rgba(0,0,0,0.06)",
          }}
        >
          <label style={{ display: "block", marginBottom: 6 }}>
            Status da entrega:
          </label>
          <select
            value={deliveryStatus}
            onChange={(e) => setDeliveryStatus(e.target.value)}
            style={{
              padding: 12,
              width: "100%",
              borderRadius: 12,
              marginBottom: 10,
            }}
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
            style={{ width: "100%", marginBottom: 10 }}
          />

          <button
            style={{
              padding: "14px 12px",
              width: "100%",
              borderRadius: 12,
              fontWeight: 900,
            }}
            disabled={!currentStop}
            onClick={async () => {
              const ok = await enviarFotoEStatus();
              if (!ok) return;

              // volta para principal, recarrega e abre waze da próxima
              setShowFinish(false);
              const next = await reloadStops();
              if (next) openInWazeFromStop(next);
            }}
          >
            Enviar foto + status
          </button>

          <button
            style={{
              marginTop: 10,
              padding: "12px 12px",
              width: "100%",
              borderRadius: 12,
              fontWeight: 800,
            }}
            onClick={() => {
              setUploadMsg("");
              setShowFinish(false);
            }}
          >
            Cancelar
          </button>

          {uploadMsg && <p style={{ marginTop: 10 }}>{uploadMsg}</p>}
        </div>
      </div>
    );
  }

  // =========================================================
  //  TELA PRINCIPAL: ROTA
  // =========================================================
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
      <h2 style={{ margin: 0 }}>{centerName}</h2>

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
            <strong>Status GPS:</strong> {status}
          </div>
          <div>
            <strong>Último envio:</strong> {lastSent ?? "—"}
          </div>
          {stopsMsg && (
            <div
              style={{ padding: 10, borderRadius: 12, background: "#f9fafb" }}
            >
              {stopsMsg}
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 12,
        }}
      >
        {/* AÇÕES */}
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 12,
            background: "#fff",
            boxShadow: "0 1px 8px rgba(0,0,0,0.06)",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Ações</div>

          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
          >
            <button
              onClick={startTracking}
              style={{
                padding: "14px 12px",
                borderRadius: 12,
                fontWeight: 800,
              }}
            >
              Iniciar GPS
            </button>
            <button
              onClick={stopTracking}
              style={{
                padding: "14px 12px",
                borderRadius: 12,
                fontWeight: 800,
              }}
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
            onClick={() => openInWazeFromStop(currentStop)}
          >
            Abrir Waze (entrega atual)
          </button>

          <button
            style={{
              marginTop: 10,
              padding: "14px 12px",
              width: "100%",
              borderRadius: 12,
              fontWeight: 900,
            }}
            disabled={!currentStop}
            onClick={() => {
              setUploadMsg("");
              setDeliveryStatus("entregue");
              setSelectedFile(null);
              setShowFinish(true);
            }}
          >
            Concluir entrega
          </button>

          <button
            style={{
              marginTop: 10,
              padding: "12px 12px",
              width: "100%",
              borderRadius: 12,
              fontWeight: 800,
            }}
            onClick={reloadStops}
          >
            Recarregar lista
          </button>
        </div>

        {/* ENTREGA ATUAL */}
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
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Entrega atual</div>

          {!currentStop ? (
            <div style={{ opacity: 0.8 }}>
              Nenhuma entrega selecionada ainda.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ opacity: 0.8 }}>
                {currentStop.stop_order != null
                  ? `Parada #${currentStop.stop_order} • Restantes: ${stops.length}`
                  : `Restantes: ${stops.length}`}
              </div>
              <div>
                <strong>Pedido:</strong> {currentStop.pedido ?? "—"}
              </div>
              <div>
                <strong>Cliente:</strong> {currentStop.cliente ?? "—"}
              </div>
              <div>
                <strong>Endereço:</strong>{" "}
                {currentStop.endereco_completo ?? "—"}
              </div>
            </div>
          )}
        </div>

        {/* ENTREGAS DO DIA (SEM BOTÃO WAZE) */}
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 12,
            background: "#fff",
            boxShadow: "0 1px 8px rgba(0,0,0,0.06)",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 10 }}>
            Entregas do dia
          </div>

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
                  <div style={{ fontWeight: 900 }}>Parada {idx + 1}</div>
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
