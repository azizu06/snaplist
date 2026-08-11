import { generateKeyPairSync } from "node:crypto";

export function generateTestPkcs8PrivateKeyPem(
  namedCurve: "P-256" | "P-384" = "P-256",
): string {
  return generateKeyPairSync("ec", { namedCurve }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  }).toString();
}
