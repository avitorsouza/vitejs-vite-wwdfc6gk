import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { AppLauncher } from "@capacitor/app-launcher";
import { LocalNotifications } from "@capacitor/local-notifications";

const BackgroundGeolocation = registerPlugin("BackgroundGeolocation");
const NativeApp = registerPlugin("App");
const TRACKING_ENABLED_KEY = "driver_tracker_tracking_enabled";


/**
 * DriverTracker.jsx
 * - Tela principal: entrega atual + ações + lista do dia
 * - Tela exclusiva: concluir entrega (entregue => foto obrigatória | não entregue => justificativa obrigatória)
 * - Após enviar: volta pra principal, recarrega e abre Waze da próxima
 */

function wazeUrlFromLatLng(lat, lng) {
  return `waze://?ll=${lat},${lng}&navigate=yes`;
}

function wazeWebUrlFromLatLng(lat, lng) {
  return `https://www.waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}

async function openInWazeFromStop(stop) {
  if (!stop) return;
  const deepLink = wazeUrlFromLatLng(stop.lat, stop.lng);
  const webLink = wazeWebUrlFromLatLng(stop.lat, stop.lng);

  if (Capacitor.isNativePlatform()) {
    try {
      const canOpen = await AppLauncher.canOpenUrl({ url: "waze://" });
      if (canOpen?.value) {
        await AppLauncher.openUrl({ url: deepLink });
        return;
      }
      await AppLauncher.openUrl({ url: webLink });
      return;
    } catch (e) {
      // fallback below
    }
  }

  const opened = window.open(deepLink, "_blank");
  if (!opened) {
    window.location.href = webLink;
  }
}

export default function DriverTracker() {
  // ---- auth / user
  const [user, setUser] = useState(null);

  // ---- gps tracking
  const [status, setStatus] = useState("Parado");
  const [lastSent, setLastSent] = useState(null);
  const watchIdRef = useRef(null);
  const bgWatcherIdRef = useRef(null);
  const pingIntervalRef = useRef(null);
  const shouldTrackRef = useRef(false);
  const lastGpsSendAtRef = useRef(0);
  const lastGpsAttemptAtRef = useRef(0);
  const sendInFlightRef = useRef(false);
  const appIsActiveRef = useRef(true);
  const driverIdRef = useRef(null);
  const accessTokenRef = useRef(null);
  const accessTokenExpiresAtRef = useRef(0);

  // ---- rota/paradas
  const [stops, setStops] = useState([]);
  const [currentStop, setCurrentStop] = useState(null);
  const [stopsMsg, setStopsMsg] = useState("Carregando entregas...");

  // ---- tela exclusiva de conclusão
  const [showFinish, setShowFinish] = useState(false);
  const [deliveryStatus, setDeliveryStatus] = useState("entregue"); // entregue | nao_realizada
  const [selectedFile, setSelectedFile] = useState(null);
  const [justificativa, setJustificativa] = useState("");
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
    driverIdRef.current = user?.id || null;
    if (!user?.id) {
      setStopsMsg("Carregando usuário...");
      return;
    }
    loadStops();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  // Auto-refresh: recarrega paradas a cada 25s (pausa na tela de concluir)
  useEffect(() => {
    if (!user?.id) return;
    if (showFinish) return;

    const t = setInterval(() => {
      reloadStops();
    }, 25000);

    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, showFinish]);

  // 3) Retoma automaticamente se o motorista havia deixado o GPS ativo.
  useEffect(() => {
    const trackingWasEnabled =
      localStorage.getItem(TRACKING_ENABLED_KEY) === "1";
    if (!trackingWasEnabled) return;
    shouldTrackRef.current = true;
    startTracking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retoma rastreio ao voltar para o app caso o motorista tenha deixado GPS ligado.
  useEffect(() => {
    function onVisible() {
      if (!shouldTrackRef.current) return;
      const hasNativeWatcher = bgWatcherIdRef.current != null;
      const hasWebWatcher = watchIdRef.current != null;
      if (!hasNativeWatcher && !hasWebWatcher) startTracking();
    }

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Estado nativo do app (foreground/background) para evitar lock de sessao no Android.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let listener = null;
    NativeApp.getState()
      .then((s) => {
        appIsActiveRef.current = !!s?.isActive;
      })
      .catch(() => {});

    NativeApp.addListener("appStateChange", (state) => {
      appIsActiveRef.current = !!state?.isActive;
      if (appIsActiveRef.current && shouldTrackRef.current) {
        getNativeAccessToken(false);
      }
    }).then((h) => {
      listener = h;
    });

    return () => {
      if (listener) listener.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 4) Ao logar novamente, atualiza token para envio nativo em background.
  useEffect(() => {
    accessTokenRef.current = null;
  }, [user?.id]);

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

    // 4) formato final + filtrar entregas em rota com lat/lng
    const stopsList = (data || [])
      .map((x) => ({
        ...(x.deliveries || {}),
        stop_order: x.stop_order,
        eta_seconds: x.eta_seconds,
        leg_seconds: x.leg_seconds,
      }))
      .filter(
        (d) =>
          d?.status === "em_rota" &&
          Number.isFinite(d.lat) &&
          Number.isFinite(d.lng),
      );

    setStops(stopsList);
    setStopsMsg(stopsList.length ? "" : "Nenhuma entrega em rota para você.");
    const next = stopsList[0] || null;
    setCurrentStop(next);
    return next;
  }

  // ---- GPS
  async function getNativeAccessToken(forceRefresh = false) {
    try {
      const isForeground =
        !Capacitor.isNativePlatform() || appIsActiveRef.current;
      if (!isForeground && !forceRefresh) {
        return accessTokenRef.current;
      }
      if (!isForeground && forceRefresh) return null;

      const nowSec = Math.floor(Date.now() / 1000);
      if (
        !forceRefresh &&
        accessTokenRef.current &&
        accessTokenExpiresAtRef.current > nowSec + 60
      ) {
        return accessTokenRef.current;
      }

      let { data: sessData } = await supabase.auth.getSession();
      let session = sessData?.session || null;

      if (
        forceRefresh ||
        (session?.expires_at && session.expires_at <= nowSec + 60)
      ) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        session = refreshed?.session || session;
      }

      accessTokenRef.current = session?.access_token || null;
      accessTokenExpiresAtRef.current = session?.expires_at || 0;
      return accessTokenRef.current;
    } catch {
      return null;
    }
  }

  async function sendLocation(lat, lng, speed) {
    const driverId = driverIdRef.current || user?.id || null;
    if (!driverId) return;

    const now = Date.now();
    if (now - lastGpsAttemptAtRef.current < 3000) return;
    if (now - lastGpsSendAtRef.current < 5000) return;
    if (sendInFlightRef.current) return;
    lastGpsAttemptAtRef.current = now;
    sendInFlightRef.current = true;

    const row = {
      driver_id: driverId,
      lat,
      lng,
      speed: Number.isFinite(speed) ? speed : null,
    };

    if (Capacitor.isNativePlatform()) {
      try {
        let accessToken = await getNativeAccessToken(false);
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

        if (!accessToken || !supabaseUrl || !supabaseAnonKey) {
          setStatus("Erro ao enviar localizacao: sessao/config ausente");
          sendInFlightRef.current = false;
          return;
        }

        let resp = await CapacitorHttp.post({
          url: `${supabaseUrl}/rest/v1/driver_locations`,
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          data: [row],
        });

        if (resp?.status === 401 || resp?.status === 403) {
          accessToken = appIsActiveRef.current
            ? await getNativeAccessToken(true)
            : null;
          if (accessToken) {
            resp = await CapacitorHttp.post({
              url: `${supabaseUrl}/rest/v1/driver_locations`,
              headers: {
                apikey: supabaseAnonKey,
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                Prefer: "return=minimal",
              },
              data: [row],
            });
          }
        }

        if (!resp || resp.status < 200 || resp.status >= 300) {
          if (resp?.status === 401 || resp?.status === 403) {
            if (appIsActiveRef.current) {
              setStatus("Sessao expirada. Faca login novamente.");
            } else {
              setStatus("Sessao expirada em segundo plano. Volte ao app para renovar.");
            }
          } else {
            setStatus("Erro ao enviar localizacao: HTTP " + (resp?.status ?? "?"));
          }
          sendInFlightRef.current = false;
          return;
        }
      } catch (e) {
        setStatus("Erro ao enviar localizacao: " + String(e?.message || e));
        sendInFlightRef.current = false;
        return;
      }
    } else {
      try {
        const { error } = await supabase.from("driver_locations").insert([row]);
        if (error) {
          console.warn("Erro enviando local:", error.message);
          setStatus("Erro ao enviar localizacao: " + error.message);
          sendInFlightRef.current = false;
          return;
        }
      } catch (e) {
        setStatus("Erro ao enviar localizacao: " + String(e?.message || e));
        sendInFlightRef.current = false;
        return;
      }
    }

    lastGpsSendAtRef.current = now;
    sendInFlightRef.current = false;
    setStatus("Rastreando...");
    setLastSent(new Date().toLocaleString());
  }

  async function startTracking() {
    shouldTrackRef.current = true;
    localStorage.setItem(TRACKING_ENABLED_KEY, "1");

    if (!navigator.geolocation) {
      setStatus("Geolocalização não suportada.");
      return;
    }

    if (Capacitor.isNativePlatform() && bgWatcherIdRef.current != null) {
      setStatus("GPS já está ativo.");
      return;
    }

    if (!Capacitor.isNativePlatform() && watchIdRef.current != null) {
      setStatus("GPS já está ativo.");
      return;
    }

    setStatus("Rastreando...");

    if (Capacitor.isNativePlatform()) {
      try {
        await getNativeAccessToken(false);
      } catch {
        accessTokenRef.current = null;
        accessTokenExpiresAtRef.current = 0;
      }

      try {
        const notifPerm = await LocalNotifications.checkPermissions();
        if (notifPerm.display !== "granted") {
          await LocalNotifications.requestPermissions();
        }
      } catch {
        // keep tracking flow even if notification permission check fails
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, speed } = pos.coords;
          sendLocation(latitude, longitude, speed);
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
      );

      BackgroundGeolocation.addWatcher(
        {
          requestPermissions: true,
          stale: false,
          distanceFilter: 0,
          backgroundTitle: "Rastreio ativo",
          backgroundMessage: "Enviando localizacao da rota em segundo plano",
        },
        (location, error) => {
          if (error) {
            const raw =
              (error?.message || error?.code || "permissao negada").toString();
            const isAuthError = raw.includes("NOT_AUTHORIZED");
            setStatus(
              isAuthError
                ? "Erro GPS: permissao em segundo plano negada. Ative localizacao 'o tempo todo' no Android."
                : "Erro GPS: " + raw,
            );
            return;
          }
          if (!location) return;

          sendLocation(location.latitude, location.longitude, location.speed);
        },
      )
        .then((watcherId) => {
          bgWatcherIdRef.current = watcherId;
          setStatus("Rastreando (segundo plano)...");
        })
        .catch((e) => {
          setStatus("Erro GPS: " + String(e?.message || e));
        });

      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, speed } = pos.coords;
        sendLocation(latitude, longitude, speed);
      },
      (err) => setStatus("Erro GPS: " + err.message),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, speed } = pos.coords;
        sendLocation(latitude, longitude, speed);
      },
      (err) => setStatus("Erro GPS: " + err.message),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );

    watchIdRef.current = id;

    if (pingIntervalRef.current == null) {
      pingIntervalRef.current = setInterval(() => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const { latitude, longitude, speed } = pos.coords;
            sendLocation(latitude, longitude, speed);
          },
          () => {},
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
        );
      }, 5000);
    }
  }

  function stopTracking() {
    shouldTrackRef.current = false;
    localStorage.removeItem(TRACKING_ENABLED_KEY);

    if (bgWatcherIdRef.current != null) {
      const watcherId = bgWatcherIdRef.current;
      bgWatcherIdRef.current = null;
      BackgroundGeolocation.removeWatcher({ id: watcherId }).catch(() => {});
    }

    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (pingIntervalRef.current != null) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
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

      // ✅ Regras obrigatórias
      if (deliveryStatus === "entregue") {
        if (!selectedFile) {
          setUploadMsg(
            "Para marcar como ENTREGUE, é obrigatório anexar a foto.",
          );
          return false;
        }
      }

      if (deliveryStatus === "nao_realizada") {
        if (!justificativa?.trim()) {
          setUploadMsg(
            "Para marcar como NÃO ENTREGUE, é obrigatório informar a justificativa.",
          );
          return false;
        }
      }

      // =========================
      // CASO 1: ENTREGUE → sobe foto e salva photo_url
      // =========================
      if (deliveryStatus === "entregue") {
        const BUCKET =
          import.meta.env.VITE_RECEIPT_BUCKET || "foto-do-recebimento";
        const ext = (selectedFile.name.split(".").pop() || "jpg").toLowerCase();
        const path = `${currentStop.id}/${Date.now()}.${ext}`;

        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, selectedFile, { cacheControl: "3600", upsert: true });

        if (upErr) {
          setUploadMsg("Erro ao enviar foto: " + upErr.message);
          return false;
        }

        const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
        const photoUrl = pub?.publicUrl || null;

        const { error: updErr } = await supabase
          .from("deliveries")
          .update({
            status: "entregue",
            photo_url: photoUrl,
            completed_at: new Date().toISOString(),
            failure_reason: null,
          })
          .eq("id", currentStop.id);

        if (updErr) {
          setUploadMsg("Erro ao salvar status: " + updErr.message);
          return false;
        }

        setUploadMsg("✅ Entrega concluída com foto!");
        setSelectedFile(null);
        setJustificativa("");
        return true;
      }

      // =========================
      // CASO 2: NÃO ENTREGUE → salva justificativa e NÃO sobe foto
      // =========================
      if (deliveryStatus === "nao_realizada") {
        const { error: updErr } = await supabase
          .from("deliveries")
          .update({
            status: "nao_realizada",
            completed_at: new Date().toISOString(),
            failure_reason: justificativa.trim(),
            photo_url: null,
          })
          .eq("id", currentStop.id);

        if (updErr) {
          setUploadMsg("Erro ao salvar status: " + updErr.message);
          return false;
        }

        setUploadMsg("✅ Marcado como NÃO ENTREGUE (com justificativa).");
        setSelectedFile(null);
        setJustificativa("");
        return true;
      }

      setUploadMsg("Status inválido.");
      return false;
    } catch (e) {
      setUploadMsg("Erro inesperado: " + String(e?.message || e));
      return false;
    }
  }

  // =========================================================
  //  TELA EXCLUSIVA: CONCLUIR ENTREGA
  // =========================================================
  if (showFinish) {
    const canSendEntregue = !!currentStop && !!selectedFile;
    const canSendNaoEntregue = !!currentStop && !!justificativa?.trim();

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
            boxSizing: "border-box",
          }}
        >
          <label style={{ display: "block", marginBottom: 6 }}>
            Status da entrega:
          </label>

          <select
            value={deliveryStatus}
            onChange={(e) => {
              const v = e.target.value;
              setDeliveryStatus(v);
              setUploadMsg("");
              // limpa campos quando troca o status
              setSelectedFile(null);
              setJustificativa("");
            }}
            style={{
              padding: 12,
              width: "100%",
              borderRadius: 12,
              marginBottom: 10,
              boxSizing: "border-box",
            }}
          >
            <option value="entregue">Entregue</option>
            <option value="nao_realizada">Não entregue</option>
          </select>

          {/* =========================
              ENTREGUE → FOTO + BOTÃO
             ========================= */}
          {deliveryStatus === "entregue" && (
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <label style={{ display: "block", marginBottom: 6 }}>
                  Foto do recebimento (obrigatório):
                </label>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </div>

              <button
                style={{
                  padding: "14px 12px",
                  width: "100%",
                  borderRadius: 12,
                  fontWeight: 900,
                }}
                disabled={!canSendEntregue}
                onClick={async () => {
                  const ok = await enviarFotoEStatus();
                  if (!ok) return;

                  setShowFinish(false);
                  const next = await reloadStops();
                  if (next) openInWazeFromStop(next);
                }}
              >
                Enviar foto e encerrar entrega
              </button>
            </div>
          )}

          {/* =========================
              NÃO ENTREGUE → TEXTO + BOTÃO
             ========================= */}
          {deliveryStatus === "nao_realizada" && (
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <label style={{ display: "block", marginBottom: 6 }}>
                  Justificativa (obrigatório):
                </label>
                <textarea
                  placeholder="Informe o motivo da não entrega..."
                  value={justificativa}
                  onChange={(e) => setJustificativa(e.target.value)}
                  style={{
                    width: "100%",
                    padding: 12,
                    borderRadius: 12,
                    minHeight: 90,
                    resize: "vertical",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <button
                style={{
                  padding: "14px 12px",
                  width: "100%",
                  borderRadius: 12,
                  fontWeight: 900,
                }}
                disabled={!canSendNaoEntregue}
                onClick={async () => {
                  const ok = await enviarFotoEStatus();
                  if (!ok) return;

                  setShowFinish(false);
                  const next = await reloadStops();
                  if (next) openInWazeFromStop(next);
                }}
              >
                Enviar justificativa e encerrar entrega
              </button>
            </div>
          )}

          <button
            style={{
              marginTop: 12,
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
              setJustificativa("");
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










