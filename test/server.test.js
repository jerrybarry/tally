import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { server } from "../src/backend/server.js";

function makeRequest(serverInstance, path) {
  return new Promise((resolve, reject) => {
    const addr = serverInstance.address();
    const port = addr.port;
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      }
    );
    req.on("error", reject);
  });
}

test("Server security: static file serving and path traversal defense (CWE-27)", async (t) => {
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  t.after(() => {
    server.close();
  });

  await t.test("Serves index.html at root path '/'", async () => {
    const res = await makeRequest(server, "/");
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.body, /<title>Tally<\/title>/);
  });

  await t.test("Serves style.css and app.js from renderer dir", async () => {
    const resCss = await makeRequest(server, "/style.css");
    assert.equal(resCss.statusCode, 200);
    assert.match(resCss.headers["content-type"], /text\/css/);

    const resJs = await makeRequest(server, "/app.js");
    assert.equal(resJs.statusCode, 200);
    assert.match(resJs.headers["content-type"], /application\/javascript/);
  });

  await t.test("Serves assets from /assets/ directory", async () => {
    const res = await makeRequest(server, "/assets/tally-logo.png");
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /image\/png/);
  });

  await t.test("Blocks directory traversal escaping to /etc/passwd", async () => {
    const res = await makeRequest(server, "/../../../../../../../../etc/passwd");
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, "Forbidden");
  });

  await t.test("Blocks encoded directory traversal (/..%2f..%2f)", async () => {
    const res = await makeRequest(server, "/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd");
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, "Forbidden");
  });

  await t.test("Blocks directory traversal through assets (/assets/../../config.json)", async () => {
    const res = await makeRequest(server, "/assets/../../config.json");
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, "Forbidden");
  });

  await t.test("Refuses to serve sensitive project files (config.json, usage.jsonl)", async () => {
    const resConfig = await makeRequest(server, "/config.json");
    assert.equal(resConfig.statusCode, 404);

    const resUsage = await makeRequest(server, "/usage.jsonl");
    assert.equal(resUsage.statusCode, 404);
  });

  await t.test("Rejects null-byte injection with 400 Bad Request", async () => {
    const res = await makeRequest(server, "/index.html%00.png");
    assert.equal(res.statusCode, 400);
    assert.equal(res.body, "Bad Request");
  });
});
