import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DataEngine } from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const RENDERER_DIR = path.resolve(__dirname, "../renderer");
const ASSETS_DIR = path.resolve(ROOT_DIR, "assets");

const engine = new DataEngine(ROOT_DIR);
if (process.env.NODE_ENV !== "test") {
  engine.start();
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  // API Endpoints
  if (urlPath === "/api/summary") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(engine.getSummary()));
  }

  if (urlPath === "/api/refresh") {
    try {
      const summary = await engine.step();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(summary));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message, summary: engine.getSummary() }));
    }
  }

  if (urlPath === "/api/disconnect" && req.method === "POST") {
    engine.disconnect();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ success: true }));
  }

  if (urlPath === "/api/connect" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const creds = JSON.parse(body);
        const summary = await engine.connect(creds);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(summary));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message, connected: false }));
      }
    });
    return;
  }

  if (urlPath === "/api/config" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const newCfg = JSON.parse(body);
        engine.saveConfig(newCfg);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, config: engine.config }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (urlPath === "/api/devices/nickname" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { mac, nickname } = JSON.parse(body);
        engine.setDeviceNickname(mac, nickname);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, summary: engine.getSummary() }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (urlPath === "/api/devices/block" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { mac, name } = JSON.parse(body);
        const result = await engine.blockDevice(mac, name);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, result, summary: engine.getSummary() }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (urlPath === "/api/devices/unblock" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { mac, name } = JSON.parse(body);
        const result = await engine.unblockDevice(mac, name);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, result, summary: engine.getSummary() }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (urlPath === "/api/devices/unblock-all" && req.method === "POST") {
    try {
      const result = await engine.unblockAll();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, result, summary: engine.getSummary() }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (urlPath === "/api/devices/limit" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { mac, limitGb, autoBlock } = JSON.parse(body);
        engine.setDeviceLimit(mac, limitGb, autoBlock);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, summary: engine.getSummary() }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (urlPath === "/api/test-connection" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const creds = JSON.parse(body);
        const result = await engine.testConnection(creds);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, result }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Static File Serving — sanitize path to prevent directory traversal (CWE-27 / GHSA-x3jp-2cwp-7q9m)
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Bad Request");
  }

  // Reject null bytes and directory traversal tricks
  if (decodedPath.includes("\0")) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Bad Request");
  }

  const cleanPath = decodedPath === "/" || decodedPath === "" ? "/index.html" : decodedPath;

  let baseDir = RENDERER_DIR;
  let relPath = cleanPath;

  if (cleanPath.startsWith("/assets/")) {
    baseDir = ASSETS_DIR;
    relPath = cleanPath.slice("/assets/".length);
  } else {
    relPath = cleanPath.replace(/^\/+/, "");
  }

  // Resolve target path and verify it stays inside baseDir
  const filePath = path.resolve(baseDir, relPath);

  // CRITICAL: Reject any resolved path that escapes the allowed directory
  if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden");
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    return res.end(fs.readFileSync(filePath));
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

function listen(port, tries = 5) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && tries > 0) {
      listen(port + 1, tries - 1);
    } else {
      console.error("Server listen error:", err.message);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const activePort = server.address().port;
    fs.writeFileSync(path.join(ROOT_DIR, ".active_port"), String(activePort));
    console.log(`Tally background engine running on http://127.0.0.1:${activePort}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  listen(engine.config.port || 3000);
}

export { server, engine, listen };

