exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters?.q;
    if (!q || q.trim().length < 3) {
      return { statusCode: 400, body: JSON.stringify({ error: "q obrigatório" }) };
    }

    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=3&q=" +
      encodeURIComponent(q);

    const resp = await fetch(url, {
      headers: {
        "User-Agent": "AppEntregasManaus/1.0 (contato: contato@seudominio.com)",
        "Accept-Language": "pt-BR",
      },
    });

    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ found: false }) };
    }

    const pick =
  data.find((x) => x.address?.city?.toLowerCase() === "manaus") ||
  data.find((x) => (x.address?.state || "").toLowerCase().includes("amazon")) ||
  data[0];

return {
  statusCode: 200,
  body: JSON.stringify({
    found: true,
    lat: Number(pick.lat),
    lng: Number(pick.lon),
    display_name: pick.display_name,
  }),
};

