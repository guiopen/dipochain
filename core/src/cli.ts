import * as fs from "node:fs";
import { verifyCredentialOnChain } from "./verifier";
import { VerifiableCredential } from "./types";

async function main() {
  const args = process.argv.slice(2);
  const filePath = args.find((a) => !a.startsWith("--"));
  const rpcIdx = args.indexOf("--rpc");
  const contractIdx = args.indexOf("--contract");

  if (!filePath) {
    console.error("Usage: npm run verify -- <path-to-vc.json> [--rpc <url>] [--contract <address>]");
    process.exit(1);
  }

  const rpcUrl = rpcIdx !== -1 && args[rpcIdx + 1] ? args[rpcIdx + 1] : "http://127.0.0.1:8545";
  const contractOverride = contractIdx !== -1 ? args[contractIdx + 1] : undefined;

  const raw = fs.readFileSync(filePath, "utf8");
  const vc = JSON.parse(raw) as VerifiableCredential;

  const result = await verifyCredentialOnChain(vc, rpcUrl, contractOverride);

  console.log("\n=== DiploChain Independent CLI Verifier (S3) ===");
  console.log(`Verdict:           ${result.verdict}`);
  console.log(`Verification Time: ${result.verificationTimeMs} ms`);
  console.log(`Leaf Hash:         ${result.leafHash}`);
  console.log("\n--- 4 Verification Dimensions ---");
  console.log(`1. Authenticity:      [${result.dimensions.authenticity.valid ? "OK" : "FAIL"}] ${result.dimensions.authenticity.summary}`);
  console.log(`2. Issuer Legitimacy: [${result.dimensions.issuerLegitimacy.valid ? "OK" : "FAIL"}] ${result.dimensions.issuerLegitimacy.summary}`);
  console.log(`3. Academic Validity: [INFO] ${result.dimensions.academicValidity.summary}`);
  console.log(`4. Revocation/Status: [${result.dimensions.revocation.valid ? "OK" : "FAIL"}] ${result.dimensions.revocation.summary}`);
  console.log("");

  if (result.verdict !== "VALID" && result.verdict !== "VALID - ISSUER CLOSED") {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error("Verification error:", err.message || err);
  process.exit(1);
});
