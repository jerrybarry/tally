import { execFileSync } from "node:child_process";
import path from "node:path";

const [appBundle, expectedArchitecture] = process.argv.slice(2);

if (!appBundle || !expectedArchitecture) {
  console.error("Usage: node scripts/verify-macos-architecture.mjs <app-bundle> <architecture>");
  process.exit(2);
}

const executable = path.join(appBundle, "Contents", "MacOS", "Tally");

let architectures;
try {
  architectures = execFileSync("lipo", ["-archs", executable], { encoding: "utf8" })
    .trim()
    .split(/\s+/);
} catch (error) {
  console.error(`Could not inspect ${executable}: ${error.message}`);
  process.exit(1);
}

if (!architectures.includes(expectedArchitecture)) {
  console.error(
    `Architecture check failed: expected ${expectedArchitecture}, found ${architectures.join(", ") || "none"}.`
  );
  process.exit(1);
}

try {
  execFileSync("codesign", ["--verify", "--deep", "--strict", appBundle], {
    encoding: "utf8",
    stdio: "pipe",
  });
} catch (error) {
  const detail = error.stderr?.trim() || error.message;
  console.error(`Code-signature check failed for ${appBundle}: ${detail}`);
  process.exit(1);
}

console.log(`Verified ${expectedArchitecture} executable: ${executable}`);
console.log(`Verified code signature: ${appBundle}`);
