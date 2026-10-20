import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DataEngine } from "../src/backend/engine.js";

test("DataEngine: basic lifecycle, device nicknames, and router lockout halt", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tally-test-"));

  try {
    const engine = new DataEngine(tmpDir);

    // 1. Verify default configurations
    assert.equal(engine.config.routerHost, "192.168.0.1");
    assert.equal(engine.config.dailyLimitGb, 15);
    assert.equal(engine.config.notifyNewDevice, true);
    assert.equal(engine.config.notifyOffline, true);
    assert.deepEqual(engine.config.deviceNicknames, {});

    // 2. Ingest sample fixture
    const sampleRecord = {
      ts: new Date().toISOString(),
      month_mb: { down: 5000, up: 2000, total: 7000 },
      wan_bytes: { rx: 5000000000, tx: 2000000000, uptime_s: 3600 },
      speed_kbps: { down: 25000, up: 5000 },
      devices: [
        { hostname: "iPhone", ip: "192.168.0.120", mac: "02:00:00:00:00:02", link: "wlan", flow: 0 },
        { hostname: "MacBook-Pro", ip: "192.168.0.114", mac: "02:00:00:00:00:01", link: "wlan", flow: 0 },
      ],
    };

    engine.ingest(sampleRecord);
    let summary = engine.getSummary();

    assert.equal(summary.month.total, 7000);
    assert.equal(summary.devices.length, 2);

    // 3. Test Device Nickname functionality
    engine.setDeviceNickname("02:00:00:00:00:02", "Jerry's iPhone");
    summary = engine.getSummary();

    const renamedDevice = summary.devices.find((d) => d.mac === "02:00:00:00:00:02");
    assert.equal(renamedDevice.name, "Jerry's iPhone");
    assert.equal(renamedDevice.nickname, "Jerry's iPhone");
    assert.equal(renamedDevice.originalName, "iPhone");

    // Persisted to config.json
    const savedConfig = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf8"));
    assert.equal(savedConfig.deviceNicknames["02:00:00:00:00:02"], "Jerry's iPhone");

    // Reset nickname
    engine.setDeviceNickname("02:00:00:00:00:02", "");
    summary = engine.getSummary();
    const resetDevice = summary.devices.find((d) => d.mac === "02:00:00:00:00:02");
    assert.equal(resetDevice.name, "iPhone");
    assert.equal(resetDevice.nickname, null);

    // 4. Test Lockout Protection: halt polling on LOGIN rejection
    let lockoutEmitted = false;
    engine.on("login-lockout", (msg) => {
      lockoutEmitted = true;
    });

    // Mock router to reject login
    engine.router = {
      sample: async () => {
        const e = new Error("Login rejected. Please check your router password.");
        e.code = "LOGIN";
        throw e;
      },
    };

    engine.start(false);
    assert.ok(engine.pollTimer !== null || !engine.config.disconnected);

    await assert.rejects(async () => {
      await engine.step();
    }, /Login rejected/);

    // Verify polling was halted and disconnected set to true
    assert.equal(engine.connected, false);
    assert.equal(engine.config.disconnected, true);
    assert.equal(engine.pollTimer, null);
    assert.ok(lockoutEmitted, "login-lockout event should be emitted");
    assert.match(engine.lastError, /Polling stopped to prevent router lockout/);

    engine.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

