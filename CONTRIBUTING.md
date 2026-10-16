# Contributing to Tally ⚡

Thank you for your interest in improving Tally! Whether you're adding support for a new router model, improving the user interface, or submitting bug fixes, your contributions are welcome.

---

## 🔒 Security & Git Hygiene First

Before committing code or submitting a pull request, **always verify what is in your git status**:

1. **Never commit sensitive files**:
   - `config.json` contains your router credentials and local network settings.
   - `usage.jsonl` contains real hostnames, IP addresses, and hardware MAC addresses.
   - Built binaries (`dist/`, `Tally.app/`) must stay out of the repository.
   
2. **Double check before pushing**:
   ```bash
   git status
   git log --all -- config.json usage.jsonl
   ```
   If either was ever committed, deleting it later does not purge it from git history. Ensure `.gitignore` is respected.

---

## 🧪 Testing Without Hardware (Recorded Fixtures)

You **do not need a physical router** to test or contribute to Tally!

Tally provides recorded, sanitized test fixtures located at:
`test/fixtures/router_replies.json`

All sensitive values (IMEI, IMSI, MAC addresses, and session tokens) have been replaced with fake values.

To run the test suite:
```bash
npm test
```

When adding support for a new router or command:
1. Record real router replies.
2. Scrub all private data (replace real MACs with `02:00:00:00:00:XX`, replace IMEIs with `860000000000000`, etc.).
3. Add the sanitized mock replies to `test/fixtures/`.
4. Add unit test assertions in `test/`.

---

## 🛠️ Development Workflow

1. Fork the repo and clone your fork locally:
   ```bash
   git clone https://github.com/<your-username>/tally.git
   cd tally
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run in development mode:
   ```bash
   npm start
   ```
4. Run tests before submitting:
   ```bash
   npm test
   ```

### Verifying macOS packages

Use the architecture-specific package commands when changing Electron startup,
assets, dependencies, or release automation:

```bash
# Native Apple Silicon (M-series Macs)
npm run build:dmg:arm64

# Intel Macs
npm run build:dmg:x64
```

The commands ad-hoc sign the finished application bundle, then inspect its
signature and packaged executable with macOS `codesign` and `lipo` before
creating the installer. This prevents an Intel application from being
published under an Apple Silicon filename and catches bundle modifications
that invalidate its signature. Pull requests that affect the application or
packaging run both packaging checks in GitHub Actions.

---

## 📋 Reporting Bugs & Feature Requests

When reporting a bug, please use our GitHub Issue templates:
- **Router Model**: Provide the exact brand and model (e.g., ZLT X17U, ZTE MC801A, etc.).
- **Firmware Version**: Check your router's web portal or status tab.
- **macOS Version**: Provide your macOS release (e.g. macOS 14 Sonoma, macOS 15 Sequoia).
- **Sanitized Logs**: Never share screenshots or terminal outputs that contain your administrative password or real WAN IP.
