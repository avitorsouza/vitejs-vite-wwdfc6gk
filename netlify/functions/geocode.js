exports.handler = async (event) => {
  try {
    const qRaw = event.queryStringParameters?.q;
    if (!qRaw || String(qRaw).trim().length < 3) {
      return { statusCode: 400, body: JSON.stringify({ error: "Parâmetro q é obrigatório" }) };
    }

    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return { statusCode: 500, body: JSON.stringify({ error: "GOOGLE_MAPS_API_KEY não configurada no Netlify" }) };
    }

    const q = String(qRaw).replace(/\s+/g, " ").trim();

    // Bias para Manaus (opcional, ajuda)
    const components = "country:BR|administrative_area:AM";

    const url =
      "https://maps.googleapis.com/maps/api/geocode/json" +
      "?address=" + encodeURIComponent(q) +
      "&components=" + encodeURIComponent(components) +
      "&key=" + encodeURIComponent(key);

    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ found: false, source: "google", status: data.status, query: q }),
      };
    }

    const r = data.results[0];
    const loc = r.geometry?.location;

    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      return {
        statusCode: 200,
        body: JSON.stringify({ found: false, source: "google", status: "NO_LOCATION", query: q }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        found: true,
        lat: loc.lat,
        lng: loc.lng,
        formatted_address: r.formatted_address,
        source: "google",
        query: q,
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e?.message || e) }) };
  }
};
