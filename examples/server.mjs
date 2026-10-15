// Test dev server: shows what localhttps forwarded and checks the WebSocket path.
//   node examples/server.mjs [port]   (default 3000)
import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.argv[2] ?? 3000);

const page = (req) => `<!doctype html>
<meta charset="utf-8"><title>localhttps test</title>
<style>body{font:16px system-ui;margin:2rem;max-width:40rem}code{background:#8882;padding:2px 4px}</style>
<h1>localhttps test server</h1>
<p>Page: <code id="url"></code></p>
<p>Upstream saw: Host <code>${req.headers.host}</code>,
X-Forwarded-Proto <code>${req.headers["x-forwarded-proto"] ?? "(none)"}</code></p>
<p>WebSocket: <code id="ws">connecting…</code></p>
<script>
  url.textContent = location.href;
  const s = new WebSocket(location.origin.replace("http", "ws") + "/ws");
  s.onopen = () => s.send("ping");
  s.onmessage = (e) => (ws.textContent = "OK (" + e.data + ")");
  s.onerror = () => (ws.textContent = "FAILED");
</script>`;

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url} host=${req.headers.host}`);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(req));
});

// Minimal WebSocket: handshake, then answer the first text frame with "pong".
server.on("upgrade", (req, socket) => {
  const accept = crypto
    .createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
      `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.once("data", () => socket.write(Buffer.from([0x81, 4, ...Buffer.from("pong")])));
  socket.on("error", () => {});
});

server.listen(port, () => console.log(`test server on http://localhost:${port}`));
