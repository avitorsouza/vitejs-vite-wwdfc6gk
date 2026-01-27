import { useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "./supabase";

export default function ExcelImport({ onImported }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleFile(file) {
    setMsg("");
    if (!file) return;

    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

      // Mapeia colunas (ajuste aqui se seus nomes forem diferentes)
      const deliveries = rows
        .map((r) => ({
          cliente: String(r.cliente || r.Cliente || r.NOME || "").trim(),
          endereco: String(r.endereco || r.Endereco || r.ENDERECO || "").trim(),
          pedido: String(r.pedido || r.Pedido || r.PEDIDO || "").trim() || null,
          telefone: String(r.telefone || r.Telefone || r.FONE || "").trim() || null,
          observacoes: String(r.observacoes || r.Observacoes || r.OBS || "").trim() || null,
          status: "pendente",
        }))
        .filter((d) => d.cliente && d.endereco);

      if (deliveries.length === 0) {
        setMsg("Nenhuma linha válida encontrada. Confirme as colunas: cliente e endereco.");
        return;
      }

      const { error } = await supabase.from("deliveries").insert(deliveries);
      if (error) {
        setMsg("Erro ao salvar no banco: " + error.message);
        return;
      }

      setMsg(`✅ Importado com sucesso: ${deliveries.length} entregas`);
      onImported?.();
    } catch (e) {
      setMsg("Erro ao ler Excel: " + String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
      <h3>Importar entregas (Excel)</h3>
      <p style={{ marginTop: 6, opacity: 0.8 }}>
        Colunas mínimas: <strong>cliente</strong> e <strong>endereco</strong>
      </p>

      <input
        type="file"
        accept=".xlsx,.xls"
        disabled={busy}
        onChange={(e) => handleFile(e.target.files?.[0] || null)}
      />

      {busy && <p>Importando...</p>}
      {msg && <p style={{ marginTop: 10 }}>{msg}</p>}
    </div>
  );
}
