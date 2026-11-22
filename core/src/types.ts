export interface VcCore {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  validFrom: string;
  validUntil?: string;
  credentialSubject: {
    id: string;
    name: string;
    course: string;
    workloadHours: number;
  };
  salt: string;
}

export interface VerifiableCredential extends VcCore {
  proof: {
    type: string;
    verificationMethod: string;
    proofPurpose: string;
    proofValue: string;
  };
  anchorReference: {
    chainId: number;
    anchorRegistry: string;
    merkleRoot: string;
    merkleProof: string[];
    txHash: string;
  };
}

export type VerificationVerdict =
  | "VALID"
  | "VALID - ISSUER CLOSED"
  | "REVOKED"
  | "ISSUER SUSPENDED"
  | "ISSUED AFTER KEY COMPROMISE - UNDER REVIEW"
  | "INVALID SIGNATURE"
  | "TAMPERED"
  | "ISSUER NOT REGISTERED"
  | "ANCHOR NOT FOUND"
  | "EXPIRED";

export interface VerificationResult {
  verdict: VerificationVerdict;
  leafHash: string;
  verificationTimeMs: number;
  dimensions: {
    authenticity: {
      valid: boolean;
      signatureValid: boolean;
      merkleValid: boolean;
      anchorFound: boolean;
      anchorTimestamp: number | null;
      txHash: string;
      summary: string;
    };
    issuerLegitimacy: {
      valid: boolean;
      issuerDid: string;
      assuranceLevel: string;
      status: string;
      keySigner: string | null;
      summary: string;
    };
    academicValidity: {
      summary: string;
    };
    revocation: {
      valid: boolean;
      revoked: boolean;
      reason: string;
      revokedAt: number | null;
      expired: boolean;
      summary: string;
    };
  };
}

export const ISSUER_STATUS_LABELS: Record<number, string> = {
  0: "Pending",
  1: "Active",
  2: "Suspended",
  3: "Closed"
};

export const ASSURANCE_LEVEL_LABELS: Record<number, string> = {
  0: "None",
  1: "L1 (Verified Legal Entity & Domain)",
  2: "L2 (Accredited Institution)"
};

export const REVOCATION_REASON_LABELS: Record<number, string> = {
  0: "None",
  1: "AdminError",
  2: "IssuerError",
  3: "Fraud",
  4: "Superseded"
};

export const DIPLOCHAIN_ABI = [
  "function governance() view returns (address)",
  "function getIssuerIds() view returns (bytes32[])",
  "function getIssuerKeyIds(bytes32 issuerId) view returns (bytes32[])",
  "function issuers(bytes32 issuerId) view returns (string did, uint8 assuranceLevel, uint8 status, address recoverySigner, uint64 closedAt, bool exists)",
  "function issuerKeys(bytes32 issuerId, bytes32 keyId) view returns (address signer, uint64 validFrom, uint64 validUntil, uint64 compromisedAt, bool exists)",
  "function anchors(bytes32 root) view returns (bytes32 issuerId, uint64 blockTimestamp, uint32 count, bytes32 schemaId, bytes32 keyId, bool exists)",
  "function revocations(bytes32 issuerId, bytes32 leafHash) view returns (uint64 revokedAt, uint8 reason, bool exists)",
  "function nonces(bytes32 issuerId) view returns (uint256)",
  "function registerIssuer(string did, uint8 assuranceLevel, address recoverySigner, bytes32 initialKeyId, address initialSigner) returns (bytes32)",
  "function setIssuerStatus(bytes32 issuerId, uint8 newStatus)",
  "function rotateKey(bytes32 issuerId, bytes32 oldKeyId, bytes32 newKeyId, address newSigner, uint256 nonce, bytes issuerSig)",
  "function anchor(bytes32 issuerId, bytes32 root, uint32 count, bytes32 schemaId, bytes32 keyId, uint256 nonce, bytes issuerSig)",
  "function revoke(bytes32 issuerId, bytes32 leafHash, uint8 reason, bytes32 keyId, uint256 nonce, bytes issuerSig)",
  "function reportCompromise(bytes32 issuerId, bytes32 keyId, uint64 estimatedTime, uint256 nonce, bytes recoverySig)"
];
