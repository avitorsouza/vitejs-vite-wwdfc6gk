async function tryNominatim(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1" +
    "&countrycodes=br" +
    "&limit=3" +
    "&viewbox=-60.30,-3.00,-59.80,-3.25&bounded=0" +
    "&q=" +
    encodeURIComponent(q);

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "AppEntregasManaus/1.0 (contato: contato@seudominio.com)",
      "Accept-Language": "pt-BR",
    },
  });

  const data = await resp.json();

  if (!Array.isArray(data) || data.length === 0) {
    return { found: false, source: "nominatim" };
  }

  const pick =
    data.find((x) => (x.address?.city || "").toLowerCase() === "manaus") ||
    data.find((x) => (x.address?.town || "").toLowerCase() === "manaus") ||
    data.find((x) => (x.address?.state || "").toLowerCase().includes("amazon")) ||
    data[0];

  return {
    found: true,
    lat: Number(pick.lat),
    lng: Number(pick.lon),
    display_name: pick.display_name,
    source: "nominatim",
  };
}

async function tryPhoton(q) {
  // Photon (Komoot) — geocoder tolerante
  const url =
    "https://photon.komoot.io/api/?limit=3&lang=pt&q=" +
    encodeURIComponent(q);

  const resp = await fetch(url, {
    headers: {
      "Accept-Language": "pt-BR",
    },
  });

  const data = await resp.json();

  const feats = data?.features;
  if (!Array.isArray(feats) || feats.length === 0) {
    return { found: false, source: "photon" };
  }

  // Prioriza Manaus/AM quando existir
  const pick =
    feats.find((f) => (f?.properties?.city || "").toLowerCase() === "manaus") ||
    feats.find((f) => (f?.properties?.state || "").toLowerCase().includes("amazon")) ||
    feats[0];

  const coords = pick?.geometry?.coordinates; // [lng, lat]
  if (!Array.isArray(coords) || coords.length < 2) {
    return { found: false, source: "photon" };
  }

  return {
    found: true,
    lat: Number(coords[1]),
    lng: Number(coords[0]),
    display_name: pick?.properties?.name || pick?.properties?.street || "Photon result",
    source: "photon",
  };
}

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

    // 1) tenta Nominatim
    const n = await tryNominatim(q);
    if (n.found && Number.isFinite(n.lat) && Number.isFinite(n.lng)) {
      return {
        statusCode: 200,
        body: JSON.stringify({ found: true, lat: n.lat, lng: n.lng, source: n.source, query: q }),
      };
    }

    // 2) fallback Photon
    const p = await tryPhoton(q);
    if (p.found && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
      return {
        statusCode: 200,
        body: JSON.stringify({ found: true, lat: p.lat, lng: p.lng, source: p.source, query: q }),
      };
    }

    // nenhum achou
    return {
      statusCode: 200,
      body: JSON.stringify({ found: false, source: "none", query: q }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(e?.message || e) }),
    };
  }
};
