import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initVault, isEncryptionAvailable, encryptString, decryptString } from "../src/backend/vault.js";
import { DataEngine } from "../src/backend/engine.js";

test("Vault: handles encryption availability and fallback gracefully", () => {
  // Before initialization or without electron safeStorage
  assert.equal(isEncryptionAvailable(), false);
  assert.equal(encryptString("secret"), null);
  assert.equal(decryptString("invalid"), null);

  // Mock safeStorage initialization
  const mockSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (str) => Buffer.from("enc_" + str),
    decryptString: (buf) => buf.toString().replace(/^enc_/, ""),
  };

  initVault(mockSafeStorage);
  assert.equal(isEncryptionAvailable(), true);

  const cipher = encryptString("my-super-secret-password");
  assert.ok(typeof cipher === "string");
  const decrypted = decryptString(cipher);
  assert.equal(decrypted, "my-super-secret-password");
});

test("Vault: scrubs plain text passwords from config.json on disk", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tally-vault-test-"));

  try {
    const configFile = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        routerHost: "192.168.0.1",
        password: "plaintext_secret_123",
      })
    );

    const mockSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (str) => Buffer.from("mock_enc_" + str),
      decryptString: (buf) => buf.toString().replace(/^mock_enc_/, ""),
    };
    initVault(mockSafeStorage);

    const engine = new DataEngine(tmpDir);

    // Verify engine loaded the password in-memory
    assert.equal(engine.password, "plaintext_secret_123");

    // Verify disk config.json had plain password scrubbed and replaced with encryptedPassword
    const onDisk = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(onDisk.password, undefined, "Plaintext password must not remain on disk");
    assert.ok(onDisk.encryptedPassword, "encryptedPassword must be set");

    // Verify getSummary() never leaks the password or encryptedPassword
    const summary = engine.getSummary();
    assert.equal(summary.config.password, undefined);
    assert.equal(summary.config.encryptedPassword, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Vault: aborts login and returns to setup when password decryption fails (Rule 3)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tally-vault-fail-"));

  try {
    const configFile = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        routerHost: "192.168.0.1",
        encryptedPassword: "corrupted_or_inaccessible_keychain_cipher",
      })
    );

    // Mock safeStorage where decryption fails (e.g. signature changed or Keychain locked)
    const mockFailingSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: () => null,
      decryptString: () => null, // Fails!
    };
    initVault(mockFailingSafeStorage);

    const engine = new DataEngine(tmpDir);

    // Engine must NOT fall back to admin or plaintext
    assert.equal(engine.password, null);
    assert.equal(engine.config.disconnected, true);
    assert.equal(engine.connected, false);

    let routerSampleCalled = false;
    engine.router = {
      sample: async () => {
        routerSampleCalled = true;
        return {};
      },
    };

    // Step must not invoke router.sample()
    const summary = await engine.step();
    assert.equal(routerSampleCalled, false);
    assert.equal(summary.connected, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
