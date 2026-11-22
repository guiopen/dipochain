import { ethers } from "ethers";
import {
  ASSURANCE_LEVEL_LABELS,
  DIPLOCHAIN_ABI,
  ISSUER_STATUS_LABELS,
  REVOCATION_REASON_LABELS,
  VerifiableCredential,
  VerificationResult,
  VerificationVerdict
} from "./types";
import {
  canonicalize,
  computeIssuerId,
  computeKeyId,
  computeLeafHash,
  stripEnvelope,
  verifyMerkleProof
} from "./crypto";

export async function verifyCredentialOnChain(
  vc: VerifiableCredential,
  rpcUrl: string,
  contractAddressOverride?: string
): Promise<VerificationResult> {
  const started = performance.now();
  const core = stripEnvelope(vc);
  const canonical = canonicalize(core);
  const leafHash = computeLeafHash(core);

  const issuerId = computeIssuerId(core.issuer);
  const keyId = computeKeyId(vc.proof.verificationMethod);
  const contractAddress = contractAddressOverride || vc.anchorReference.anchorRegistry;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(contractAddress, DIPLOCHAIN_ABI, provider);

  const [issuer, key, anchor, revocation, latestBlock] = await Promise.all([
    contract.issuers(issuerId),
    contract.issuerKeys(issuerId, keyId),
    contract.anchors(vc.anchorReference.merkleRoot),
    contract.revocations(issuerId, leafHash),
    provider.getBlock("latest")
  ]);

  const nowUnix = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);
  const merkleValid = verifyMerkleProof(leafHash, vc.anchorReference.merkleProof, vc.anchorReference.merkleRoot);

  let recoveredAddress: string | null = null;
  try {
    recoveredAddress = ethers.verifyMessage(canonical, vc.proof.proofValue);
  } catch {
    recoveredAddress = null;
  }

  const issuerExists = Boolean(issuer.exists);
  const keyExists = Boolean(key.exists);
  const issuerStatusNum = Number(issuer.status);
  const issuerStatusLabel = issuerExists ? ISSUER_STATUS_LABELS[issuerStatusNum] || "Unknown" : "Not Registered";
  const assuranceLabel = issuerExists ? ASSURANCE_LEVEL_LABELS[Number(issuer.assuranceLevel)] || "None" : "None";

  const signatureValid =
    keyExists &&
    recoveredAddress !== null &&
    recoveredAddress.toLowerCase() === String(key.signer).toLowerCase();

  const anchorFound = Boolean(anchor.exists) && String(anchor.issuerId).toLowerCase() === issuerId.toLowerCase();
  const anchorTs = anchorFound ? Number(anchor.blockTimestamp) : null;

  const compromisedAt = keyExists ? Number(key.compromisedAt) : 0;
  const validFrom = keyExists ? Number(key.validFrom) : 0;
  const validUntil = keyExists ? Number(key.validUntil) : 0;

  const afterCompromise = anchorTs !== null && compromisedAt !== 0 && anchorTs >= compromisedAt;
  const outsideKeyWindow =
    anchorTs !== null && (anchorTs < validFrom || (validUntil !== 0 && anchorTs >= validUntil));

  const revoked = Boolean(revocation.exists);
  const revocationReason = revoked ? REVOCATION_REASON_LABELS[Number(revocation.reason)] || "Unknown" : "None";
  const revokedAt = revoked ? Number(revocation.revokedAt) : null;
  const expired = Boolean(core.validUntil && Math.floor(new Date(core.validUntil).getTime() / 1000) < nowUnix);

  let verdict: VerificationVerdict = "VALID";
  if (!issuerExists || !keyExists) {
    verdict = "ISSUER NOT REGISTERED";
  } else if (!signatureValid) {
    verdict = !merkleValid ? "TAMPERED" : "INVALID SIGNATURE";
  } else if (!merkleValid) {
    verdict = "TAMPERED";
  } else if (!anchorFound) {
    verdict = "ANCHOR NOT FOUND";
  } else if (afterCompromise) {
    verdict = "ISSUED AFTER KEY COMPROMISE - UNDER REVIEW";
  } else if (outsideKeyWindow) {
    verdict = "INVALID SIGNATURE";
  } else if (revoked) {
    verdict = "REVOKED";
  } else if (expired) {
    verdict = "EXPIRED";
  } else if (issuerStatusNum === 2) {
    verdict = "ISSUER SUSPENDED";
  } else if (issuerStatusNum === 3) {
    verdict = anchorTs !== null && anchorTs <= Number(issuer.closedAt) ? "VALID - ISSUER CLOSED" : "INVALID SIGNATURE";
  } else if (issuerStatusNum !== 1) {
    verdict = "ISSUER NOT REGISTERED";
  }

  const authenticityValid = signatureValid && merkleValid && anchorFound && !afterCompromise && !outsideKeyWindow;
  const issuerLegitimacyValid = issuerExists && keyExists && (issuerStatusNum === 1 || issuerStatusNum === 3);
  const revocationValid = !revoked && !expired;

  const authenticitySummary = !signatureValid || !merkleValid
    ? "Content does not match signature or Merkle proof"
    : !anchorFound
      ? "Merkle root not found on-chain for this issuer"
      : afterCompromise
        ? `Anchored after reported key compromise (${new Date(compromisedAt * 1000).toISOString()})`
        : outsideKeyWindow
          ? "Anchored outside the signing key validity window"
          : `Signature valid and anchored on ${new Date(anchorTs! * 1000).toISOString()}`;

  const legitimacySummary = !issuerExists
    ? "Issuer DID not found in on-chain registry"
    : !keyExists
      ? "Signing key not registered for this issuer"
      : `Registered (${assuranceLabel}) - Status: ${issuerStatusLabel}`;

  const revocationSummary = revoked
    ? `Revoked on ${new Date(revokedAt! * 1000).toISOString()} (Reason: ${revocationReason})`
    : expired
      ? `Credential expired on ${core.validUntil}`
      : "Not revoked and within validity period";

  return {
    verdict,
    leafHash,
    verificationTimeMs: Number((performance.now() - started).toFixed(2)),
    dimensions: {
      authenticity: {
        valid: authenticityValid,
        signatureValid,
        merkleValid,
        anchorFound,
        anchorTimestamp: anchorTs,
        txHash: vc.anchorReference.txHash,
        summary: authenticitySummary
      },
      issuerLegitimacy: {
        valid: issuerLegitimacyValid,
        issuerDid: core.issuer,
        assuranceLevel: assuranceLabel,
        status: issuerStatusLabel,
        keySigner: keyExists ? String(key.signer) : null,
        summary: legitimacySummary
      },
      academicValidity: {
        summary: "Asserted by the issuer"
      },
      revocation: {
        valid: revocationValid,
        revoked,
        reason: revocationReason,
        revokedAt,
        expired,
        summary: revocationSummary
      }
    }
  };
}
