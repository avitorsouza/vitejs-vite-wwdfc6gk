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
  .map((r) => {
    const pedido = String(r.pedido || r.Pedido || r.PEDIDO || "").trim() || null;
    const cliente = String(r.nome_cliente || r.nome || r.Nome || r.CLIENTE || r.Cliente || r.NOME || "").trim();

    const rua = String(r.rua || r.Rua || r.logradouro || r.Logradouro || "").trim();
    const numero = String(r.numero || r.Número || r.Numero || "").trim();
    const bairro = String(r.bairro || r.Bairro || "").trim();

    const cidade = String(r.cidade || r.Cidade || "Manaus").trim() || "Manaus";
    const estado = String(r.estado || r.Estado || "AM").trim() || "AM";

    const telefone = String(r.telefone || r.Telefone || r.FONE || "").trim() || null;
    const observacoes = String(r.observacoes || r.Observacoes || r.OBS || "").trim() || null;

    // endereço completo montado (para geocodificação)
    const endereco_completo = [rua, numero, bairro, `${cidade} - ${estado}`, "Brasil"]
      .filter(Boolean)
      .join(", ");

      return {
        pedido,
        cliente,
        rua: rua || null,
        numero: numero || null,
        bairro: bairro || null,
        cidade,
        estado,
        endereco_completo,
        telefone,
        observacoes,
        status: "pendente",
      };
      
  })
  // regras mínimas: cliente + rua + numero + bairro
  .filter((d) => d.cliente && d.rua && d.numero && d.bairro);


      if (deliveries.length === 0) {
        setMsg("Nenhuma linha válida encontrada. Confirme as colunas: Nome do cliente, rua, numero, bairro (cidade/estado opcionais).");
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
      Colunas mínimas: <strong>nome do cliente</strong>, <strong>rua</strong>, <strong>numero</strong>, <strong>bairro</strong>

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
