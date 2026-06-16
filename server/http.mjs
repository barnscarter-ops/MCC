export function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

export function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

export async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 512_000) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}

export function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app') || origin.endsWith('.ts.net')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}
