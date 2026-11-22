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

interface OnChainIssuerInfo {
  issuerId: string;
  did: string;
  assuranceLevel: number;
  status: number;
  recoverySigner: string;
  closedAt: number;
  keys: Array<{ keyId: string; signer: string; validFrom: number; validUntil: number; compromisedAt: number }>;
}

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "verify", label: "Verificar" },
  { id: "issuer", label: "Emitir" },
  { id: "governance", label: "Governança" }
];

const VERDICT_LABELS: Record<string, string> = {
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

const IDLE_DIMENSIONS = [
  {
    cls: "idle-1",
    title: "1. Autenticidade",
    chip: "Assinatura e Merkle",
    body: "Valida a assinatura ECDSA secp256k1, o hash com salt (JCS) e a prova de inclusão na raiz de Merkle ancorada."
  },
  {
    cls: "idle-2",
    title: "2. Emissor",
    chip: "Registro on-chain",
    body: "Consulta no contrato o DID do emissor, o nível de garantia (L1 ou L2) e a janela de validade da chave."
  },
  {
    cls: "idle-3",
    title: "3. Validade Acadêmica",
    chip: "Fora da chain",
    body: "Declarada pelo emissor na própria credencial. O reconhecimento acadêmico e legal fica fora da verificação técnica."
  },
  {
    cls: "idle-4",
    title: "4. Revogação e Prazo",
    chip: "Status on-chain",
    body: "Confere o registro permanente de revogação no contrato, o código de motivo e o campo validUntil."
  }
];

const shortAddr = (addr: string) => (addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr);
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const verdictTone = (v: string): "ok" | "warn" | "err" =>
  v === "VALID" ? "ok" : v === "VALID - ISSUER CLOSED" || v.includes("UNDER REVIEW") ? "warn" : "err";

export default function App() {
  const [tab, setTab] = useState<TabId>("verify");
  const [slideDir, setSlideDir] = useState<"left" | "right">("right");
  const [issueMode, setIssueMode] = useState<IssueMode>("single");
  const [showNetwork, setShowNetwork] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [rpcUrl, setRpcUrl] = useState(DEFAULT_RPC_URL);
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(31337);
  const [connected, setConnected] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);
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

  const activeTabIndex = TABS.findIndex((t) => t.id === tab);
  const activeKey = activeKeyIndex === 0 ? DEMO_ACCOUNTS.issuer1 : DEMO_ACCOUNTS.issuer2;
  const activeKeyMethod = activeKeyIndex === 0 ? DEMO_KEY_METHOD_1 : DEMO_KEY_METHOD_2;

  function switchTab(next: TabId) {
    if (next === tab) return;
    setSlideDir(TABS.findIndex((t) => t.id === next) > activeTabIndex ? "right" : "left");
    setTab(next);
  }

  async function runAction(errorPrefix: string, fn: () => Promise<void>) {
    setBusy(true);
    setStatusMsg(null);
    try {
      await fn();
    } catch (err) {
      setStatusMsg({ tone: "err", text: `${errorPrefix}: ${errMsg(err)}` });
    } finally {
      setBusy(false);
    }
  }

  async function connectChain(senderPrivateKey?: string) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const activeChainId = Number((await provider.getNetwork()).chainId);
    const runner = senderPrivateKey ? new ethers.Wallet(senderPrivateKey, provider) : provider;
    const contract = new ethers.Contract(contractAddress, DIPLOCHAIN_ABI, runner);
    return { provider, activeChainId, contract };
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

    const encoded = new URLSearchParams(window.location.search).get("vc");
    if (!encoded) return;
    try {
      const decoded = decodeVcFromUrlParam(encoded);
      setVcText(JSON.stringify(decoded, null, 2));
      setLoadedVc(decoded);
      if (decoded.anchorReference?.anchorRegistry) setContractAddress(decoded.anchorReference.anchorRegistry);
      verifyCredentialOnChain(decoded, DEFAULT_RPC_URL, decoded.anchorReference?.anchorRegistry)
        .then(setVerifyResult)
        .catch(() => {});
    } catch {
      setStatusMsg({ tone: "err", text: "Falha ao ler a credencial do link." });
    }
  }, []);

  async function refreshChainState() {
    if (!contractAddress) return setConnected(false);
    try {
      const { activeChainId, contract } = await connectChain();
      setChainId(activeChainId);
      const ids: string[] = await contract.getIssuerIds();
      const list: OnChainIssuerInfo[] = await Promise.all(
        ids.map(async (id) => {
          const [rec, keyIds] = await Promise.all([contract.issuers(id), contract.getIssuerKeyIds(id)]);
          const keys = await Promise.all(
            (keyIds as string[]).map(async (kid) => {
              const k = await contract.issuerKeys(id, kid);
              return {
                keyId: kid,
                signer: String(k.signer),
                validFrom: Number(k.validFrom),
                validUntil: Number(k.validUntil),
                compromisedAt: Number(k.compromisedAt)
              };
            })
          );
          return {
            issuerId: id,
            did: String(rec.did),
            assuranceLevel: Number(rec.assuranceLevel),
            status: Number(rec.status),
            recoverySigner: String(rec.recoverySigner),
            closedAt: Number(rec.closedAt),
            keys
          };
        })
      );
      setIssuers(list);
      setConnected(true);
      const demo = list.find((i) => i.did === DEMO_ISSUER_DID);
      const key2Id = computeKeyId(DEMO_KEY_METHOD_2).toLowerCase();
      if (demo?.keys.some((k) => k.keyId.toLowerCase() === key2Id && k.validUntil === 0)) setActiveKeyIndex(1);
    } catch {
      setConnected(false);
    }
  }

  useEffect(() => {
    if (contractAddress) refreshChainState();
  }, [contractAddress, rpcUrl]);

  const runVerification = (vcOverride?: VerifiableCredential) =>
    runAction("Não foi possível verificar", async () => {
      const parsed = vcOverride || (JSON.parse(vcText) as VerifiableCredential);
      setLoadedVc(parsed);
      setVerifyResult(await verifyCredentialOnChain(parsed, rpcUrl, contractAddress || undefined));
    });

  function loadJsonFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      setVcText(text);
      try {
        runVerification(JSON.parse(text) as VerifiableCredential);
      } catch {
        setStatusMsg({ tone: "err", text: "Arquivo JSON inválido." });
      }
    };
    reader.readAsText(file);
  }

  function testModifiedVc(vc: VerifiableCredential) {
    setVcText(JSON.stringify(vc, null, 2));
    runVerification(vc);
  }

  const simulateTamperN1 = () =>
    loadedVc &&
    testModifiedVc({
      ...loadedVc,
      credentialSubject: { ...loadedVc.credentialSubject, workloadHours: loadedVc.credentialSubject.workloadHours + 500 }
    });

  const simulateUnanchoredN6 = () =>
    loadedVc &&
    testModifiedVc({
      ...loadedVc,
      anchorReference: {
        ...loadedVc.anchorReference,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes("non-existent-root-" + Date.now())),
        txHash: ethers.ZeroHash
      }
    });

  const simulateUnregisteredN2 = () =>
    runAction("Não foi possível verificar", async () => {
      const rogue = ethers.Wallet.createRandom();
      const core: VcCore = {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        id: `urn:uuid:rogue-${Date.now()}`,
        type: ["VerifiableCredential", "AcademicCertificate"],
        issuer: "did:web:falsa-instituicao.edu",
        validFrom: new Date().toISOString(),
        credentialSubject: { id: "urn:diplochain:holder:rogue", name: "Aluno Teste", course: "Curso Não Credenciado", workloadHours: 100 },
        salt: generateSalt()
      };
      const fakeVc: VerifiableCredential = {
        ...core,
        proof: { type: "EcdsaSecp256k1Signature2019", verificationMethod: "did:web:falsa-instituicao.edu#key-1", proofPurpose: "assertionMethod", proofValue: await signVcCore(core, rogue) },
        anchorReference: { chainId, anchorRegistry: contractAddress, merkleRoot: computeLeafHash(core), merkleProof: [], txHash: ethers.ZeroHash }
      };
      setVcText(JSON.stringify(fakeVc, null, 2));
      setLoadedVc(fakeVc);
      setVerifyResult(await verifyCredentialOnChain(fakeVc, rpcUrl, contractAddress || undefined));
    });

  function issueCredentials(count: number) {
    if (!contractAddress) return setStatusMsg({ tone: "err", text: "Contrato não configurado. Abra o painel de rede no topo." });
    runAction("Erro ao emitir", async () => {
      const { provider, activeChainId, contract } = await connectChain(DEMO_ACCOUNTS.relayer.privateKey);
      const issuerWallet = new ethers.Wallet(activeKey.privateKey, provider);
      const issuerId = computeIssuerId(DEMO_ISSUER_DID);
      const keyId = computeKeyId(activeKeyMethod);
      const schemaId = ethers.keccak256(ethers.toUtf8Bytes(DEFAULT_SCHEMA_NAME));

      const started = performance.now();
      const nowIso = new Date().toISOString();
      const cores: VcCore[] = Array.from({ length: count }, (_, i) => ({
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        id: `urn:uuid:${Date.now()}-${i}`,
        type: ["VerifiableCredential", "AcademicCertificate"],
        issuer: DEMO_ISSUER_DID,
        validFrom: nowIso,
        ...(validUntil ? { validUntil: new Date(validUntil).toISOString() } : {}),
        credentialSubject: {
          id: `urn:diplochain:holder:${Date.now()}-${i}`,
          name: count === 1 ? holderName : `${holderName} #${i + 1}`,
          course: courseName,
          workloadHours: Number(workloadHours)
        },
        salt: generateSalt()
      }));

      const { root, proofs } = buildMerkleTree(cores.map(computeLeafHash));
      const nonce: bigint = await contract.nonces(issuerId);
      const sig = await signAnchorTypedData(contractAddress, activeChainId, issuerWallet, issuerId, root, count, schemaId, keyId, nonce);
      const tx = await contract.anchor(issuerId, root, count, schemaId, keyId, nonce, sig);
      const receipt = await tx.wait();

      const newVcs: VerifiableCredential[] = await Promise.all(
        cores.slice(0, Math.min(count, 10)).map(async (core, i) => ({
          ...core,
          proof: { type: "EcdsaSecp256k1Signature2019", verificationMethod: activeKeyMethod, proofPurpose: "assertionMethod", proofValue: await signVcCore(core, issuerWallet) },
          anchorReference: { chainId: activeChainId, anchorRegistry: contractAddress, merkleRoot: root, merkleProof: proofs[i], txHash: tx.hash }
        }))
      );

      const gasUsed = Number(receipt.gasUsed);
      setIssuedVcs((prev) => [...newVcs, ...prev]);
      setStatusMsg({
        tone: "ok",
        text: `${count} credencial(is) ancoradas em 1 transação · ${gasUsed.toLocaleString()} gás (${(gasUsed / count).toFixed(1)} gás/cred) · ${(performance.now() - started).toFixed(0)} ms`
      });
    });
  }

  const revokeVc = (vc: VerifiableCredential) =>
    runAction("Erro ao revogar", async () => {
      const { provider, activeChainId, contract } = await connectChain(DEMO_ACCOUNTS.relayer.privateKey);
      const issuerWallet = new ethers.Wallet(activeKey.privateKey, provider);
      const issuerId = computeIssuerId(vc.issuer);
      const keyId = computeKeyId(activeKeyMethod);
      const leafHash = computeLeafHash(stripEnvelope(vc));
      const nonce: bigint = await contract.nonces(issuerId);
      const sig = await signRevokeTypedData(contractAddress, activeChainId, issuerWallet, issuerId, leafHash, revokeReason, keyId, nonce);
      await (await contract.revoke(issuerId, leafHash, revokeReason, keyId, nonce, sig)).wait();
      setStatusMsg({ tone: "warn", text: `Credencial de ${vc.credentialSubject.name} revogada (${REVOCATION_REASON_LABELS[revokeReason]}).` });
    });

  const rotateDemoIssuerKey = () =>
    runAction("Erro ao rotacionar chave", async () => {
      const { provider, activeChainId, contract } = await connectChain(DEMO_ACCOUNTS.relayer.privateKey);
      const oldWallet = new ethers.Wallet(DEMO_ACCOUNTS.issuer1.privateKey, provider);
      const issuerId = computeIssuerId(DEMO_ISSUER_DID);
      const oldKeyId = computeKeyId(DEMO_KEY_METHOD_1);
      const newKeyId = computeKeyId(DEMO_KEY_METHOD_2);
      const nonce: bigint = await contract.nonces(issuerId);
      const sig = await signRotateKeyTypedData(contractAddress, activeChainId, oldWallet, issuerId, oldKeyId, newKeyId, DEMO_ACCOUNTS.issuer2.address, nonce);
      await (await contract.rotateKey(issuerId, oldKeyId, newKeyId, DEMO_ACCOUNTS.issuer2.address, nonce, sig)).wait();
      setActiveKeyIndex(1);
      await refreshChainState();
      setStatusMsg({ tone: "ok", text: "Chave rotacionada para #key-2027-1. Credenciais antigas permanecem válidas." });
    });

  const updateIssuerStatus = (issuerId: string, newStatus: number) =>
    runAction("Erro ao alterar status", async () => {
      const { contract } = await connectChain(DEMO_ACCOUNTS.governance.privateKey);
      await (await contract.setIssuerStatus(issuerId, newStatus)).wait();
      await refreshChainState();
      setStatusMsg({ tone: "ok", text: `Status alterado para ${ISSUER_STATUS_LABELS[newStatus]}.` });
    });

  const registerNewIssuer = () =>
    runAction("Erro ao registrar", async () => {
      const { contract } = await connectChain(DEMO_ACCOUNTS.governance.privateKey);
      const keyId = computeKeyId(`${newIssuerDid}#key-1`);
      await (
        await contract.registerIssuer(newIssuerDid, newIssuerLevel, DEMO_ACCOUNTS.recovery.address, keyId, ethers.Wallet.createRandom().address)
      ).wait();
      await refreshChainState();
      setStatusMsg({ tone: "ok", text: `Emissor ${newIssuerDid} registrado.` });
    });

  const reportDemoCompromise = (issuerId: string, keyId: string) =>
    runAction("Erro ao reportar comprometimento", async () => {
      const { provider, activeChainId, contract } = await connectChain(DEMO_ACCOUNTS.relayer.privateKey);
      const block = await provider.getBlock("latest");
      const estimatedTime = Math.max(1, (block ? Number(block.timestamp) : Math.floor(Date.now() / 1000)) - Number(compromiseSecondsAgo));
      const recoveryWallet = new ethers.Wallet(DEMO_ACCOUNTS.recovery.privateKey, provider);
      const nonce: bigint = await contract.nonces(issuerId);
      const sig = await signCompromiseTypedData(contractAddress, activeChainId, recoveryWallet, issuerId, keyId, estimatedTime, nonce);
      await (await contract.reportCompromise(issuerId, keyId, estimatedTime, nonce, sig)).wait();
      await refreshChainState();
      setStatusMsg({
        tone: "warn",
        text: `Comprometimento registrado (${new Date(estimatedTime * 1000).toLocaleTimeString()}). Credenciais anteriores seguem válidas; posteriores ficam sob revisão.`
      });
    });

  async function openQrModal(vc: VerifiableCredential) {
    const verifyUrl = `${window.location.origin}/?vc=${encodeVcToUrlParam(vc)}`;
    setQrModal({ vc, dataUrl: await QRCode.toDataURL(verifyUrl, { width: 220, margin: 1 }), verifyUrl });
  }

  function downloadVcJson(vc: VerifiableCredential) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(vc, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `vc-${vc.credentialSubject.name.toLowerCase().replace(/\s+/g, "-")}.json`
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  const wallets = [
    { role: "Governança", address: DEMO_ACCOUNTS.governance.address },
    { role: `Emissor (${activeKeyIndex === 0 ? "#key-2026-1" : "#key-2027-1"})`, address: activeKey.address },
    { role: "Relayer (paga gás)", address: DEMO_ACCOUNTS.relayer.address },
    { role: "Recuperação", address: DEMO_ACCOUNTS.recovery.address }
  ];

  const activeDimensions = verifyResult
    ? [
        {
          cls: verifyResult.dimensions.authenticity.valid ? "ok" : "err",
          title: "1. Autenticidade",
          chipCls: verifyResult.dimensions.authenticity.valid ? "ok" : "err",
          chip: verifyResult.dimensions.authenticity.valid ? "Confirmada" : "Falhou",
          body: verifyResult.dimensions.authenticity.summary,
          meta: verifyResult.dimensions.authenticity.txHash ? `tx ${shortAddr(verifyResult.dimensions.authenticity.txHash)}` : ""
        },
        {
          cls: verifyResult.dimensions.issuerLegitimacy.valid ? "ok" : "err",
          title: "2. Emissor",
          chipCls: verifyResult.dimensions.issuerLegitimacy.valid ? "ok" : "err",
          chip: verifyResult.dimensions.issuerLegitimacy.status,
          body: verifyResult.dimensions.issuerLegitimacy.summary,
          meta: verifyResult.dimensions.issuerLegitimacy.issuerDid
        },
        {
          cls: "info",
          title: "3. Validade Acadêmica",
          chipCls: "",
          chip: "Declarada",
          body: "Declarada pelo emissor. O reconhecimento acadêmico e legal fica fora da verificação técnica.",
          meta: ""
        },
        {
          cls: verifyResult.dimensions.revocation.valid ? "ok" : "err",
          title: "4. Revogação e Prazo",
          chipCls: verifyResult.dimensions.revocation.valid ? "ok" : "err",
          chip: verifyResult.dimensions.revocation.revoked
            ? "Revogada"
            : verifyResult.dimensions.revocation.expired
              ? "Expirada"
              : "Em vigor",
          body: verifyResult.dimensions.revocation.summary,
          meta: ""
        }
      ]
    : [];

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
            {TABS.map((t) => (
              <button key={t.id} className={`nav-pill ${tab === t.id ? "active" : ""}`} onClick={() => switchTab(t.id)}>
                {t.label}
              </button>
            ))}
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
                  <input value={contractAddress} onChange={(e) => setContractAddress(e.target.value)} placeholder="0x..." />
                </div>
                <button className="dark" onClick={refreshChainState} disabled={busy || !contractAddress}>
                  Reconectar
                </button>
              </div>
              <div className="wallet-grid">
                {wallets.map((w) => (
                  <div className="wallet-item" key={w.role}>
                    <div className="wallet-role">{w.role}</div>
                    <div className="mono">{shortAddr(w.address)}</div>
                  </div>
                ))}
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
                  Consulta pública na blockchain, sem conta ou login. Envie o arquivo .json da credencial ou abra o link do QR Code.
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
                    if (e.dataTransfer.files?.[0]) loadJsonFile(e.dataTransfer.files[0]);
                  }}
                >
                  <input type="file" accept=".json" onChange={(e) => e.target.files?.[0] && loadJsonFile(e.target.files[0])} />
                  <span className="dropzone-tag">Upload .json</span>
                  <div className="dropzone-title">Arraste o arquivo .json da credencial ou clique para selecionar</div>
                  <div className="dropzone-sub">Os dados da credencial são validados no navegador, sem envio a servidores.</div>
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
                          {loadedVc ? loadedVc.credentialSubject.name : VERDICT_LABELS[verifyResult.verdict] || verifyResult.verdict}
                        </h3>
                        {loadedVc && (
                          <div className="verdict-course">
                            {loadedVc.credentialSubject.course} · {loadedVc.credentialSubject.workloadHours}h
                          </div>
                        )}
                      </div>
                      <div className="verdict-meta">
                        <div>{VERDICT_LABELS[verifyResult.verdict] || verifyResult.verdict}</div>
                        <div className="mono">{verifyResult.verificationTimeMs} ms · read-only</div>
                        <div className="mono">leaf {shortAddr(verifyResult.leafHash)}</div>
                      </div>
                    </div>

                    <div className="dim-grid">
                      {activeDimensions.map((d) => (
                        <div key={d.title} className={`dim-card ${d.cls}`}>
                          <div className="dim-head">
                            <span className="dim-title">{d.title}</span>
                            <span className={`chip ${d.chipCls}`}>{d.chip}</span>
                          </div>
                          <div className="dim-body">{d.body}</div>
                          {d.meta && <div className="mono">{d.meta}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="dim-grid">
                    {IDLE_DIMENSIONS.map((d) => (
                      <div key={d.title} className={`dim-card ${d.cls}`}>
                        <div className="dim-head">
                          <span className="dim-title">{d.title}</span>
                          <span className="chip">{d.chip}</span>
                        </div>
                        <div className="dim-body">{d.body}</div>
                      </div>
                    ))}
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
                    <span className="segmented-slider" style={{ transform: `translateX(${issueMode === "single" ? 0 : 100}%)` }} />
                    <button className={issueMode === "single" ? "active" : ""} onClick={() => setIssueMode("single")}>
                      Individual
                    </button>
                    <button className={issueMode === "batch" ? "active" : ""} onClick={() => setIssueMode("batch")}>
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
                    <input type="number" value={workloadHours} onChange={(e) => setWorkloadHours(Number(e.target.value))} />
                  </div>
                  {issueMode === "single" ? (
                    <div className="field">
                      <label>Expiração opcional (N7)</label>
                      <input type="datetime-local" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
                    </div>
                  ) : (
                    <div className="field">
                      <label>Tamanho do lote (1 tx)</label>
                      <input type="number" min={2} max={1000} value={batchCount} onChange={(e) => setBatchCount(Number(e.target.value))} />
                    </div>
                  )}
                </div>

                <button className="primary" style={{ marginTop: 6 }} onClick={() => issueCredentials(issueMode === "single" ? 1 : batchCount)} disabled={busy}>
                  {issueMode === "single" ? "Emitir e ancorar credencial" : `Ancorar lote de ${batchCount} credenciais`}
                </button>

                <div className="section-foot" style={{ marginTop: "auto" }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="demo-label">
                      Chave ativa: <span className="mono">{activeKeyIndex === 0 ? "#key-2026-1" : "#key-2027-1"}</span>
                    </span>
                    <button className="ghost sm" onClick={rotateDemoIssuerKey} disabled={busy || activeKeyIndex === 1}>
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
                    <select value={revokeReason} onChange={(e) => setRevokeReason(Number(e.target.value))} style={{ padding: "5px 10px", fontSize: "0.8rem" }}>
                      <option value={1}>AdminError</option>
                      <option value={2}>IssuerError</option>
                      <option value={3}>Fraud</option>
                      <option value={4}>Superseded</option>
                    </select>
                  </div>
                </div>

                {issuedVcs.length === 0 ? (
                  <div className="empty-state">
                    Nenhuma credencial emitida nesta sessão. Preencha o formulário ao lado para emitir uma credencial individual ou um lote.
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
                    Nenhum emissor encontrado. Abra “Configurar rede” no topo para informar o RPC e o endereço do contrato.
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
                            <button className="warn sm" onClick={() => updateIssuerStatus(iss.issuerId, 2)} disabled={busy}>
                              Suspender (N4)
                            </button>
                          )}
                          {iss.status === 2 && (
                            <button className="primary sm" onClick={() => updateIssuerStatus(iss.issuerId, 1)} disabled={busy}>
                              Reativar
                            </button>
                          )}
                          {iss.status !== 3 && (
                            <button className="danger sm" onClick={() => updateIssuerStatus(iss.issuerId, 3)} disabled={busy}>
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
                              <td>{k.compromisedAt ? new Date(k.compromisedAt * 1000).toLocaleTimeString() : "Não"}</td>
                              <td style={{ textAlign: "right" }}>
                                <button className="danger sm" disabled={busy || k.compromisedAt !== 0} onClick={() => reportDemoCompromise(iss.issuerId, k.keyId)}>
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

                <button className="dark" style={{ marginTop: 6 }} onClick={registerNewIssuer} disabled={busy || !newIssuerDid.trim()}>
                  Registrar emissor
                </button>

                <div className="role-note">
                  A conta de governança gerencia o registro de emissores. A conta de recuperação executa{" "}
                  <span className="mono">reportCompromise</span> via EIP-712. O relayer envia as transações e paga o gás.
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
