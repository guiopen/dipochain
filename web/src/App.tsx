import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import QRCode from "qrcode";
import {
  ASSURANCE_LEVEL_LABELS,
  DIPLOCHAIN_ABI,
  ISSUER_STATUS_LABELS,
  REVOCATION_REASON_LABELS,
  VcCore,
  VerifiableCredential,
  VerificationResult,
  buildMerkleTree,
  computeIssuerId,
  computeKeyId,
  computeLeafHash,
  decodeVcFromUrlParam,
  encodeVcToUrlParam,
  generateSalt,
  signAnchorTypedData,
  signCompromiseTypedData,
  signRevokeTypedData,
  signRotateKeyTypedData,
  signVcCore,
  stripEnvelope,
  verifyCredentialOnChain
} from "../../core/src/index";
import {
  DEFAULT_RPC_URL,
  DEFAULT_SCHEMA_NAME,
  DEMO_ACCOUNTS,
  DEMO_ISSUER_DID,
  DEMO_KEY_METHOD_1,
  DEMO_KEY_METHOD_2
} from "./config";

type TabId = "verify" | "issuer" | "governance";
type IssueMode = "single" | "batch";

const TAB_ORDER: TabId[] = ["verify", "issuer", "governance"];

interface OnChainIssuerInfo {
  issuerId: string;
  did: string;
  assuranceLevel: number;
  status: number;
  recoverySigner: string;
  closedAt: number;
  keys: Array<{
    keyId: string;
    signer: string;
    validFrom: number;
    validUntil: number;
    compromisedAt: number;
  }>;
}

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}

function verdictTone(verdict: string): "ok" | "warn" | "err" {
  if (verdict === "VALID") return "ok";
  if (verdict === "VALID - ISSUER CLOSED" || verdict.includes("UNDER REVIEW")) return "warn";
  return "err";
}

function verdictPtLabel(verdict: string): string {
  const map: Record<string, string> = {
    VALID: "Credencial Válida",
    "VALID - ISSUER CLOSED": "Válida (Emissor Encerrado)",
    REVOKED: "Credencial Revogada",
    "ISSUER SUSPENDED": "Emissor Suspenso",
    "ISSUED AFTER KEY COMPROMISE - UNDER REVIEW": "Sob Revisão (Pós-Comprometimento)",
    "INVALID SIGNATURE": "Assinatura Inválida",
    TAMPERED: "Credencial Adulterada",
    "ISSUER NOT REGISTERED": "Emissor Não Registrado",
    "ANCHOR NOT FOUND": "Âncora Não Encontrada",
    EXPIRED: "Credencial Expirada"
  };
  return map[verdict] || verdict;
}

export default function App() {
  const [tab, setTab] = useState<TabId>("verify");
  const [slideDir, setSlideDir] = useState<"left" | "right">("right");
  const [issueMode, setIssueMode] = useState<IssueMode>("single");
  const [showNetwork, setShowNetwork] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [rpcUrl, setRpcUrl] = useState(DEFAULT_RPC_URL);
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState<number>(31337);
  const [connected, setConnected] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ tone: "ok" | "warn" | "err" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [vcText, setVcText] = useState("");
  const [verifyResult, setVerifyResult] = useState<VerificationResult | null>(null);
  const [loadedVc, setLoadedVc] = useState<VerifiableCredential | null>(null);

  const [holderName, setHolderName] = useState("Maria Silva");
  const [courseName, setCourseName] = useState("Arquitetura Blockchain e Smart Contracts");
  const [workloadHours, setWorkloadHours] = useState(60);
  const [validUntil, setValidUntil] = useState("");
  const [batchCount, setBatchCount] = useState(100);
  const [issuedVcs, setIssuedVcs] = useState<VerifiableCredential[]>([]);
  const [revokeReason, setRevokeReason] = useState(2);
  const [activeKeyIndex, setActiveKeyIndex] = useState<0 | 1>(0);
  const [qrModal, setQrModal] = useState<{ vc: VerifiableCredential; dataUrl: string; verifyUrl: string } | null>(
    null
  );

  const [issuers, setIssuers] = useState<OnChainIssuerInfo[]>([]);
  const [newIssuerDid, setNewIssuerDid] = useState("did:web:cursos.exemplo.br");
  const [newIssuerLevel, setNewIssuerLevel] = useState(1);
  const [compromiseSecondsAgo, setCompromiseSecondsAgo] = useState(30);

  function switchTab(next: TabId) {
    if (next === tab) return;
    setSlideDir(TAB_ORDER.indexOf(next) > TAB_ORDER.indexOf(tab) ? "right" : "left");
    setTab(next);
  }

  useEffect(() => {
    fetch("/deployment.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.address) {
          setContractAddress(data.address);
          if (data.chainId) setChainId(Number(data.chainId));
        }
      })
      .catch(() => {});

    const params = new URLSearchParams(window.location.search);
    const encoded = params.get("vc");
    if (encoded) {
      try {
        const decoded = decodeVcFromUrlParam(encoded);
        setVcText(JSON.stringify(decoded, null, 2));
        setLoadedVc(decoded);
        if (decoded.anchorReference?.anchorRegistry) {
          setContractAddress(decoded.anchorReference.anchorRegistry);
        }
        verifyCredentialOnChain(decoded, DEFAULT_RPC_URL, decoded.anchorReference?.anchorRegistry)
          .then(setVerifyResult)
          .catch(() => {});
      } catch {
        setStatusMsg({ tone: "err", text: "Falha ao ler a credencial do link." });
      }
    }
  }, []);

  async function refreshChainState() {
    if (!contractAddress) {
      setConnected(false);
      return;
    }
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const net = await provider.getNetwork();
      setChainId(Number(net.chainId));
      const contract = new ethers.Contract(contractAddress, DIPLOCHAIN_ABI, provider);
      const ids: string[] = await contract.getIssuerIds();
      const list: OnChainIssuerInfo[] = [];
      for (const id of ids) {
        const rec = await contract.issuers(id);
        const keyIds: string[] = await contract.getIssuerKeyIds(id);
        const keys = [];
        for (const kid of keyIds) {
          const k = await contract.issuerKeys(id, kid);
          keys.push({
            keyId: kid,
            signer: String(k.signer),
            validFrom: Number(k.validFrom),
            validUntil: Number(k.validUntil),
            compromisedAt: Number(k.compromisedAt)
          });
        }
        list.push({
          issuerId: id,
          did: String(rec.did),
          assuranceLevel: Number(rec.assuranceLevel),
          status: Number(rec.status),
          recoverySigner: String(rec.recoverySigner),
          closedAt: Number(rec.closedAt),
          keys
        });
      }
      setIssuers(list);
      setConnected(true);
      const demo = list.find((i) => i.did === DEMO_ISSUER_DID);
      if (demo && demo.keys.length >= 2) {
        const key2Id = computeKeyId(DEMO_KEY_METHOD_2).toLowerCase();
        if (demo.keys.some((k) => k.keyId.toLowerCase() === key2Id && k.validUntil === 0)) {
          setActiveKeyIndex(1);
        }
      }
    } catch {
      setConnected(false);
    }
  }

  useEffect(() => {
    if (contractAddress) {
      refreshChainState();
    }
  }, [contractAddress, rpcUrl]);

  async function runVerification(vcOverride?: VerifiableCredential) {
    setBusy(true);
    setStatusMsg(null);
    try {
      const parsed = vcOverride || (JSON.parse(vcText) as VerifiableCredential);
      setLoadedVc(parsed);
      const res = await verifyCredentialOnChain(parsed, rpcUrl, contractAddress || undefined);
      setVerifyResult(res);
    } catch (err) {
      setStatusMsg({
        tone: "err",
        text: `Não foi possível verificar: ${err instanceof Error ? err.message : String(err)}`
      });
    } finally {
      setBusy(false);
    }
  }

  function loadJsonFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      setVcText(text);
      try {
        const parsed = JSON.parse(text) as VerifiableCredential;
        runVerification(parsed);
      } catch {
        setStatusMsg({ tone: "err", text: "Arquivo JSON inválido." });
      }
    };
    reader.readAsText(file);
  }

  function simulateTamperN1() {
    if (!loadedVc) return;
    const tampered: VerifiableCredential = {
      ...loadedVc,
      credentialSubject: {
        ...loadedVc.credentialSubject,
        workloadHours: loadedVc.credentialSubject.workloadHours + 500
      }
    };
    setVcText(JSON.stringify(tampered, null, 2));
    runVerification(tampered);
  }

  function simulateUnanchoredN6() {
    if (!loadedVc) return;
    const unanchored: VerifiableCredential = {
      ...loadedVc,
      anchorReference: {
        ...loadedVc.anchorReference,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes("non-existent-root-" + Date.now())),
        txHash: ethers.ZeroHash
      }
    };
    setVcText(JSON.stringify(unanchored, null, 2));
    runVerification(unanchored);
  }

  async function simulateUnregisteredN2() {
    setBusy(true);
    try {
      const rogue = ethers.Wallet.createRandom();
      const core: VcCore = {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        id: `urn:uuid:rogue-${Date.now()}`,
        type: ["VerifiableCredential", "AcademicCertificate"],
        issuer: "did:web:falsa-instituicao.edu",
        validFrom: new Date().toISOString(),
        credentialSubject: {
          id: "urn:diplochain:holder:rogue",
          name: "Aluno Teste",
          course: "Curso Não Credenciado",
          workloadHours: 100
        },
        salt: generateSalt()
      };
      const proofValue = await signVcCore(core, rogue);
      const fakeVc: VerifiableCredential = {
        ...core,
        proof: {
          type: "EcdsaSecp256k1Signature2019",
          verificationMethod: "did:web:falsa-instituicao.edu#key-1",
          proofPurpose: "assertionMethod",
          proofValue
        },
        anchorReference: {
          chainId,
          anchorRegistry: contractAddress,
          merkleRoot: computeLeafHash(core),
          merkleProof: [],
          txHash: ethers.ZeroHash
        }
      };
      setVcText(JSON.stringify(fakeVc, null, 2));
      await runVerification(fakeVc);
    } finally {
      setBusy(false);
    }
  }

  async function issueCredentials(count: number) {
    if (!contractAddress) {
      setStatusMsg({ tone: "err", text: "Contrato não configurado. Abra o painel de rede no topo." });
      return;
    }
    setBusy(true);
    setStatusMsg(null);
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const net = await provider.getNetwork();
      const activeChainId = Number(net.chainId);
      const keyConfig = activeKeyIndex === 0 ? DEMO_ACCOUNTS.issuer1 : DEMO_ACCOUNTS.issuer2;
      const keyMethod = activeKeyIndex === 0 ? DEMO_KEY_METHOD_1 : DEMO_KEY_METHOD_2;

      const issuerWallet = new ethers.Wallet(keyConfig.privateKey, provider);
      const relayerWallet = new ethers.Wallet(DEMO_ACCOUNTS.relayer.privateKey, provider);
      const contract = new ethers.Contract(contractAddress, DIPLOCHAIN_ABI, relayerWallet);

      const issuerId = computeIssuerId(DEMO_ISSUER_DID);
      const keyId = computeKeyId(keyMethod);
      const schemaId = ethers.keccak256(ethers.toUtf8Bytes(DEFAULT_SCHEMA_NAME));

      const started = performance.now();
      const cores: VcCore[] = [];
      for (let i = 0; i < count; i++) {
        cores.push({
          "@context": ["https://www.w3.org/ns/credentials/v2"],
          id: `urn:uuid:${Date.now()}-${i}`,
          type: ["VerifiableCredential", "AcademicCertificate"],
          issuer: DEMO_ISSUER_DID,
          validFrom: new Date().toISOString(),
          ...(validUntil ? { validUntil: new Date(validUntil).toISOString() } : {}),
          credentialSubject: {
            id: `urn:diplochain:holder:${Date.now()}-${i}`,
            name: count === 1 ? holderName : `${holderName} #${i + 1}`,
            course: courseName,
            workloadHours: Number(workloadHours)
          },
          salt: generateSalt()
        });
      }

      const leaves = cores.map(computeLeafHash);
      const { root, proofs } = buildMerkleTree(leaves);

      const nonce: bigint = await contract.nonces(issuerId);
      const sig = await signAnchorTypedData(
        contractAddress,
        activeChainId,
        issuerWallet,
        issuerId,
        root,
        count,
        schemaId,
        keyId,
        nonce
      );

      const tx = await contract.anchor(issuerId, root, count, schemaId, keyId, nonce, sig);
      const receipt = await tx.wait();
      const elapsedMs = (performance.now() - started).toFixed(0);
      const gasUsed = Number(receipt.gasUsed);

      const sampleLimit = Math.min(count, 10);
      const newVcs: VerifiableCredential[] = [];
      for (let i = 0; i < sampleLimit; i++) {
        const proofValue = await signVcCore(cores[i], issuerWallet);
        newVcs.push({
          ...cores[i],
          proof: {
            type: "EcdsaSecp256k1Signature2019",
            verificationMethod: keyMethod,
            proofPurpose: "assertionMethod",
            proofValue
          },
          anchorReference: {
            chainId: activeChainId,
            anchorRegistry: contractAddress,
            merkleRoot: root,
            merkleProof: proofs[i],
            txHash: tx.hash
          }
        });
      }

      setIssuedVcs((prev) => [...newVcs, ...prev]);
      setStatusMsg({
        tone: "ok",
        text: `${count} credencial(is) ancoradas em 1 transação · ${gasUsed.toLocaleString()} gás (${(gasUsed / count).toFixed(1)} gás/cred) · ${elapsedMs} ms`
      });
    } catch (err) {
      setStatusMsg({
        tone: "err",
        text: `Erro ao emitir: ${err instanceof Error ? err.message : String(err)}`
      });
    } finally {
      setBusy(false);
    }
  }

  async function revokeVc(vc: VerifiableCredential) {
    setBusy(true);
    setStatusMsg(null);
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const net = await provider.getNetwork();
      const keyConfig = activeKeyIndex === 0 ? DEMO_ACCOUNTS.issuer1 : DEMO_ACCOUNTS.issuer2;
      const keyMethod = activeKeyIndex === 0 ? DEMO_KEY_METHOD_1 : DEMO_KEY_METHOD_2;

      const issuerWallet = new ethers.Wallet(keyConfig.privateKey, provider);
      const relayerWallet = new ethers.Wallet(DEMO_ACCOUNTS.relayer.privateKey, provider);
      const contract = new ethers.Contract(contractAddress, DIPLOCHAIN_ABI, relayerWallet);

      const issuerId = computeIssuerId(vc.issuer);
      const keyId = computeKeyId(keyMethod);
      const leafHash = computeLeafHash(stripEnvelope(vc));
      const nonce: bigint = await contract.nonces(issuerId);

      const sig = await signRevokeTypedData(
        contractAddress,
        Number(net.chainId),
        issuerWallet,
        issuerId,
        leafHash,
        revokeReason,
        keyId,
        nonce
      );

      const tx = await contract.revoke(issuerId, leafHash, revokeReason, keyId, nonce, sig);
      await tx.wait();
      setStatusMsg({
        tone: "warn",
        text: `Credencial de ${vc.credentialSubject.name} revogada (${REVOCATION_REASON_LABELS[revokeReason]}).`
      });
    } catch (err) {
      setStatusMsg({
        tone: "err",
        text: `Erro ao revogar: ${err instanceof Error ? err.message : String(err)}`
      });
    } finally {
      setBusy(false);
    }
  }

  async function rotateDemoIssuerKey() {
    setBusy(true);
    setStatusMsg(null);
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const net = await provider.getNetwork();
      const oldWallet = new ethers.Wallet(DEMO_ACCOUNTS.issuer1.privateKey, provider);
      const relayerWallet = new ethers.Wallet(DEMO_ACCOUNTS.relayer.privateKey, provider);
      const contract = new ethers.Contract(contractAddress, DIPLOCHAIN_ABI, relayerWallet);

      const issuerId = computeIssuerId(DEMO_ISSUER_DID);
      const oldKeyId = computeKeyId(DEMO_KEY_METHOD_1);
      const newKeyId = computeKeyId(DEMO_KEY_METHOD_2);
      const nonce: bigint = await contract.nonces(issuerId);

      const sig = await signRotateKeyTypedData(
        contractAddress,
        Number(net.chainId),
        oldWallet,
        issuerId,
        oldKeyId,
        newKeyId,
        DEMO_ACCOUNTS.issuer2.address,
        nonce
      );

      const tx = await contract.rotateKey(issuerId, oldKeyId, newKeyId, DEMO_ACCOUNTS.issuer2.address, nonce, sig);
      await tx.wait();
      setActiveKeyIndex(1);
      await refreshChainState();
      setStatusMsg({
        tone: "ok",
        text: "Chave rotacionada para #key-2027-1. Credenciais antigas permanecem válidas."
      });
    } catch (err) {
      setStatusMsg({
        tone: "err",
        text: `Erro ao rotacionar chave: ${err instanceof Error ? err.message : String(err)}`
      });
    } finally {
      setBusy(false);
    }
  }

  async function openQrModal(vc: VerifiableCredential) {
    const encoded = encodeVcToUrlParam(vc);
    const verifyUrl = `${window.location.origin}/?vc=${encoded}`;
    const dataUrl = await QRCode.toDataURL(verifyUrl, { width: 220, margin: 1 });
    setQrModal({ vc, dataUrl, verifyUrl });
  }

  function downloadVcJson(vc: VerifiableCredential) {
    const blob = new Blob([JSON.stringify(vc, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vc-${vc.credentialSubject.name.toLowerCase().replace(/\s+/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function updateIssuerStatus(issuerId: string, newStatus: number) {
    setBusy(true);
    setStatusMsg(null);
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const govWallet = new ethers.Wallet(DEMO_ACCOUNTS.governance.privateKey, provider);
      const contract = new ethers.Contract(contractAddress, DIPLOCHAIN_ABI, govWallet);
      const tx = await contract.setIssuerStatus(issuerId, newStatus);
      await tx.wait();
      await refreshChainState();
      setStatusMsg({
        tone: "ok",
        text: `Status alterado para ${ISSUER_STATUS_LABELS[newStatus]}.`
      });
    } catch (err) {
      setStatusMsg({
        tone: "err",
        text: `Erro ao alterar status: ${err instanceof Error ? err.message : String(err)}`
      });
    } finally {
      setBusy(false);
    }
  }

  async function registerNewIssuer() {
    setBusy(true);
    setStatusMsg(null);
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const govWallet = new ethers.Wallet(DEMO_ACCOUNTS.governance.privateKey, provider);
      const contract = new ethers.Contract(contractAddress, DIPLOCHAIN_ABI, govWallet);
      const randomKey = ethers.Wallet.createRandom();
      const keyId = computeKeyId(`${newIssuerDid}#key-1`);
      const tx = await contract.registerIssuer(
        newIssuerDid,
        newIssuerLevel,
        DEMO_ACCOUNTS.recovery.address,
        keyId,
        randomKey.address
      );
      await tx.wait();
      await refreshChainState();
      setStatusMsg({ tone: "ok", text: `Emissor ${newIssuerDid} registrado.` });
    } catch (err) {
      setStatusMsg({
        tone: "err",
        text: `Erro ao registrar: ${err instanceof Error ? err.message : String(err)}`
      });
    } finally {
      setBusy(false);
    }
  }

  async function reportDemoCompromise(issuerId: string, keyId: string) {
    setBusy(true);
    setStatusMsg(null);
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const net = await provider.getNetwork();
      const block = await provider.getBlock("latest");
      const nowBlockTs = block ? Number(block.timestamp) : Math.floor(Date.now() / 1000);
      const estimatedTime = Math.max(1, nowBlockTs - Number(compromiseSecondsAgo));

      const recoveryWallet = new ethers.Wallet(DEMO_ACCOUNTS.recovery.privateKey, provider);
      const relayerWallet = new ethers.Wallet(DEMO_ACCOUNTS.relayer.privateKey, provider);
      const contract = new ethers.Contract(contractAddress, DIPLOCHAIN_ABI, relayerWallet);

      const nonce: bigint = await contract.nonces(issuerId);
      const sig = await signCompromiseTypedData(
        contractAddress,
        Number(net.chainId),
        recoveryWallet,
        issuerId,
        keyId,
        estimatedTime,
        nonce
      );

      const tx = await contract.reportCompromise(issuerId, keyId, estimatedTime, nonce, sig);
      await tx.wait();
      await refreshChainState();
      setStatusMsg({
        tone: "warn",
        text: `Comprometimento registrado (${new Date(estimatedTime * 1000).toLocaleTimeString()}). Credenciais anteriores seguem válidas; posteriores ficam sob revisão.`
      });
    } catch (err) {
      setStatusMsg({
        tone: "err",
        text: `Erro ao reportar comprometimento: ${err instanceof Error ? err.message : String(err)}`
      });
    } finally {
      setBusy(false);
    }
  }

  const activeTabIndex = TAB_ORDER.indexOf(tab);

  return (
    <div className="viewport-frame">
      <div className="bg-decor" aria-hidden="true">
        <div className="bg-shape bg-pill-tr-amber" />
        <div className="bg-shape bg-pill-tr-pink" />
        <div className="bg-shape bg-pill-bl-sky" />
        <div className="bg-shape bg-pill-bl-green" />
        <div className="bg-shape bg-dots-left">
          <span />
          <span />
          <span />
        </div>
        <svg className="bg-shape bg-star-left" width="52" height="52" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="32" y1="6" x2="32" y2="58" />
          <line x1="6" y1="32" x2="58" y2="32" />
          <line x1="13" y1="13" x2="51" y2="51" />
          <line x1="51" y1="13" x2="13" y2="51" />
        </svg>
        <svg className="bg-shape bg-globe-right" width="66" height="66" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="32" cy="32" r="26" />
          <ellipse cx="32" cy="32" rx="12" ry="26" />
          <line x1="6" y1="32" x2="58" y2="32" />
          <path d="M10 19c7 4 14 6 22 6s15-2 22-6" />
          <path d="M10 45c7-4 14-6 22-6s15 2 22 6" />
        </svg>
      </div>
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-wordmark">
              <span className="brace">{"{"}</span>
              DiploChain
              <span className="brace brace-pink">{"}"}</span>
            </span>
            <span className="brand-pill">UFSC · PD3</span>
          </div>

          <nav className="nav-pills">
            <span className="nav-slider" style={{ transform: `translateX(${activeTabIndex * 100}%)` }} />
            <button className={`nav-pill ${tab === "verify" ? "active" : ""}`} onClick={() => switchTab("verify")}>
              Verificar
            </button>
            <button className={`nav-pill ${tab === "issuer" ? "active" : ""}`} onClick={() => switchTab("issuer")}>
              Emitir
            </button>
            <button
              className={`nav-pill ${tab === "governance" ? "active" : ""}`}
              onClick={() => switchTab("governance")}
            >
              Governança
            </button>
          </nav>

          <button className="net-btn" onClick={() => setShowNetwork((v) => !v)}>
            <span className={`status-dot ${connected ? "" : "off"}`} />
            {connected ? `Rede ${chainId}` : "Configurar rede"}
            <span className={`net-chevron ${showNetwork ? "open" : ""}`}>▼</span>
          </button>
        </header>

        <div className={`collapse-wrap ${showNetwork ? "open" : ""}`}>
          <div className="collapse-inner">
            <div className="drawer">
              <div className="drawer-grid">
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>RPC URL</label>
                  <input value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Contrato DiploChain</label>
                  <input
                    value={contractAddress}
                    onChange={(e) => setContractAddress(e.target.value)}
                    placeholder="0x..."
                  />
                </div>
                <button className="dark" onClick={refreshChainState} disabled={busy || !contractAddress}>
                  Reconectar
                </button>
              </div>

              <div className="wallet-grid">
                <div className="wallet-item">
                  <div className="wallet-role">Governança</div>
                  <div className="mono">{shortAddr(DEMO_ACCOUNTS.governance.address)}</div>
                </div>
                <div className="wallet-item">
                  <div className="wallet-role">
                    Emissor ({activeKeyIndex === 0 ? "#key-2026-1" : "#key-2027-1"})
                  </div>
                  <div className="mono">
                    {shortAddr(activeKeyIndex === 0 ? DEMO_ACCOUNTS.issuer1.address : DEMO_ACCOUNTS.issuer2.address)}
                  </div>
                </div>
                <div className="wallet-item">
                  <div className="wallet-role">Relayer (paga gás)</div>
                  <div className="mono">{shortAddr(DEMO_ACCOUNTS.relayer.address)}</div>
                </div>
                <div className="wallet-item">
                  <div className="wallet-role">Recuperação</div>
                  <div className="mono">{shortAddr(DEMO_ACCOUNTS.recovery.address)}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {statusMsg && (
          <div className={`toast ${statusMsg.tone}`}>
            <span>{statusMsg.text}</span>
            <button className="sm" onClick={() => setStatusMsg(null)}>
              Fechar
            </button>
          </div>
        )}

        {tab === "verify" && (
          <main key="verify" className={`workspace slide-${slideDir}`}>
            <div className="workspace-grid">
              <section className="panel">
                <h1 className="page-title">Verificar credencial</h1>
                <p className="page-sub">
                  Consulta pública na blockchain, sem conta ou login. Envie o arquivo .json da credencial ou abra o link
                  do QR Code.
                </p>

                <div
                  className={`dropzone ${dragging ? "dragging" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) loadJsonFile(f);
                  }}
                >
                  <input
                    type="file"
                    accept=".json"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) loadJsonFile(f);
                    }}
                  />
                  <span className="dropzone-tag">Upload .json</span>
                  <div className="dropzone-title">Arraste o arquivo .json da credencial ou clique para selecionar</div>
                  <div className="dropzone-sub">
                    Os dados da credencial são validados no navegador, sem envio a servidores.
                  </div>
                </div>

                <div className={`collapse-wrap ${showPaste ? "open" : ""}`}>
                  <div className="collapse-inner">
                    <div style={{ paddingTop: 14 }}>
                      <textarea
                        rows={6}
                        value={vcText}
                        onChange={(e) => setVcText(e.target.value)}
                        placeholder='{"@context": [...], "credentialSubject": {...}}'
                      />
                      <div style={{ marginTop: 8 }}>
                        <button className="primary" onClick={() => runVerification()} disabled={busy || !vcText.trim()}>
                          Verificar JSON
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="section-foot">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <button className="ghost sm" onClick={() => setShowPaste((v) => !v)}>
                      {showPaste ? "Ocultar editor JSON" : "Colar JSON manualmente"}
                    </button>
                    <span className="demo-label">Cenários negativos (PD3)</span>
                  </div>
                  <div className="row">
                    <button className="ghost sm" onClick={simulateTamperN1} disabled={busy || !loadedVc}>
                      Adulterar (N1)
                    </button>
                    <button className="ghost sm" onClick={simulateUnregisteredN2} disabled={busy || !contractAddress}>
                      Emissor falso (N2)
                    </button>
                    <button className="ghost sm" onClick={simulateUnanchoredN6} disabled={busy || !loadedVc}>
                      Sem âncora (N6)
                    </button>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-header">
                  <h2 className="panel-title">Resultado da verificação</h2>
                  <span className="chip">4 dimensões</span>
                </div>

                {verifyResult ? (
                  <div key={verifyResult.leafHash + verifyResult.verdict} className="result-animate">
                    <div className={`verdict-hero ${verdictTone(verifyResult.verdict)}`}>
                      <div>
                        <span className="verdict-badge">{verifyResult.verdict}</span>
                        <h3 className="verdict-name">
                          {loadedVc ? loadedVc.credentialSubject.name : verdictPtLabel(verifyResult.verdict)}
                        </h3>
                        {loadedVc && (
                          <div className="verdict-course">
                            {loadedVc.credentialSubject.course} · {loadedVc.credentialSubject.workloadHours}h
                          </div>
                        )}
                      </div>
                      <div className="verdict-meta">
                        <div>{verdictPtLabel(verifyResult.verdict)}</div>
                        <div className="mono">{verifyResult.verificationTimeMs} ms · read-only</div>
                        <div className="mono">leaf {shortAddr(verifyResult.leafHash)}</div>
                      </div>
                    </div>

                    <div className="dim-grid">
                      <div className={`dim-card ${verifyResult.dimensions.authenticity.valid ? "ok" : "err"}`}>
                        <div className="dim-head">
                          <span className="dim-title">1. Autenticidade</span>
                          <span className={`chip ${verifyResult.dimensions.authenticity.valid ? "ok" : "err"}`}>
                            {verifyResult.dimensions.authenticity.valid ? "Confirmada" : "Falhou"}
                          </span>
                        </div>
                        <div className="dim-body">{verifyResult.dimensions.authenticity.summary}</div>
                        {verifyResult.dimensions.authenticity.txHash && (
                          <div className="mono">tx {shortAddr(verifyResult.dimensions.authenticity.txHash)}</div>
                        )}
                      </div>

                      <div className={`dim-card ${verifyResult.dimensions.issuerLegitimacy.valid ? "ok" : "err"}`}>
                        <div className="dim-head">
                          <span className="dim-title">2. Emissor</span>
                          <span className={`chip ${verifyResult.dimensions.issuerLegitimacy.valid ? "ok" : "err"}`}>
                            {verifyResult.dimensions.issuerLegitimacy.status}
                          </span>
                        </div>
                        <div className="dim-body">{verifyResult.dimensions.issuerLegitimacy.summary}</div>
                        <div className="mono">{verifyResult.dimensions.issuerLegitimacy.issuerDid}</div>
                      </div>

                      <div className="dim-card info">
                        <div className="dim-head">
                          <span className="dim-title">3. Validade Acadêmica</span>
                          <span className="chip">Declarada</span>
                        </div>
                        <div className="dim-body">
                          Declarada pelo emissor. O reconhecimento acadêmico e legal fica fora da verificação técnica.
                        </div>
                      </div>

                      <div className={`dim-card ${verifyResult.dimensions.revocation.valid ? "ok" : "err"}`}>
                        <div className="dim-head">
                          <span className="dim-title">4. Revogação e Prazo</span>
                          <span className={`chip ${verifyResult.dimensions.revocation.valid ? "ok" : "err"}`}>
                            {verifyResult.dimensions.revocation.revoked
                              ? "Revogada"
                              : verifyResult.dimensions.revocation.expired
                                ? "Expirada"
                                : "Em vigor"}
                          </span>
                        </div>
                        <div className="dim-body">{verifyResult.dimensions.revocation.summary}</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="dim-grid">
                    <div className="dim-card idle-1">
                      <div className="dim-head">
                        <span className="dim-title">1. Autenticidade</span>
                        <span className="chip">Assinatura e Merkle</span>
                      </div>
                      <div className="dim-body">
                        Valida a assinatura ECDSA secp256k1, o hash com salt (JCS) e a prova de inclusão na raiz de
                        Merkle ancorada.
                      </div>
                    </div>
                    <div className="dim-card idle-2">
                      <div className="dim-head">
                        <span className="dim-title">2. Emissor</span>
                        <span className="chip">Registro on-chain</span>
                      </div>
                      <div className="dim-body">
                        Consulta no contrato o DID do emissor, o nível de garantia (L1 ou L2) e a janela de validade da
                        chave.
                      </div>
                    </div>
                    <div className="dim-card idle-3">
                      <div className="dim-head">
                        <span className="dim-title">3. Validade Acadêmica</span>
                        <span className="chip">Fora da chain</span>
                      </div>
                      <div className="dim-body">
                        Declarada pelo emissor na própria credencial. O reconhecimento acadêmico e legal fica fora da
                        verificação técnica.
                      </div>
                    </div>
                    <div className="dim-card idle-4">
                      <div className="dim-head">
                        <span className="dim-title">4. Revogação e Prazo</span>
                        <span className="chip">Status on-chain</span>
                      </div>
                      <div className="dim-body">
                        Confere o registro permanente de revogação no contrato, o código de motivo e o campo validUntil.
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </main>
        )}

        {tab === "issuer" && (
          <main key="issuer" className={`workspace slide-${slideDir}`}>
            <div className="workspace-grid">
              <section className="panel">
                <div className="panel-header">
                  <div>
                    <h1 className="page-title">Emissão de credenciais</h1>
                    <div className="mono" style={{ marginTop: 2 }}>
                      {DEMO_ISSUER_DID}
                    </div>
                  </div>
                  <div className="segmented">
                    <span
                      className="segmented-slider"
                      style={{ transform: `translateX(${issueMode === "single" ? 0 : 100}%)` }}
                    />
                    <button
                      className={issueMode === "single" ? "active" : ""}
                      onClick={() => setIssueMode("single")}
                    >
                      Individual
                    </button>
                    <button
                      className={issueMode === "batch" ? "active" : ""}
                      onClick={() => setIssueMode("batch")}
                    >
                      Lote
                    </button>
                  </div>
                </div>

                <div className="form-grid">
                  <div className="field span-2">
                    <label>{issueMode === "single" ? "Nome do titular" : "Prefixo dos titulares"}</label>
                    <input value={holderName} onChange={(e) => setHolderName(e.target.value)} />
                  </div>
                  <div className="field span-2">
                    <label>Curso</label>
                    <input value={courseName} onChange={(e) => setCourseName(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Carga horária (h)</label>
                    <input
                      type="number"
                      value={workloadHours}
                      onChange={(e) => setWorkloadHours(Number(e.target.value))}
                    />
                  </div>
                  {issueMode === "single" ? (
                    <div className="field">
                      <label>Expiração opcional (N7)</label>
                      <input type="datetime-local" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
                    </div>
                  ) : (
                    <div className="field">
                      <label>Tamanho do lote (1 tx)</label>
                      <input
                        type="number"
                        min={2}
                        max={1000}
                        value={batchCount}
                        onChange={(e) => setBatchCount(Number(e.target.value))}
                      />
                    </div>
                  )}
                </div>

                <button
                  className="primary"
                  style={{ marginTop: 6 }}
                  onClick={() => issueCredentials(issueMode === "single" ? 1 : batchCount)}
                  disabled={busy}
                >
                  {issueMode === "single"
                    ? "Emitir e ancorar credencial"
                    : `Ancorar lote de ${batchCount} credenciais`}
                </button>

                <div className="section-foot" style={{ marginTop: "auto" }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="demo-label">
                      Chave ativa:{" "}
                      <span className="mono">{activeKeyIndex === 0 ? "#key-2026-1" : "#key-2027-1"}</span>
                    </span>
                    <button
                      className="ghost sm"
                      onClick={rotateDemoIssuerKey}
                      disabled={busy || activeKeyIndex === 1}
                    >
                      {activeKeyIndex === 1 ? "Rotacionada (#key-2027-1)" : "Rotacionar chave"}
                    </button>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-header">
                  <h2 className="panel-title">Credenciais emitidas ({issuedVcs.length})</h2>
                  <div className="row">
                    <span className="demo-label">Motivo ao revogar</span>
                    <select
                      value={revokeReason}
                      onChange={(e) => setRevokeReason(Number(e.target.value))}
                      style={{ padding: "5px 10px", fontSize: "0.8rem" }}
                    >
                      <option value={1}>AdminError</option>
                      <option value={2}>IssuerError</option>
                      <option value={3}>Fraud</option>
                      <option value={4}>Superseded</option>
                    </select>
                  </div>
                </div>

                {issuedVcs.length === 0 ? (
                  <div className="empty-state">
                    Nenhuma credencial emitida nesta sessão. Preencha o formulário ao lado para emitir uma credencial
                    individual ou um lote.
                  </div>
                ) : (
                  <div className="cred-list">
                    {issuedVcs.map((vc) => (
                      <div className="cred-row" key={vc.id}>
                        <div>
                          <div className="cred-title">{vc.credentialSubject.name}</div>
                          <div className="cred-sub">
                            {vc.credentialSubject.course} · {vc.credentialSubject.workloadHours}h ·{" "}
                            <span className="mono">{vc.proof.verificationMethod.split("#")[1]}</span>
                          </div>
                        </div>
                        <div className="row">
                          <button
                            className="dark sm"
                            onClick={() => {
                              setVcText(JSON.stringify(vc, null, 2));
                              switchTab("verify");
                              runVerification(vc);
                            }}
                          >
                            Verificar
                          </button>
                          <button className="sm" onClick={() => openQrModal(vc)}>
                            QR Code
                          </button>
                          <button className="ghost sm" onClick={() => downloadVcJson(vc)}>
                            JSON
                          </button>
                          <button className="danger sm" onClick={() => revokeVc(vc)} disabled={busy}>
                            Revogar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </main>
        )}

        {tab === "governance" && (
          <main key="governance" className={`workspace slide-${slideDir}`}>
            <div className="workspace-grid gov-grid">
              <section className="panel">
                <div className="panel-header">
                  <h1 className="page-title">Emissores registrados ({issuers.length})</h1>
                  <div className="row">
                    <span className="demo-label">Janela N5 (s atrás)</span>
                    <input
                      type="number"
                      min={0}
                      max={3600}
                      style={{ width: 76, padding: "5px 10px", fontSize: "0.8rem" }}
                      value={compromiseSecondsAgo}
                      onChange={(e) => setCompromiseSecondsAgo(Number(e.target.value))}
                    />
                  </div>
                </div>

                {issuers.length === 0 ? (
                  <div className="empty-state">
                    Nenhum emissor encontrado. Abra “Configurar rede” no topo para informar o RPC e o endereço do
                    contrato.
                  </div>
                ) : (
                  issuers.map((iss) => (
                    <div className="issuer-block" key={iss.issuerId}>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: "0.98rem" }}>{iss.did}</div>
                          <div className="row" style={{ marginTop: 4 }}>
                            <span className="demo-label">{ASSURANCE_LEVEL_LABELS[iss.assuranceLevel]}</span>
                            <span className={`chip ${iss.status === 1 ? "ok" : iss.status === 2 ? "warn" : "err"}`}>
                              {ISSUER_STATUS_LABELS[iss.status]}
                            </span>
                          </div>
                        </div>

                        <div className="row">
                          {iss.status === 1 && (
                            <button
                              className="warn sm"
                              onClick={() => updateIssuerStatus(iss.issuerId, 2)}
                              disabled={busy}
                            >
                              Suspender (N4)
                            </button>
                          )}
                          {iss.status === 2 && (
                            <button
                              className="primary sm"
                              onClick={() => updateIssuerStatus(iss.issuerId, 1)}
                              disabled={busy}
                            >
                              Reativar
                            </button>
                          )}
                          {iss.status !== 3 && (
                            <button
                              className="danger sm"
                              onClick={() => updateIssuerStatus(iss.issuerId, 3)}
                              disabled={busy}
                            >
                              Encerrar
                            </button>
                          )}
                        </div>
                      </div>

                      <table className="key-table">
                        <thead>
                          <tr>
                            <th>Chave</th>
                            <th>Início</th>
                            <th>Fim</th>
                            <th>Comprometida</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {iss.keys.map((k) => (
                            <tr key={k.keyId}>
                              <td className="mono">{shortAddr(k.signer)}</td>
                              <td>{new Date(k.validFrom * 1000).toLocaleTimeString()}</td>
                              <td>{k.validUntil ? new Date(k.validUntil * 1000).toLocaleTimeString() : "Ativa"}</td>
                              <td>
                                {k.compromisedAt ? new Date(k.compromisedAt * 1000).toLocaleTimeString() : "Não"}
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <button
                                  className="danger sm"
                                  disabled={busy || k.compromisedAt !== 0}
                                  onClick={() => reportDemoCompromise(iss.issuerId, k.keyId)}
                                >
                                  {k.compromisedAt !== 0 ? "Comprometida" : "Reportar N5"}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))
                )}
              </section>

              <section className="panel panel-amber">
                <h2 className="panel-title">Registrar emissor</h2>
                <p className="page-sub">
                  A conta de governança registra novos emissores e altera o status de emissores existentes no contrato.
                </p>

                <div className="field">
                  <label>DID do emissor</label>
                  <input value={newIssuerDid} onChange={(e) => setNewIssuerDid(e.target.value)} />
                </div>
                <div className="field">
                  <label>Nível de garantia</label>
                  <select value={newIssuerLevel} onChange={(e) => setNewIssuerLevel(Number(e.target.value))}>
                    <option value={1}>L1 (Entidade e domínio verificados)</option>
                    <option value={2}>L2 (Instituição acreditada)</option>
                  </select>
                </div>

                <button
                  className="dark"
                  style={{ marginTop: 6 }}
                  onClick={registerNewIssuer}
                  disabled={busy || !newIssuerDid.trim()}
                >
                  Registrar emissor
                </button>

                <div className="role-note">
                  A conta de governança gerencia o registro de emissores. A conta de recuperação executa{" "}
                  <span className="mono">reportCompromise</span> via EIP-712. O relayer envia as transações e paga o
                  gás.
                </div>
              </section>
            </div>
          </main>
        )}

        {qrModal && (
          <div className="modal-backdrop" onClick={() => setQrModal(null)}>
            <div className="cert-modal" onClick={(e) => e.stopPropagation()}>
              <div className="cert-frame">
                <div className="cert-banner">{qrModal.vc.issuer}</div>
                <div className="cert-body">
                  <div className="cert-holder">{qrModal.vc.credentialSubject.name}</div>
                  <div className="cert-course">
                    {qrModal.vc.credentialSubject.course} · {qrModal.vc.credentialSubject.workloadHours}h
                  </div>
                  <div className="qr-frame">
                    <img src={qrModal.dataUrl} alt="QR Code da credencial" />
                  </div>
                  <div>
                    <a className="cert-link" href={qrModal.verifyUrl} target="_blank" rel="noreferrer">
                      Abrir verificação direta →
                    </a>
                  </div>
                </div>
              </div>
              <div className="row" style={{ justifyContent: "center" }}>
                <button onClick={() => downloadVcJson(qrModal.vc)}>Baixar JSON</button>
                <button className="primary" onClick={() => setQrModal(null)}>
                  Fechar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
