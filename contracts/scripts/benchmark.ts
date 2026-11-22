import { ethers } from "hardhat";

function hashPair(a: string, b: string): string {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([left, right]));
}

function buildMerkleRoot(leaves: string[]): string {
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(hashPair(level[i], level[i + 1]));
      } else {
        next.push(level[i]);
      }
    }
    level = next;
  }
  return level[0];
}

async function main() {
  const [governance, issuerSigner, recoverySigner, relayer] = await ethers.getSigners();
  const contract = await ethers.deployContract("DiploChain", governance);
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const did = "did:web:extensao.ufsc.br";
  const issuerId = ethers.keccak256(ethers.toUtf8Bytes(did));
  const keyId = ethers.keccak256(ethers.toUtf8Bytes("did:web:extensao.ufsc.br#key-2026-1"));
  const schemaId = ethers.keccak256(ethers.toUtf8Bytes("AcademicCertificate:v1"));

  await (
    await contract.connect(governance).registerIssuer(did, 2, recoverySigner.address, keyId, issuerSigner.address)
  ).wait();

  const batchSizes = [1, 100, 1000];
  const l2GasPriceGwei = 0.01;
  const ethPriceUsd = 3000;
  const usdToBrl = 5.5;

  const rows: Array<Record<string, string | number>> = [];

  for (const size of batchSizes) {
    const startOffchain = performance.now();
    const leaves = Array.from({ length: size }, (_, i) =>
      ethers.keccak256(ethers.toUtf8Bytes(`batch-${size}-cred-${i}-${Math.random()}`))
    );
    const root = buildMerkleRoot(leaves);
    const offchainMs = performance.now() - startOffchain;

    const nonce = await contract.nonces(issuerId);
    const sig = await issuerSigner.signTypedData(
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
      { issuerId, root, count: size, schemaId, keyId, nonce }
    );

    const startTx = performance.now();
    const tx = await contract.connect(relayer).anchor(issuerId, root, size, schemaId, keyId, nonce, sig);
    const receipt = await tx.wait();
    const txMs = performance.now() - startTx;

    const gasUsed = Number(receipt!.gasUsed);
    const costEth = (gasUsed * l2GasPriceGwei) / 1e9;
    const costBrl = costEth * ethPriceUsd * usdToBrl;

    rows.push({
      batchSize: size,
      gasUsed,
      gasPerCred: Number((gasUsed / size).toFixed(1)),
      estBrlAt0_01Gwei: `R$ ${costBrl.toFixed(6)}`,
      offchainMs: Number(offchainMs.toFixed(2)),
      onchainMs: Number(txMs.toFixed(2))
    });
  }

  console.log("\nDiploChain Batch Anchoring Benchmark (S2):");
  console.table(rows);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
