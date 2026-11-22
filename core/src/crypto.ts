import { ethers, Signer } from "ethers";
import { VcCore, VerifiableCredential } from "./types";

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
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
  const canonical = canonicalize(core);
  return ethers.keccak256(ethers.concat([core.salt, ethers.toUtf8Bytes(canonical)]));
}

export function hashPair(a: string, b: string): string {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([left, right]));
}

export function buildMerkleTree(leaves: string[]): { root: string; proofs: string[][] } {
  if (leaves.length === 0) {
    throw new Error("Cannot build Merkle tree with zero leaves");
  }
  const levels: string[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashPair(current[i], current[i + 1]));
      } else {
        next.push(current[i]);
      }
    }
    levels.push(next);
  }
  const root = levels[levels.length - 1][0];
  const proofs = leaves.map((_, startIdx) => {
    const proof: string[] = [];
    let idx = startIdx;
    for (let lvl = 0; lvl < levels.length - 1; lvl++) {
      const layer = levels[lvl];
      if (idx % 2 === 0) {
        if (idx + 1 < layer.length) {
          proof.push(layer[idx + 1]);
        }
      } else {
        proof.push(layer[idx - 1]);
      }
      idx = Math.floor(idx / 2);
    }
    return proof;
  });
  return { root, proofs };
}

export function verifyMerkleProof(leaf: string, proof: string[], root: string): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed = hashPair(computed, sibling);
  }
  return computed.toLowerCase() === root.toLowerCase();
}

export async function signVcCore(core: VcCore, signer: Signer): Promise<string> {
  return signer.signMessage(canonicalize(core));
}

export async function signAnchorTypedData(
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
  return signer.signTypedData(
    { name: "DiploChain", version: "1", chainId, verifyingContract: contractAddress },
    {
      Anchor: [
        { name: "issuerId", type: "bytes32" },
        { name: "root", type: "bytes32" },
        { name: "count", type: "uint32" },
        { name: "schemaId", type: "bytes32" },
        { name: "keyId", type: "bytes32" },
        { name: "nonce", type: "uint256" }
      ]
    },
    { issuerId, root, count, schemaId, keyId, nonce }
  );
}

export async function signRevokeTypedData(
  contractAddress: string,
  chainId: number,
  signer: Signer,
  issuerId: string,
  leafHash: string,
  reason: number,
  keyId: string,
  nonce: bigint
): Promise<string> {
  return signer.signTypedData(
    { name: "DiploChain", version: "1", chainId, verifyingContract: contractAddress },
    {
      Revoke: [
        { name: "issuerId", type: "bytes32" },
        { name: "leafHash", type: "bytes32" },
        { name: "reason", type: "uint8" },
        { name: "keyId", type: "bytes32" },
        { name: "nonce", type: "uint256" }
      ]
    },
    { issuerId, leafHash, reason, keyId, nonce }
  );
}

export async function signRotateKeyTypedData(
  contractAddress: string,
  chainId: number,
  signer: Signer,
  issuerId: string,
  oldKeyId: string,
  newKeyId: string,
  newSigner: string,
  nonce: bigint
): Promise<string> {
  return signer.signTypedData(
    { name: "DiploChain", version: "1", chainId, verifyingContract: contractAddress },
    {
      RotateKey: [
        { name: "issuerId", type: "bytes32" },
        { name: "oldKeyId", type: "bytes32" },
        { name: "newKeyId", type: "bytes32" },
        { name: "newSigner", type: "address" },
        { name: "nonce", type: "uint256" }
      ]
    },
    { issuerId, oldKeyId, newKeyId, newSigner, nonce }
  );
}

export async function signCompromiseTypedData(
  contractAddress: string,
  chainId: number,
  recoverySigner: Signer,
  issuerId: string,
  keyId: string,
  estimatedTime: number,
  nonce: bigint
): Promise<string> {
  return recoverySigner.signTypedData(
    { name: "DiploChain", version: "1", chainId, verifyingContract: contractAddress },
    {
      ReportCompromise: [
        { name: "issuerId", type: "bytes32" },
        { name: "keyId", type: "bytes32" },
        { name: "estimatedTime", type: "uint64" },
        { name: "nonce", type: "uint256" }
      ]
    },
    { issuerId, keyId, estimatedTime, nonce }
  );
}

export function encodeVcToUrlParam(vc: VerifiableCredential): string {
  const b64 = ethers.encodeBase64(ethers.toUtf8Bytes(JSON.stringify(vc)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeVcFromUrlParam(encoded: string): VerifiableCredential {
  const pad = encoded.length % 4 === 0 ? "" : "=".repeat(4 - (encoded.length % 4));
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const json = ethers.toUtf8String(ethers.decodeBase64(b64));
  return JSON.parse(json) as VerifiableCredential;
}
