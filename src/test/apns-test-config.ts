import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * APNs configuration for tests that build a real composition root (#891).
 *
 * The composition resolves the credential eagerly and refuses to start without
 * it, which is the point: a push path that starts unconfigured would claim
 * every moment and send nothing. Tests that compose the worker or a publish
 * entry point therefore have to supply one, the same as a deployment does.
 *
 * The key is generated per process and thrown away. Apple's real `.p8` is a
 * credential and never appears in this repository, in a fixture, or in a log.
 */

const NAMES = [
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_BUNDLE_ID",
  "APNS_AUTH_KEY_PATH",
] as const;

let keyPath: string | undefined;

export function configureApnsTestEnv(): void {
  if (!keyPath) {
    keyPath = join(tmpdir(), `snaplist-apns-test-${process.pid}.p8`);
    writeFileSync(
      keyPath,
      generateKeyPairSync("ec", { namedCurve: "P-256" })
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
    );
  }
  process.env.APNS_KEY_ID = "TEST_KEY_ID";
  process.env.APNS_TEAM_ID = "TEST_TEAM_ID";
  process.env.APNS_BUNDLE_ID = "com.snaplist.app.test";
  process.env.APNS_AUTH_KEY_PATH = keyPath;
}

export function clearApnsTestEnv(): void {
  for (const name of NAMES) delete process.env[name];
}
