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
          "route_id, stop_order, deliveries:delivery_id (id, pedido, cliente, endereco_completo, status)",
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
