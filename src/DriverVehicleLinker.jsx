import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";

export default function DriverVehicleLinker() {
  const [drivers, setDrivers] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [links, setLinks] = useState([]);
  const [driverId, setDriverId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const driversById = useMemo(() => {
    const m = new Map();
    for (const d of drivers) m.set(d.id, d);
    return m;
  }, [drivers]);

  const vehiclesById = useMemo(() => {
    const m = new Map();
    for (const v of vehicles) m.set(v.id, v);
    return m;
  }, [vehicles]);

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAll() {
    setMsg("");
    setBusy(true);
    try {
      // motoristas (ajuste o select conforme sua tabela profiles)
      // (removi email pq no seu banco não existe)
      const { data: ds, error: dErr } = await supabase
        .from("profiles")
        .select("id, name")
        .eq("role", "motorista")
        .order("name", { ascending: true })
        .limit(500);

      if (dErr) throw dErr;

      // veículos
      const { data: vs, error: vErr } = await supabase
        .from("vehicles")
        .select("id, name, plate")
        .order("name", { ascending: true })
        .limit(500);

      if (vErr) throw vErr;

      // vínculos (removi created_at pq no seu banco não existe)
      const { data: ls, error: lErr } = await supabase
        .from("driver_vehicle")
        .select("driver_id, vehicle_id")
        .limit(2000);

      if (lErr) throw lErr;

      setDrivers(ds || []);
      setVehicles(vs || []);
      setLinks(ls || []);

      if (!driverId && ds?.[0]?.id) setDriverId(ds[0].id);
      if (!vehicleId && vs?.[0]?.id) setVehicleId(vs[0].id);
    } catch (e) {
      setMsg("Erro ao carregar: " + (e?.message || String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function vincular() {
    setMsg("");
    if (!driverId) return setMsg("Selecione um motorista.");
    if (!vehicleId) return setMsg("Selecione um veículo.");

    setBusy(true);
    try {
      const resp = await fetch("/api/admin/link-driver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driver_id: driverId, vehicle_id: vehicleId }),
      });

      const j = await resp.json().catch(() => null);

      if (!resp.ok) {
        throw new Error(j?.error || "Falha ao salvar vínculo");
      }

      setMsg("✅ Vínculo salvo!");
      await loadAll();
    } catch (e) {
      setMsg("Erro ao vincular: " + (e?.message || String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function desvincular(dId) {
    setMsg("");
    setBusy(true);
    try {
      const { error } = await supabase
        .from("driver_vehicle")
        .delete()
        .eq("driver_id", dId);

      if (error) throw error;

      setMsg("✅ Vínculo removido.");
      await loadAll();
    } catch (e) {
      setMsg("Erro ao remover: " + (e?.message || String(e)));
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
      <div style={{ fontWeight: 900, marginBottom: 10 }}>
        Vínculo Motorista ↔ Caminhão
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <label>
          <div style={{ fontSize: 13, opacity: 0.8 }}>Motorista</div>
          <select
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            style={{ padding: 10, width: "100%", borderRadius: 12 }}
            disabled={busy}
          >
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name ?? d.id}
              </option>
            ))}
          </select>
        </label>

        <label>
          <div style={{ fontSize: 13, opacity: 0.8 }}>Caminhão</div>
          <select
            value={vehicleId}
            onChange={(e) => setVehicleId(e.target.value)}
            style={{ padding: 10, width: "100%", borderRadius: 12 }}
            disabled={busy}
          >
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} — {v.plate}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={vincular}
          disabled={busy}
          style={{ padding: "12px 12px", borderRadius: 12, fontWeight: 900 }}
        >
          {busy ? "Salvando..." : "Salvar vínculo"}
        </button>

        {msg && (
          <div style={{ padding: 10, borderRadius: 12, background: "#f9fafb" }}>
            {msg}
          </div>
        )}

        <div style={{ fontWeight: 800, marginTop: 10 }}>Vínculos atuais</div>

        {links.length === 0 ? (
          <div style={{ opacity: 0.85 }}>Nenhum vínculo cadastrado.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {links.map((l) => {
              const d = driversById.get(l.driver_id);
              const v = vehiclesById.get(l.vehicle_id);
              return (
                <div
                  key={l.driver_id}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 12,
                    padding: 10,
                    background: "#fff",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 900 }}>
                      👤 {d?.name ?? l.driver_id}
                    </div>
                    <div style={{ opacity: 0.9 }}>
                      🚚 {v ? `${v.name} — ${v.plate}` : l.vehicle_id}
                    </div>
                  </div>

                  <button
                    onClick={() => desvincular(l.driver_id)}
                    disabled={busy}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 12,
                      fontWeight: 800,
                    }}
                  >
                    Remover vínculo
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
