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

test("DataEngine: Blacklist ACL controls, protection rules, audit logging, and soft limits", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tally-acl-test-"));
  try {
    const engine = new DataEngine(tmpDir);

    // 1. Ingest sample with local Mac, router gateway IP, and a phone
    const sample = {
      ts: new Date().toISOString(),
      month_mb: { down: 1000, up: 500, total: 1500 },
      wan_bytes: { rx: 1000000000, tx: 500000000, uptime_s: 3600 },
      speed_kbps: { down: 5000, up: 1000 },
      devices: [
        { hostname: "MacBook-Pro", ip: "192.168.0.114", mac: "02:00:00:00:00:01", link: "wlan", flow: 0 },
        { hostname: "Gateway-Sim", ip: "192.168.0.1", mac: "02:00:00:00:00:fe", link: "eth", flow: 0 },
        { hostname: "Guest-Phone", ip: "192.168.0.150", mac: "02:00:00:00:00:99", link: "wlan", flow: 0 }
      ]
    };
    engine.ingest(sample);

    // Set local machine info AFTER ingest (ingest overwrites engine.latest)
    engine.latest.local = { ip: "192.168.0.114", mac: "02:00:00:00:00:01", name: "MacBook-Pro" };

    // Rule 2: Verify protection checks
    const macProt = engine.isProtectedDevice({ ip: "192.168.0.114", mac: "02:00:00:00:00:01", isThisComputer: true });
    assert.equal(macProt.protected, true);
    assert.match(macProt.reason, /this computer/i);

    const gwProt = engine.isProtectedDevice({ ip: "192.168.0.1", mac: "02:00:00:00:00:fe" });
    assert.equal(gwProt.protected, true);
    assert.match(gwProt.reason, /gateway/i);

    const guestProt = engine.isProtectedDevice({ ip: "192.168.0.150", mac: "02:00:00:00:00:99" });
    assert.equal(guestProt.protected, false);

    // Refusal: Trying to block this Mac throws Error
    await assert.rejects(async () => {
      await engine.blockDevice("02:00:00:00:00:01", "MacBook-Pro");
    }, /Refused to block/);

    // Refusal: Trying to block gateway throws Error
    await assert.rejects(async () => {
      await engine.blockDevice("02:00:00:00:00:fe", "Gateway");
    }, /Refused to block/);

    // Mock router for blacklist operations
    let mockBlacklist = [];
    engine.router = {
      getBlacklist: async () => ({ success: true, mode: "deny", macs: [...mockBlacklist] }),
      setBlacklist: async (list) => {
        mockBlacklist = [...list];
        return { success: true, macs: [...mockBlacklist] };
      },
      getLastBlacklistWriteTime: () => 0
    };

    // Rule 3: Block Guest-Phone
    const summaryAfterBlock = await engine.blockDevice("02:00:00:00:00:99", "Guest-Phone");
    assert.ok(engine.blockedMacs.has("02:00:00:00:00:99"));
    assert.deepEqual(mockBlacklist, ["02:00:00:00:00:99"]);

    const blockedDev = summaryAfterBlock.devices.find((d) => d.mac === "02:00:00:00:00:99");
    assert.equal(blockedDev.isBlocked, true);

    // Rule 6: Audit logging check in usage.jsonl
    const usageLines = fs.readFileSync(path.join(tmpDir, "usage.jsonl"), "utf8").trim().split("\n");
    const aclLogs = usageLines.map((l) => JSON.parse(l)).filter((e) => e.type === "acl_event");
    assert.ok(aclLogs.length >= 1);
    const blockEvent = aclLogs.find((e) => e.action === "block" && e.mac === "02:00:00:00:00:99");
    assert.ok(blockEvent);
    assert.equal(blockEvent.success, true);
    assert.ok(blockEvent.timestamp);

    // Rule 4: Unblock Guest-Phone
    await engine.unblockDevice("02:00:00:00:00:99", "Guest-Phone");
    assert.equal(engine.blockedMacs.has("02:00:00:00:00:99"), false);
    assert.equal(mockBlacklist.length, 0);

    // Rule 4: Unblock All
    await engine.blockDevice("02:00:00:00:00:99", "Guest-Phone");
    assert.equal(engine.blockedMacs.size, 1);
    await engine.unblockAll();
    assert.equal(engine.blockedMacs.size, 0);
    assert.equal(mockBlacklist.length, 0);

    // Rule 7: Soft limits and estimated usage
    engine.setDeviceLimit("02:00:00:00:00:99", 5, false);
    const summaryWithLimit = engine.getSummary();
    const limitedDev = summaryWithLimit.devices.find((d) => d.mac === "02:00:00:00:00:99");
    assert.equal(limitedDev.limitGb, 5);
    assert.equal(limitedDev.autoBlock, false);

    // Saved in config.json
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf8"));
    assert.equal(cfg.deviceLimits["02:00:00:00:00:99"].limitGb, 5);

    // Remove limit
    engine.setDeviceLimit("02:00:00:00:00:99", null, false);
    assert.equal(engine.config.deviceLimits["02:00:00:00:00:99"], undefined);

    engine.stop();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
