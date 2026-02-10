import { useState } from "react";
import AdminOps from "./AdminOps";
import AdminMonitor from "./AdminMonitor";

export default function AdminHome() {
  const [tab, setTab] = useState("ops"); // ops | monitor

  return (
    <div style={{ fontFamily: "Arial", padding: 16 }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <button
          onClick={() => setTab("ops")}
          style={{
            padding: "10px 12px",
            borderRadius: 12,
            fontWeight: 800,
            border: tab === "ops" ? "2px solid #111" : "1px solid #ddd",
            background: tab === "ops" ? "#f3f4f6" : "#fff",
          }}
        >
          Painel ADM (Burocrático)
        </button>

        <button
          onClick={() => setTab("monitor")}
          style={{
            padding: "10px 12px",
            borderRadius: 12,
            fontWeight: 800,
            border: tab === "monitor" ? "2px solid #111" : "1px solid #ddd",
            background: tab === "monitor" ? "#f3f4f6" : "#fff",
          }}
        >
          Mapa & Monitoramento
        </button>
      </div>

      {tab === "ops" ? <AdminOps /> : <AdminMonitor />}
    </div>
  );
}
