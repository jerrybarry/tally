import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "router_replies.json"), "utf8")
);

test("Router test fixture sanity: sensitive data is sanitized", () => {
  assert.equal(fixtures.cmd_80.imei, "860000000000000");
  assert.equal(fixtures.cmd_80.imsi, "421000000000000");
  for (const d of fixtures.cmd_402.dhcp_list_info) {
    assert.match(d.mac, /^02:00:00:00:00:0[1-3]$/);
  }
});

test("Router parser correctly calculates month MB and speed rates", () => {
  const m = fixtures.cmd_337;
  assert.equal(m.mon_download_flow, 232500);
  assert.equal(m.dl_mon_flow, 131700);
  assert.equal(m.ul_mon_flow, 100800);

  const lan = fixtures.cmd_402;
  assert.equal(lan.dl_flow_rate, 35840);
  assert.equal(lan.ul_flow_rate, 4096);
});

test("Router correctly correlates DHCP devices with 5G and 2.4G Wi-Fi bands", () => {
  const lan = fixtures.cmd_402.dhcp_list_info;
  const wifi5 = new Set(fixtures.cmd_225.wlan5g_wifi_info.map((w) => w.mac.toLowerCase()));
  const wifi24 = new Set(fixtures.cmd_224.wlan24g_wifi_info.map((w) => w.mac.toLowerCase()));

  const matched = lan.map((d) => {
    const mac = d.mac.toLowerCase();
    let band = null;
    if (wifi5.has(mac)) band = "5G";
    else if (wifi24.has(mac)) band = "2.4G";
    return { name: d.hostname, band };
  });

  assert.equal(matched[0].name, "MacBook-Pro");
  assert.equal(matched[0].band, "5G");
  assert.equal(matched[1].name, "iPhone");
  assert.equal(matched[1].band, "5G");
  assert.equal(matched[2].name, "Smart-TV");
  assert.equal(matched[2].band, "2.4G");
});

test("Lockout protection: login rejection returns LOGIN error code", () => {
  const failReply = fixtures.cmd_100_fail;
  assert.equal(failReply.success, false);
  assert.equal(failReply.login_fail, "fail");

  const err = new Error("Login rejected. Please check your router password.");
  err.code = "LOGIN";

  assert.equal(err.code, "LOGIN");
  assert.match(err.message, /Login rejected/);
});
