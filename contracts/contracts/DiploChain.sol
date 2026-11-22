// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract DiploChain {
    enum IssuerStatus { Pending, Active, Suspended, Closed }
    enum AssuranceLevel { None, L1, L2 }
    enum RevocationReason { None, AdminError, IssuerError, Fraud, Superseded }

    struct IssuerRecord {
        string did;
        AssuranceLevel assuranceLevel;
        IssuerStatus status;
        address recoverySigner;
        uint64 closedAt;
        bool exists;
    }

    struct KeyRecord {
        address signer;
        uint64 validFrom;
        uint64 validUntil;
        uint64 compromisedAt;
        bool exists;
    }

    struct AnchorRecord {
        bytes32 issuerId;
        uint64 blockTimestamp;
        uint32 count;
        bytes32 schemaId;
        bytes32 keyId;
        bool exists;
    }

    struct RevocationRecord {
        uint64 revokedAt;
        RevocationReason reason;
        bool exists;
    }

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("DiploChain");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant ANCHOR_TYPEHASH =
        keccak256("Anchor(bytes32 issuerId,bytes32 root,uint32 count,bytes32 schemaId,bytes32 keyId,uint256 nonce)");
    bytes32 private constant REVOKE_TYPEHASH =
        keccak256("Revoke(bytes32 issuerId,bytes32 leafHash,uint8 reason,bytes32 keyId,uint256 nonce)");
    bytes32 private constant ROTATE_KEY_TYPEHASH =
        keccak256("RotateKey(bytes32 issuerId,bytes32 oldKeyId,bytes32 newKeyId,address newSigner,uint256 nonce)");
    bytes32 private constant COMPROMISE_TYPEHASH =
        keccak256("ReportCompromise(bytes32 issuerId,bytes32 keyId,uint64 estimatedTime,uint256 nonce)");

    address public governance;
    mapping(bytes32 => IssuerRecord) public issuers;
    mapping(bytes32 => mapping(bytes32 => KeyRecord)) public issuerKeys;
    mapping(bytes32 => AnchorRecord) public anchors;
    mapping(bytes32 => mapping(bytes32 => RevocationRecord)) public revocations;
    mapping(bytes32 => uint256) public nonces;

    bytes32[] public issuerList;
    mapping(bytes32 => bytes32[]) private issuerKeyList;

    event IssuerRegistered(bytes32 indexed issuerId, string did, AssuranceLevel assuranceLevel, address recoverySigner, bytes32 initialKeyId, address initialSigner);
    event IssuerStatusChanged(bytes32 indexed issuerId, IssuerStatus status, uint64 timestamp);
    event KeyRotated(bytes32 indexed issuerId, bytes32 indexed oldKeyId, bytes32 indexed newKeyId, address newSigner, uint64 timestamp);
    event KeyCompromised(bytes32 indexed issuerId, bytes32 indexed keyId, uint64 estimatedTime, uint64 reportedAt);
    event AnchorRecorded(bytes32 indexed issuerId, bytes32 indexed root, uint32 count, bytes32 schemaId, bytes32 keyId, uint64 blockTimestamp);
    event CredentialRevoked(bytes32 indexed issuerId, bytes32 indexed leafHash, RevocationReason reason, uint64 revokedAt);

    modifier onlyGovernance() {
        require(msg.sender == governance, "Only governance");
        _;
    }

    constructor() {
        governance = msg.sender;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function getIssuerIds() external view returns (bytes32[] memory) {
        return issuerList;
    }

    function getIssuerKeyIds(bytes32 issuerId) external view returns (bytes32[] memory) {
        return issuerKeyList[issuerId];
    }

    function registerIssuer(
        string calldata did,
        AssuranceLevel assuranceLevel,
        address recoverySigner,
        bytes32 initialKeyId,
        address initialSigner
    ) external onlyGovernance returns (bytes32 issuerId) {
        require(bytes(did).length > 0, "Empty DID");
        require(assuranceLevel != AssuranceLevel.None, "Invalid assurance level");
        require(recoverySigner != address(0), "Invalid recovery signer");
        require(initialSigner != address(0), "Invalid initial signer");
        require(initialKeyId != bytes32(0), "Invalid keyId");

        issuerId = keccak256(bytes(did));
        require(!issuers[issuerId].exists, "Issuer already registered");

        issuers[issuerId] = IssuerRecord(did, assuranceLevel, IssuerStatus.Active, recoverySigner, 0, true);
        issuerKeys[issuerId][initialKeyId] = KeyRecord(initialSigner, uint64(block.timestamp), 0, 0, true);
        issuerList.push(issuerId);
        issuerKeyList[issuerId].push(initialKeyId);

        emit IssuerRegistered(issuerId, did, assuranceLevel, recoverySigner, initialKeyId, initialSigner);
    }

    function setIssuerStatus(bytes32 issuerId, IssuerStatus newStatus) external onlyGovernance {
        IssuerRecord storage issuer = issuers[issuerId];
        require(issuer.exists, "Issuer not found");
        require(issuer.status != IssuerStatus.Closed, "Issuer permanently closed");

        issuer.status = newStatus;
        if (newStatus == IssuerStatus.Closed) {
            issuer.closedAt = uint64(block.timestamp);
        }
        emit IssuerStatusChanged(issuerId, newStatus, uint64(block.timestamp));
    }

    function rotateKey(
        bytes32 issuerId,
        bytes32 oldKeyId,
        bytes32 newKeyId,
        address newSigner,
        uint256 nonce,
        bytes calldata issuerSig
    ) external {
        require(newKeyId != bytes32(0) && newSigner != address(0), "Invalid new key");
        require(!issuerKeys[issuerId][newKeyId].exists, "New key already exists");

        bytes32 structHash = keccak256(abi.encode(ROTATE_KEY_TYPEHASH, issuerId, oldKeyId, newKeyId, newSigner, nonce));
        _consumeIssuerAuth(issuerId, oldKeyId, nonce, structHash, issuerSig, "Old key not active");

        uint64 nowTs = uint64(block.timestamp);
        issuerKeys[issuerId][oldKeyId].validUntil = nowTs;
        issuerKeys[issuerId][newKeyId] = KeyRecord(newSigner, nowTs, 0, 0, true);
        issuerKeyList[issuerId].push(newKeyId);

        emit KeyRotated(issuerId, oldKeyId, newKeyId, newSigner, nowTs);
    }

    function anchor(
        bytes32 issuerId,
        bytes32 root,
        uint32 count,
        bytes32 schemaId,
        bytes32 keyId,
        uint256 nonce,
        bytes calldata issuerSig
    ) external {
        require(root != bytes32(0) && count > 0, "Invalid anchor");
        require(!anchors[root].exists, "Anchor already exists");

        bytes32 structHash = keccak256(abi.encode(ANCHOR_TYPEHASH, issuerId, root, count, schemaId, keyId, nonce));
        _consumeIssuerAuth(issuerId, keyId, nonce, structHash, issuerSig, "Key not active");

        uint64 nowTs = uint64(block.timestamp);
        anchors[root] = AnchorRecord(issuerId, nowTs, count, schemaId, keyId, true);

        emit AnchorRecorded(issuerId, root, count, schemaId, keyId, nowTs);
    }

    function revoke(
        bytes32 issuerId,
        bytes32 leafHash,
        RevocationReason reason,
        bytes32 keyId,
        uint256 nonce,
        bytes calldata issuerSig
    ) external {
        require(leafHash != bytes32(0), "Invalid leafHash");
        require(reason != RevocationReason.None, "Invalid reason");
        require(!revocations[issuerId][leafHash].exists, "Already revoked");

        bytes32 structHash = keccak256(abi.encode(REVOKE_TYPEHASH, issuerId, leafHash, uint8(reason), keyId, nonce));
        _consumeIssuerAuth(issuerId, keyId, nonce, structHash, issuerSig, "Key not active");

        uint64 nowTs = uint64(block.timestamp);
        revocations[issuerId][leafHash] = RevocationRecord(nowTs, reason, true);

        emit CredentialRevoked(issuerId, leafHash, reason, nowTs);
    }

    function reportCompromise(
        bytes32 issuerId,
        bytes32 keyId,
        uint64 estimatedTime,
        uint256 nonce,
        bytes calldata recoverySig
    ) external {
        IssuerRecord storage issuer = issuers[issuerId];
        require(issuer.exists, "Issuer not found");

        KeyRecord storage key = issuerKeys[issuerId][keyId];
        require(key.exists, "Key not found");
        require(key.compromisedAt == 0, "Already reported compromised");
        require(estimatedTime > 0 && estimatedTime <= block.timestamp, "Invalid estimatedTime");
        require(nonce == nonces[issuerId], "Invalid nonce");

        bytes32 structHash = keccak256(abi.encode(COMPROMISE_TYPEHASH, issuerId, keyId, estimatedTime, nonce));
        require(_recoverSigner(structHash, recoverySig) == issuer.recoverySigner, "Invalid recovery signature");

        nonces[issuerId] = nonce + 1;
        uint64 nowTs = uint64(block.timestamp);
        key.compromisedAt = estimatedTime;
        if (key.validUntil == 0) {
            key.validUntil = nowTs;
        }
        emit KeyCompromised(issuerId, keyId, estimatedTime, nowTs);
    }

    function _consumeIssuerAuth(
        bytes32 issuerId,
        bytes32 keyId,
        uint256 nonce,
        bytes32 structHash,
        bytes calldata sig,
        string memory inactiveKeyMsg
    ) internal {
        IssuerRecord storage issuer = issuers[issuerId];
        require(issuer.exists && issuer.status == IssuerStatus.Active, "Issuer not active");
        KeyRecord storage key = issuerKeys[issuerId][keyId];
        require(_isKeyCurrentlyActive(key), inactiveKeyMsg);
        require(nonce == nonces[issuerId], "Invalid nonce");
        require(_recoverSigner(structHash, sig) == key.signer, "Invalid issuer signature");
        nonces[issuerId] = nonce + 1;
    }

    function _isKeyCurrentlyActive(KeyRecord storage key) internal view returns (bool) {
        return
            key.exists &&
            key.compromisedAt == 0 &&
            block.timestamp >= key.validFrom &&
            (key.validUntil == 0 || block.timestamp < key.validUntil);
    }

    function _recoverSigner(bytes32 structHash, bytes calldata sig) internal view returns (address) {
        require(sig.length == 65, "Invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Invalid v");
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "Invalid s");
        address recovered = ecrecover(keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash)), v, r, s);
        require(recovered != address(0), "Invalid signature");
        return recovered;
    }
}
