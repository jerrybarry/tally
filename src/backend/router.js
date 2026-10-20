import https from "node:https";
import { randomBytes, createHash } from "node:crypto";

const arr = (x) => (Array.isArray(x) ? x : []);
const num = (x) => (x === "" || x == null || Number.isNaN(Number(x)) ? null : Number(x));

// The router sometimes puts garbage bytes inside key names (seen in dhcp_list_info);
// strip control characters so JSON.parse does not choke on them.
const parse = (t) => JSON.parse(t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));

export const cleanHost = (h) =>
  String(h || "192.168.0.1")
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[\/?#].*$/, "")
    .replace(/:\d+$/, "") || "192.168.0.1";

export function createRouter(cfg) {
  cfg = { ...cfg, host: cleanHost(cfg.host) };
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  const jar = new Map();
  let session = null;

  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const keepCookies = (headers) => {
    for (const c of headers["set-cookie"] || []) {
      const kv = c.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
    }
  };

  function post(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const cookie = cookieHeader();
      const req = https.request(
        {
          host: cfg.host,
          port: cfg.port || 443,
          path: "/cgi-bin/http.cgi",
          method: "POST",
          agent,
          timeout: 10000,
          headers: {
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
            "Content-Type": "application/json;charset=UTF-8",
            "Content-Length": Buffer.byteLength(data),
            Origin: `https://${cfg.host}`,
            Referer: `https://${cfg.host}/`,
            ...(cookie && { Cookie: cookie }),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            keepCookies(res.headers);
            resolve(text);
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("Router did not answer within 10s")));
      req.on("error", reject);
      req.end(data);
    });
  }

  async function login() {
    jar.clear();
    session = null;
    await post({ cmd: 104, method: "GET", sessionId: "" });
    await post({ cmd: 80, method: "GET", sessionId: "" });
    const { token } = parse(await post({ cmd: 232, method: "GET", sessionId: "" }));
    const text = await post({
      sessionId: randomBytes(32).toString("hex"),
      username: cfg.user || "admin",
      passwd: createHash("sha256").update(token + (cfg.pass || "")).digest("hex"),
      isAutoUpgrade: "1",
      method: "POST",
      cmd: 100,
      isCheckPasswd: "1",
      token: randomBytes(16).toString("hex"),
    });
    const j = parse(text);
    if (j.success === false || j.login_fail === "fail" || j.login_fail2 === "fail" || !j.sessionId) {
      const e = new Error("Login rejected. Please check your router password.");
      e.code = "LOGIN";
      throw e;
    }
    if (!jar.has("secure_sessionId")) jar.set("secure_sessionId", j.sessionId);
    session = j.sessionId;
  }

  async function get(cmd, extra = {}) {
    const j = parse(await post({ cmd, method: "GET", ...extra, sessionId: session }));
    if (j.success === false) throw new Error(`cmd ${cmd} failed: ${j.message || "Unknown error"}`);
    return j;
  }

  async function collect() {
    const monthly = await get(337); // monthly counters (units: MB)
    const wan = await get(133);     // raw WAN byte counters since connection uptime
    const lan = await get(402);     // DHCP device list + live speed
    const wifi5 = await get(225);   // devices on 5G radio
    const wifi24 = await get(224);  // devices on 2.4G radio

    let cellular = null;
    try {
      cellular = await get(205);    // 5G/4G signal info (network_type_str, signal_lvl, RSRP)
    } catch {
      // Non-critical if cellular info is unavailable
    }

    const radio = new Map();
    for (const c of arr(wifi5.wlan5g_wifi_info)) {
      radio.set(String(c.mac).toLowerCase(), { ...c, band: "5G" });
    }
    for (const c of arr(wifi24.wlan24g_wifi_info)) {
      radio.set(String(c.mac).toLowerCase(), { ...c, band: "2.4G" });
    }

    const devices = arr(lan.dhcp_list_info).map((d) => {
      const r = radio.get(String(d.mac).toLowerCase());
      return {
        mac: d.mac,
        ip: d.ip,
        name: d.hostname || "Unknown Device",
        link: d.interface,
        flow: num(d.flow), // router firmware returns 0
        wifi_connected: Boolean(r),
        band: r?.band ?? null,
        rssi: num(r?.rssi),
        tx_rate: num(r?.txrate),
        rx_rate: num(r?.rxrate),
      };
    });

    return {
      ts: new Date().toISOString(),
      month_mb: {
        down: num(monthly.dl_mon_flow),
        up: num(monthly.ul_mon_flow),
        total: num(monthly.mon_download_flow),
      },
      wan_bytes: {
        rx: num(wan.wan_rx_bytes),
        tx: num(wan.wan_tx_bytes),
        uptime_s: num(wan.uptime),
      },
      speed_kbps: {
        down: num(lan.dl_flow_rate),
        up: num(lan.ul_flow_rate),
      },
      cellular: cellular
        ? {
            networkType: cellular.network_type_str || "5G",
            operator: cellular.network_operator || "Cellular",
            signalLevel: num(cellular.signal_lvl),
            rsrp: cellular.RSRP || cellular.RSRP_5G || null,
          }
        : null,
      devices,
    };
  }

  async function sample() {
    try {
      if (!session) await login();
      return await collect();
    } catch (e) {
      if (e.code === "LOGIN") throw e;
      await login(); // Session may have expired: re-authenticate and retry
      return await collect();
    }
  }

  async function probe() {
    await login();
    const status = await get(113);
    return {
      boardType: status.board_type || "ZLT X17U",
      success: true,
    };
  }

  return { sample, probe };
}
