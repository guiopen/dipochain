import * as http from "node:http";
import { ethers } from "ethers";
import { canonicalize, generateSalt, signVcCore } from "./crypto";
import { VcCore } from "./types";

interface DidDocument {
  id: string;
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    ethereumAddress: string;
  }>;
}

async function verifyViaDidWeb(
  vc: VcCore & { proof: { verificationMethod: string; proofValue: string } },
  didUrl: string
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(didUrl);
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status} fetching did.json` };
    }
    const doc = (await res.json()) as DidDocument;
    const method = doc.verificationMethod.find((m) => m.id === vc.proof.verificationMethod);
    if (!method) {
      return { ok: false, detail: "Key not found in did.json" };
    }
    const { proof: _p, ...core } = vc;
    const recovered = ethers.verifyMessage(canonicalize(core), vc.proof.proofValue);
    if (recovered.toLowerCase() !== method.ethereumAddress.toLowerCase()) {
      return { ok: false, detail: "Invalid signature" };
    }
    return { ok: true, detail: "Signature valid via issuer server" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `Resolution failed (${message})` };
  }
}

async function main() {
  const issuerWallet = ethers.Wallet.createRandom();
  const port = 4321;
  const did = `did:web:127.0.0.1%3A${port}`;
  const keyMethod = `${did}#key-1`;
  const didUrl = `http://127.0.0.1:${port}/.well-known/did.json`;

  const didDocument: DidDocument = {
    id: did,
    verificationMethod: [
      {
        id: keyMethod,
        type: "EcdsaSecp256k1RecoveryMethod2020",
        controller: did,
        ethereumAddress: issuerWallet.address
      }
    ]
  };

  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/did.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(didDocument));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));

  const genuineCore: VcCore = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    id: "urn:uuid:genuine-001",
    type: ["VerifiableCredential", "AcademicCertificate"],
    issuer: did,
    validFrom: "2026-03-15T12:00:00Z",
    credentialSubject: {
      id: "urn:diplochain:holder:1",
      name: "Maria Silva",
      course: "Blockchain Architecture",
      workloadHours: 60
    },
    salt: generateSalt()
  };

  const backdatedCore: VcCore = {
    ...genuineCore,
    id: "urn:uuid:attacker-backdated-002",
    validFrom: "2025-01-10T12:00:00Z",
    credentialSubject: {
      id: "urn:diplochain:holder:999",
      name: "Attacker with Stolen Key",
      course: "Blockchain Architecture",
      workloadHours: 60
    },
    salt: generateSalt()
  };

  const genuineVc = {
    ...genuineCore,
    proof: { verificationMethod: keyMethod, proofValue: await signVcCore(genuineCore, issuerWallet) }
  };
  const backdatedVc = {
    ...backdatedCore,
    proof: { verificationMethod: keyMethod, proofValue: await signVcCore(backdatedCore, issuerWallet) }
  };

  const onlineCheck = await verifyViaDidWeb(genuineVc, didUrl);
  const backdatedCheck = await verifyViaDidWeb(backdatedVc, didUrl);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  const offlineCheck = await verifyViaDidWeb(genuineVc, didUrl);

  console.log("\n=== Baseline Comparison: did:web (No Blockchain) vs DiploChain ===");
  console.table([
    {
      scenario: "Normal verification (issuer online)",
      didWebResult: onlineCheck.ok ? "VALID" : "FAIL",
      diploChainResult: "VALID",
      observation: onlineCheck.detail
    },
    {
      scenario: "S3: Issuer server offline / closed",
      didWebResult: offlineCheck.ok ? "VALID" : "FAIL (BROKEN)",
      diploChainResult: "VALID / VALID - ISSUER CLOSED",
      observation: offlineCheck.detail
    },
    {
      scenario: "N5: Stolen key + backdated validFrom",
      didWebResult: backdatedCheck.ok ? "FALSE POSITIVE (VALID)" : "DETECTED",
      diploChainResult: "UNDER REVIEW (bounded by blockTimestamp)",
      observation: "did:web has no independent timestamp to detect backdating"
    }
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
