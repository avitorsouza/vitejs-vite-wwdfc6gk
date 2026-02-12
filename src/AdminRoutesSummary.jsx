import { useEffect, useState } from "react";
import { supabase } from "./supabase";

export default function AdminRoutesSummary() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [who, setWho] = useState("");
  const [rows, setRows] = useState([]); // rotas ativas + veículo + paradas

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data: u } = await supabase.auth.getUser();
    setWho(
      u?.user?.email ? `Logado como: ${u.user.email}` : "⚠️ NÃO LOGADO (anon)",
    );
    setBusy(true);
    setMsg("");
    try {
      // 1) Rotas ativas + veículo
      const { data: routes, error: rErr } = await supabase
        .from("routes")
        .select(
          "id, vehicle_id, status, created_at, vehicles:vehicle_id (id, name, plate)",
        )
        .eq("status", "ativa")
        .order("created_at", { ascending: false })
        .limit(20);

      if (rErr) {
        setMsg("Erro ao carregar rotas: " + rErr.message);
        setRows([]);
        return;
      }

      const routeIds = (routes || []).map((r) => r.id);
      if (routeIds.length === 0) {
        setRows([]);
        setMsg("Nenhuma rota ativa no momento.");
        return;
      }

      // 2) Paradas das rotas + entrega
      const { data: stops, error: sErr } = await supabase
        .from("route_stops")
        .select(
          "route_id, stop_order, deliveries:delivery_id (id, pedido, cliente, endereco_completo, status, lat, lng)",
        )

        .in("route_id", routeIds)
        .order("stop_order", { ascending: true })
        .limit(5000);

      if (sErr) {
        setMsg("Erro ao carregar paradas: " + sErr.message);
        setRows([]);
        return;
      }

      // 3) Montar estrutura: cada rota com suas entregas
      const map = new Map();
      for (const r of routes || []) {
        map.set(r.id, { route: r, stops: [] });
      }
      for (const s of stops || []) {
        const bucket = map.get(s.route_id);
        if (!bucket) continue;
        bucket.stops.push({
          stop_order: s.stop_order,
          delivery: s.deliveries,
        });
      }

      setRows(Array.from(map.values()));
      setMsg("");
    } catch (e) {
      setMsg("Erro inesperado: " + String(e?.message || e));
      setRows([]);
    } finally {
      setBusy(false);
    }
  }
  async function optimizeRoute(routeId) {
    setBusy(true);
    setMsg("");

    try {
      // 1) Pegar paradas da rota + lat/lng
      const { data: rs, error: rsErr } = await supabase
        .from("route_stops")
        .select(
          "delivery_id, stop_order, deliveries:delivery_id (id, lat, lng)",
        )
        .eq("route_id", routeId)
        .order("stop_order", { ascending: true });

      if (rsErr) {
        setMsg("Erro ao carregar paradas da rota: " + rsErr.message);
        return;
      }

      const stops = (rs || [])
        .map((x) => x.deliveries)
        .filter((d) => d && Number.isFinite(d.lat) && Number.isFinite(d.lng))
        .map((d) => ({ id: d.id, lat: d.lat, lng: d.lng }));

      if (stops.length < 2) {
        setMsg("Precisa de pelo menos 2 entregas com lat/lng para otimizar.");
        return;
      }

      // 2) Chamar o otimizador no Heroku (/api/optimize)
      const resp = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          depot_address: "AV. TEFÉ, 2840 - JAPIIM - MANAUS",
          stops,
        }),
      });

      const j = await resp.json().catch(() => null);

      if (!resp.ok || !j?.order?.length) {
        setMsg("Falha ao otimizar: " + (j?.error || "resposta inválida"));
        return;
      }

      // 3) Atualizar stop_order no Supabase seguindo a ordem nova
      // j.order: [delivery_id, delivery_id, ...]
      async function salvarNovaOrdemDaRota(routeId, orderedStops) {
        // orderedStops precisa ser a lista FINAL na ordem correta
        // Ex.: [{id, delivery_id, ...}] ou [{delivery_id, ...}]
        const orderedDeliveryIds = orderedStops.map(
          (s) => s.delivery_id || s.id,
        );

        const { error } = await supabase.rpc("reorder_route_stops", {
          p_route_id: routeId,
          p_ordered_delivery_ids: orderedDeliveryIds,
        });

        if (error) {
          throw new Error(error.message);
        }
      }

      setMsg("✅ Rota otimizada com sucesso!");
      await load(); // recarrega UI
    } catch (e) {
      setMsg("Erro inesperado ao otimizar: " + String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 14,
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        padding: 12,
        background: "#fff",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontWeight: 900 }}>
          Resumo — Entregas por caminhão (rotas ativas)
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.85 }}>{who}</div>
        </div>
        <button
          onClick={load}
          disabled={busy}
          style={{ padding: "10px 12px", borderRadius: 12, fontWeight: 900 }}
        >
          {busy ? "Atualizando..." : "Atualizar"}
        </button>
      </div>

      {msg && <div style={{ marginTop: 10, opacity: 0.9 }}>{msg}</div>}

      {rows.length === 0 && !msg && (
        <div style={{ marginTop: 10, opacity: 0.85 }}>Nenhuma rota ativa.</div>
      )}

      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        {rows.map(({ route, stops }) => {
          const v = route.vehicles;
          return (
            <div
              key={route.id}
              style={{
                border: "1px solid #eee",
                borderRadius: 14,
                padding: 12,
                background: "#fafafa",
              }}
            >
              <div style={{ fontWeight: 900 }}>
                🚚 {v?.name ?? "Veículo"} — {v?.plate ?? "—"}
              </div>
              <div style={{ fontSize: 13, opacity: 0.85 }}>
                Rota: {route.id} • Criada:{" "}
                {route.created_at
                  ? new Date(route.created_at).toLocaleString()
                  : "—"}
              </div>
              <button
                onClick={() => optimizeRoute(route.id)}
                disabled={busy}
                style={{
                  marginTop: 10,
                  padding: "10px 12px",
                  borderRadius: 12,
                  fontWeight: 900,
                  width: "100%",
                }}
              >
                {busy ? "Otimizando..." : "Otimizar rota"}
              </button>

              {stops.length === 0 ? (
                <div style={{ marginTop: 8, opacity: 0.85 }}>
                  Sem entregas nessa rota.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {stops.map((s) => (
                    <div
                      key={`${route.id}-${s.stop_order}-${s.delivery?.id ?? "x"}`}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 12,
                        padding: 10,
                        background: "#fff",
                      }}
                    >
                      <div style={{ fontWeight: 900 }}>
                        Parada {s.stop_order}
                      </div>
                      <div>
                        <strong>Pedido:</strong> {s.delivery?.pedido ?? "—"}
                      </div>
                      <div>
                        <strong>Cliente:</strong> {s.delivery?.cliente ?? "—"}
                      </div>
                      <div style={{ opacity: 0.9 }}>
                        <strong>Endereço:</strong>{" "}
                        {s.delivery?.endereco_completo ?? "—"}
                      </div>
                      <div>
                        <strong>Status:</strong> {s.delivery?.status ?? "—"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
