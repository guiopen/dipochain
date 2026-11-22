import { ethers, network, artifacts } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [governance, issuerSigner, recoverySigner, relayer] = await ethers.getSigners();
  const contract = await ethers.deployContract("DiploChain", governance);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const demoDid = "did:web:extensao.ufsc.br";
  const demoKeyMethod = "did:web:extensao.ufsc.br#key-2026-1";
  const demoKeyId = ethers.keccak256(ethers.toUtf8Bytes(demoKeyMethod));
  const demoIssuerId = ethers.keccak256(ethers.toUtf8Bytes(demoDid));

  if (issuerSigner && recoverySigner) {
    const tx = await contract
      .connect(governance)
      .registerIssuer(demoDid, 2, recoverySigner.address, demoKeyId, issuerSigner.address);
    await tx.wait();
  }

  const artifact = await artifacts.readArtifact("DiploChain");
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });

  const deployment = {
    network: network.name,
    chainId,
    address,
    governance: governance.address,
    demoIssuer: issuerSigner && recoverySigner
      ? {
          did: demoDid,
          issuerId: demoIssuerId,
          keyMethod: demoKeyMethod,
          keyId: demoKeyId,
          issuerSigner: issuerSigner.address,
          recoverySigner: recoverySigner.address,
          relayer: relayer ? relayer.address : governance.address
        }
      : null,
    abi: artifact.abi
  };

  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));

  const webPublicDir = path.join(__dirname, "..", "..", "web", "public");
  fs.mkdirSync(webPublicDir, { recursive: true });
  fs.writeFileSync(path.join(webPublicDir, "deployment.json"), JSON.stringify(deployment, null, 2));

  console.log(`DiploChain deployed to ${address} on ${network.name} (chainId ${chainId})`);
  console.log(`Saved deployment metadata to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
