import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";

export default function ManualRoutePlanner({
  vehicles = [],
  usedVehicleIds = new Set(),
  deliveries = [],
  onAfterCreate,
}) {
  const [selectedVehicleId, setSelectedVehicleId] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [optimizedOrder, setOptimizedOrder] = useState(null);
  const [optBusy, setOptBusy] = useState(false);

  const availableVehicles = useMemo(
    () => vehicles.filter((v) => !usedVehicleIds.has(v.id)),
    [vehicles, usedVehicleIds],
  );

  const selectedCount = useMemo(() => selected.size, [selected]);

  useEffect(() => {
    const stillAvailable = availableVehicles.some(
      (v) => v.id === selectedVehicleId,
    );
    if (!selectedVehicleId || !stillAvailable) {
      setSelectedVehicleId(availableVehicles?.[0]?.id || "");
    }
  }, [availableVehicles, selectedVehicleId]);

  function toggle(id) {
    setOptimizedOrder(null);
    setSelected((prev) => {
      const copy = new Set(prev);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });
  }

  function clearSelection() {
    setOptimizedOrder(null);
    setSelected(new Set());
  }

  async function otimizarRotaGoogle() {
    if (selected.size < 2) {
      setMsg("Selecione pelo menos 2 entregas para otimizar.");
      return;
    }

    setOptBusy(true);
    setMsg("Otimizando rota no Google...");

    try {
      const selectedDeliveries = deliveries.filter((d) => selected.has(d.id));
      const resp = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stops: selectedDeliveries.map((d) => ({
            id: d.id,
            lat: d.lat,
            lng: d.lng,
          })),
        }),
      });

      const j = await resp.json().catch(() => null);
      if (!resp.ok || !Array.isArray(j?.order) || j.order.length < 2) {
        setMsg("Erro ao otimizar: " + (j?.error || "resposta invalida"));
        return;
      }

      setOptimizedOrder(j.order);
      setMsg("Rota otimizada. Agora clique em Criar rota.");
    } catch (e) {
      setMsg("Erro ao otimizar: " + String(e?.message || e));
    } finally {
      setOptBusy(false);
    }
  }

  async function criarRotaManual() {
    setMsg("");

    if (!selectedVehicleId) {
      setMsg("Nao ha caminhao disponivel.");
      return;
    }
    if (selected.size < 2) {
      setMsg("Selecione pelo menos 2 entregas para criar rota.");
      return;
    }

    setBusy(true);
    try {
      const { data: link, error: linkErr } = await supabase
        .from("driver_vehicle")
        .select("driver_id")
        .eq("vehicle_id", selectedVehicleId)
        .maybeSingle();

      if (linkErr || !link?.driver_id) {
        setMsg(
          "Esse caminhao ainda nao tem motorista vinculado. Vincule antes de criar a rota.",
        );
        return;
      }

      let ordered = deliveries.filter((d) => selected.has(d.id));
      if (optimizedOrder) {
        ordered = optimizedOrder
          .map((id) => deliveries.find((d) => d.id === id))
          .filter(Boolean);
      }

      const deliveryIds = ordered.map((d) => d.id);
      const resp = await fetch("/api/routes/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicle_id: selectedVehicleId,
          driver_id: link.driver_id,
          depot_address: "AV. TEFE, 2840 - JAPIIM - MANAUS",
          delivery_ids: deliveryIds,
        }),
      });

      const j = await resp.json().catch(() => null);
      if (!resp.ok || !j?.ok) {
        setMsg("Erro ao criar rota: " + (j?.error || j?.details || "desconhecido"));
        return;
      }

      setMsg(`Rota criada para ${ordered.length} entregas.`);
      clearSelection();
      await onAfterCreate?.();
    } catch (e) {
      setMsg("Erro inesperado: " + String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>Caminhao disponivel</div>
        <select
          value={selectedVehicleId}
          onChange={(e) => setSelectedVehicleId(e.target.value)}
          style={{ padding: 10, width: "100%", borderRadius: 12 }}
          disabled={busy || availableVehicles.length === 0}
        >
          {availableVehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} - {v.plate}
            </option>
          ))}
        </select>

        {availableVehicles.length === 0 && (
          <div style={{ marginTop: 8, opacity: 0.85 }}>
            Todos os caminhoes ja possuem rota ativa.
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={criarRotaManual}
          disabled={busy || !selectedVehicleId}
          style={{ padding: "12px 12px", borderRadius: 12, fontWeight: 900 }}
        >
          {busy ? "Criando..." : `Criar rota (${selectedCount})`}
        </button>
        <button
          onClick={otimizarRotaGoogle}
          disabled={busy || optBusy || selectedCount < 2}
          style={{ padding: "12px 12px", borderRadius: 12, fontWeight: 900 }}
        >
          {optBusy ? "Otimizando..." : "Otimizar selecao"}
        </button>
        <button
          onClick={clearSelection}
          disabled={busy}
          style={{ padding: "12px 12px", borderRadius: 12 }}
        >
          Limpar selecao
        </button>
      </div>

      {msg && (
        <div style={{ padding: 10, borderRadius: 12, background: "#f9fafb" }}>
          {msg}
        </div>
      )}

      <div style={{ fontWeight: 800 }}>
        Entregas disponiveis (geocodificadas e sem rota): {deliveries.length}
      </div>

      <div
        style={{
          display: "grid",
          gap: 8,
          maxHeight: 380,
          overflow: "auto",
          border: "1px solid #eee",
          borderRadius: 12,
          padding: 8,
          background: "#fff",
        }}
      >
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
                {checked ? "[x] " : ""}Pedido: {d.pedido ?? "-"}
              </div>
              <div>
                <strong>Cliente:</strong> {d.cliente ?? "-"}
              </div>
              <div style={{ opacity: 0.9 }}>
                <strong>Endereco:</strong> {d.endereco_completo ?? "-"}
              </div>
            </div>
          );
        })}

        {deliveries.length === 0 && (
          <div style={{ opacity: 0.85 }}>
            Nenhuma entrega disponivel (talvez ja estejam em rota).
          </div>
        )}
      </div>
    </div>
  );
}
