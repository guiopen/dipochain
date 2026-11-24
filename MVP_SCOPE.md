# Course MVP Scope (PD3) and Differences from the Target Product

This document defines what the DiploChain MVP (PD3) implements for the course presentation and what belongs only to the target product described in the white papers and Business Model Canvas. Specification adjustments are documented in [WHITEPAPER_ADJUSTMENTS.md](./WHITEPAPER_ADJUSTMENTS.md).

## 1. Features implemented in the MVP

The MVP executes the full workflow of issuance, anchoring, revocation, key lifecycle management, and verification using real cryptography and a smart contract on an EVM network (local Hardhat node with optional Base Sepolia testnet deployment). It covers all 11 scenarios defined in Section 12 of the *Technical White Paper* (S1 to S4 and N1 to N7).

### 1.1. Smart contract (`DiploChain.sol`)

- Issuer registration with `issuerId`, DID, assurance level (`L1` or `L2`), recovery address, and initial key, plus status transitions across `Active`, `Suspended`, and `Closed`.
- Per-issuer key history with validity windows (`validFrom`, `validUntil`, and `compromisedAt`), supporting key rotation (`rotateKey`) and retroactive compromise reporting (`reportCompromise`).
- Merkle root anchoring (`anchor`) and permanent revocation by `(issuerId, leafHash)` with a reason code (`AdminError`, `IssuerError`, `Fraud`, or `Superseded`), both authenticated via EIP-712 signatures with `nonce` replay protection for relayer submission.

### 1.2. Cryptographic library, CLI, and evaluation scripts (`core/` and `contracts/`)

- Credential generation in W3C VC 2.0 format with random 128-bit `salt`, RFC 8785 (JCS) canonicalization, `leafHash` calculation, ECDSA secp256k1 signing, and sorted-pair Merkle trees.
- Read-only verification engine that queries the blockchain RPC directly and returns all four dimensions (authenticity, issuer legitimacy, academic validity asserted by the issuer, and revocation/expiry) alongside the verdict (`VALID`, `VALID - ISSUER CLOSED`, `REVOKED`, `ISSUER SUSPENDED`, `ISSUED AFTER KEY COMPROMISE - UNDER REVIEW`, `INVALID SIGNATURE`, `TAMPERED`, `ISSUER NOT REGISTERED`, `ANCHOR NOT FOUND`, and `EXPIRED`).
- Independent CLI for verifying `.json` files directly from the terminal without the web portal (scenario S3).
- Automated gas and latency benchmark for batches of 1, 100, and 1,000 credentials (scenario S2) and a comparison script against a local `did:web` baseline (offline S3 and N5 scenarios).

### 1.3. Web interface (`web/`)

React and TypeScript SPA connected directly to the blockchain RPC, with no backend and no database, organized into three tabs.

- **Verify** supports uploading a `.json` file, pasting JSON text, or opening a QR Code link to inspect the verdict and the four verification dimensions.
- **Issue** supports single credentials (S1 and N7) and Merkle tree batches from a holder list or `.csv` import (S2) in one transaction, generating a visual QR Code card, `.json` downloads, revocations (S4 and N3), and issuer key rotation.
- **Governance** lists registered issuers and their key histories from the contract, allowing new issuer registration, suspension (N4), reactivation, permanent closure (`Closed`), and key compromise reporting with an estimated date and time (N5).

## 2. Comparison between course MVP and target product

| Component | Course MVP (PD3) | Target product (White Papers and BMC) |
| :--- | :--- | :--- |
| Contracts | Single contract (`DiploChain.sol`) holding all three registries | Three separate contracts, externally audited and upgradeable with a time-lock |
| Blockchain network | Local Hardhat network with optional Base Sepolia testnet deploy | Public L2 mainnet (Base, Polygon, or Arbitrum) with periodic cross-anchoring on Ethereum L1 |
| Governance | Single governance account and one recovery account per issuer | 3-of-5 multi-sig in Phase 1 and institutional consortium in Phase 2, with a 7-day time-lock |
| Issuer onboarding | Direct registration from the Governance tab | Legal entity verification (CNPJ and legal representative), DNS TXT domain proof, and e-MEC validation |
| Key custody | Built-in local demo accounts inside the client | Managed HSM with role-based access control or multi-party computation (MPC) custody |
| Relayer and billing | Client-side relayer account submitting EIP-712 signatures | Dedicated backend relayer service and operational treasury funded by BRL fees |
| Issuance workflow | Single or batch issuance (holder list and `.csv` import) | Two-step approval, daily issuance limits, and academic ERP integrations |
| Holder delivery | `.json` file download and on-screen QR Code card | PDF generation with QR Code, optional encrypted backup, and LinkedIn sharing |
| Issuer closure | `Closed` status preserving credentials anchored before closure | Transfer of revocation rights to a designated custodian recorded in the contract |
| Optional extensions | Out of MVP scope | Soulbound Token (ERC-5192), cryptographic holder possession challenge, and HR/ATS verification API |
| Legal compliance | Strictly didactic scope | DPO review for LGPD compliance and regulatory assessment under MEC Ordinance 554/2019 |
