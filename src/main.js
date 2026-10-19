import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, nativeTheme, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DataEngine } from "./backend/engine.js";
import { initVault } from "./backend/vault.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const appPath = app.getAppPath();
const isPackaged = app.isPackaged;

// User data (config.json and usage.jsonl) is stored in app.getPath("userData")
const dataDir = app.getPath("userData");

// Ensure writable data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Seed config.json and usage.jsonl into dataDir if missing
const userConfig = path.join(dataDir, "config.json");
const rootConfig = path.join(ROOT_DIR, "config.json");
const bundledConfig = path.join(appPath, "config.json");
if (!fs.existsSync(userConfig)) {
  const source = fs.existsSync(rootConfig) ? rootConfig : (fs.existsSync(bundledConfig) ? bundledConfig : null);
  if (source) {
    try {
      fs.copyFileSync(source, userConfig);
    } catch (e) {
      console.warn("Could not copy initial config.json:", e);
    }
  }
}

const userUsage = path.join(dataDir, "usage.jsonl");
const rootUsage = path.join(ROOT_DIR, "usage.jsonl");
const bundledUsage = path.join(appPath, "usage.jsonl");
if (!fs.existsSync(userUsage)) {
  const source = fs.existsSync(rootUsage) ? rootUsage : (fs.existsSync(bundledUsage) ? bundledUsage : null);
  if (source) {
    try {
      fs.copyFileSync(source, userUsage);
    } catch (e) {
      console.warn("Could not copy initial usage.jsonl:", e);
    }
  }
}

let mainWindow = null;
let tray = null;
let engine = null;
let isQuitting = false;
let notifiedThisMonth = null;
let lastNotifiedDay = null;

function formatGb(mb, gbBase = 1024) {
  if (mb == null) return "0.0 GB";
  const gb = mb / gbBase;
  return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
}

function createMainWindow() {
  const iconPath = path.join(app.getAppPath(), "assets", "icon.png");

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 680,
    minWidth: 840,
    minHeight: 580,
    title: "Tally",
    icon: iconPath,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#171713" : "#F4F3EE",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("close", (e) => {
    if (!isQuitting && engine?.config?.showMenuBar !== false) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function updateTray(summary) {
  if (!tray || !summary) return;

  const totalMb = summary.month?.total || 0;
  const gbText = formatGb(totalMb, summary.mbPerGb || 1024);

  if (engine?.config?.showMenuBar !== false) {
    tray.setTitle(` ${gbText}`);
  } else {
    tray.setTitle("");
  }

  const sp = summary.speed || {};
  const spDown = sp.down ? `${sp.down >= 1000 ? (sp.down / 1000).toFixed(1) + " Mb/s" : sp.down + " kb/s"}` : "0 kb/s";
  const spUp = sp.up ? `${sp.up >= 1000 ? (sp.up / 1000).toFixed(1) + " Mb/s" : sp.up + " kb/s"}` : "0 kb/s";
  const onlineCount = (summary.devices || []).filter((d) => d.online).length;

  const contextMenu = Menu.buildFromTemplate([
    { label: `Tally: ${gbText} this month`, enabled: false },
    { label: `Speed: ${spDown} ↓ / ${spUp} ↑`, enabled: false },
    { label: `Devices: ${onlineCount} online`, enabled: false },
    { type: "separator" },
    {
      label: "Open Tally",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: "Settings",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.executeJavaScript(`document.querySelector('[data-go="settings"]')?.click()`);
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit Tally",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip(`Tally: ${gbText} used`);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  const iconPath = path.join(app.getAppPath(), "assets", "trayTemplate.png");
  let trayIcon = nativeImage.createFromPath(iconPath);
  trayIcon.setTemplateImage(true);

  tray = new Tray(trayIcon);
  tray.setTitle(" Loading…");

  tray.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

function checkThresholdAlert(summary) {
  if (!summary) return;
  const mbPerGb = summary.mbPerGb || 1024;
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const todayKey = `${currentMonthKey}-${String(now.getDate()).padStart(2, "0")}`;

  // Monthly threshold alert
  if (summary.planGb && summary.month) {
    const planMb = summary.planGb * mbPerGb;
    const warnPct = summary.config?.warnPercent || 80;
    const currentPct = (summary.month.total / planMb) * 100;

    if (currentPct >= warnPct && notifiedThisMonth !== currentMonthKey) {
      notifiedThisMonth = currentMonthKey;
      if (Notification.isSupported()) {
        new Notification({
          title: "Tally Monthly Usage Alert",
          body: `You have reached ${currentPct.toFixed(0)}% of your ${summary.planGb} GB plan (${formatGb(summary.month.total, mbPerGb)} used).`,
          icon: path.join(app.getAppPath(), "assets", "icon.png"),
        }).show();
      }
    }
  }

  // Daily threshold alert
  const dailyLimitGb = Number(summary.config?.dailyLimitGb);
  const todayMeasuredMb = (summary.measured?.today?.down || 0) + (summary.measured?.today?.up || 0);
  const todayGb = todayMeasuredMb / mbPerGb;

  if (dailyLimitGb > 0 && todayGb >= dailyLimitGb && lastNotifiedDay !== todayKey) {
    lastNotifiedDay = todayKey;
    if (Notification.isSupported()) {
      new Notification({
        title: "Tally Daily Usage Alert",
        body: `You have used ${todayGb.toFixed(1)} GB today, reaching your ${dailyLimitGb} GB daily threshold.`,
        icon: path.join(app.getAppPath(), "assets", "icon.png"),
      }).show();
    }
  }
}

// IPC Handlers
ipcMain.handle("get-summary", async () => {
  return engine.getSummary();
});

ipcMain.handle("set-device-nickname", async (_event, { mac, nickname }) => {
  engine.setDeviceNickname(mac, nickname);
  return engine.getSummary();
});

ipcMain.handle("block-device", async (_event, { mac, name }) => {
  return await engine.blockDevice(mac, name);
});

ipcMain.handle("unblock-device", async (_event, { mac, name }) => {
  return await engine.unblockDevice(mac, name);
});

ipcMain.handle("unblock-all", async () => {
  return await engine.unblockAll();
});

ipcMain.handle("set-device-limit", async (_event, { mac, limitGb, autoBlock }) => {
  engine.setDeviceLimit(mac, limitGb, autoBlock);
  return engine.getSummary();
});

ipcMain.handle("save-config", async (_event, newConfig) => {
  engine.saveConfig(newConfig);
  if (typeof newConfig.openAtLogin === "boolean") {
    app.setLoginItemSettings({ openAtLogin: newConfig.openAtLogin });
  }
  updateTray(engine.getSummary());
  return true;
});

ipcMain.handle("disconnect", async () => {
  engine.disconnect();
  updateTray(engine.getSummary());
  return true;
});

ipcMain.handle("connect-router", async (_event, creds) => {
  try {
    const summary = await engine.connect(creds);
    updateTray(summary);
    return summary;
  } catch (err) {
    updateTray(engine.getSummary());
    return {
      connected: false,
      lastError: err.message || "Failed to connect to router",
    };
  }
});

ipcMain.handle("test-connection", async (_event, creds) => {
  return await engine.testConnection(creds);
});

ipcMain.handle("refresh-now", async () => {
  try {
    return await engine.step();
  } catch (err) {
    return engine.getSummary();
  }
});

ipcMain.handle("quit-app", () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle("minimize-window", () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle("close-window", () => {
  if (mainWindow) mainWindow.close();
});

// App Lifecycle
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const iconPath = path.join(app.getAppPath(), "assets", "icon.png");
    if (process.platform === "darwin" && app.dock && fs.existsSync(iconPath)) {
      try {
        app.dock.setIcon(iconPath);
      } catch (e) {
        console.warn("Could not set dock icon:", e);
      }
    }

    // Initialize macOS Keychain vault before creating DataEngine
    initVault(safeStorage);

    engine = new DataEngine(dataDir);

    createTray();
    createMainWindow();

    engine.on("update", (summary) => {
      updateTray(summary);
      checkThresholdAlert(summary);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("summary-update", summary);
      }
    });

    engine.on("device-joined", (device) => {
      if (engine?.config?.notifyNewDevice !== false && Notification.isSupported()) {
        new Notification({
          title: "New Device Connected",
          body: `"${device.name || "Unknown Device"}" (${device.mac || device.ip}) joined your network.`,
          icon: path.join(app.getAppPath(), "assets", "icon.png"),
        }).show();
      }
    });

    engine.on("router-offline", (info) => {
      if (engine?.config?.notifyOffline !== false && Notification.isSupported()) {
        new Notification({
          title: "Router Offline",
          body: `Lost connection to router at ${info.host}. ${info.error || ""}`,
          icon: path.join(app.getAppPath(), "assets", "icon.png"),
        }).show();
      }
    });

    engine.on("login-lockout", (msg) => {
      if (Notification.isSupported()) {
        new Notification({
          title: "Tally Login Paused",
          body: msg || "Polling paused to prevent router lockout. Please check password in Settings.",
          icon: path.join(app.getAppPath(), "assets", "icon.png"),
        }).show();
      }
    });

    // Rule 7: Soft limit notification - offer Block button and link to devices
    engine.on("device-limit-reached", (info) => {
      if (Notification.isSupported()) {
        new Notification({
          title: "Device Data Limit Reached (Estimated)",
          body: `"${info.name}" (${info.mac}) reached ${info.estimatedGb} GB (limit: ${info.limitGb} GB). Click to view in Devices and choose to block.`,
          icon: path.join(app.getAppPath(), "assets", "icon.png"),
        }).show();
      }
    });

    // Rule 7: Auto-block notification when enabled by user
    engine.on("device-auto-blocked", (info) => {
      if (Notification.isSupported()) {
        new Notification({
          title: "Device Auto-Blocked (Estimated Limit)",
          body: `"${info.name}" (${info.mac}) reached ${info.estimatedGb} GB (limit: ${info.limitGb} GB) and was automatically blocked.`,
          icon: path.join(app.getAppPath(), "assets", "icon.png"),
        }).show();
      }
    });

    // Rule 4: Scheduled auto-unblock notification
    engine.on("auto-unblock-triggered", (info) => {
      if (Notification.isSupported()) {
        new Notification({
          title: "Scheduled Auto-Unblock",
          body: `All devices have been unblocked according to your ${info.schedule} reset schedule.`,
          icon: path.join(app.getAppPath(), "assets", "icon.png"),
        }).show();
      }
    });

    engine.start();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      } else if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (engine) engine.stop();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
