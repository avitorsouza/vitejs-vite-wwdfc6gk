export async function handler(event) {
    try {
      const q = event.queryStringParameters?.q;
      if (!q || q.trim().length < 5) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "Parâmetro q (endereço) é obrigatório." }),
        };
      }
  
      const url =
        "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
        encodeURIComponent(q);
  
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "AppEntregasManaus/1.0 (contato: ti@euromanaus.com.br)",
          "Accept-Language": "pt-BR",
        },
      });
  
      const data = await resp.json();
  
      if (!Array.isArray(data) || data.length === 0) {
        return {
          statusCode: 200,
          body: JSON.stringify({ found: false }),
        };
      }
  
      return {
        statusCode: 200,
        body: JSON.stringify({
          found: true,
          lat: Number(data[0].lat),
          lng: Number(data[0].lon),
        }),
      };
    } catch (e) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: String(e) }),
      };
    }
  }
  