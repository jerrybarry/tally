import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRouter } from "./router.js";
import { measureThisComputer, getLocalMachineInfo } from "./local.js";
import { isEncryptionAvailable, encryptString, decryptString } from "./vault.js";

export class DataEngine extends EventEmitter {
  constructor(baseDir) {
    super();
    this.baseDir = baseDir;
    this.configFile = path.join(baseDir, "config.json");
    this.dataFile = path.join(baseDir, "usage.jsonl");

    this.password = null;
    this.config = this.loadConfig();
    this.samples = [];
    this.latest = null;
    this.devicesSeen = new Map();
    this.blockedMacs = new Set();
    this.aclHistory = [];
    this.deviceEstimatedUsage = new Map();
    this.limitNotifiedDevices = new Set();
    this.pollTimer = null;
    this.connected = false;
    this.lastError = null;
    this.router = null;
    this.historyLoaded = false;

    // Load saved estimated usage if available
    if (this.config.deviceEstimatedMb) {
      for (const [mac, mb] of Object.entries(this.config.deviceEstimatedMb)) {
        this.deviceEstimatedUsage.set(String(mac).toLowerCase(), Number(mb) || 0);
      }
    }

    this.EVERY = (this.config.pollSeconds || 30) * 1000;
    this.GB = this.config.gbBase || 1024;
    this.MIB = 1048576;
    this.HOUR = 3600e3;
    this.DAY = 24 * this.HOUR;
    this.KEEP = 3650 * this.DAY; // Keep all-time usage records for 10 years
    this.GAP = Math.max(5 * this.EVERY, 10 * 60e3);

    this.loadHistory();
    this.historyLoaded = true;
    this.initRouter();
  }

  loadConfig() {
    const defaults = {
      routerHost: "192.168.0.1",
      username: "admin",
      planGb: 350,
      warnPercent: 80,
      dailyLimitGb: 15,
      notifyNewDevice: true,
      notifyOffline: true,
      showMenuBar: true,
      openAtLogin: false,
      theme: "auto",
      pollSeconds: 30,
      gbBase: 1024,
      deviceNicknames: {},
      deviceLimits: {},
      deviceEstimatedMb: {},
      autoUnblockSchedule: "disabled", // "disabled", "daily", "monthly"
      lastAutoUnblockKey: null,
    };

    if (fs.existsSync(this.configFile)) {
      try {
        const raw = fs.readFileSync(this.configFile, "utf8");
        const data = JSON.parse(raw);

        // Retrieve password from macOS Keychain if encrypted
        if (data.encryptedPassword) {
          if (isEncryptionAvailable()) {
            const decrypted = decryptString(data.encryptedPassword);
            if (decrypted) {
              this.password = decrypted;
            } else {
              // Decryption failed: Keychain locked, inaccessible, or signature changed
              console.warn("safeStorage decryption failed; aborting login to prevent router lockout.");
              this.password = null;
              data.disconnected = true;
            }
          } else {
            console.warn("safeStorage encryption unavailable; aborting login to prevent router lockout.");
            this.password = null;
            data.disconnected = true;
          }
        } else if (data.password) {
          this.password = data.password;
          // Upgrade plain-text password to Keychain safeStorage encryption immediately
          if (isEncryptionAvailable()) {
            const cipher = encryptString(data.password);
            if (cipher) {
              data.encryptedPassword = cipher;
              delete data.password;
              fs.writeFileSync(this.configFile, JSON.stringify(data, null, 2));
            }
          }
        } else {
          this.password = "admin";
        }

        // Return configuration without plain password exposed in state
        const sanitized = { ...defaults, ...data };
        delete sanitized.password;
        if (!this.password) {
          sanitized.disconnected = true;
        }
        return sanitized;
      } catch (err) {
        console.error("Failed to parse config.json, using defaults:", err);
      }
    }

    if (!this.password) this.password = "admin";
    return defaults;
  }

  saveConfig(newConfig) {
    const toSave = { ...this.config, ...newConfig };

    // If new password provided, encrypt into Keychain and scrub from JSON disk file
    if (newConfig.password) {
      this.password = newConfig.password;
      if (isEncryptionAvailable()) {
        const cipher = encryptString(newConfig.password);
        if (cipher) {
          toSave.encryptedPassword = cipher;
        }
      }
    }

    // Never write plain text password to config.json when encryptedPassword exists or safeStorage is active
    if (toSave.encryptedPassword || isEncryptionAvailable()) {
      delete toSave.password;
    }

    this.config = toSave;
    fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
    this.EVERY = (this.config.pollSeconds || 30) * 1000;
    this.initRouter();
    this.emit("config-updated", this.config);
    this.emit("update", this.getSummary());
  }

  setDeviceNickname(mac, nickname) {
    if (!mac) return;
    const macKey = String(mac).toLowerCase();
    const nicknames = { ...(this.config.deviceNicknames || {}) };
    if (nickname && String(nickname).trim()) {
      nicknames[macKey] = String(nickname).trim();
    } else {
      delete nicknames[macKey];
    }
    this.saveConfig({ deviceNicknames: nicknames });
  }

  isProtectedDevice(device = {}) {
    const routerHost = String(this.config.routerHost || "192.168.0.1").trim().toLowerCase();
    const targetIp = String(device.ip || "").trim().toLowerCase();
    const targetMac = String(device.mac || "").trim().toLowerCase();

    // 1. Router Gateway Protection (Rule 2)
    if (targetIp === routerHost || targetIp === "192.168.0.1") {
      return {
        protected: true,
        reason: "Router gateway (192.168.0.1) cannot be blocked.",
      };
    }

    // 2. This Computer Protection (via OS network interfaces - Rule 2)
    const local = getLocalMachineInfo();
    if (targetIp && local.ips.has(targetIp)) {
      return {
        protected: true,
        reason: `This computer (${local.hostname} - ${device.ip}) cannot be blocked.`,
      };
    }
    if (targetMac && local.macs.has(targetMac)) {
      return {
        protected: true,
        reason: `This computer (${local.hostname} - ${device.mac}) cannot be blocked.`,
      };
    }

    // 3. This Computer Protection (via measured local device)
    const me = this.latest?.local;
    if (me) {
      if (targetIp && me.ip && targetIp === me.ip.toLowerCase()) {
        return {
          protected: true,
          reason: `This computer (${me.name || local.hostname} - ${device.ip}) cannot be blocked.`,
        };
      }
      if (targetMac && me.mac && targetMac === me.mac.toLowerCase()) {
        return {
          protected: true,
          reason: `This computer (${me.name || local.hostname} - ${device.mac}) cannot be blocked.`,
        };
      }
    }

    if (device.isThisComputer) {
      return {
        protected: true,
        reason: "This computer cannot be blocked.",
      };
    }

    return { protected: false };
  }

  logAclEvent(action, mac, name, details) {
    const entry = {
      type: "acl_event",
      action, // "block", "unblock", "unblock_all"
      mac: mac || null,
      name: name || null,
      timestamp: new Date().toISOString(),
      ts: Date.now(),
      success: true,
      details: details || null,
    };
    try {
      fs.appendFileSync(this.dataFile, JSON.stringify(entry) + "\n");
    } catch (e) {
      console.warn("Could not write ACL event to usage.jsonl:", e.message);
    }
    this.aclHistory.push(entry);
    this.emit("acl-event", entry);
  }

  async blockDevice(mac, name, reason) {
    if (!mac) throw new Error("MAC address is required.");
    const cleanMac = mac.trim().toUpperCase();
    const dev = this.devicesSeen.get(cleanMac) ||
                this.devicesSeen.get(cleanMac.toLowerCase()) ||
                [...this.devicesSeen.values()].find((d) => d.mac && d.mac.toUpperCase() === cleanMac) ||
                { mac: cleanMac, name: name || "Unknown Device" };

    const prot = this.isProtectedDevice(dev);
    if (prot.protected) {
      throw new Error(`Refused to block: ${prot.reason}`);
    }

    if (!this.router) this.initRouter();
    const current = await this.router.getBlacklist();
    const macSet = new Set(current.macs.map((m) => m.toUpperCase()));

    if (macSet.has(cleanMac)) {
      this.blockedMacs = macSet;
      return { success: true, alreadyBlocked: true, macs: [...macSet] };
    }

    macSet.add(cleanMac);
    const result = await this.router.setBlacklist([...macSet]);

    this.blockedMacs = new Set(result.macs.map((m) => m.toUpperCase()));
    this.logAclEvent("block", cleanMac, name || dev.name, reason || "Manual block by user");
    const summary = this.getSummary();
    this.emit("update", summary);

    return summary;
  }

  async unblockDevice(mac, name, reason) {
    if (!mac) throw new Error("MAC address is required.");
    const cleanMac = mac.trim().toUpperCase();

    if (!this.router) this.initRouter();
    const current = await this.router.getBlacklist();
    const macSet = new Set(current.macs.map((m) => m.toUpperCase()));
    macSet.delete(cleanMac);

    const result = await this.router.setBlacklist([...macSet]);

    this.blockedMacs = new Set(result.macs.map((m) => m.toUpperCase()));
    this.logAclEvent("unblock", cleanMac, name || "Device", reason || "Manual unblock by user");
    const summary = this.getSummary();
    this.emit("update", summary);

    return summary;
  }

  async unblockAll(reason = "Manual unblock all by user") {
    if (!this.router) this.initRouter();
    const result = await this.router.setBlacklist([]);

    this.blockedMacs = new Set();
    this.logAclEvent("unblock_all", null, "All Devices", reason);
    const summary = this.getSummary();
    this.emit("update", summary);

    return summary;
  }

  async syncBlacklist() {
    if (this.router && typeof this.router.getBlacklist === "function") {
      try {
        const bl = await this.router.getBlacklist();
        if (bl?.macs) {
          this.blockedMacs = new Set(bl.macs.map((m) => m.toUpperCase()));
        }
      } catch {}
    }
  }

  setDeviceLimit(mac, limitGb, autoBlock) {
    if (!mac) return;
    const macKey = String(mac).toLowerCase();
    const limits = { ...(this.config.deviceLimits || {}) };

    if (limitGb == null || limitGb === "" || Number(limitGb) <= 0) {
      delete limits[macKey];
    } else {
      limits[macKey] = {
        limitGb: Number(limitGb),
        autoBlock: Boolean(autoBlock),
      };
    }

    this.saveConfig({ deviceLimits: limits });
  }

  getEstimatedDeviceUsage(mac) {
    if (!mac) return 0;
    const macKey = String(mac).toLowerCase();
    const rawEst = this.deviceEstimatedUsage.get(macKey) || 0;
    return Math.round(rawEst * 10) / 10;
  }

  updateEstimatedDeviceUsage(rec) {
    if (!Array.isArray(rec.devices) || this.samples.length < 2) return;

    const prev = this.samples.at(-2);
    const cur = this.samples.at(-1);
    if (!prev || !cur) return;

    const totalGrowth = this.grow(cur.total, prev.total);
    let localGrowth = 0;
    if (cur.lrx != null && prev.lrx != null) {
      localGrowth = (this.grow(cur.lrx, prev.lrx) + this.grow(cur.ltx, prev.ltx)) / this.MIB;
    }

    const otherGrowth = Math.max(0, totalGrowth - localGrowth);
    if (otherGrowth <= 0) return;

    const me = rec.local;
    const onlineOthers = rec.devices.filter((d) => {
      const isMe = me && (me.ip === d.ip || (me.mac && d.mac && me.mac.toLowerCase() === d.mac.toLowerCase()));
      return !isMe && (d.wifi_connected || d.link !== "wlan");
    });

    const activeList = onlineOthers.length > 0 ? onlineOthers : rec.devices.filter((d) => {
      const isMe = me && (me.ip === d.ip || (me.mac && d.mac && me.mac.toLowerCase() === d.mac.toLowerCase()));
      return !isMe;
    });

    if (activeList.length === 0) return;
    const share = otherGrowth / activeList.length;

    for (const d of activeList) {
      if (!d.mac) continue;
      const macKey = String(d.mac).toLowerCase();
      const curVal = this.deviceEstimatedUsage.get(macKey) || 0;
      this.deviceEstimatedUsage.set(macKey, curVal + share);
    }

    // Persist to config
    const estObj = {};
    for (const [k, v] of this.deviceEstimatedUsage.entries()) {
      estObj[k] = Math.round(v * 10) / 10;
    }
    this.config.deviceEstimatedMb = estObj;
  }

  async checkAutoUnblockSchedule() {
    const sched = this.config.autoUnblockSchedule || "disabled";
    if (sched === "disabled") return;

    const now = Date.now();
    const curDay = this.dayKey(now);
    const curMonth = curDay.slice(0, 7);

    if (sched === "daily") {
      if (this.config.lastAutoUnblockKey !== curDay) {
        try {
          await this.unblockAll("Auto-unblock: Daily reset schedule");
          this.saveConfig({ lastAutoUnblockKey: curDay });
          this.emit("auto-unblock-triggered", { schedule: "daily", key: curDay });
        } catch (e) {
          console.warn("Daily auto-unblock failed:", e.message);
        }
      }
    } else if (sched === "monthly") {
      if (this.config.lastAutoUnblockKey !== curMonth) {
        try {
          await this.unblockAll("Auto-unblock: Monthly reset schedule");
          this.saveConfig({ lastAutoUnblockKey: curMonth });
          this.emit("auto-unblock-triggered", { schedule: "monthly", key: curMonth });
        } catch (e) {
          console.warn("Monthly auto-unblock failed:", e.message);
        }
      }
    }
  }

  async checkDeviceLimits() {
    const limits = this.config.deviceLimits || {};
    const todayKey = this.dayKey(Date.now());

    for (const [macKey, cfg] of Object.entries(limits)) {
      if (!cfg || !cfg.limitGb || cfg.limitGb <= 0) continue;

      const estMb = this.getEstimatedDeviceUsage(macKey);
      const estGb = estMb / this.GB;

      if (estGb >= cfg.limitGb) {
        const notifKey = `${macKey}-${todayKey}-${cfg.limitGb}`;
        if (!this.limitNotifiedDevices.has(notifKey)) {
          this.limitNotifiedDevices.add(notifKey);

          const dev = this.devicesSeen.get(macKey.toUpperCase()) ||
                      this.devicesSeen.get(macKey.toLowerCase()) ||
                      { mac: macKey, name: "Device" };
          const nick = this.config.deviceNicknames?.[macKey];
          const displayName = nick || dev.name || "Device";

          if (cfg.autoBlock) {
            try {
              await this.blockDevice(
                macKey,
                displayName,
                `Auto-blocked: passed estimated limit of ${cfg.limitGb} GB (${estGb.toFixed(1)} GB used)`
              );
              this.emit("device-auto-blocked", {
                mac: macKey,
                name: displayName,
                limitGb: cfg.limitGb,
                estimatedGb: estGb.toFixed(1),
              });
            } catch (err) {
              console.warn("Auto-block on limit exceeded failed:", err.message);
            }
          } else {
            this.emit("device-limit-reached", {
              mac: macKey,
              name: displayName,
              limitGb: cfg.limitGb,
              estimatedGb: estGb.toFixed(1),
              autoBlock: false,
            });
          }
        }
      }
    }
  }


  initRouter() {
    this.router = createRouter({
      host: this.config.routerHost || "192.168.0.1",
      user: this.config.username || "admin",
      pass: this.password || "",
    });
  }

  pad(n) {
    return String(n).padStart(2, "0");
  }

  dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`;
  }

  grow(cur, prev) {
    return cur >= prev ? cur - prev : cur;
  }

  ingest(rec) {
    if (rec.type === "acl_event") {
      this.aclHistory.push(rec);
      return;
    }
    const t = Date.parse(rec.ts),
      m = rec.month_mb;
    if (![t, m?.down, m?.up, m?.total].every((v) => v != null && !Number.isNaN(v))) return;

    this.samples.push({
      t,
      down: m.down,
      up: m.up,
      total: m.total,
      kd: rec.speed_kbps?.down,
      ku: rec.speed_kbps?.up,
      lrx: rec.local?.rx ?? null,
      ltx: rec.local?.tx ?? null,
    });

    while (this.samples.length && this.samples[0].t < Date.now() - this.KEEP) {
      this.samples.shift();
    }

    this.latest = rec;

    for (const d of rec.devices || []) {
      const connected = d.wifi_connected || d.link !== "wlan";
      const old = this.devicesSeen.get(d.mac);
      this.devicesSeen.set(d.mac, {
        mac: d.mac,
        name: d.name || d.hostname || "Unknown Device",
        ip: d.ip,
        band: d.band,
        link: d.link,
        rssi: d.rssi,
        flow: d.flow,
        t: connected ? t : old?.t ?? 0,
        last: t,
      });
    }
  }

  loadHistory() {
    if (!fs.existsSync(this.dataFile)) return;
    try {
      const content = fs.readFileSync(this.dataFile, "utf8");
      for (const line of content.split("\n")) {
        if (line.trim()) {
          try {
            this.ingest(JSON.parse(line));
          } catch {}
        }
      }
    } catch (err) {
      console.warn("Could not load usage history:", err);
    }
  }

  async testConnection(credentials) {
    const testR = createRouter({
      host: credentials.host || this.config.routerHost,
      user: credentials.user || this.config.username,
      pass: credentials.pass || this.config.password,
    });
    return await testR.probe();
  }

  disconnect() {
    this.stop();
    this.connected = false;
    this.lastError = null;
    this.saveConfig({ disconnected: true });
    this.emit("update", this.getSummary());
  }

  async connect(credentials = {}) {
    this.stop();
    this.saveConfig({
      ...credentials,
      disconnected: false,
    });
    this.initRouter();
    try {
      const summary = await this.step();
      // Start polling timer without firing an immediate second step
      this.start(false);
      return summary;
    } catch (err) {
      this.connected = false;
      this.lastError = err.message;
      this.saveConfig({ disconnected: true });
      this.emit("update", this.getSummary());
      throw err;
    }
  }

  async step() {
    if (this.config.disconnected || !this.password) {
      this.connected = false;
      return this.getSummary();
    }
    if (!this.router) this.initRouter();
    const wasConnected = this.connected;

    try {
      const rec = await this.router.sample();
      try {
        rec.local = await measureThisComputer(rec.devices);
      } catch (err) {
        rec.local = null;
      }

      // Check for newly joined devices during live polling
      if (this.historyLoaded && Array.isArray(rec.devices)) {
        for (const d of rec.devices) {
          if (d.mac && !this.devicesSeen.has(d.mac)) {
            const macKey = String(d.mac).toLowerCase();
            const nickname = this.config.deviceNicknames?.[macKey];
            this.emit("device-joined", {
              mac: d.mac,
              name: nickname || d.name || "Unknown Device",
              ip: d.ip,
              band: d.band,
            });
          }
        }
      }

      fs.appendFileSync(this.dataFile, JSON.stringify(rec) + "\n");
      this.ingest(rec);
      this.connected = true;
      this.lastError = null;

      // Update estimated device usage and evaluate soft limits (Rule 7)
      this.updateEstimatedDeviceUsage(rec);
      await this.checkDeviceLimits();

      // Check scheduled auto-unblock (Rule 4)
      await this.checkAutoUnblockSchedule();

      // Periodically sync router blacklist
      await this.syncBlacklist();

      const summary = this.getSummary();
      this.emit("update", summary);
      return summary;
    } catch (err) {
      this.connected = false;

      // Protect against router lockout:
      // Router firmware locks logins for minutes after 3 failed attempts.
      // Halt polling immediately upon a rejected login.
      if (err.code === "LOGIN") {
        this.stop();
        this.config.disconnected = true;
        this.lastError = "Login rejected. Polling stopped to prevent router lockout (firmware blocks logins after 3 failed attempts).";
        this.emit("login-lockout", this.lastError);
        this.emit("error", err);
        this.emit("update", this.getSummary());
        throw err;
      }

      if (wasConnected) {
        this.emit("router-offline", {
          host: this.config.routerHost || "192.168.0.1",
          error: err.message || "Router became unreachable",
        });
      }

      this.lastError = err.message;
      this.emit("error", err);
      this.emit("update", this.getSummary());
      throw err;
    }
  }

  start(immediate = true) {
    this.stop();
    if (this.config.disconnected) {
      this.connected = false;
      return;
    }
    if (immediate) {
      this.step().catch((e) => console.warn("Initial poll tick failed:", e.message));
    }
    this.pollTimer = setInterval(() => {
      if (!this.config.disconnected) {
        this.step().catch((e) => console.warn("Poll tick failed:", e.message));
      }
    }, this.EVERY);
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getSummary() {
    const now = Date.now(),
      days = new Map(),
      hours = new Map();

    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1],
        b = this.samples[i],
        gap = b.t - a.t > this.GAP;
      const inc = { down: this.grow(b.down, a.down), up: this.grow(b.up, a.up) };
      if (a.lrx != null && b.lrx != null) {
        inc.ldown = this.grow(b.lrx, a.lrx) / this.MIB;
        inc.lup = this.grow(b.ltx, a.ltx) / this.MIB;
      }

      for (let t = a.t; t < b.t; ) {
        const d = new Date(t),
          end = Math.min(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(), b.t);
        const frac = (end - t) / (b.t - a.t),
          day = days.get(this.dayKey(t)) || { partial: false };
        for (const k in inc) day[k] = (day[k] || 0) + inc[k] * frac;
        day.partial ||= gap;
        days.set(this.dayKey(t), day);
        t = end;
      }

      if (!gap) {
        const h = Math.floor(b.t / this.HOUR) * this.HOUR,
          hr = hours.get(h) || { down: 0, up: 0 };
        hr.down += inc.down;
        hr.up += inc.up;
        hours.set(h, hr);
      }
    }

    if (this.samples.length) {
      const d = days.get(this.dayKey(this.samples[0].t));
      if (d) d.partial = true;
    }

    const dayList = [];
    for (let k = 13; k >= 0; k--) {
      const key = this.dayKey(now - k * this.DAY),
        m = days.get(key);
      let e;
      if (m) e = { source: "measured", down: m.down, up: m.up, partial: Boolean(m.partial) };
      else e = { source: "none", down: 0, up: 0 };
      dayList.push({ date: key, ...e });
    }

    const hourList = [],
      h0 = Math.floor(now / this.HOUR) * this.HOUR;
    for (let k = 23; k >= 0; k--) {
      hourList.push({
        start: h0 - k * this.HOUR,
        ...(hours.get(h0 - k * this.HOUR) || { down: 0, up: 0 }),
      });
    }

    const td = days.get(this.dayKey(now)) || {},
      mk = this.dayKey(now).slice(0, 7);
    const sum = (f) =>
      [...days].filter(([k]) => k.startsWith(mk)).reduce((s, [, d]) => s + (d[f] || 0), 0);
    const since = this.samples.find((s) => this.dayKey(s.t).startsWith(mk))?.t;
    const last = this.samples.at(-1),
      me = this.latest?.local;

    // Devices & computation
    const thisMacData = me
      ? {
          name: me.name || "MacBook Pro",
          ip: me.ip,
          mac: me.mac,
          today: { down: td.ldown || 0, up: td.lup || 0 },
          month: { down: sum("ldown"), up: sum("lup") },
        }
      : null;

    const totalTodayMeasured = (td.down || 0) + (td.up || 0);
    const totalMonthMeasured = sum("down") + sum("up");

    const thisMacTodayTotal = thisMacData ? thisMacData.today.down + thisMacData.today.up : 0;
    const thisMacMonthTotal = thisMacData ? thisMacData.month.down + thisMacData.month.up : 0;

    // Full router month counters (incorporating WAN router month data when available)
    const monthWanTotal = last?.total ? Math.max(last.total, totalMonthMeasured) : totalMonthMeasured;
    const monthWanDown = last?.down ? Math.max(last.down, sum("down")) : sum("down");
    const monthWanUp = last?.up ? Math.max(last.up, sum("up")) : sum("up");

    const otherDevicesData = {
      today: Math.max(0, totalTodayMeasured - thisMacTodayTotal),
      month: Math.max(0, monthWanTotal - thisMacMonthTotal),
    };

    const deviceList = [...this.devicesSeen.values()].map((d) => {
      const macKey = d.mac ? String(d.mac).toLowerCase() : "";
      const macUpper = d.mac ? String(d.mac).toUpperCase() : "";
      const nickname = this.config.deviceNicknames?.[macKey] || null;
      const isThisComp = Boolean(me && (me.ip === d.ip || (me.mac && d.mac && me.mac.toLowerCase() === d.mac.toLowerCase())));
      const prot = this.isProtectedDevice({ ...d, isThisComputer: isThisComp });
      const isBlocked = this.blockedMacs.has(macUpper);
      const estMb = this.getEstimatedDeviceUsage(d.mac);
      const limitConf = this.config.deviceLimits?.[macKey];

      return {
        ...d,
        name: nickname || d.name || "Unknown Device",
        nickname,
        originalName: d.name || "Unknown Device",
        online: last ? d.t === last.t : false,
        isThisComputer: isThisComp,
        isProtected: prot.protected,
        protectedReason: prot.reason || null,
        isBlocked,
        estimatedMb: estMb,
        estimatedGb: (estMb / this.GB).toFixed(2),
        limitGb: limitConf?.limitGb ?? null,
        autoBlock: Boolean(limitConf?.autoBlock),
      };
    });

    // Pace & forecast calculation based on full month WAN data
    const todayDate = new Date();
    const dayOfMonth = todayDate.getDate();
    const daysInMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).getDate();
    const monthTotalMb = monthWanTotal;
    const avgPerDayMb = dayOfMonth > 0 ? monthTotalMb / dayOfMonth : 0;
    const projectedMonthMb = avgPerDayMb * daysInMonth;

    // All-time monthly records calculation
    const monthlySummaryMap = new Map();
    for (const [dayKey, d] of days.entries()) {
      const mKey = dayKey.slice(0, 7);
      const rec = monthlySummaryMap.get(mKey) || { down: 0, up: 0, total: 0, daysCount: 0 };
      rec.down += d.down || 0;
      rec.up += d.up || 0;
      rec.total += (d.down || 0) + (d.up || 0);
      rec.daysCount += 1;
      monthlySummaryMap.set(mKey, rec);
    }

    // Ensure current month includes full router month counters
    const curRec = monthlySummaryMap.get(mk) || { down: 0, up: 0, total: 0, daysCount: 1 };
    curRec.total = Math.max(curRec.total, monthWanTotal);
    curRec.down = Math.max(curRec.down, monthWanDown);
    curRec.up = Math.max(curRec.up, monthWanUp);
    monthlySummaryMap.set(mk, curRec);

    const monthKeysSorted = [...monthlySummaryMap.keys()].sort(); // chronological: Month 1, Month 2, ...
    const allMonthsList = monthKeysSorted.map((k, idx) => {
      const rec = monthlySummaryMap.get(k);
      const [y, m] = k.split("-");
      const dObj = new Date(Number(y), Number(m) - 1, 1);
      const name = dObj.toLocaleDateString([], { month: "short", year: "numeric" });
      const fullName = dObj.toLocaleDateString([], { month: "long", year: "numeric" });
      return {
        key: k,
        index: idx + 1,
        monthLabel: `Month ${idx + 1}`,
        name,
        fullName,
        down: rec.down,
        up: rec.up,
        total: rec.total,
        isCurrent: k === mk,
      };
    });

    const allTimeTotalMb = allMonthsList.reduce((s, m) => s + m.total, 0);
    const allTimeDownMb = allMonthsList.reduce((s, m) => s + m.down, 0);
    const allTimeUpMb = allMonthsList.reduce((s, m) => s + m.up, 0);

    const allTimeData = {
      total: allTimeTotalMb,
      down: allTimeDownMb,
      up: allTimeUpMb,
      monthsCount: allMonthsList.length,
      averagePerMonth: allMonthsList.length ? allTimeTotalMb / allMonthsList.length : 0,
      months: allMonthsList.map((m) => ({
        ...m,
        percent: allTimeTotalMb > 0 ? Number(((m.total / allTimeTotalMb) * 100).toFixed(1)) : 100,
      })),
    };

    return {
      connected: this.connected,
      lastError: this.lastError,
      config: {
        routerHost: this.config.routerHost,
        planGb: this.config.planGb,
        warnPercent: this.config.warnPercent,
        dailyLimitGb: this.config.dailyLimitGb ?? 15,
        notifyNewDevice: this.config.notifyNewDevice !== false,
        notifyOffline: this.config.notifyOffline !== false,
        showMenuBar: this.config.showMenuBar,
        openAtLogin: this.config.openAtLogin,
        theme: this.config.theme,
        deviceNicknames: this.config.deviceNicknames || {},
      },
      mbPerGb: this.GB,
      planGb: this.config.planGb || null,
      updatedAt: last ? new Date(last.t).toISOString() : null,
      ageSeconds: last ? Math.round((now - last.t) / 1000) : null,
      month: last ? { down: last.down, up: last.up, total: last.total } : null,
      speed: this.latest?.speed_kbps ?? null,
      cellular: this.latest?.cellular ?? {
        networkType: "5G (NSA)",
        operator: "Cellular",
        signalLevel: 4,
      },
      days: dayList,
      hours: hourList,
      allTime: allTimeData,
      pace: {
        avgPerDayMb,
        projectedMonthMb,
        daysInMonth,
        dayOfMonth,
      },
      measured: {
        today: { down: td.down || 0, up: td.up || 0 },
        month: { down: monthWanDown, up: monthWanUp, total: monthWanTotal },
        since: since ? new Date(since).toISOString() : null,
      },
      thisComputer: thisMacData,
      otherDevices: otherDevicesData,
      devices: deviceList,
      blockedMacs: [...this.blockedMacs],
      autoUnblockSchedule: this.config.autoUnblockSchedule || "disabled",
      aclHistory: this.aclHistory.slice(-50),
    };
  }
}
