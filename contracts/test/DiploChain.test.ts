import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { DiploChain } from "../typechain-types";

interface VcCore {
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

interface VerifiableCredential extends VcCore {
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

function canonicalize(value: unknown): string {
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

function stripEnvelope(vc: VerifiableCredential): VcCore {
  const { proof: _p, anchorReference: _a, ...core } = vc;
  return core;
}

function computeLeafHash(core: VcCore): string {
  const canonical = canonicalize(core);
  return ethers.keccak256(ethers.concat([core.salt, ethers.toUtf8Bytes(canonical)]));
}

function hashPair(a: string, b: string): string {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([left, right]));
}

function buildMerkleTree(leaves: string[]): { root: string; proofs: string[][] } {
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

function verifyMerkleProof(leaf: string, proof: string[], root: string): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed = hashPair(computed, sibling);
  }
  return computed.toLowerCase() === root.toLowerCase();
}

async function signAnchor(
  contractAddress: string,
  chainId: number,
  signer: HardhatEthersSigner,
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

async function signRevoke(
  contractAddress: string,
  chainId: number,
  signer: HardhatEthersSigner,
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

async function signRotateKey(
  contractAddress: string,
  chainId: number,
  signer: HardhatEthersSigner,
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

async function signCompromise(
  contractAddress: string,
  chainId: number,
  recoverySigner: HardhatEthersSigner,
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

async function verifyCredential(contract: DiploChain, vc: VerifiableCredential, nowUnix: number): Promise<string> {
  const core = stripEnvelope(vc);
  const canonical = canonicalize(core);
  const leafHash = computeLeafHash(core);

  const issuerId = ethers.keccak256(ethers.toUtf8Bytes(core.issuer));
  const keyId = ethers.keccak256(ethers.toUtf8Bytes(vc.proof.verificationMethod));

  const issuer = await contract.issuers(issuerId);
  if (!issuer.exists) {
    return "ISSUER NOT REGISTERED";
  }

  const key = await contract.issuerKeys(issuerId, keyId);
  if (!key.exists) {
    return "ISSUER NOT REGISTERED";
  }

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(canonical, vc.proof.proofValue);
  } catch {
    return "INVALID SIGNATURE";
  }

  const merkleMatches = verifyMerkleProof(leafHash, vc.anchorReference.merkleProof, vc.anchorReference.merkleRoot);
  if (recovered.toLowerCase() !== key.signer.toLowerCase()) {
    return !merkleMatches ? "TAMPERED" : "INVALID SIGNATURE";
  }
  if (!merkleMatches) {
    return "TAMPERED";
  }

  const anchor = await contract.anchors(vc.anchorReference.merkleRoot);
  if (!anchor.exists || anchor.issuerId !== issuerId) {
    return "ANCHOR NOT FOUND";
  }

  const anchorTs = Number(anchor.blockTimestamp);
  if (Number(key.compromisedAt) !== 0 && anchorTs >= Number(key.compromisedAt)) {
    return "ISSUED AFTER KEY COMPROMISE - UNDER REVIEW";
  }
  if (anchorTs < Number(key.validFrom) || (Number(key.validUntil) !== 0 && anchorTs >= Number(key.validUntil))) {
    return "INVALID SIGNATURE";
  }

  const revocation = await contract.revocations(issuerId, leafHash);
  if (revocation.exists) {
    return "REVOKED";
  }

  if (core.validUntil && Math.floor(new Date(core.validUntil).getTime() / 1000) < nowUnix) {
    return "EXPIRED";
  }

  if (Number(issuer.status) === 2) {
    return "ISSUER SUSPENDED";
  }

  if (Number(issuer.status) === 3) {
    return anchorTs <= Number(issuer.closedAt) ? "VALID - ISSUER CLOSED" : "INVALID SIGNATURE";
  }

  if (Number(issuer.status) !== 1) {
    return "ISSUER NOT REGISTERED";
  }

  return "VALID";
}

describe("DiploChain PD3 Scenarios", function () {
  const ISSUER_DID = "did:web:extensao.ufsc.br";
  const KEY_METHOD_1 = "did:web:extensao.ufsc.br#key-2026-1";
  const KEY_METHOD_2 = "did:web:extensao.ufsc.br#key-2027-1";
  const SCHEMA_ID = ethers.keccak256(ethers.toUtf8Bytes("AcademicCertificate:v1"));

  let contract: DiploChain;
  let contractAddress: string;
  let chainId: number;
  let governance: HardhatEthersSigner;
  let issuerSigner: HardhatEthersSigner;
  let issuerSigner2: HardhatEthersSigner;
  let recoverySigner: HardhatEthersSigner;
  let relayer: HardhatEthersSigner;
  let rogueSigner: HardhatEthersSigner;
  let issuerId: string;
  let keyId1: string;

  async function issueBatch(
    cores: VcCore[],
    signer: HardhatEthersSigner = issuerSigner,
    keyMethod: string = KEY_METHOD_1
  ): Promise<VerifiableCredential[]> {
    const keyId = ethers.keccak256(ethers.toUtf8Bytes(keyMethod));
    const leaves = cores.map(computeLeafHash);
    const { root, proofs } = buildMerkleTree(leaves);
    const nonce = await contract.nonces(issuerId);
    const sig = await signAnchor(
      contractAddress,
      chainId,
      signer,
      issuerId,
      root,
      cores.length,
      SCHEMA_ID,
      keyId,
      nonce
    );
    const tx = await contract.connect(relayer).anchor(issuerId, root, cores.length, SCHEMA_ID, keyId, nonce, sig);
    await tx.wait();

    const vcs: VerifiableCredential[] = [];
    for (let i = 0; i < cores.length; i++) {
      const proofValue = await signer.signMessage(canonicalize(cores[i]));
      vcs.push({
        ...cores[i],
        proof: {
          type: "EcdsaSecp256k1Signature2019",
          verificationMethod: keyMethod,
          proofPurpose: "assertionMethod",
          proofValue
        },
        anchorReference: {
          chainId,
          anchorRegistry: contractAddress,
          merkleRoot: root,
          merkleProof: proofs[i],
          txHash: tx.hash
        }
      });
    }
    return vcs;
  }

  function makeCore(idx: number, validUntil?: string): VcCore {
    return {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      id: `urn:uuid:cred-${idx}-${Math.random().toString(16).slice(2)}`,
      type: ["VerifiableCredential", "AcademicCertificate"],
      issuer: ISSUER_DID,
      validFrom: "2026-03-15T12:00:00Z",
      ...(validUntil ? { validUntil } : {}),
      credentialSubject: {
        id: `urn:diplochain:holder:${idx}`,
        name: `Student ${idx}`,
        course: "Blockchain Architecture and Smart Contracts",
        workloadHours: 60
      },
      salt: ethers.hexlify(ethers.randomBytes(16))
    };
  }

  beforeEach(async function () {
    [governance, issuerSigner, recoverySigner, relayer, issuerSigner2, rogueSigner] = await ethers.getSigners();
    contract = await ethers.deployContract("DiploChain", governance);
    await contract.waitForDeployment();
    contractAddress = await contract.getAddress();
    chainId = Number((await ethers.provider.getNetwork()).chainId);

    issuerId = ethers.keccak256(ethers.toUtf8Bytes(ISSUER_DID));
    keyId1 = ethers.keccak256(ethers.toUtf8Bytes(KEY_METHOD_1));

    await contract
      .connect(governance)
      .registerIssuer(ISSUER_DID, 2, recoverySigner.address, keyId1, issuerSigner.address);
  });

  it("S1 & S3: issues a single credential via relayer and verifies independently as VALID", async function () {
    const [vc] = await issueBatch([makeCore(1)]);
    const result = await verifyCredential(contract, vc, await time.latest());
    expect(result).to.equal("VALID");
  });

  it("S2: issues a batch of 100 credentials in one transaction and verifies members", async function () {
    const cores = Array.from({ length: 100 }, (_, i) => makeCore(i));
    const vcs = await issueBatch(cores);
    const now = await time.latest();
    expect(await verifyCredential(contract, vcs[0], now)).to.equal("VALID");
    expect(await verifyCredential(contract, vcs[50], now)).to.equal("VALID");
    expect(await verifyCredential(contract, vcs[99], now)).to.equal("VALID");

    const anchor = await contract.anchors(vcs[0].anchorReference.merkleRoot);
    expect(anchor.count).to.equal(100);
  });

  it("S4 & N3: revokes a credential and verifies as REVOKED", async function () {
    const [vc] = await issueBatch([makeCore(1)]);
    const leafHash = computeLeafHash(stripEnvelope(vc));
    const nonce = await contract.nonces(issuerId);
    const sig = await signRevoke(contractAddress, chainId, issuerSigner, issuerId, leafHash, 2, keyId1, nonce);

    await contract.connect(relayer).revoke(issuerId, leafHash, 2, keyId1, nonce, sig);

    expect(await verifyCredential(contract, vc, await time.latest())).to.equal("REVOKED");
    const rec = await contract.revocations(issuerId, leafHash);
    expect(rec.reason).to.equal(2);
  });

  it("N1: detects tampered credential field as TAMPERED", async function () {
    const [vc] = await issueBatch([makeCore(1)]);
    const tampered: VerifiableCredential = {
      ...vc,
      credentialSubject: {
        ...vc.credentialSubject,
        workloadHours: 600
      }
    };
    expect(await verifyCredential(contract, tampered, await time.latest())).to.equal("TAMPERED");
  });

  it("N2: rejects valid signature from an unregistered issuer or key", async function () {
    const core = makeCore(1);
    const rogueCore: VcCore = { ...core, issuer: "did:web:fake-university.edu" };
    const proofValue = await rogueSigner.signMessage(canonicalize(rogueCore));
    const fakeVc: VerifiableCredential = {
      ...rogueCore,
      proof: {
        type: "EcdsaSecp256k1Signature2019",
        verificationMethod: "did:web:fake-university.edu#key-1",
        proofPurpose: "assertionMethod",
        proofValue
      },
      anchorReference: {
        chainId,
        anchorRegistry: contractAddress,
        merkleRoot: computeLeafHash(rogueCore),
        merkleProof: [],
        txHash: ethers.ZeroHash
      }
    };
    expect(await verifyCredential(contract, fakeVc, await time.latest())).to.equal("ISSUER NOT REGISTERED");
  });

  it("N4: reports ISSUER SUSPENDED when governance suspends issuer", async function () {
    const [vc] = await issueBatch([makeCore(1)]);
    await contract.connect(governance).setIssuerStatus(issuerId, 2);
    expect(await verifyCredential(contract, vc, await time.latest())).to.equal("ISSUER SUSPENDED");
  });

  it("N5: keeps credentials before compromise VALID and marks post-compromise as UNDER REVIEW", async function () {
    const [vcBefore] = await issueBatch([makeCore(1)]);
    await time.increase(20);
    const compromiseEstimate = await time.latest();
    await time.increase(20);
    const [vcAfter] = await issueBatch([makeCore(2)]);

    const nonce = await contract.nonces(issuerId);
    const recoverySig = await signCompromise(
      contractAddress,
      chainId,
      recoverySigner,
      issuerId,
      keyId1,
      compromiseEstimate,
      nonce
    );
    await contract.connect(relayer).reportCompromise(issuerId, keyId1, compromiseEstimate, nonce, recoverySig);

    const now = await time.latest();
    expect(await verifyCredential(contract, vcBefore, now)).to.equal("VALID");
    expect(await verifyCredential(contract, vcAfter, now)).to.equal("ISSUED AFTER KEY COMPROMISE - UNDER REVIEW");

    const nextNonce = await contract.nonces(issuerId);
    const blockedSig = await signAnchor(
      contractAddress,
      chainId,
      issuerSigner,
      issuerId,
      ethers.keccak256(ethers.toUtf8Bytes("blocked")),
      1,
      SCHEMA_ID,
      keyId1,
      nextNonce
    );
    await expect(
      contract
        .connect(relayer)
        .anchor(issuerId, ethers.keccak256(ethers.toUtf8Bytes("blocked")), 1, SCHEMA_ID, keyId1, nextNonce, blockedSig)
    ).to.be.revertedWith("Key not active");
  });

  it("N6: reports ANCHOR NOT FOUND when root was never anchored", async function () {
    const core = makeCore(1);
    const leaf = computeLeafHash(core);
    const proofValue = await issuerSigner.signMessage(canonicalize(core));
    const unanchoredVc: VerifiableCredential = {
      ...core,
      proof: {
        type: "EcdsaSecp256k1Signature2019",
        verificationMethod: KEY_METHOD_1,
        proofPurpose: "assertionMethod",
        proofValue
      },
      anchorReference: {
        chainId,
        anchorRegistry: contractAddress,
        merkleRoot: leaf,
        merkleProof: [],
        txHash: ethers.ZeroHash
      }
    };
    expect(await verifyCredential(contract, unanchoredVc, await time.latest())).to.equal("ANCHOR NOT FOUND");
  });

  it("N7: reports EXPIRED when validUntil is in the past", async function () {
    const [vc] = await issueBatch([makeCore(1, "2020-01-01T00:00:00Z")]);
    expect(await verifyCredential(contract, vc, await time.latest())).to.equal("EXPIRED");
  });

  it("supports key rotation without invalidating previous credentials", async function () {
    const [vcOld] = await issueBatch([makeCore(1)]);
    await time.increase(10);

    const keyId2 = ethers.keccak256(ethers.toUtf8Bytes(KEY_METHOD_2));
    const nonce = await contract.nonces(issuerId);
    const rotateSig = await signRotateKey(
      contractAddress,
      chainId,
      issuerSigner,
      issuerId,
      keyId1,
      keyId2,
      issuerSigner2.address,
      nonce
    );
    await contract.connect(relayer).rotateKey(issuerId, keyId1, keyId2, issuerSigner2.address, nonce, rotateSig);

    const [vcNew] = await issueBatch([makeCore(2)], issuerSigner2, KEY_METHOD_2);
    const now = await time.latest();
    expect(await verifyCredential(contract, vcOld, now)).to.equal("VALID");
    expect(await verifyCredential(contract, vcNew, now)).to.equal("VALID");
  });

  it("preserves verification as VALID - ISSUER CLOSED after institutional closure", async function () {
    const [vc] = await issueBatch([makeCore(1)]);
    await contract.connect(governance).setIssuerStatus(issuerId, 3);
    expect(await verifyCredential(contract, vc, await time.latest())).to.equal("VALID - ISSUER CLOSED");
  });
});
