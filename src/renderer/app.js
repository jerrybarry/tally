(function () {
  const $ = (id) => document.getElementById(id);
  const qsa = (sel) => document.querySelectorAll(sel);

  let currentScreen = "dash";
  let connected = false;
  let summaryData = null;
  let G = 1024;
  let currentPeriod = "month";

  // Unified API bridge for Electron / Native Mac WKWebView / Local HTTP
  const api = {
    async getSummary() {
      if (window.electronAPI?.getSummary) {
        return await window.electronAPI.getSummary();
      }
      if (window.webkit?.messageHandlers?.getSummary) {
        return new Promise((resolve) => {
          window.__onSummaryReply = resolve;
          window.webkit.messageHandlers.getSummary.postMessage({});
        });
      }
      const res = await fetch("/api/summary", { cache: "no-store" });
      return await res.json();
    },

    async saveConfig(cfg) {
      if (window.electronAPI?.saveConfig) {
        return await window.electronAPI.saveConfig(cfg);
      }
      if (window.webkit?.messageHandlers?.saveConfig) {
        window.webkit.messageHandlers.saveConfig.postMessage(cfg);
        return true;
      }
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      return true;
    },

    async setDeviceNickname(mac, nickname) {
      if (window.electronAPI?.setDeviceNickname) {
        return await window.electronAPI.setDeviceNickname(mac, nickname);
      }
      const res = await fetch("/api/devices/nickname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mac, nickname }),
      });
      const data = await res.json();
      return data.summary;
    },

    async connectRouter(creds) {
      if (window.electronAPI?.connectRouter) {
        return await window.electronAPI.connectRouter(creds);
      }
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
      });
      return await res.json();
    },

    async disconnect() {
      if (window.electronAPI?.disconnect) {
        return await window.electronAPI.disconnect();
      }
      return await fetch("/api/disconnect", { method: "POST" });
    },

    async testConnection(creds) {
      if (window.electronAPI?.testConnection) {
        return await window.electronAPI.testConnection(creds);
      }
      if (window.webkit?.messageHandlers?.testConnection) {
        return new Promise((resolve) => {
          window.__onTestReply = resolve;
          window.webkit.messageHandlers.testConnection.postMessage(creds);
        });
      }
      const res = await fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
      });
      return await res.json();
    },

    async refresh() {
      if (window.electronAPI?.refreshNow) {
        return await window.electronAPI.refreshNow();
      }
      return await this.getSummary();
    },

    quit() {
      if (window.electronAPI?.quitApp) window.electronAPI.quitApp();
      else if (window.webkit?.messageHandlers?.quitApp) window.webkit.messageHandlers.quitApp.postMessage({});
      else window.close();
    },

    minimize() {
      if (window.electronAPI?.minimizeWindow) window.electronAPI.minimizeWindow();
    },

    close() {
      if (window.electronAPI?.closeWindow) window.electronAPI.closeWindow();
    },
  };

  // Screen navigation and sidebar visibility
  function updateScreenState(conn, targetScreen) {
    connected = Boolean(conn);
    const win = $("appWindow");

    if (!connected) {
      win.classList.add("logged-out");
      currentScreen = "connect";
      qsa(".screen").forEach((s) => s.classList.toggle("on", s.id === "connect"));
      qsa(".side button").forEach((b) => b.setAttribute("aria-current", "false"));
    } else {
      win.classList.remove("logged-out");
      if (targetScreen) currentScreen = targetScreen;
      if (currentScreen === "connect") currentScreen = "dash";
      qsa(".screen").forEach((s) => s.classList.toggle("on", s.id === currentScreen));
      qsa(".side button").forEach((b) => b.setAttribute("aria-current", b.dataset.go === currentScreen));
    }
  }

  function go(id) {
    if (!connected) {
      updateScreenState(false);
      return;
    }
    if (id === "connect") id = "dash";
    updateScreenState(true, id);
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-go]");
    if (btn) go(btn.dataset.go);
  });

  $("previewBtnQuit")?.addEventListener("click", () => api.quit());

  // Formatting helpers
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function parts(mb) {
    if (mb == null) return ["0.0", "GB"];
    if (mb >= G) {
      const val = (mb / G).toFixed(mb >= 10 * G ? 1 : 2);
      return [val, "GB"];
    }
    return [String(Math.round(mb)), "MB"];
  }

  function fmt(mb) {
    const [val, u] = parts(mb);
    return `${val} ${u}`;
  }

  function rate(k) {
    if (k == null || k === 0) return "0";
    if (k >= 1000) return (k / 1000).toFixed(2);
    return String(Math.round(k));
  }

  function rateUnit(k) {
    return k >= 1000 ? "Mb/s" : "kb/s";
  }

  // Render SVG Usage Over Time Chart (Area + Multi-line matching screenshot)
  let currentChartMode = "daily";

  function renderUsageOverTimeChart(d) {
    const svg = $("lineChartSvg");
    const tooltip = $("chartTooltip");
    if (!svg || !d) return;

    const isHourly = currentChartMode === "hourly";
    const rawItems = isHourly ? (d.hours || []).slice(-24) : (d.days || []).slice(-14);
    if (!rawItems.length) return;

    // Subtitle update
    const subtitle = $("chartSubtitle");
    if (subtitle) {
      if (isHourly) {
        subtitle.textContent = "Hourly data consumption · Last 24 hours";
      } else {
        const curDate = new Date();
        const monthYear = curDate.toLocaleDateString([], { month: "long", year: "numeric" });
        subtitle.textContent = `Daily data consumption · ${monthYear}`;
      }
    }

    const padLeft = 46;
    const padRight = 16;
    const padTop = 18;
    const padBottom = 26;
    const totalW = 620;
    const totalH = 210;
    const plotW = totalW - padLeft - padRight;
    const plotH = totalH - padTop - padBottom;
    const baseY = padTop + plotH;

    // Find max value in MB across both download and upload
    const maxValMb = Math.max(
      5 * G,
      ...rawItems.map((item) => Math.max(item.down || 0, item.up || 0))
    );
    const maxGbRaw = maxValMb / G;

    let niceMaxGb = 20;
    if (maxGbRaw <= 2.5) niceMaxGb = 2.5;
    else if (maxGbRaw <= 5) niceMaxGb = 5;
    else if (maxGbRaw <= 10) niceMaxGb = 10;
    else if (maxGbRaw <= 15) niceMaxGb = 15;
    else if (maxGbRaw <= 20) niceMaxGb = 20;
    else if (maxGbRaw <= 30) niceMaxGb = 30;
    else if (maxGbRaw <= 40) niceMaxGb = 40;
    else if (maxGbRaw <= 60) niceMaxGb = 60;
    else if (maxGbRaw <= 100) niceMaxGb = 100;
    else niceMaxGb = Math.ceil(maxGbRaw / 20) * 20;

    const niceMaxMb = niceMaxGb * G;

    // Grid lines and Y-axis tick marks (5 intervals: 0, 0.25, 0.5, 0.75, 1.0)
    const ticks = [0, 0.25, 0.5, 0.75, 1];
    let gridSvg = "";
    ticks.forEach((frac) => {
      const y = baseY - frac * plotH;
      const gbVal = (niceMaxGb * frac).toFixed(niceMaxGb <= 5 ? 1 : 0);
      gridSvg += `
        <line x1="${padLeft}" y1="${y}" x2="${totalW - padRight}" y2="${y}" stroke="rgba(128,128,128,0.18)" stroke-width="1" />
        <text x="${padLeft - 8}" y="${y + 4}" text-anchor="end" font-size="10.5" fill="var(--mute)">${gbVal} GB</text>
      `;
    });

    const N = rawItems.length;
    const downPts = [];
    const upPts = [];

    rawItems.forEach((item, i) => {
      const x = padLeft + (i / Math.max(1, N - 1)) * plotW;
      const dMb = item.down || 0;
      const uMb = item.up || 0;
      const yDown = baseY - Math.min(plotH, (dMb / niceMaxMb) * plotH);
      const yUp = baseY - Math.min(plotH, (uMb / niceMaxMb) * plotH);
      downPts.push({ x, y: yDown, dMb, uMb, item, i });
      upPts.push({ x, y: yUp, dMb, uMb, item, i });
    });

    // Area path for Download (translucent lime fill)
    const downPathD = downPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const areaD = `M ${downPts[0].x.toFixed(1)} ${baseY} ${downPts.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")} L ${downPts[downPts.length - 1].x.toFixed(1)} ${baseY} Z`;

    // Line path for Upload (blue line)
    const upPathD = upPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

    // X-Axis Date / Hour Labels
    let xAxisSvg = "";
    rawItems.forEach((item, i) => {
      let showLabel = false;
      let label = "";
      if (!isHourly) {
        if (i % 2 === 0 || i === N - 1) {
          showLabel = true;
          const dObj = new Date(item.date + "T12:00:00");
          label = dObj.toLocaleDateString([], { month: "short", day: "numeric" });
        }
      } else {
        if (i % 4 === 0 || i === N - 1) {
          showLabel = true;
          const dObj = new Date(item.start);
          label = String(dObj.getHours()).padStart(2, "0") + ":00";
        }
      }
      if (showLabel) {
        const x = padLeft + (i / Math.max(1, N - 1)) * plotW;
        xAxisSvg += `<text x="${x}" y="${baseY + 18}" text-anchor="middle" font-size="10.5" fill="var(--mute)">${label}</text>`;
      }
    });

    // SVG Composition
    svg.innerHTML = `
      <defs>
        <linearGradient id="limeAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#D4F070" stop-opacity="0.5" />
          <stop offset="100%" stop-color="#D4F070" stop-opacity="0.08" />
        </linearGradient>
      </defs>
      ${gridSvg}
      <path d="${areaD}" fill="url(#limeAreaGrad)" />
      <path d="${downPathD}" fill="none" stroke="var(--ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="${upPathD}" fill="none" stroke="#4a85f6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
      ${xAxisSvg}
      <g id="chartHoverOverlay"></g>
    `;

    // Interactive tooltip and vertical hover crosshair
    svg.onmousemove = (e) => {
      const rect = svg.getBoundingClientRect();
      const relX = ((e.clientX - rect.left) / rect.width) * totalW;
      if (relX < padLeft || relX > totalW - padRight) {
        if (tooltip) tooltip.style.display = "none";
        const overlay = $("chartHoverOverlay");
        if (overlay) overlay.innerHTML = "";
        return;
      }

      let nearest = downPts[0];
      let minDist = 99999;
      downPts.forEach((p) => {
        const dist = Math.abs(p.x - relX);
        if (dist < minDist) {
          minDist = dist;
          nearest = p;
        }
      });

      if (!nearest) return;

      const pUp = upPts[nearest.i];
      let dateTitle = "";
      if (!isHourly) {
        const dObj = new Date(nearest.item.date + "T12:00:00");
        dateTitle = dObj.toLocaleDateString([], { month: "short", day: "2-digit" });
      } else {
        const dObj = new Date(nearest.item.start);
        dateTitle = dObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }

      const totMb = nearest.dMb + nearest.uMb;
      if (tooltip) {
        tooltip.innerHTML = `<b>${dateTitle}</b> · Down ${fmt(nearest.dMb)} · Up ${fmt(nearest.uMb)} (Total ${fmt(totMb)})`;
        tooltip.style.display = "block";
        const leftPct = (nearest.x / totalW) * 100;
        const topPx = (nearest.y / totalH) * rect.height;
        tooltip.style.left = `${leftPct}%`;
        tooltip.style.top = `${topPx}px`;
      }

      const overlay = $("chartHoverOverlay");
      if (overlay) {
        overlay.innerHTML = `
          <line x1="${nearest.x}" y1="${padTop}" x2="${nearest.x}" y2="${baseY}" stroke="var(--ink)" stroke-dasharray="3 3" opacity="0.35" />
          <circle cx="${nearest.x}" cy="${nearest.y}" r="4" fill="var(--ink)" stroke="var(--card)" stroke-width="2" />
          <circle cx="${pUp.x}" cy="${pUp.y}" r="4" fill="#4a85f6" stroke="var(--card)" stroke-width="2" />
        `;
      }
    };

    svg.onmouseleave = () => {
      if (tooltip) tooltip.style.display = "none";
      const overlay = $("chartHoverOverlay");
      if (overlay) overlay.innerHTML = "";
    };
  }

  // All-Time & Monthly Pie / Donut Chart Renderer
  const MONTH_COLORS = ["#D4F070", "#3d82d6", "#55622B", "#e08a5a", "#7a6bd6", "#2fa866", "#d64545", "#f5c842"];

  function renderAllTimeView(allTime, gBase) {
    if (!allTime) return;
    const totMb = allTime.total || 0;
    const avgMb = allTime.averagePerMonth || totMb;
    const count = allTime.monthsCount || (allTime.months?.length || 1);

    if ($("atTotalVal")) $("atTotalVal").textContent = fmt(totMb);
    if ($("atAvgVal")) $("atAvgVal").textContent = fmt(avgMb);
    if ($("atCountVal")) $("atCountVal").textContent = `${count} Month${count > 1 ? "s" : ""}`;
    if ($("atCountBadge")) $("atCountBadge").textContent = `${count} Month${count > 1 ? "s" : ""}`;
    if ($("atRangeVal") && allTime.months?.length) {
      const first = allTime.months[0].name;
      const last = allTime.months[allTime.months.length - 1].name;
      $("atRangeVal").textContent = first === last ? first : `${first} – ${last}`;
    }

    if ($("pieCenterVal")) $("pieCenterVal").textContent = fmt(totMb);

    // Render SVG Donut Chart
    const svg = $("pieSvg");
    const legend = $("pieLegendList");
    if (!svg || !legend) return;

    const months = allTime.months || [];
    if (!months.length) return;

    const C = 2 * Math.PI * 74; // Circumference ~464.955
    let currentOffset = 0;
    let svgSlicesHtml = "";
    let legendHtml = "";

    months.forEach((m, i) => {
      const color = MONTH_COLORS[i % MONTH_COLORS.length];
      const pct = m.percent != null ? Number(m.percent) : (totMb > 0 ? (m.total / totMb) * 100 : 100);
      const dash = (pct / 100) * C;
      const gap = Math.max(0, C - dash);
      const strokeOffset = currentOffset;
      currentOffset += dash;

      const isCur = Boolean(m.isCurrent);
      const tagHtml = isCur ? `<span class="pie-leg-tag">Current</span>` : "";

      svgSlicesHtml += `
        <circle class="donut-slice" cx="100" cy="100" r="74"
          stroke="${color}"
          stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"
          stroke-dashoffset="${(-strokeOffset).toFixed(2)}"
          data-month="${esc(m.monthLabel)}"
          data-val="${fmt(m.total)}"
          data-name="${esc(m.name)}"
          data-pct="${pct.toFixed(1)}%">
          <title>${esc(m.monthLabel)} (${esc(m.name)}): ${fmt(m.total)} (${pct.toFixed(1)}%)</title>
        </circle>
      `;

      legendHtml += `
        <div class="pie-legend-item" data-idx="${i}">
          <div class="pie-leg-left">
            <span class="pie-leg-dot" style="background:${color}"></span>
            <div class="pie-leg-info">
              <div class="pie-leg-header">
                <span class="pie-leg-name">${esc(m.name)}</span>
              </div>
              <div class="pie-leg-sub-row">
                <span class="pie-leg-label">${esc(m.monthLabel)}</span>
                ${tagHtml}
              </div>
            </div>
          </div>
          <div class="pie-leg-right">
            <span class="pie-leg-val">${fmt(m.total)}</span>
            <span class="pie-leg-pct">${pct.toFixed(1)}%</span>
          </div>
        </div>
      `;
    });

    svg.innerHTML = svgSlicesHtml;
    legend.innerHTML = legendHtml;

    // Monthly Records Table
    const tbody = $("mTableBody");
    if (tbody) {
      tbody.innerHTML = months.map((m, i) => {
        const color = MONTH_COLORS[i % MONTH_COLORS.length];
        const pct = m.percent != null ? Number(m.percent) : (totMb > 0 ? (m.total / totMb) * 100 : 100);
        const tag = m.isCurrent ? `<span class="tag">current</span>` : "";
        return `
          <tr>
            <td>
              <div class="m-period-cell">
                <span class="dot" style="background:${color}"></span>
                <b>${esc(m.monthLabel)}</b>
                <span style="color:var(--mute)">(${esc(m.name)})</span>
                ${tag}
              </div>
            </td>
            <td><b>${fmt(m.total)}</b></td>
            <td>
              <span style="font-size:12px;color:var(--mute)">
                Down <b>${fmt(m.down)}</b> · Up <b>${fmt(m.up)}</b>
              </span>
            </td>
            <td>
              <div class="m-share-bar-wrap">
                <div class="m-share-bar">
                  <i style="width:${Math.max(3, pct)}%;background:${color}"></i>
                </div>
                <span style="font-size:11.5px;color:var(--mute);min-width:38px">${pct.toFixed(1)}%</span>
              </div>
            </td>
          </tr>
        `;
      }).join("");
    }

    // Interactive Hover on Slices and Legend Items
    qsa(".donut-slice").forEach((slice) => {
      slice.addEventListener("mouseenter", () => {
        const val = slice.dataset.val;
        const name = slice.dataset.name;
        const pct = slice.dataset.pct;
        if ($("pieCenterLabel")) $("pieCenterLabel").textContent = name;
        if ($("pieCenterVal")) $("pieCenterVal").textContent = val;
        if ($("pieCenterNote")) $("pieCenterNote").textContent = `${pct} of all-time`;
      });
      slice.addEventListener("mouseleave", () => {
        if ($("pieCenterLabel")) $("pieCenterLabel").textContent = "All-Time";
        if ($("pieCenterVal")) $("pieCenterVal").textContent = fmt(totMb);
        if ($("pieCenterNote")) $("pieCenterNote").textContent = "Total tracked";
      });
    });
  }

  // Render Devices
  function renderDevices(devices = [], thisMac = null, otherDevices = null, meas = null) {
    const tbody = $("devicesTableBody");
    if (!tbody) return;

    const rows = [];

    // Sort: Online first, then this computer, then offline devices
    const sorted = [...devices].sort((a, b) => {
      if (b.online !== a.online) return b.online ? 1 : -1;
      if (b.isThisComputer !== a.isThisComputer) return b.isThisComputer ? 1 : -1;
      return 0;
    });

    for (const d of sorted) {
      const isOnline = Boolean(d.online);
      const dotHtml = `<span class="dot ${isOnline ? "" : "off"}" style="display:inline-block;margin-right:8px"></span>`;
      
      const nick = d.nickname;
      const orig = d.originalName || d.name || "Device";
      const displayName = esc(d.name || "Device");
      const origHtml = nick && nick !== orig ? `<span class="nickname-orig">(${esc(orig)})</span>` : "";
      const editBtn = d.mac ? `
        <button class="btn-edit-nick" data-mac="${esc(d.mac)}" data-name="${esc(nick || '')}" data-orig="${esc(orig)}" title="Rename device" aria-label="Rename device">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
        </button>
      ` : "";

      const nameHtml = `<b>${displayName}</b>${origHtml}${editBtn}`;
      const tagHtml = d.isThisComputer ? `<span class="tag">this Mac</span>` : "";
      const ipHtml = `<small>${esc(d.ip || "—")}${d.mac ? " · " + esc(d.mac) : ""}</small>`;

      let connHtml = "";
      if (isOnline) {
        connHtml = `${d.band ? "Wi-Fi " + esc(d.band) : esc(d.link || "Wired")}`;
        if (d.rssi != null && d.rssi !== 0) {
          connHtml += `<small>signal ${d.rssi} dBm</small>`;
        }
      } else {
        const lastSeenStr = d.t ? new Date(d.t).toLocaleDateString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "recently";
        connHtml = `Not connected<small>last seen ${lastSeenStr}</small>`;
      }

      let usedToday = "—";
      let usedMonth = "—";

      if (d.isThisComputer && thisMac) {
        usedToday = fmt((thisMac.today?.down || 0) + (thisMac.today?.up || 0));
        usedMonth = fmt((thisMac.month?.down || 0) + (thisMac.month?.up || 0));
      } else if (d.flow && d.flow > 0) {
        usedToday = usedMonth = fmt(d.flow);
      }

      rows.push(`
        <tr class="${isOnline ? "" : "off"}">
          <td>
            <div class="dev-cell">
              ${dotHtml}
              <div>
                ${nameHtml}${tagHtml}
                ${ipHtml}
              </div>
            </div>
          </td>
          <td>${connHtml}</td>
          <td>${usedToday}</td>
          <td>${usedMonth}</td>
        </tr>
      `);
    }

    // Always include "All other devices together"
    const otherToday = otherDevices ? fmt(otherDevices.today) : "0 MB";
    const otherMonth = otherDevices ? fmt(otherDevices.month) : "0 MB";

    rows.push(`
      <tr class="row-other-devices">
        <td>
          <div class="dev-cell">
            <span class="dot" style="background:var(--mute)"></span>
            <div>
              <b>All other devices together</b>
              <small>phones, TVs, tablets, other computers</small>
            </div>
          </div>
        </td>
        <td>Other connected devices</td>
        <td>${otherToday}</td>
        <td>${otherMonth}</td>
      </tr>
    `);

    // Total network usage across all devices combined
    const totalTodayMb = (meas?.today?.down || 0) + (meas?.today?.up || 0);
    const totalMonthMb = meas?.month?.total || (meas?.month?.down || 0) + (meas?.month?.up || 0);
    const totalTodayStr = fmt(totalTodayMb);
    const totalMonthStr = fmt(totalMonthMb);

    rows.push(`
      <tr class="row-total-devices">
        <td>
          <div class="dev-cell">
            <span class="dot" style="background:var(--lime);box-shadow:0 0 8px rgba(212,240,112,0.6)"></span>
            <div>
              <b>Total network usage</b>
              <small>All devices combined</small>
            </div>
          </div>
        </td>
        <td><span class="tag" style="background:rgba(212,240,112,0.2);color:var(--ink);font-weight:700">Network Total</span></td>
        <td><b style="color:var(--lime);font-family:var(--font-heading);font-size:14px">${totalTodayStr}</b></td>
        <td><b style="color:var(--lime);font-family:var(--font-heading);font-size:14px">${totalMonthStr}</b></td>
      </tr>
    `);

    tbody.innerHTML = rows.join("");

    // Attach click listeners to nickname edit buttons
    tbody.querySelectorAll(".btn-edit-nick").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openNicknameModal(btn.dataset.mac, btn.dataset.name, btn.dataset.orig);
      });
    });

    // Update callout note with start date and tally summary
    const sinceStr = meas?.since ? new Date(meas.since).toLocaleDateString([], { day: "numeric", month: "short" }) : "when this app started";
    const thisMacTodayFormatted = fmt(thisMac?.today ? (thisMac.today.down || 0) + (thisMac.today.up || 0) : 0);
    const callout = $("devicesCallout");
    if (callout) {
      callout.innerHTML = `
        <b>How device usage is measured:</b> This router doesn’t report per-device byte counters in its firmware, so only <b>this Mac</b> is measured directly via macOS network counters (${thisMacTodayFormatted} today). <b>“All other devices together”</b> is calculated as the router’s total traffic minus this Mac (${otherToday} today). <b>“Total network usage”</b> (${totalTodayStr} today / ${totalMonthStr} this month) is the sum of all connected devices.
      `;
    }
  }

  // Device Nickname Modal Handlers
  let activeEditingMac = null;
  function openNicknameModal(mac, currentNick, origName) {
    activeEditingMac = mac;
    const sub = $("nicknameModalSub");
    if (sub) sub.textContent = `Original: ${origName || mac} · MAC: ${mac}`;
    const input = $("nicknameInput");
    if (input) {
      input.value = currentNick || "";
      setTimeout(() => input.focus(), 60);
    }
    const modal = $("nicknameModal");
    if (modal) modal.style.display = "flex";
  }

  function closeNicknameModal() {
    activeEditingMac = null;
    const modal = $("nicknameModal");
    if (modal) modal.style.display = "none";
  }

  $("btnCancelNickname")?.addEventListener("click", closeNicknameModal);
  $("nicknameModal")?.addEventListener("click", (e) => {
    if (e.target === $("nicknameModal")) closeNicknameModal();
  });
  $("nicknameInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btnSaveNickname")?.click();
    if (e.key === "Escape") closeNicknameModal();
  });

  $("btnSaveNickname")?.addEventListener("click", async () => {
    if (!activeEditingMac) return;
    const input = $("nicknameInput");
    const val = input ? input.value.trim() : "";
    closeNicknameModal();
    try {
      const updated = await api.setDeviceNickname(activeEditingMac, val);
      if (updated) render(updated);
    } catch (e) {
      console.warn("Failed to save nickname:", e);
    }
  });

  $("btnResetNickname")?.addEventListener("click", async () => {
    if (!activeEditingMac) return;
    closeNicknameModal();
    try {
      const updated = await api.setDeviceNickname(activeEditingMac, "");
      if (updated) render(updated);
    } catch (e) {
      console.warn("Failed to reset nickname:", e);
    }
  });

  // Main UI update
  function render(d) {
    if (!d) return;
    summaryData = d;
    G = d.mbPerGb || 1024;

    // Check login state
    const isConn = Boolean(d.connected && !d.config?.disconnected);
    updateScreenState(isConn, currentScreen === "connect" ? "dash" : currentScreen);

    // Sidebar status
    const sdot = $("sdot");
    const stext = $("stext");
    if (sdot && stext) {
      sdot.className = "dot" + (!d.connected ? (d.lastError ? " err" : " off") : "");
      if (d.connected) {
        const netType = d.cellular?.networkType || "5G(NSA)";
        stext.textContent = `Connected · ${netType}`;
      } else {
        stext.textContent = d.lastError ? "Connection error" : "Not connected";
      }
    }

    // Dashboard Hero based on selected period
    const now = new Date();
    const monthFull = now.toLocaleDateString([], { month: "long", year: "numeric" });
    const monthTotal = d.month?.total || d.measured?.month?.total || ((d.measured?.month?.down || 0) + (d.measured?.month?.up || 0));
    const todayTot = (d.measured?.today?.down || 0) + (d.measured?.today?.up || 0);
    const last7DaysTotal = (d.days || []).slice(-7).reduce((acc, x) => acc + (x.total || (x.down || 0) + (x.up || 0)), 0);

    let heroValMb = monthTotal;
    let heroDownMb = d.month?.down || d.measured?.month?.down || 0;
    let heroUpMb = d.month?.up || d.measured?.month?.up || 0;

    if (currentPeriod === "today") {
      heroValMb = todayTot;
      heroDownMb = d.measured?.today?.down || 0;
      heroUpMb = d.measured?.today?.up || 0;
      if ($("heroPeriodLabel")) $("heroPeriodLabel").textContent = "Today’s usage";
      if ($("heroCaptionText")) $("heroCaptionText").textContent = "Total data used today";
    } else if (currentPeriod === "week") {
      heroValMb = last7DaysTotal;
      const weekDown = (d.days || []).slice(-7).reduce((acc, x) => acc + (x.down || 0), 0);
      const weekUp = (d.days || []).slice(-7).reduce((acc, x) => acc + (x.up || 0), 0);
      heroDownMb = weekDown;
      heroUpMb = weekUp;
      if ($("heroPeriodLabel")) $("heroPeriodLabel").textContent = "Usage in the last 7 days";
      if ($("heroCaptionText")) $("heroCaptionText").textContent = "Total data across all connected devices in the past week";
    } else {
      if ($("heroPeriodLabel")) $("heroPeriodLabel").textContent = `${monthFull} usage so far`;
      if ($("heroCaptionText")) $("heroCaptionText").textContent = "Total data used this month";
    }

    const [totVal, totUnit] = parts(heroValMb);
    if ($("usedTotal")) $("usedTotal").textContent = totVal;
    if ($("usedUnit")) $("usedUnit").textContent = totUnit;

    const splitPct = heroValMb > 0 ? (heroDownMb / heroValMb) * 100 : 50;
    if ($("splitBar")) $("splitBar").style.width = `${splitPct}%`;
    if ($("legDown")) $("legDown").textContent = fmt(heroDownMb);
    if ($("legUp")) $("legUp").textContent = fmt(heroUpMb);

    // Hero Plan / Connection card
    const planBox = $("planBox");
    if (planBox) {
      if (d.planGb) {
        const planMb = d.planGb * G;
        const bundleUsedMb = d.month?.total || monthTotal;
        const leftMb = planMb - bundleUsedMb;
        const planPct = Math.min(100, Math.max(0, (bundleUsedMb / planMb) * 100));
        if ($("planRemaining")) $("planRemaining").textContent = leftMb > 0 ? `${fmt(leftMb)} left` : "Plan limit reached";
        if ($("planProgBar")) $("planProgBar").style.width = `${planPct}%`;
        if ($("planPercentText")) $("planPercentText").textContent = `${planPct.toFixed(0)}% of ${d.planGb} GB used`;
      } else {
        if ($("planRemaining")) $("planRemaining").textContent = "Unlimited Plan";
        if ($("planProgBar")) $("planProgBar").style.width = "100%";
        if ($("planPercentText")) $("planPercentText").textContent = "No plan limit configured";
      }
      if ($("heroNetworkBadge")) $("heroNetworkBadge").textContent = d.cellular?.networkType || "5G Online";
    }

    // 4 Key Metric Cards
    const spDown = d.speed?.down || 0;
    const spUp = d.speed?.up || 0;
    if ($("statSpeedDown")) $("statSpeedDown").textContent = rate(spDown);
    if ($("statSpeedUp")) $("statSpeedUp").textContent = rate(spUp);
    if ($("speedUnit")) $("speedUnit").textContent = rateUnit(Math.max(spDown, spUp));
    if ($("statToday")) $("statToday").textContent = todayTot > 0 ? fmt(todayTot) : "0 MB";
    if ($("statWeek")) $("statWeek").textContent = fmt(last7DaysTotal);
    const avgPerMonth = d.allTime?.averagePerMonth || monthTotal;
    if ($("statAvg")) $("statAvg").textContent = fmt(avgPerMonth);

    // Chart Summary Bar
    const days = d.days || [];
    if (days.length) {
      let peakDay = days[0];
      let peakTot = 0;
      let sumTot = 0;
      let sumUp = 0;
      let sumDown = 0;
      let activeDays = 0;

      for (const day of days) {
        const dMb = day.down || 0;
        const uMb = day.up || 0;
        const t = dMb + uMb;
        if (t > peakTot) {
          peakTot = t;
          peakDay = day;
        }
        sumTot += t;
        sumUp += uMb;
        sumDown += dMb;
        if (t > 0) activeDays++;
      }

      const pDate = new Date(peakDay.date + "T12:00:00");
      const monthShort = pDate.toLocaleDateString([], { month: "short" });
      const dayNum = String(pDate.getDate()).padStart(2, "0");
      if ($("summaryPeakDay")) $("summaryPeakDay").textContent = `${monthShort} ${dayNum} · ${fmt(peakTot)}`;

      const divisor = activeDays > 0 ? activeDays : Math.max(1, days.length);
      const dailyAvg = sumTot / divisor;
      if ($("summaryDailyAvg")) $("summaryDailyAvg").textContent = fmt(dailyAvg);

      const upShare = (sumDown + sumUp) > 0 ? ((sumUp / (sumDown + sumUp)) * 100).toFixed(1) + "%" : "0.0%";
      if ($("summaryUpShare")) $("summaryUpShare").textContent = upShare;
    }

    // Monthly History List
    const historyList = $("monthlyHistoryList");
    if (historyList && d.allTime?.months) {
      historyList.innerHTML = d.allTime.months.map((m, i) => {
        const color = MONTH_COLORS[i % MONTH_COLORS.length];
        const pct = m.percent != null ? Number(m.percent) : 100;
        return `
          <div class="history-item">
            <div>
              <div class="history-month">
                <span class="month-mark" style="background:${color}"></span>
                ${esc(m.monthLabel)} · ${esc(m.name)}
                ${m.isCurrent ? '<span class="status-pill">Current</span>' : ''}
              </div>
              <div class="history-date">${esc(m.name)} · Down ${fmt(m.down)} · Up ${fmt(m.up)}</div>
            </div>
            <div class="history-value">${fmt(m.total)}</div>
            <div class="history-change">${m.isCurrent ? "In progress" : pct.toFixed(1) + "%"}</div>
          </div>
        `;
      }).join("");
    }

    // Router Connection Card
    if ($("connRouterModel")) $("connRouterModel").textContent = d.routerModel ? `${d.routerModel}` : "5G Router (ZLT X17U)";
    if ($("connNetworkType")) $("connNetworkType").textContent = `${d.cellular?.networkType || "5G (NSA)"}`;
    const rssi = d.cellular?.rssi;
    if ($("connSignalText")) $("connSignalText").textContent = rssi ? `Good · ${rssi} dBm` : "Connected · 5G";
    if ($("connSignalFill")) {
      const sigPct = rssi ? Math.max(10, Math.min(100, Math.round(((rssi + 110) / 60) * 100))) : 80;
      $("connSignalFill").style.width = `${sigPct}%`;
    }
    if ($("connLocalIp")) $("connLocalIp").textContent = `${d.thisComputer?.ip || "192.168.0.114"} (this Mac)`;
    if ($("connLastSync")) $("connLastSync").textContent = "Just now";

    // Charts
    renderAllTimeView(d.allTime, G);
    renderUsageOverTimeChart(d);

    // Devices Table
    renderDevices(d.devices || [], d.thisComputer, d.otherDevices, d.measured);

    // Update settings inputs if not focused
    if (document.activeElement !== $("sRouterHost")) $("sRouterHost").value = d.config?.routerHost || "192.168.0.1";
    if (document.activeElement !== $("sPlanGb")) $("sPlanGb").value = d.config?.planGb ? `${d.config.planGb} GB` : "";
    if (document.activeElement !== $("sDailyLimitGb")) $("sDailyLimitGb").value = d.config?.dailyLimitGb ? `${d.config.dailyLimitGb} GB` : "15 GB";
    if (document.activeElement !== $("sWarnPercent")) $("sWarnPercent").value = String(d.config?.warnPercent || 80);
    if ($("sNotifyNewDevice")) $("sNotifyNewDevice").checked = d.config?.notifyNewDevice !== false;
    if ($("sNotifyOffline")) $("sNotifyOffline").checked = d.config?.notifyOffline !== false;
    $("sShowMenuBar").checked = d.config?.showMenuBar !== false;
    $("sOpenAtLogin").checked = Boolean(d.config?.openAtLogin);
    if (document.activeElement !== $("sTheme")) $("sTheme").value = d.config?.theme || "auto";

    applyTheme(d.config?.theme || "auto");
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === "auto") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", theme);
    }
  }

  // Connect Form Handling
  $("cform")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const host = $("cRouterIp").value.trim();
    const pass = $("cRouterPass").value;
    const errBox = $("cErr");
    const submitBtn = $("btnConnectSubmit");

    errBox.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Connecting…";

    try {
      const res = await api.connectRouter({
        routerHost: host,
        password: pass,
        savePasswordKeychain: $("cSaveKey").checked,
      });

      if (res?.connected) {
        updateScreenState(true, "dash");
        render(res);
      } else {
        errBox.textContent = res?.lastError || "Could not connect to router. Check password.";
      }
    } catch (err) {
      errBox.textContent = err.message || "Connection failed. Please check password.";
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Connect";
    }
  });

  // Settings Save Handling
  function saveSettings() {
    const host = $("sRouterHost").value.trim();
    const planText = $("sPlanGb").value.replace(/[^\d.]/g, "");
    const planGb = planText ? Number(planText) : null;
    const warnPercent = Number($("sWarnPercent").value) || 80;
    const dailyText = $("sDailyLimitGb") ? $("sDailyLimitGb").value.replace(/[^\d.]/g, "") : "15";
    const dailyLimitGb = dailyText ? Number(dailyText) : 15;
    const notifyNewDevice = $("sNotifyNewDevice") ? $("sNotifyNewDevice").checked : true;
    const notifyOffline = $("sNotifyOffline") ? $("sNotifyOffline").checked : true;
    const showMenuBar = $("sShowMenuBar").checked;
    const openAtLogin = $("sOpenAtLogin").checked;
    const theme = $("sTheme").value;
    applyTheme(theme);

    api.saveConfig({
      routerHost: host,
      planGb,
      warnPercent,
      dailyLimitGb,
      notifyNewDevice,
      notifyOffline,
      showMenuBar,
      openAtLogin,
      theme,
    });
  }

  $("sRouterHost")?.addEventListener("change", saveSettings);
  $("sPlanGb")?.addEventListener("change", saveSettings);
  $("sDailyLimitGb")?.addEventListener("change", saveSettings);
  $("sWarnPercent")?.addEventListener("change", saveSettings);
  $("sNotifyNewDevice")?.addEventListener("change", saveSettings);
  $("sNotifyOffline")?.addEventListener("change", saveSettings);
  $("sShowMenuBar")?.addEventListener("change", saveSettings);
  $("sOpenAtLogin")?.addEventListener("change", saveSettings);
  $("sTheme")?.addEventListener("change", () => {
    applyTheme($("sTheme").value);
    saveSettings();
  });

  // Disconnect button: stop background polling and switch to connect screen
  $("btnDisconnect")?.addEventListener("click", async () => {
    $("cRouterPass").value = "";
    updateScreenState(false);
    const errBox = $("cErr");
    if (errBox) errBox.textContent = "";

    try {
      await api.disconnect();
    } catch (e) {
      console.warn("Disconnect failed:", e);
    }
  });

  $("btnRefreshDevices")?.addEventListener("click", async () => {
    const btn = $("btnRefreshDevices");
    btn.textContent = "Refreshing…";
    btn.disabled = true;
    try {
      const data = await api.refresh();
      render(data);
    } catch (e) {
      console.warn("Refresh failed:", e);
    } finally {
      btn.textContent = "Refresh";
      btn.disabled = false;
    }
  });

  // Period selector (This month / 7 days / Today)
  qsa("[data-period]").forEach((btn) => {
    btn.addEventListener("click", () => {
      qsa("[data-period]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentPeriod = btn.dataset.period;
      if (summaryData) render(summaryData);
    });
  });

  // Chart view dropdown toggle (Daily vs Hourly)
  $("chartPeriodSelect")?.addEventListener("change", (e) => {
    currentChartMode = e.target.value;
    if (summaryData) renderUsageOverTimeChart(summaryData);
  });

  // Usage Refresh button (in topbar)
  $("btnRefreshUsage")?.addEventListener("click", async () => {
    const btn = $("btnRefreshUsage");
    btn.classList.add("spinning");
    try {
      const data = await api.refresh();
      render(data);
    } catch (e) {
      console.warn("Refresh failed:", e);
    } finally {
      setTimeout(() => btn.classList.remove("spinning"), 600);
    }
  });

  // Export CSV button
  $("btnExportCsv")?.addEventListener("click", () => {
    if (!summaryData?.allTime?.months) return;
    const header = "Month,Period,Download (GB),Upload (GB),Total (GB),Share\n";
    const rows = summaryData.allTime.months.map(m => {
      return `"${m.monthLabel}","${m.name}",${(m.down/G).toFixed(2)},${(m.up/G).toFixed(2)},${(m.total/G).toFixed(2)},${m.percent}%`;
    }).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tally-monthly-history.csv";
    a.click();
    URL.revokeObjectURL(url);
  });

  // Polling loop
  async function poll() {
    if (!connected) return;
    try {
      const d = await api.getSummary();
      render(d);
    } catch (e) {
      console.warn("Poll tick failed:", e);
    }
  }

  // Initial load
  poll();
  setInterval(poll, 6000);

  // Listen to IPC updates if Electron
  if (window.electronAPI?.onSummaryUpdate) {
    window.electronAPI.onSummaryUpdate((data) => {
      render(data);
    });
  }
})();
