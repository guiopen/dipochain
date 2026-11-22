import { ethers, Signer } from "ethers";
import { VcCore, VerifiableCredential } from "./types";

const EIP712_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Anchor: [
    { name: "issuerId", type: "bytes32" },
    { name: "root", type: "bytes32" },
    { name: "count", type: "uint32" },
    { name: "schemaId", type: "bytes32" },
    { name: "keyId", type: "bytes32" },
    { name: "nonce", type: "uint256" }
  ],
  Revoke: [
    { name: "issuerId", type: "bytes32" },
    { name: "leafHash", type: "bytes32" },
    { name: "reason", type: "uint8" },
    { name: "keyId", type: "bytes32" },
    { name: "nonce", type: "uint256" }
  ],
  RotateKey: [
    { name: "issuerId", type: "bytes32" },
    { name: "oldKeyId", type: "bytes32" },
    { name: "newKeyId", type: "bytes32" },
    { name: "newSigner", type: "address" },
    { name: "nonce", type: "uint256" }
  ],
  ReportCompromise: [
    { name: "issuerId", type: "bytes32" },
    { name: "keyId", type: "bytes32" },
    { name: "estimatedTime", type: "uint64" },
    { name: "nonce", type: "uint256" }
  ]
};

function signTyped(
  contractAddress: string,
  chainId: number,
  signer: Signer,
  typeName: string,
  value: Record<string, unknown>
): Promise<string> {
  return signer.signTypedData(
    { name: "DiploChain", version: "1", chainId, verifyingContract: contractAddress },
    { [typeName]: EIP712_TYPES[typeName] },
    value
  );
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
      .join(",") +
    "}"
  );
}

export function stripEnvelope(vc: VerifiableCredential): VcCore {
  const { proof: _p, anchorReference: _a, ...core } = vc;
  return core;
}

export function generateSalt(): string {
  return ethers.hexlify(ethers.randomBytes(16));
}

export function computeIssuerId(did: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(did));
}

export function computeKeyId(verificationMethod: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(verificationMethod));
}

export function computeLeafHash(core: VcCore): string {
  return ethers.keccak256(ethers.concat([core.salt, ethers.toUtf8Bytes(canonicalize(core))]));
}

export function hashPair(a: string, b: string): string {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([left, right]));
}

export function buildMerkleTree(leaves: string[]): { root: string; proofs: string[][] } {
  if (leaves.length === 0) throw new Error("Cannot build Merkle tree with zero leaves");
  const levels: string[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    }
    levels.push(next);
  }
  const proofs = leaves.map((_, start) => {
    const proof: string[] = [];
    let idx = start;
    for (let l = 0; l < levels.length - 1; l++) {
      const layer = levels[l];
      if (idx % 2 === 0 && idx + 1 < layer.length) proof.push(layer[idx + 1]);
      else if (idx % 2 === 1) proof.push(layer[idx - 1]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  });
  return { root: levels[levels.length - 1][0], proofs };
}

export function verifyMerkleProof(leaf: string, proof: string[], root: string): boolean {
  return proof.reduce((acc, sibling) => hashPair(acc, sibling), leaf).toLowerCase() === root.toLowerCase();
}

export function signVcCore(core: VcCore, signer: Signer): Promise<string> {
  return signer.signMessage(canonicalize(core));
}

export function signAnchorTypedData(
  contractAddress: string,
  chainId: number,
  signer: Signer,
  issuerId: string,
  root: string,
  count: number,
  schemaId: string,
  keyId: string,
  nonce: bigint
): Promise<string> {
  return signTyped(contractAddress, chainId, signer, "Anchor", { issuerId, root, count, schemaId, keyId, nonce });
}

export function signRevokeTypedData(
  contractAddress: string,
  chainId: number,
  signer: Signer,
  issuerId: string,
  leafHash: string,
  reason: number,
  keyId: string,
  nonce: bigint
): Promise<string> {
  return signTyped(contractAddress, chainId, signer, "Revoke", { issuerId, leafHash, reason, keyId, nonce });
}

export function signRotateKeyTypedData(
  contractAddress: string,
  chainId: number,
  signer: Signer,
  issuerId: string,
  oldKeyId: string,
  newKeyId: string,
  newSigner: string,
  nonce: bigint
): Promise<string> {
  return signTyped(contractAddress, chainId, signer, "RotateKey", { issuerId, oldKeyId, newKeyId, newSigner, nonce });
}

export function signCompromiseTypedData(
  contractAddress: string,
  chainId: number,
  recoverySigner: Signer,
  issuerId: string,
  keyId: string,
  estimatedTime: number,
  nonce: bigint
): Promise<string> {
  return signTyped(contractAddress, chainId, recoverySigner, "ReportCompromise", {
    issuerId,
    keyId,
    estimatedTime,
    nonce
  });
}

export function encodeVcToUrlParam(vc: VerifiableCredential): string {
  return ethers
    .encodeBase64(ethers.toUtf8Bytes(JSON.stringify(vc)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeVcFromUrlParam(encoded: string): VerifiableCredential {
  const pad = encoded.length % 4 === 0 ? "" : "=".repeat(4 - (encoded.length % 4));
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return JSON.parse(ethers.toUtf8String(ethers.decodeBase64(b64))) as VerifiableCredential;
}
