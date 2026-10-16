# Tally

Tally is a native macOS data monitor and bandwidth analytics desktop application for 5G and broadband routers. It connects directly to your router to track live speeds, monthly quotas, per-device consumption, and historical usage patterns in real time from your macOS desktop and menu bar.

This repository implements the native desktop app foundation using **Electron + Node.js + Vanilla CSS Tokens + macOS Keychain (`safeStorage`)**.

<img width="1024" alt="Tally macOS App Dashboard" src="assets/tally-dashboard.png" />

---

## Key Features

- **Real-Time Bandwidth & Speed**: Live download and upload telemetry gauges with sub-second polling updates.
- **Hardware Lockout Protection**: Automatically halts connection attempts after a single rejected login to prevent router administrative lockout.
- **macOS Keychain Encryption**: Encrypts router passwords directly in the macOS Keychain via Electron's native `safeStorage` API—never stored in plain text.
- **Custom Device Nicknames**: Assign and persist human-readable names (e.g. *"Jerry's iPhone"*, *"Living Room TV"*) to connected MAC addresses.
- **Smart macOS Notifications**:
  - **New Device Alert**: Instant notification whenever an unknown device connects to your Wi-Fi or LAN.
  - **Daily Usage Threshold**: Configurable limit (e.g. 15 GB) alerting you when today's traffic exceeds your target.
  - **Monthly Quota Warning**: Configurable warning percentage (e.g. 80% of your plan allowance).
  - **Router Offline Alert**: Immediate alert if the router drops offline or becomes unreachable.
- **Quota & Plan Tracking**: Set monthly bundle sizes, calculate burn rates, and view projected end-of-month data usage.
- **Interactive Visualizations**:
  - **Daily Breakdown**: 14-day trailing bar chart comparing download and upload proportions.
  - **Hourly Activity Heatmap**: Visualize traffic spikes across 24-hour periods.
  - **Monthly Distribution**: Clean circular gauge tracking active month vs. all-time usage.
- **Menu Bar Tray Companion**: Compact menu bar item displaying real-time speeds, monthly totals, and quick status.
- **Zero-Hardware Test Fixtures**: Contributor-friendly recorded router API replies with sanitized mock data for offline development and testing.

---

## Prerequisites

- **Operating System**: macOS 11.0 (Big Sur) or newer
- **Runtime**: [Node.js](https://nodejs.org) (v18 or v20 LTS recommended)
- **Supported Hardware**: 5G CPE / Broadband routers with web administrative interfaces (e.g., ZLT X17U series, ZTE, and compatible firmware)

---

## Installation & Setup

### 🖥️ Running in Development

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-username/tally.git
   cd tally
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the application**:
   ```bash
   npm start
   ```

4. **Connect your router**:
   - Enter your router's gateway IP address (default: `192.168.0.1`) and admin password.
   - Click **Connect Router**.

---

### 📦 Building the macOS Standalone App

Install dependencies first with `npm ci`, then select the build that matches
the target Mac.

For Apple Silicon Macs (M1, M2, M3, M4, and newer):

```bash
npm run build:dmg:arm64
```

This produces the native arm64 installer at:

```text
dist/Tally-AppleSilicon-arm64.dmg
```

For Intel Macs:

```bash
npm run build:dmg:x64
```

This produces:

```text
dist/Tally-Intel-x64.dmg
```

Apple Silicon users should install the artifact containing
`AppleSilicon-arm64` in its name. The Intel/x64 build requires Rosetta 2 on an
Apple Silicon Mac. Both build commands verify the packaged executable's CPU
architecture and ad-hoc code signature before creating the DMG. Release builds
are not Apple-notarized, so macOS may still require the documented Gatekeeper
bypass on first launch.

---

## Security & Privacy

Tally is built with a local-first philosophy and strict security standards:

- **Encrypted Credentials**: Your router password is encrypted with the macOS Keychain using Electron's `safeStorage`. Passwords are scrubbed from disk configurations.
- **Router Lockout Safeguard**: Most router firmware triggers a several-minute lockout after 3 consecutive wrong passwords. Tally immediately halts further polling after 1 authentication error to safeguard your router access.
- **Clean Git Repository**: Sensitive files (`config.json`, `usage.jsonl`), build artifacts (`dist/`), and `.app` bundles are strictly ignored by `.gitignore` and never committed to source control.
- **Zero Telemetry**: All data remains entirely on your machine. No cloud analytics, tracking pixels, or third-party metrics are collected.

---

## Testing with Recorded Fixtures

You do **not** need to own the physical router hardware to contribute or run tests.

Tally includes recorded, sanitized router reply fixtures (`test/fixtures/router_replies.json`) where all sensitive identifiers (IMEI, IMSI, MAC addresses, and session tokens) have been replaced with safe mock values.

Run the automated test suite with Node's built-in test runner:

```bash
npm test
```

---

## Configuration Reference

Settings can be managed anytime in the app's **Settings** screen. For automated setups or testing, copy `config.example.json`:

```bash
cp config.example.json config.json
```

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `routerHost` | `string` | `"192.168.0.1"` | Gateway IP address of the router |
| `username` | `string` | `"admin"` | Administrative login username |
| `planGb` | `number` | `350` | Monthly data allowance in GB |
| `dailyLimitGb` | `number` | `15` | Daily threshold triggering desktop notification |
| `warnPercent` | `number` | `80` | Monthly quota warning percentage |
| `notifyNewDevice` | `boolean` | `true` | Send notification when an unknown device joins |
| `notifyOffline` | `boolean` | `true` | Send notification when router becomes unreachable |
| `showMenuBar` | `boolean` | `true` | Show status in macOS menu bar |
| `openAtLogin` | `boolean` | `false` | Launch automatically on macOS login |
| `pollSeconds` | `number` | `30` | Polling frequency in seconds |
| `gbBase` | `number` | `1024` | 1000 vs. 1024 GB computation standard |

---

## Project Structure

```
├── assets/                  # Icons, brand logos, and menu bar tray assets
│   ├── icon.icns            # macOS app bundle icon
│   ├── icon.png             # Continuous squircle Dock icon
│   ├── tally-dashboard.png  # Application overview screenshot
│   └── trayTemplate*.png    # Menu bar status icons
├── test/
│   ├── fixtures/            # Sanitized router API responses
│   │   └── router_replies.json
│   ├── engine.test.js       # DataEngine & nickname unit tests
│   ├── router.test.js       # Router parser & lockout tests
│   └── vault.test.js        # Keychain safeStorage tests
├── src/
│   ├── backend/             # Core monitoring engine
│   │   ├── engine.js        # Polling loops, state cache, JSONL writer
│   │   ├── router.js        # Router HTTP API client & auth session handler
│   │   ├── vault.js         # macOS Keychain safeStorage encryption
│   │   ├── local.js         # macOS local network interface measurement
│   │   └── server.js        # Internal local bridge
│   ├── renderer/            # Frontend dashboard UI
│   │   ├── index.html       # Dashboard, device table & nickname modal
│   │   ├── style.css        # Space Grotesk tokens & dark/light styling
│   │   └── app.js           # Chart rendering, IPC bridge, reactive views
│   ├── main.js              # Electron lifecycle, window & notifications
│   └── preload.cjs          # Secure IPC context bridge
├── CONTRIBUTING.md          # Contribution guidelines
├── SECURITY.md              # Security policy & vulnerability reporting
├── package.json
├── config.example.json
└── README.md
```

---

## Contributing & Support

- Check [CONTRIBUTING.md](CONTRIBUTING.md) for branch workflows and development setup.
- Review [SECURITY.md](SECURITY.md) for vulnerability reporting and credential security.
- To request features or report bugs, use our GitHub [Issue Templates](.github/ISSUE_TEMPLATE/).

---

## License

Distributed under the [MIT License](LICENSE).
