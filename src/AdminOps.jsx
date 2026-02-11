import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import ExcelImport from "./ExcelImport";
import ManualRoutePlanner from "./ManualRoutePlanner";
import AdminRoutesSummary from "./AdminRoutesSummary";

export default function AdminOps() {
  // Etapas: 1 Importar | 2 Geocodificar | 3 Rotear
  const [step, setStep] = useState(1);

  const [deliveries, setDeliveries] = useState([]);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoMsg, setGeoMsg] = useState("");
  const [geoFails, setGeoFails] = useState([]);

  const [vehicles, setVehicles] = useState([]);
  const [usedVehicleIds, setUsedVehicleIds] = useState(new Set());

  const geocodedCount = useMemo(
    () =>
      deliveries.filter((d) => Number.isFinite(d.lat) && Number.isFinite(d.lng))
        .length,
    [deliveries],
  );

  useEffect(() => {
    loadVehicles();
    refreshDeliveriesAvailable();
    refreshUsedVehicles();
  }, []);

  async function loadVehicles() {
    const { data } = await supabase
      .from("vehicles")
      .select("id, name, plate")
      .order("name");
    setVehicles(data || []);
  }

  // Entregas disponíveis = pendentes + geocodificadas + ainda NÃO estão em rota
  async function refreshDeliveriesAvailable() {
    const { data, error } = await supabase
      .from("deliveries")
      .select(
        "id, pedido, cliente, endereco_completo, lat, lng, status, created_at, route_id",
      )
      .in("status", ["pendente"]) // só as ainda não alocadas
      .not("lat", "is", null)
      .not("lng", "is", null)
      .order("created_at", { ascending: true })
      .limit(500);

    if (!error) setDeliveries(data || []);
  }

  // veículos já usados (já possuem rota ativa) -> trava seleção (regra 5)
  async function refreshUsedVehicles() {
    // início do dia (Manaus)
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const { data, error } = await supabase
      .from("routes")
      .select("vehicle_id, created_at, status")
      .eq("status", "ativa")
      .gte("created_at", start.toISOString())
      .limit(200);

    if (!error) {
      const setIds = new Set(
        (data || []).map((x) => x.vehicle_id).filter(Boolean),
      );
      setUsedVehicleIds(setIds);
    }
  }

  // Você já tem uma função de geocode no AdminMonitor/AdminLiveMap.
  // Aqui eu chamo uma RPC/endpoint? Não.
  // Solução: a geocodificação continua no AdminMonitor, mas aqui só controlamos a etapa.
  // Como você já tem geocodificarPendentes funcionando, a gente vai reaproveitar criando uma versão enxuta aqui.

  async function geocodificarPendentes() {
    setGeoMsg("");
    setGeoFails([]);
    setGeoBusy(true);

    try {
      // pega pendentes sem lat/lng (até 30)
      const { data: list, error } = await supabase
        .from("deliveries")
        .select("id, endereco_completo, rua, numero, bairro, cidade, estado")
        .is("lat", null)
        .limit(30);

      if (error) {
        setGeoMsg("Erro buscando pendentes: " + error.message);
        return;
      }
      if (!list || list.length === 0) {
        setGeoMsg("✅ Nenhuma entrega pendente para geocodificar.");
        await refreshDeliveriesAvailable();
        return;
      }

      let ok = 0;
      let fail = 0;
      const fails = [];

      for (const d of list) {
        try {
          await new Promise((r) => setTimeout(r, 250)); // evita spam

          // monta query
          const rua = String(d.rua || "").trim();
          const numero = String(d.numero || "").trim();
          const bairro = String(d.bairro || "").trim();
          const cidade = String(d.cidade || "Manaus").trim() || "Manaus";
          const estado = String(d.estado || "AM").trim() || "AM";

          let q = String(d.endereco_completo || "").trim();
          if (!q) {
            q = [rua, numero, bairro, `${cidade} - ${estado}`, "Brasil"]
              .filter(Boolean)
              .join(", ");
          }

          const resp = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
          const txt = await resp.text();

          let j;
          try {
            j = JSON.parse(txt);
          } catch {
            fail++;
            fails.push({
              endereco: q,
              motivo: "Resposta inválida do servidor",
            });
            continue;
          }

          if (!j?.found || !Number.isFinite(j.lat) || !Number.isFinite(j.lng)) {
            fail++;
            fails.push({ endereco: q, motivo: "Não encontrado" });
            continue;
          }

          const { error: upErr } = await supabase
            .from("deliveries")
            .update({ lat: j.lat, lng: j.lng })
            .eq("id", d.id);

          if (upErr) fail++;
          else ok++;
        } catch {
          fail++;
        }
      }

      setGeoFails(fails);
      setGeoMsg(`✅ Geocodificação finalizada: ${ok} ok, ${fail} falhas.`);
      await refreshDeliveriesAvailable();
    } finally {
      setGeoBusy(false);
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Painel ADM — Operação</h2>

      {/* STEP HEADER */}
      <div
        style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}
      >
        <StepPill
          active={step === 1}
          onClick={() => setStep(1)}
          label="1) Importar"
        />
        <StepPill
          active={step === 2}
          onClick={() => setStep(2)}
          label="2) Geocodificar"
        />
        <StepPill
          active={step === 3}
          onClick={() => setStep(3)}
          label="3) Montar rotas"
        />
      </div>

      {/* STEP 1 */}
      {step === 1 && (
        <Card>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>
            1) Importar entregas
          </div>

          <ExcelImport
            onImported={async () => {
              await refreshDeliveriesAvailable();
              setStep(2);
            }}
          />

          <div style={{ marginTop: 10, opacity: 0.85 }}>
            Após importar, vá para <strong>Geocodificar</strong>.
          </div>
        </Card>
      )}

      {/* STEP 2 */}
      {step === 2 && (
        <Card>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>
            2) Geocodificar entregas
          </div>

          <button
            onClick={geocodificarPendentes}
            disabled={geoBusy}
            style={{ padding: "12px 14px", borderRadius: 12, fontWeight: 900 }}
          >
            {geoBusy ? "Geocodificando..." : "Geocodificar (Google)"}
          </button>

          {geoMsg && <div style={{ marginTop: 10 }}>{geoMsg}</div>}

          {geoFails.length > 0 && (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                border: "1px solid #eee",
                borderRadius: 10,
              }}
            >
              <strong>Falharam ({geoFails.length}):</strong>
              <ul>
                {geoFails.map((f, i) => (
                  <li key={i}>
                    {f.endereco} {f.motivo ? `— ${f.motivo}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ marginTop: 10, opacity: 0.85 }}>
            Geocodificadas disponíveis: <strong>{geocodedCount}</strong>
          </div>

          <div style={{ marginTop: 12 }}>
            <button
              onClick={async () => {
                await refreshDeliveriesAvailable();
                setStep(3);
              }}
              style={{
                padding: "12px 14px",
                borderRadius: 12,
                fontWeight: 900,
              }}
            >
              Ir para Montar rotas
            </button>
          </div>
        </Card>
      )}

      {/* STEP 3 */}
      {step === 3 && (
        <Card>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>
            3) Montar rotas manualmente
          </div>

          <div style={{ marginBottom: 10, opacity: 0.85 }}>
            Você vai selecionar entregas para um caminhão, criar a rota, e elas
            somem da lista.
          </div>
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              marginBottom: 10,
            }}
          >
            <button
              onClick={async () => {
                setStep(3);
                setGeoMsg("");
                const { error } = await supabase
                  .from("routes")
                  .update({ status: "encerrada" })
                  .eq("status", "ativa");
                if (error) alert("Erro ao encerrar rotas: " + error.message);
                await refreshUsedVehicles();
              }}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                fontWeight: 900,
              }}
            >
              Encerrar todas rotas ativas
            </button>
          </div>

          <ManualRoutePlanner
            vehicles={vehicles}
            usedVehicleIds={usedVehicleIds}
            deliveries={deliveries}
            onAfterCreate={async () => {
              await refreshDeliveriesAvailable();
              await refreshUsedVehicles();
            }}
          />
        </Card>
      )}
      <AdminRoutesSummary />
    </div>
  );
}

function StepPill({ active, label, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "10px 12px",
        borderRadius: 999,
        fontWeight: 900,
        border: active ? "2px solid #111" : "1px solid #ddd",
        background: active ? "#f3f4f6" : "#fff",
      }}
    >
      {label}
    </button>
  );
}

function Card({ children }) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        padding: 12,
        background: "#fff",
      }}
    >
      {children}
    </div>
  );
}
