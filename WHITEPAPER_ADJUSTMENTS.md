# Technical Adjustments to the Technical White Paper (PD2)

This document records the technical inconsistencies and gaps found in the DiploChain *Technical White Paper* (PD2) and the fixes implemented in the MVP (PD3). Scope simplifications between the MVP and the target product are documented in [MVP_SCOPE.md](./MVP_SCOPE.md).

## 1. Per-issuer revocation isolation

In Section 4.3 of the white paper, `AnchorRegistry` stores only the batch Merkle root (`root`), while `RevocationRegistry.revoke(issuerId, leafHash, reasonCode, issuerSig)` stores the revocation entry directly under `leafHash`. Because the contract does not store individual leaves, it cannot check which issuer owns a given `leafHash`. If issuer B obtained the `leafHash` of a credential issued by A, issuer B could write a revocation under that hash.

To close this gap, the revocation mapping in the contract is indexed by the pair `(issuerId, leafHash)`. Each issuer can only write inside its own revocation namespace without requiring a Merkle proof on every revocation transaction.

## 2. Mapping DID and verificationMethod strings to bytes32

The Solidity interface in Section 4.3 expects `bytes32 issuerId` and `bytes32 keyId`, while the *Verifiable Credential* (VC) JSON in Section 4.4 represents those fields as strings (`issuer` and `proof.verificationMethod`). The specification does not define how to convert the strings into `bytes32`.

The implementation derives both identifiers deterministically using `keccak256` over UTF-8 bytes (`issuerId = keccak256(issuer)` and `keyId = keccak256(proof.verificationMethod)`). Any verifier can therefore resolve both issuer and key in the contract using only the credential JSON file.

## 3. Credential signature encoding

The VC example in Section 4.4 shows `proofValue` in ASN.1 DER format (`0x3045...`). Solidity contracts and EVM libraries work natively with compact 65-byte ECDSA secp256k1 signatures (`r, s, v`).

The implementation uses compact 65-byte secp256k1 signatures over the RFC 8785 (JCS) canonicalized `VC_core`. The cryptographic guarantee remains identical while preserving direct compatibility with `ethers.js` and `ecrecover`, avoiding extra ASN.1 encoding dependencies.

## 4. Merkle tree pair ordering

The `anchorReference.merkleProof` field in Section 4.4 is a flat list of hashes with no left/right position metadata for sibling nodes. Without a deterministic ordering rule, a verifier cannot know in which order to concatenate each pair to recompute the root.

The Merkle tree sorts each pair lexicographically before applying `keccak256`, following the OpenZeppelin standard. This format works with the flat hash array specified in the white paper and treats single-item batches as single-leaf trees (empty `merkleProof` and `merkleRoot` equal to `leafHash`).

## 5. Functions and fields omitted from the specification

The `IDiploChainRegistries` interface in Section 4.3 declares `anchor`, `revoke`, and `reportCompromise`, but omits operations required by the Section 12 evaluation scenarios (PD3), including issuer registration, status transitions (`Suspended` in N4 and `Closed` for `VALID - ISSUER CLOSED`), key rotation, and storing the recovery address (`recoverySigner`). In addition, the VC JSON example in Section 4.4 omits the `validUntil` field required for scenario N7 (`EXPIRED`).

The `DiploChain.sol` contract implements `registerIssuer`, `setIssuerStatus`, `rotateKey`, `anchor`, `revoke`, and `reportCompromise` (supporting retroactive `estimatedTime` for scenario N5), along with per-issuer `nonce` tracking to prevent EIP-712 signature replay. The VC JSON adds the optional ISO-8601 `validUntil` field (W3C VC 2.0).

## 6. Salt placement in leafHash calculation

Section 4.4 defines `leafHash = keccak256(salt || canonical(VC_core))` while also placing the `salt` property inside `VC_core`.

To adhere strictly to the specification and ensure issuer and verifier compute the exact same hash, the implementation strips only `proof` and `anchorReference` before JCS canonicalization and prepends the `salt` bytes to the canonicalized JSON bytes.

## 7. Reason code in the revocation example

Section 5.3 describes a revocation recorded with reason `issuer error`, yet states that the verifier displays `REVOKED - superseded`. Because `IssuerError` and `Superseded` are distinct values in the `RevocationReason` enum, the verifier displays the exact reason code recorded in the contract.

## 8. QR Code payload size for self-contained credentials

A complete VC JSON containing payload, signature, and Merkle proof ranges from 800 to 1,200 bytes, which produces a dense QR Code when encoded as raw text.

In the MVP, the verifier accepts `.json` file uploads as well as QR Code links carrying the base64url-encoded JSON in the URL query parameter (`?vc=...`), keeping credential storage under holder control with no intermediary server.
