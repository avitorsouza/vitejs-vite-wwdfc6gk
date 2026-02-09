import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";

export default function ManualRoutePlanner({ onRouteCreated }) {
  const [vehicles, setVehicles] = useState([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState("");
  const [deliveries, setDeliveries] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedCount = useMemo(() => selected.size, [selected]);

  useEffect(() => {
    loadVehicles();
    loadDeliveries();
  }, []);

  async function loadVehicles() {
    const { data, error } = await supabase
      .from("vehicles")
      .select("id, name, plate")
      .order("name", { ascending: true });
    if (!error) {
      setVehicles(data || []);
      if (!selectedVehicleId && data?.[0]?.id) setSelectedVehicleId(data[0].id);
    }
  }

  async function loadDeliveries() {
    setMsg("Carregando entregas pendentes...");
    const { data, error } = await supabase
      .from("deliveries")
      .select("id, pedido, cliente, endereco_completo, lat, lng, status, created_at")
      .eq("status", "pendente")
      .not("lat", "is", null)
      .not("lng", "is", null)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) {
      setMsg("Erro ao carregar entregas: " + error.message);
      setDeliveries([]);
      return;
    }
    setDeliveries(data || []);
    setMsg((data || []).length ? "" : "Nenhuma entrega pendente com lat/lng.");
  }

  function toggle(id) {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function criarRotaManual() {
    setMsg("");
    if (!selectedVehicleId) {
      setMsg("Selecione um veículo.");
      return;
    }
    if (selected.size === 0) {
      setMsg("Selecione pelo menos 1 entrega.");
      return;
    }

    setBusy(true);
    try {
      // 1) criar rota "ativa"
      const { data: route, error: rErr } = await supabase
        .from("routes")
        .insert([
          {
            vehicle_id: selectedVehicleId,
            status: "ativa",
            mode: "manual",
          },
        ])
        .select("id")
        .single();

      if (rErr || !route?.id) {
        setMsg("Erro ao criar rota: " + (rErr?.message || "sem id"));
        return;
      }

      // 2) criar paradas (na ordem da seleção em tela)
      const ordered = deliveries.filter((d) => selected.has(d.id));

      const stopsPayload = ordered.map((d, idx) => ({
        route_id: route.id,
        delivery_id: d.id,
        stop_order: idx + 1,
      }));

      const { error: sErr } = await supabase.from("route_stops").insert(stopsPayload);
      if (sErr) {
        setMsg("Erro ao criar paradas: " + sErr.message);
        return;
      }

      // 3) marcar entregas como "em_rota"
      const ids = ordered.map((d) => d.id);
      const { error: upErr } = await supabase
        .from("deliveries")
        .update({ status: "em_rota" })
        .in("id", ids);

      if (upErr) {
        setMsg("Rota criada, mas falhou ao atualizar entregas: " + upErr.message);
      } else {
        setMsg(`✅ Rota criada para ${ordered.length} entregas.`);
      }

      clearSelection();
      await loadDeliveries();
      onRouteCreated?.();
    } catch (e) {
      setMsg("Erro inesperado: " + String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12, background: "#fff" }}>
      <div style={{ fontWeight: 900, marginBottom: 8 }}>Planejador Manual de Rotas</div>

      <div style={{ display: "grid", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Veículo</div>
          <select
            value={selectedVehicleId}
            onChange={(e) => setSelectedVehicleId(e.target.value)}
            style={{ padding: 10, width: "100%", borderRadius: 12 }}
            disabled={busy}
          >
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} — {v.plate}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={criarRotaManual}
            disabled={busy}
            style={{ padding: "12px 12px", borderRadius: 12, fontWeight: 900 }}
          >
            {busy ? "Criando..." : `Criar rota (${selectedCount})`}
          </button>
          <button onClick={clearSelection} disabled={busy} style={{ padding: "12px 12px", borderRadius: 12 }}>
            Limpar seleção
          </button>
          <button onClick={loadDeliveries} disabled={busy} style={{ padding: "12px 12px", borderRadius: 12 }}>
            Recarregar entregas
          </button>
        </div>

        {msg && <div style={{ padding: 10, borderRadius: 12, background: "#f9fafb" }}>{msg}</div>}

        <div style={{ fontWeight: 700 }}>Entregas pendentes (clique para selecionar)</div>
        <div style={{ display: "grid", gap: 8, maxHeight: 320, overflow: "auto", border: "1px solid #eee", borderRadius: 12, padding: 8 }}>
          {deliveries.map((d) => {
            const checked = selected.has(d.id);
            return (
              <div
                key={d.id}
                onClick={() => toggle(d.id)}
                style={{
                  border: checked ? "2px solid #111" : "1px solid #e5e7eb",
                  borderRadius: 12,
                  padding: 10,
                  cursor: "pointer",
                  background: checked ? "#f3f4f6" : "#fff",
                }}
              >
                <div style={{ fontWeight: 900 }}>
                  {checked ? "✅ " : ""}Pedido: {d.pedido ?? "—"}
                </div>
                <div><strong>Cliente:</strong> {d.cliente ?? "—"}</div>
                <div style={{ opacity: 0.9 }}><strong>Endereço:</strong> {d.endereco_completo ?? "—"}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
