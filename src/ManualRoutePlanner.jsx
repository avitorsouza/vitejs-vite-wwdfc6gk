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

  // garante um veículo disponível selecionado (do jeito certo)
  useEffect(() => {
    // Se o veículo selecionado não existe mais na lista disponível, escolhe o primeiro disponível
    const stillAvailable = availableVehicles.some(
      (v) => v.id === selectedVehicleId,
    );

    if (!selectedVehicleId || !stillAvailable) {
      if (availableVehicles?.[0]?.id) {
        setSelectedVehicleId(availableVehicles[0].id);
      } else {
        setSelectedVehicleId("");
      }
    }
  }, [availableVehicles, selectedVehicleId]);

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
  async function otimizarRotaGoogle() {
    if (selected.size === 0) {
      setMsg("Selecione entregas para otimizar.");
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

      const j = await resp.json();

      if (!resp.ok) {
        setMsg("Erro ao otimizar: " + (j.error || "desconhecido"));
        return;
      }

      // ordem otimizada retornada do servidor
      setOptimizedOrder(j.order);
      setMsg("✅ Rota otimizada! Agora clique em CRIAR ROTA.");
    } catch (e) {
      setMsg("Erro ao otimizar: " + e.message);
    } finally {
      setOptBusy(false);
    }
  }

  async function criarRotaManual() {
    setMsg("");

    if (!selectedVehicleId) {
      setMsg("Não há caminhão disponível (os anteriores já foram usados).");
      return;
    }
    if (selected.size === 0) {
      setMsg("Selecione pelo menos 1 entrega.");
      return;
    }

    setBusy(true);
    try {
      // 1) criar rota ativa
      const { data: route, error: rErr } = await supabase
        .from("routes")
        .insert([
          {
            vehicle_id: selectedVehicleId,
            status: "ativa",
            depot_address: "AV. TEFÉ, 2840 - JAPIIM - MANAUS",
          },
        ])
        .select("id")
        .single();

      if (rErr || !route?.id) {
        setMsg("Erro ao criar rota: " + (rErr?.message || "sem id (RLS?)"));
        return;
      }

      // 2) paradas na ordem da seleção em tela
      let ordered = deliveries.filter((d) => selected.has(d.id));

      // se já foi otimizado, usar a ordem otimizada
      if (optimizedOrder) {
        ordered = optimizedOrder
          .map((id) => deliveries.find((d) => d.id === id))
          .filter(Boolean);
      }

      const stopsPayload = ordered.map((d, idx) => ({
        route_id: route.id,
        delivery_id: d.id,
        stop_order: idx + 1,
      }));

      const { error: sErr } = await supabase
        .from("route_stops")
        .insert(stopsPayload);
      if (sErr) {
        setMsg("Erro ao criar paradas: " + sErr.message);
        return;
      }

      // 3) marcar entregas como em_rota (saem da lista principal)
      const ids = ordered.map((d) => d.id);
      const { error: upErr } = await supabase
        .from("deliveries")
        .update({ status: "Em Rota" })
        .in("id", ids);

      if (upErr) {
        setMsg(
          "Rota criada, mas falhou ao atualizar entregas: " + upErr.message,
        );
      } else {
        setMsg(`✅ Rota criada para ${ordered.length} entregas.`);
      }

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
        <div style={{ fontWeight: 800, marginBottom: 6 }}>
          Caminhão disponível
        </div>
        <select
          value={selectedVehicleId}
          onChange={(e) => setSelectedVehicleId(e.target.value)}
          style={{ padding: 10, width: "100%", borderRadius: 12 }}
          disabled={busy || availableVehicles.length === 0}
        >
          {availableVehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} — {v.plate}
            </option>
          ))}
        </select>

        {availableVehicles.length === 0 && (
          <div style={{ marginTop: 8, opacity: 0.85 }}>
            Todos os caminhões já possuem rota ativa.
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
          onClick={otimizarRotaGoogle}
          disabled={optBusy || selected.size === 0}
          style={{ padding: "12px 12px", borderRadius: 12, fontWeight: 900 }}
        >
          {optBusy ? "Otimizando..." : "Otimizar rota (Google)"}
        </button>

        <button
          onClick={criarRotaManual}
          disabled={busy || !selectedVehicleId}
          style={{ padding: "12px 12px", borderRadius: 12, fontWeight: 900 }}
        >
          {busy ? "Criando..." : `Criar rota (${selectedCount})`}
        </button>
        <button
          onClick={clearSelection}
          disabled={busy}
          style={{ padding: "12px 12px", borderRadius: 12 }}
        >
          Limpar seleção
        </button>
      </div>

      {msg && (
        <div style={{ padding: 10, borderRadius: 12, background: "#f9fafb" }}>
          {msg}
        </div>
      )}

      <div style={{ fontWeight: 800 }}>
        Entregas disponíveis (geocodificadas e sem rota): {deliveries.length}
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
                {checked ? "✅ " : ""}Pedido: {d.pedido ?? "—"}
              </div>
              <div>
                <strong>Cliente:</strong> {d.cliente ?? "—"}
              </div>
              <div style={{ opacity: 0.9 }}>
                <strong>Endereço:</strong> {d.endereco_completo ?? "—"}
              </div>
            </div>
          );
        })}

        {deliveries.length === 0 && (
          <div style={{ opacity: 0.85 }}>
            Nenhuma entrega disponível (talvez já estejam em rota).
          </div>
        )}
      </div>
    </div>
  );
}
