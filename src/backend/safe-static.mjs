import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STATIC_DIR = path.resolve(__dirname, "../renderer");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Safely serve static files from rootDir, preventing CWE-27 directory traversal,
 * null-byte injection, and symlink-based jailbreaks.
 */
export function serveStatic(req, res, rootDir = DEFAULT_STATIC_DIR) {
  const urlPath = req.url.split("?")[0];

  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Bad Request");
  }

  // Reject null-bytes
  if (decoded.includes("\0")) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Bad Request");
  }

  // Reject directory traversal attempts early
  if (decoded.includes("..")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not Found");
  }

  let realRootDir;
  try {
    realRootDir = fs.realpathSync(rootDir);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    return res.end("Server Configuration Error");
  }

  const cleanPath = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");
  const targetPath = path.resolve(realRootDir, cleanPath);

  // Containment check on unresolved path
  if (!targetPath.startsWith(realRootDir + path.sep) && targetPath !== realRootDir) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not Found");
  }

  if (!fs.existsSync(targetPath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not Found");
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(targetPath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not Found");
  }

  // Symlink jailbreak check: ensure real target path stays inside realRootDir
  if (!realTarget.startsWith(realRootDir + path.sep) && realTarget !== realRootDir) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not Found");
  }

  let stat;
  try {
    stat = fs.statSync(realTarget);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not Found");
  }

  if (!stat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not Found");
  }

  const ext = path.extname(realTarget).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  res.writeHead(200, {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  return res.end(fs.readFileSync(realTarget));
}
