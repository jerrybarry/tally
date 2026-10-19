import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { server } from "../src/backend/server.js";
import { serveStatic, DEFAULT_STATIC_DIR } from "../src/backend/safe-static.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const RENDERER_DIR = path.resolve(ROOT_DIR, "src/renderer");

function makeRawRequest(serverInstance, rawPath) {
  return new Promise((resolve, reject) => {
    const port = serverInstance.address().port;
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => {
      const match = data.match(/^HTTP\/1\.[01]\s+(\d+)/);
      const statusCode = match ? Number(match[1]) : null;
      resolve({ statusCode, raw: data });
    });
    socket.on("error", reject);
  });
}

test("Server security & static file serving defense (GHSA-x3jp-2cwp-7q9m)", async (t) => {
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  t.after(() => {
    server.close();
  });

  await t.test("Valid file: /index.html returns 200", async () => {
    const res = await makeRawRequest(server, "/index.html");
    assert.equal(res.statusCode, 200);
    assert.match(res.raw, /<title>Tally<\/title>/);
  });

  await t.test("Valid root path: / returns 200 (index.html)", async () => {
    const res = await makeRawRequest(server, "/");
    assert.equal(res.statusCode, 200);
    assert.match(res.raw, /<title>Tally<\/title>/);
  });

  await t.test("Path traversal: /../x returns 404 or 400", async () => {
    const res = await makeRawRequest(server, "/../x");
    assert.ok(
      res.statusCode === 404 || res.statusCode === 400,
      `Expected 404 or 400, got ${res.statusCode}`
    );
  });

  await t.test("Encoded path traversal: /%2e%2e/x returns 404 or 400", async () => {
    const res = await makeRawRequest(server, "/%2e%2e/x");
    assert.ok(
      res.statusCode === 404 || res.statusCode === 400,
      `Expected 404 or 400, got ${res.statusCode}`
    );
  });

  await t.test("Forbidden sensitive file: /config.json returns 404 or 400", async () => {
    const res = await makeRawRequest(server, "/config.json");
    assert.ok(
      res.statusCode === 404 || res.statusCode === 400,
      `Expected 404 or 400, got ${res.statusCode}`
    );
  });

  await t.test("Forbidden sensitive file: /usage.jsonl returns 404 or 400", async () => {
    const res = await makeRawRequest(server, "/usage.jsonl");
    assert.ok(
      res.statusCode === 404 || res.statusCode === 400,
      `Expected 404 or 400, got ${res.statusCode}`
    );
  });

  await t.test("Null byte injection: /%00 returns 404 or 400", async () => {
    const res = await makeRawRequest(server, "/%00");
    assert.ok(
      res.statusCode === 404 || res.statusCode === 400,
      `Expected 404 or 400, got ${res.statusCode}`
    );
  });

  await t.test("Symlink pointing outside root returns 404 or 400", async () => {
    const symlinkPath = path.join(RENDERER_DIR, "test-symlink.txt");
    try {
      if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      // Create symlink pointing outside RENDERER_DIR
      fs.symlinkSync(path.resolve(ROOT_DIR, "package.json"), symlinkPath);

      const res = await makeRawRequest(server, "/test-symlink.txt");
      assert.ok(
        res.statusCode === 404 || res.statusCode === 400,
        `Expected 404 or 400 for symlink outside root, got ${res.statusCode}`
      );
    } finally {
      if (fs.existsSync(symlinkPath)) {
        fs.unlinkSync(symlinkPath);
      }
    }
  });
});
