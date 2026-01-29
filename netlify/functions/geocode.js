exports.handler = async (event) => {
  try {
    const qRaw = event.queryStringParameters?.q;
    if (!qRaw || String(qRaw).trim().length < 3) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Parâmetro q (endereço) é obrigatório." }),
      };
    }

    // limpa CEP e excesso de espaços
    const q = String(qRaw)
      .replace(/cep[:\s]*/gi, "")
      .replace(/\b\d{5}-?\d{3}\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const url =
      "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1" +
      "&countrycodes=br" +
      "&limit=3" +
      "&viewbox=-60.30,-3.00,-59.80,-3.25&bounded=0" +
      "&q=" + encodeURIComponent(q);

    const resp = await fetch(url, {
      headers: {
        "User-Agent": "AppEntregasManaus/1.0 (contato: contato@seudominio.com)",
        "Accept-Language": "pt-BR",
      },
    });

    const data = await resp.json();

    if (!Array.isArray(data) || data.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ found: false, query: q }),
      };
    }

    // escolhe o melhor resultado (Manaus/Amazonas quando possível)
    const pick =
      data.find((x) => (x.address?.city || "").toLowerCase() === "manaus") ||
      data.find((x) => (x.address?.town || "").toLowerCase() === "manaus") ||
      data.find((x) => (x.address?.state || "").toLowerCase().includes("amazon")) ||
      data[0];

    return {
      statusCode: 200,
      body: JSON.stringify({
        found: true,
        lat: Number(pick.lat),
        lng: Number(pick.lon),
        display_name: pick.display_name,
        query: q,
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(e?.message || e) }),
    };
  }
};
