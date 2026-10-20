import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 5000 }, (e, out) => res(e ? "" : out)));

export function parseNetstatMac(text, iface) { // netstat -ib
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] === iface && f[2]?.startsWith("<Link")) {
      return { rx: Number(f[f.length - 5]), tx: Number(f[f.length - 2]) };
    }
  }
  return null;
}

export function parseProcNetDev(text, iface) { // Linux /proc/net/dev
  for (const line of text.split("\n")) {
    const [name, rest] = line.split(":");
    if (name?.trim() === iface && rest) {
      const f = rest.trim().split(/\s+/);
      return { rx: Number(f[0]), tx: Number(f[8]) };
    }
  }
  return null;
}

export function parseNetstatWin(text) { // netstat -e
  const m = text.match(/Bytes\s+(\d+)\s+(\d+)/i);
  return m ? { rx: Number(m[1]), tx: Number(m[2]) } : null;
}

export async function measureThisComputer(devices = []) {
  const mine = new Map(); // ip -> interface name
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === "IPv4" || a.family === 4) && !a.internal) {
        mine.set(a.address, name);
      }
    }
  }

  // Find the device corresponding to this machine
  let dev = devices.find((d) => mine.has(d.ip));
  let iface = dev ? mine.get(dev.ip) : null;

  // Fallback: if not found in router device list yet, pick the active Wi-Fi / en0 interface
  if (!iface) {
    if (mine.size > 0) {
      const [firstIp, firstIface] = [...mine.entries()][0];
      iface = firstIface;
      dev = { ip: firstIp, mac: null, name: os.hostname() };
    } else {
      iface = "en0";
    }
  }

  let c = null;
  if (process.platform === "darwin") {
    c = parseNetstatMac(await run("netstat", ["-ib"]), iface);
    // If specific iface failed, try en0
    if (!c && iface !== "en0") {
      c = parseNetstatMac(await run("netstat", ["-ib"]), "en0");
    }
  } else if (process.platform === "linux") {
    try { c = parseProcNetDev(fs.readFileSync("/proc/net/dev", "utf8"), iface); } catch {}
  } else if (process.platform === "win32") {
    c = parseNetstatWin(await run("netstat", ["-e"]));
  }

  return c && Number.isFinite(c.rx) && Number.isFinite(c.tx)
    ? {
        ip: dev?.ip || "Unknown",
        mac: dev?.mac || null,
        name: dev?.name || os.hostname(),
        iface,
        rx: c.rx,
        tx: c.tx,
      }
    : null;
}
