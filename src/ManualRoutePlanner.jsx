import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";

export default function ManualRoutePlanner({
  vehicles = [],
  drivers = [],
  usedVehicleIds = new Set(),
  usedDriverIds = new Set(),
  deliveries = [],
  onAfterCreate,
}) {
  const [selectedVehicleId, setSelectedVehicleId] = useState("");
  const [selectedDriverId, setSelectedDriverId] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [optimizedOrder, setOptimizedOrder] = useState(null);
  const [optBusy, setOptBusy] = useState(false);

  const availableVehicles = useMemo(
    () => vehicles.filter((v) => !usedVehicleIds.has(v.id)),
    [vehicles, usedVehicleIds],
  );
  const availableDrivers = useMemo(
    () => drivers.filter((d) => !usedDriverIds.has(d.id)),
    [drivers, usedDriverIds],
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

  useEffect(() => {
    const stillAvailable = availableDrivers.some((d) => d.id === selectedDriverId);
    if (!selectedDriverId || !stillAvailable) {
      setSelectedDriverId(availableDrivers?.[0]?.id || "");
    }
  }, [availableDrivers, selectedDriverId]);

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
    if (!selectedDriverId) {
      setMsg("Selecione um motorista.");
      return;
    }
    if (selected.size < 2) {
      setMsg("Selecione pelo menos 2 entregas para criar rota.");
      return;
    }

    setBusy(true);
    try {
      const linkResp = await fetch("/api/admin/link-driver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driver_id: selectedDriverId,
          vehicle_id: selectedVehicleId,
        }),
      });
      const linkJson = await linkResp.json().catch(() => null);
      if (!linkResp.ok || !linkJson?.ok) {
        setMsg(
          "Erro ao vincular motorista e caminhao: " +
            (linkJson?.error || linkJson?.details || "desconhecido"),
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
          driver_id: selectedDriverId,
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
      <div>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>Motorista disponivel</div>
        <select
          value={selectedDriverId}
          onChange={(e) => setSelectedDriverId(e.target.value)}
          style={{ padding: 10, width: "100%", borderRadius: 12 }}
          disabled={busy || availableDrivers.length === 0}
        >
          {availableDrivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name || d.id}
            </option>
          ))}
        </select>

        {availableDrivers.length === 0 && (
          <div style={{ marginTop: 8, opacity: 0.85 }}>
            Todos os motoristas ja possuem rota ativa.
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
          disabled={busy || !selectedVehicleId || !selectedDriverId}
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
