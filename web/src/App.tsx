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
  { id: "verify", label: "Verify" },
  { id: "issuer", label: "Issue" },
  { id: "governance", label: "Governance" }
];

const VERDICT_LABELS: Record<string, string> = {
  VALID: "Valid Credential",
  "VALID - ISSUER CLOSED": "Valid (Issuer Closed)",
  REVOKED: "Credential Revoked",
  "ISSUER SUSPENDED": "Issuer Suspended",
  "ISSUED AFTER KEY COMPROMISE - UNDER REVIEW": "Under Review (Post-Compromise)",
  "INVALID SIGNATURE": "Invalid Signature",
  TAMPERED: "Tampered Credential",
  "ISSUER NOT REGISTERED": "Issuer Not Registered",
  "ANCHOR NOT FOUND": "Anchor Not Found",
  EXPIRED: "Expired Credential"
};

const IDLE_DIMENSIONS = [
  {
    cls: "dim-1",
    title: "1. Authenticity",
    chip: "Signature & Merkle",
    body: "Validates the ECDSA secp256k1 signature, salted hash (JCS), and Merkle inclusion proof against the anchored root."
  },
  {
    cls: "dim-2",
    title: "2. Issuer",
    chip: "On-chain registry",
    body: "Queries the contract for the issuer DID, assurance level (L1 or L2), and signing key validity window."
  },
  {
    cls: "dim-3",
    title: "3. Academic Validity",
    chip: "Off-chain",
    body: "Asserted by the issuer inside the credential. Academic and legal recognition remain outside technical verification."
  },
  {
    cls: "dim-4",
    title: "4. Revocation & Expiry",
    chip: "On-chain status",
    body: "Checks the permanent revocation registry in the contract, reason code, and validUntil timestamp."
  }
];

const shortAddr = (addr: string) => (addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr);
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const verdictTone = (v: string): "ok" | "warn" | "err" =>
  v === "VALID" ? "ok" : v === "VALID - ISSUER CLOSED" || v.includes("UNDER REVIEW") ? "warn" : "err";

function toLocalDateTimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseBatchEntries(text: string, fallbackCourse: string, fallbackHours: number) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, idx) => !(idx === 0 && /^(name|holder)\b/i.test(line)))
    .map((line) => {
      const parts = line.split(/[;,]/).map((p) => p.trim());
      return {
        name: parts[0] || "",
        course: parts[1] || fallbackCourse.trim(),
        workloadHours: Number(parts[2]) || fallbackHours
      };
    })
    .filter((entry) => entry.name && entry.course && entry.workloadHours > 0);
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
  const [chainId, setChainId] = useState(31337);
  const [connected, setConnected] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [vcText, setVcText] = useState("");
  const [verifyResult, setVerifyResult] = useState<VerificationResult | null>(null);
  const [loadedVc, setLoadedVc] = useState<VerifiableCredential | null>(null);

  const [holderName, setHolderName] = useState("");
  const [courseName, setCourseName] = useState("");
  const [workloadHours, setWorkloadHours] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [batchInput, setBatchInput] = useState("");
  const [issuedVcs, setIssuedVcs] = useState<VerifiableCredential[]>([]);
  const [revokeReason, setRevokeReason] = useState(2);
  const [activeKeyIndex, setActiveKeyIndex] = useState<0 | 1>(0);
  const [qrModal, setQrModal] = useState<{ vc: VerifiableCredential; dataUrl: string; verifyUrl: string } | null>(
    null
  );

  const [issuers, setIssuers] = useState<OnChainIssuerInfo[]>([]);
  const [newIssuerDid, setNewIssuerDid] = useState("");
  const [newIssuerLevel, setNewIssuerLevel] = useState(1);
  const [compromiseAt, setCompromiseAt] = useState(() => toLocalDateTimeValue(new Date()));

  const activeTabIndex = TABS.findIndex((t) => t.id === tab);
  const activeKey = activeKeyIndex === 0 ? DEMO_ACCOUNTS.issuer1 : DEMO_ACCOUNTS.issuer2;
  const activeKeyMethod = activeKeyIndex === 0 ? DEMO_KEY_METHOD_1 : DEMO_KEY_METHOD_2;
  const parsedBatch = parseBatchEntries(batchInput, courseName, Number(workloadHours));

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
      setStatusMsg({ tone: "err", text: "Failed to read credential from link." });
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
    runAction("Verification failed", async () => {
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
        setStatusMsg({ tone: "err", text: "Invalid JSON file." });
      }
    };
    reader.readAsText(file);
  }

  function loadCsvFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setBatchInput(String(reader.result || ""));
    reader.readAsText(file);
  }

  function issueCredentials() {
    if (!contractAddress) return setStatusMsg({ tone: "err", text: "Contract not configured. Open the network panel at the top." });
    const entries =
      issueMode === "single"
        ? [{ name: holderName.trim(), course: courseName.trim(), workloadHours: Number(workloadHours) }]
        : parsedBatch;

    if (entries.length === 0 || !entries[0].name || !entries[0].course || entries[0].workloadHours <= 0) {
      return setStatusMsg({ tone: "err", text: "Fill in all required fields before issuing." });
    }

    runAction("Issuance failed", async () => {
      const { provider, activeChainId, contract } = await connectChain(DEMO_ACCOUNTS.relayer.privateKey);
      const issuerWallet = new ethers.Wallet(activeKey.privateKey, provider);
      const issuerId = computeIssuerId(DEMO_ISSUER_DID);
      const keyId = computeKeyId(activeKeyMethod);
      const schemaId = ethers.keccak256(ethers.toUtf8Bytes(DEFAULT_SCHEMA_NAME));

      const started = performance.now();
      const nowIso = new Date().toISOString();
      const cores: VcCore[] = entries.map((entry, i) => ({
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        id: `urn:uuid:${Date.now()}-${i}`,
        type: ["VerifiableCredential", "AcademicCertificate"],
        issuer: DEMO_ISSUER_DID,
        validFrom: nowIso,
        ...(validUntil ? { validUntil: new Date(validUntil).toISOString() } : {}),
        credentialSubject: {
          id: `urn:diplochain:holder:${Date.now()}-${i}`,
          name: entry.name,
          course: entry.course,
          workloadHours: entry.workloadHours
        },
        salt: generateSalt()
      }));

      const { root, proofs } = buildMerkleTree(cores.map(computeLeafHash));
      const nonce: bigint = await contract.nonces(issuerId);
      const sig = await signAnchorTypedData(contractAddress, activeChainId, issuerWallet, issuerId, root, entries.length, schemaId, keyId, nonce);
      const tx = await contract.anchor(issuerId, root, entries.length, schemaId, keyId, nonce, sig);
      const receipt = await tx.wait();

      const newVcs: VerifiableCredential[] = await Promise.all(
        cores.slice(0, Math.min(entries.length, 20)).map(async (core, i) => ({
          ...core,
          proof: { type: "EcdsaSecp256k1Signature2019", verificationMethod: activeKeyMethod, proofPurpose: "assertionMethod", proofValue: await signVcCore(core, issuerWallet) },
          anchorReference: { chainId: activeChainId, anchorRegistry: contractAddress, merkleRoot: root, merkleProof: proofs[i], txHash: tx.hash }
        }))
      );

      const gasUsed = Number(receipt.gasUsed);
      setIssuedVcs((prev) => [...newVcs, ...prev]);
      setStatusMsg({
        tone: "ok",
        text: `${entries.length} credential(s) anchored in 1 transaction · ${gasUsed.toLocaleString()} gas (${(gasUsed / entries.length).toFixed(1)} gas/cred) · ${(performance.now() - started).toFixed(0)} ms`
      });
    });
  }

  const revokeVc = (vc: VerifiableCredential) =>
    runAction("Revocation failed", async () => {
      const { provider, activeChainId, contract } = await connectChain(DEMO_ACCOUNTS.relayer.privateKey);
      const issuerWallet = new ethers.Wallet(activeKey.privateKey, provider);
      const issuerId = computeIssuerId(vc.issuer);
      const keyId = computeKeyId(activeKeyMethod);
      const leafHash = computeLeafHash(stripEnvelope(vc));
      const nonce: bigint = await contract.nonces(issuerId);
      const sig = await signRevokeTypedData(contractAddress, activeChainId, issuerWallet, issuerId, leafHash, revokeReason, keyId, nonce);
      await (await contract.revoke(issuerId, leafHash, revokeReason, keyId, nonce, sig)).wait();
      setStatusMsg({ tone: "warn", text: `Credential for ${vc.credentialSubject.name} revoked (${REVOCATION_REASON_LABELS[revokeReason]}).` });
    });

  const rotateIssuerKey = () =>
    runAction("Key rotation failed", async () => {
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
      setStatusMsg({ tone: "ok", text: "Key rotated to #key-2027-1. Previously issued credentials remain valid." });
    });

  const updateIssuerStatus = (issuerId: string, newStatus: number) =>
    runAction("Status update failed", async () => {
      const { contract } = await connectChain(DEMO_ACCOUNTS.governance.privateKey);
      await (await contract.setIssuerStatus(issuerId, newStatus)).wait();
      await refreshChainState();
      setStatusMsg({ tone: "ok", text: `Status updated to ${ISSUER_STATUS_LABELS[newStatus]}.` });
    });

  const registerNewIssuer = () =>
    runAction("Registration failed", async () => {
      const did = newIssuerDid.trim();
      const { contract } = await connectChain(DEMO_ACCOUNTS.governance.privateKey);
      const keyId = computeKeyId(`${did}#key-1`);
      await (
        await contract.registerIssuer(did, newIssuerLevel, DEMO_ACCOUNTS.recovery.address, keyId, ethers.Wallet.createRandom().address)
      ).wait();
      setNewIssuerDid("");
      await refreshChainState();
      setStatusMsg({ tone: "ok", text: `Issuer ${did} registered.` });
    });

  const reportCompromise = (issuerId: string, keyId: string) =>
    runAction("Compromise report failed", async () => {
      const { provider, activeChainId, contract } = await connectChain(DEMO_ACCOUNTS.relayer.privateKey);
      const block = await provider.getBlock("latest");
      const nowBlockTs = block ? Number(block.timestamp) : Math.floor(Date.now() / 1000);
      const selectedTs = compromiseAt ? Math.floor(new Date(compromiseAt).getTime() / 1000) : nowBlockTs;
      const estimatedTime = Math.max(1, Math.min(selectedTs, nowBlockTs));
      const recoveryWallet = new ethers.Wallet(DEMO_ACCOUNTS.recovery.privateKey, provider);
      const nonce: bigint = await contract.nonces(issuerId);
      const sig = await signCompromiseTypedData(contractAddress, activeChainId, recoveryWallet, issuerId, keyId, estimatedTime, nonce);
      await (await contract.reportCompromise(issuerId, keyId, estimatedTime, nonce, sig)).wait();
      await refreshChainState();
      setStatusMsg({
        tone: "warn",
        text: `Compromise recorded (${new Date(estimatedTime * 1000).toLocaleString()}). Prior credentials remain valid and subsequent ones are marked under review.`
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
    { role: "Governance", address: DEMO_ACCOUNTS.governance.address },
    { role: `Issuer (${activeKeyIndex === 0 ? "#key-2026-1" : "#key-2027-1"})`, address: activeKey.address },
    { role: "Relayer (gas)", address: DEMO_ACCOUNTS.relayer.address },
    { role: "Recovery", address: DEMO_ACCOUNTS.recovery.address }
  ];

  function clearVerification() {
    setVerifyResult(null);
    setLoadedVc(null);
    setVcText("");
    setStatusMsg(null);
  }

  const displayedDimensions = verifyResult
    ? [
        {
          cls: "dim-1",
          title: "1. Authenticity",
          chipCls: verifyResult.dimensions.authenticity.valid ? "" : "err",
          chip: verifyResult.dimensions.authenticity.valid ? "Verified" : "Failed",
          body: verifyResult.dimensions.authenticity.summary,
          meta: verifyResult.dimensions.authenticity.txHash ? `tx ${shortAddr(verifyResult.dimensions.authenticity.txHash)}` : ""
        },
        {
          cls: "dim-2",
          title: "2. Issuer",
          chipCls: verifyResult.dimensions.issuerLegitimacy.valid ? "" : "err",
          chip: verifyResult.dimensions.issuerLegitimacy.status,
          body: verifyResult.dimensions.issuerLegitimacy.summary,
          meta: verifyResult.dimensions.issuerLegitimacy.issuerDid
        },
        {
          cls: "dim-3",
          title: "3. Academic Validity",
          chipCls: "",
          chip: "Asserted",
          body: "Asserted by the issuer. Academic and legal recognition remain outside technical verification.",
          meta: ""
        },
        {
          cls: "dim-4",
          title: "4. Revocation & Expiry",
          chipCls: verifyResult.dimensions.revocation.valid ? "" : "err",
          chip: verifyResult.dimensions.revocation.revoked
            ? "Revoked"
            : verifyResult.dimensions.revocation.expired
              ? "Expired"
              : "Active",
          body: verifyResult.dimensions.revocation.summary,
          meta: ""
        }
      ]
    : IDLE_DIMENSIONS.map((d) => ({ ...d, chipCls: "", meta: "" }));

  const canIssue =
    issueMode === "single"
      ? Boolean(holderName.trim() && courseName.trim() && Number(workloadHours) > 0)
      : parsedBatch.length > 0;

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
            {connected ? `Network ${chainId}` : "Configure network"}
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
                  <label>DiploChain Contract</label>
                  <input value={contractAddress} onChange={(e) => setContractAddress(e.target.value)} placeholder="0x..." />
                </div>
                <button className="dark" onClick={refreshChainState} disabled={busy || !contractAddress}>
                  Reconnect
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
              Close
            </button>
          </div>
        )}

        {tab === "verify" && (
          <main key="verify" className={`workspace slide-${slideDir}`}>
            <div className="workspace-grid">
              <section className="panel">
                <h1 className="page-title">Verify credential</h1>
                <p className="page-sub">
                  Public blockchain lookup with no account or login. Upload the credential .json file or open its QR Code link.
                </p>

                {verifyResult ? (
                  <div
                    key={verifyResult.leafHash + verifyResult.verdict}
                    className={`verdict-hero ${verdictTone(verifyResult.verdict)}`}
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
                    <div className="verdict-top">
                      <span className="verdict-badge">{verifyResult.verdict}</span>
                      <button className="sm" onClick={clearVerification} disabled={busy}>
                        Clear
                      </button>
                    </div>

                    <div>
                      <h3 className="verdict-name">
                        {loadedVc ? loadedVc.credentialSubject.name : VERDICT_LABELS[verifyResult.verdict] || verifyResult.verdict}
                      </h3>
                      {loadedVc && (
                        <div className="verdict-course">
                          {loadedVc.credentialSubject.course} · {loadedVc.credentialSubject.workloadHours}h
                        </div>
                      )}
                      <div className="verdict-sub">{VERDICT_LABELS[verifyResult.verdict] || verifyResult.verdict}</div>
                    </div>

                    <div className="verdict-meta">
                      <span className="mono">{verifyResult.verificationTimeMs} ms · read-only</span>
                      <span className="mono">leaf {shortAddr(verifyResult.leafHash)}</span>
                    </div>
                  </div>
                ) : (
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
                    <span className="dropzone-tag">Credential (.json)</span>
                    <div className="dropzone-title">Drop the .json file generated by DiploChain or click to select</div>
                    <div className="dropzone-sub">
                      File obtained when issuing the credential. Validation runs locally in your browser without sending data to servers.
                    </div>
                  </div>
                )}

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
                          Verify JSON
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="section-foot">
                  <div className="row">
                    <button className="ghost sm" onClick={() => setShowPaste((v) => !v)}>
                      {showPaste ? "Hide JSON editor" : "Paste JSON manually"}
                    </button>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-header">
                  <h2 className="panel-title">Verification result</h2>
                  <span className="chip">4 dimensions</span>
                </div>

                <div className="dim-grid">
                  {displayedDimensions.map((d) => (
                    <div key={d.title} className={`dim-card ${d.cls}`}>
                      <div className="dim-head">
                        <span className="dim-title">{d.title}</span>
                        <span className={`chip ${d.chipCls}`}>{d.chip}</span>
                      </div>
                      <div>
                        <div className="dim-body">{d.body}</div>
                        {d.meta && (
                          <div className="mono" style={{ marginTop: 8 }}>
                            {d.meta}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
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
                    <h1 className="page-title">Issue credentials</h1>
                    <div className="mono" style={{ marginTop: 2 }}>
                      {DEMO_ISSUER_DID}
                    </div>
                  </div>
                  <div className="segmented">
                    <span className="segmented-slider" style={{ transform: `translateX(${issueMode === "single" ? 0 : 100}%)` }} />
                    <button className={issueMode === "single" ? "active" : ""} onClick={() => setIssueMode("single")}>
                      Single
                    </button>
                    <button className={issueMode === "batch" ? "active" : ""} onClick={() => setIssueMode("batch")}>
                      Batch
                    </button>
                  </div>
                </div>

                <div className="form-grid">
                  {issueMode === "single" && (
                    <div className="field span-2">
                      <label>Holder name</label>
                      <input value={holderName} onChange={(e) => setHolderName(e.target.value)} placeholder="e.g. Maria Silva" />
                    </div>
                  )}
                  <div className="field span-2">
                    <label>{issueMode === "single" ? "Course" : "Default course (when CSV lists names only)"}</label>
                    <input
                      value={courseName}
                      onChange={(e) => setCourseName(e.target.value)}
                      placeholder="e.g. Blockchain Architecture and Smart Contracts"
                    />
                  </div>
                  <div className="field">
                    <label>Workload (h)</label>
                    <input type="number" value={workloadHours} onChange={(e) => setWorkloadHours(e.target.value)} placeholder="60" />
                  </div>
                  <div className="field">
                    <label>Expiration date (optional)</label>
                    <input type="datetime-local" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
                  </div>
                  {issueMode === "batch" && (
                    <div className="field span-2">
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <label>Holders (one per line or CSV: name,course,workload_hours)</label>
                        <label className="csv-upload">
                          <span className="chip" style={{ cursor: "pointer" }}>
                            Import .csv
                          </span>
                          <input type="file" accept=".csv,.txt" onChange={(e) => e.target.files?.[0] && loadCsvFile(e.target.files[0])} />
                        </label>
                      </div>
                      <textarea
                        rows={4}
                        value={batchInput}
                        onChange={(e) => setBatchInput(e.target.value)}
                        placeholder={"One name per line (e.g. Maria Silva)\nor CSV: Maria Silva,Blockchain Architecture,60"}
                      />
                    </div>
                  )}
                </div>

                <button className="primary" style={{ marginTop: 6 }} onClick={issueCredentials} disabled={busy || !canIssue}>
                  {issueMode === "single"
                    ? "Issue and anchor credential"
                    : parsedBatch.length > 0
                      ? `Anchor batch (${parsedBatch.length} credentials)`
                      : "Anchor batch"}
                </button>

                <div className="section-foot" style={{ marginTop: "auto" }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="demo-label">
                      Active key: <span className="mono">{activeKeyIndex === 0 ? "#key-2026-1" : "#key-2027-1"}</span>
                    </span>
                    <button className="ghost sm" onClick={rotateIssuerKey} disabled={busy || activeKeyIndex === 1}>
                      {activeKeyIndex === 1 ? "Rotated (#key-2027-1)" : "Rotate key"}
                    </button>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-header">
                  <h2 className="panel-title">Issued credentials ({issuedVcs.length})</h2>
                  <div className="row">
                    <span className="demo-label">Revocation reason</span>
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
                    No credentials issued in this session. Fill out the form on the left to issue a single credential or a batch.
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
                            Verify
                          </button>
                          <button className="sm" onClick={() => openQrModal(vc)}>
                            QR Code
                          </button>
                          <button className="ghost sm" onClick={() => downloadVcJson(vc)}>
                            JSON
                          </button>
                          <button className="danger sm" onClick={() => revokeVc(vc)} disabled={busy}>
                            Revoke
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
                  <h1 className="page-title">Registered issuers ({issuers.length})</h1>
                  <div className="row">
                    <span className="demo-label">Compromise date/time</span>
                    <input
                      type="datetime-local"
                      step="1"
                      style={{ padding: "5px 10px", fontSize: "0.8rem" }}
                      value={compromiseAt}
                      onChange={(e) => setCompromiseAt(e.target.value)}
                    />
                  </div>
                </div>

                {issuers.length === 0 ? (
                  <div className="empty-state">
                    No issuers found. Open "Configure network" at the top to set the RPC URL and contract address.
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
                              Suspend
                            </button>
                          )}
                          {iss.status === 2 && (
                            <button className="primary sm" onClick={() => updateIssuerStatus(iss.issuerId, 1)} disabled={busy}>
                              Reactivate
                            </button>
                          )}
                          {iss.status !== 3 && (
                            <button className="danger sm" onClick={() => updateIssuerStatus(iss.issuerId, 3)} disabled={busy}>
                              Close
                            </button>
                          )}
                        </div>
                      </div>

                      <table className="key-table">
                        <thead>
                          <tr>
                            <th>Key</th>
                            <th>Valid from</th>
                            <th>Valid until</th>
                            <th>Compromised</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {iss.keys.map((k) => (
                            <tr key={k.keyId}>
                              <td className="mono">{shortAddr(k.signer)}</td>
                              <td>{new Date(k.validFrom * 1000).toLocaleTimeString()}</td>
                              <td>{k.validUntil ? new Date(k.validUntil * 1000).toLocaleTimeString() : "Active"}</td>
                              <td>{k.compromisedAt ? new Date(k.compromisedAt * 1000).toLocaleTimeString() : "No"}</td>
                              <td style={{ textAlign: "right" }}>
                                <button className="danger sm" disabled={busy || k.compromisedAt !== 0} onClick={() => reportCompromise(iss.issuerId, k.keyId)}>
                                  {k.compromisedAt !== 0 ? "Compromised" : "Report compromise"}
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
                <h2 className="panel-title">Register issuer</h2>
                <p className="page-sub">
                  Add a new issuer to the on-chain registry with assurance level L1 or L2.
                </p>

                <div className="field">
                  <label>Issuer DID</label>
                  <input
                    value={newIssuerDid}
                    onChange={(e) => setNewIssuerDid(e.target.value)}
                    placeholder="e.g. did:web:institution.edu"
                  />
                </div>
                <div className="field">
                  <label>Assurance level</label>
                  <select value={newIssuerLevel} onChange={(e) => setNewIssuerLevel(Number(e.target.value))}>
                    <option value={1}>L1 (Verified legal entity and domain)</option>
                    <option value={2}>L2 (Accredited institution)</option>
                  </select>
                </div>

                <button className="dark" style={{ marginTop: 6 }} onClick={registerNewIssuer} disabled={busy || !newIssuerDid.trim()}>
                  Register issuer
                </button>
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
                    <img src={qrModal.dataUrl} alt="Credential QR Code" />
                  </div>
                  <div>
                    <a className="cert-link" href={qrModal.verifyUrl} target="_blank" rel="noreferrer">
                      Open direct verification →
                    </a>
                  </div>
                </div>
              </div>
              <div className="row" style={{ justifyContent: "center" }}>
                <button onClick={() => downloadVcJson(qrModal.vc)}>Download JSON</button>
                <button className="primary" onClick={() => setQrModal(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
