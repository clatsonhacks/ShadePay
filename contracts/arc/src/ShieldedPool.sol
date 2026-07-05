// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./IncrementalMerkleTree.sol";
import "./CommitteeRegistry.sol";
import "./interfaces/IVerifiers.sol";

interface INullifierRegistry {
    function spend(bytes32 nullifier) external returns (bool);
    function isSpent(bytes32 nullifier) external view returns (bool);
}

/// @dev Circle CCTP TokenMessenger (v2 depositForBurn) on Arc — outbound USDC burn.
interface ITokenMessenger {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

/**
 * @title ShieldedPool
 * @notice Faithful EVM/Arc port of `contracts/stellar/shielded_pool/src/lib.rs`
 *         — the canonical Shade settlement contract. ALL settlement paths are
 *         preserved: deposit (note mint), withdraw, private transfer, and MPC
 *         settlement (same-asset and priced cross-asset). Only the chain changes.
 *
 * Differences from Soroban (behavior-preserving):
 *   - BLS12-381 -> BN254; verifiers are snarkjs-generated Solidity contracts.
 *   - O(n) tree rebuild -> O(log n) frontier tree (IncrementalMerkleTree). The
 *     root is computed on-chain authoritatively; the Soroban `new_root` arg
 *     (never trusted, only cross-checked) is dropped as redundant.
 *   - Public signals arrive as native uint256[] instead of byte-encoded blobs.
 *   - Stellar SAC tokens -> ERC-20; ed25519 committee check delegated to a
 *     pluggable verifier (no EVM precompile) with identical threshold semantics.
 *   - Amounts are uint256 (circuits range-check to 128 bits).
 *
 * Operation types (bound into proof public signals), identical to Soroban:
 */
contract ShieldedPool is AccessControl, Pausable, IncrementalMerkleTree {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    // operation types bound into deposit/withdraw proofs (proof signal [1]).
    int256 internal constant OP_WITHDRAW_PUBLIC = 1;
    int256 internal constant OP_WITHDRAW_CCTP = 2;
    int256 internal constant OP_RFQ_SETTLEMENT = 3;
    int256 internal constant OP_DEPOSIT_NOTE_MINT = 4;
    int256 internal constant OP_RFQ_ATOMIC_SWAP = 5;
    int256 internal constant PRICE_SCALE = 1_000_000_000;

    // domain separators bound into every spend proof.
    uint256 public immutable poolId;
    uint256 public immutable chainId;

    // verifiers (one per circuit)
    IWithdrawVerifier public withdrawVerifier;
    ITransferVerifier public transferVerifier;
    IDepositVerifier public depositVerifier;
    IMpcSettlementVerifier public mpcVerifier;
    IMpcPricedSettlementVerifier public mpcPricedVerifier;

    INullifierRegistry public immutable nullifierRegistry;

    // ASP allowlist root that spend proofs must match.
    uint256 public associationRoot;

    // asset registry: asset_id (field element) => ERC-20 token
    mapping(uint256 => address) public assetToken;
    // per-asset shielded note supply (7dp)
    mapping(uint256 => int256) public noteSupplyOf;

    // MPC committee (ed25519 pubkeys) + threshold check delegate
    bytes32[] internal _committee;
    IEd25519Verifier public ed25519Verifier;

    // authorized RFQ solver ed25519 pubkeys
    mapping(bytes32 => bool) public authorizedSolver;
    // CCTP destination domain allowed for outbound burns (e.g. Arbitrum Sepolia = 3)
    uint32 public cctpOutboundDomain;
    // Arc CCTP TokenMessenger for outbound burns (injectable)
    ITokenMessenger public tokenMessenger;
    // USDC token (CCTP exit is USDC-only)
    address public usdcToken;

    // duplicate-deposit guard (cctp nonce => used)
    mapping(bytes32 => bool) public depositUsed;

    // authorized StreamEscrow contract(s) allowed to insert channel notes
    // (change/payee/refund/reclaim) into this pool's shared tree. Value is
    // conserved in-circuit by the stream_open/stream_settle circuits, so a
    // stream insert carries an explicit signed supply delta the escrow computes.
    mapping(address => bool) public authorizedStreamContract;

    // ---- events (mirror Soroban event topics) ----
    event Deposit(
        uint32 indexed sourceDomain,
        bytes32 cctpNonce,
        uint256 assetId,
        uint256 amount,
        uint256 commitment,
        uint32 leafIndex,
        uint256 newRoot
    );
    event Withdraw(address indexed to, uint256 nullifierHash, uint256 net, uint256 relayerFee);
    event Transfer(uint256 nullifierHash, uint256 outputCommitment, uint32 leafIndex, uint256 newRoot);
    event MpcSettled(
        bytes32 indexed batchHash,
        uint256 nullifierA,
        uint256 nullifierB,
        uint256 outputCommitmentA,
        uint256 outputCommitmentB,
        uint256 newRoot
    );
    event AssetRegistered(uint256 indexed assetId, address token);
    event AssociationRootSet(uint256 root);
    event CommitteeSet(uint256 size);

    // ---- errors (mirror Soroban Error enum) ----
    error DuplicateDeposit();
    error UnknownRoot();
    error ProofInvalid();
    error BadAmount();
    error WrongDomain();
    error WrongAssociation();
    error WrongOperation();
    error WrongRecipient();
    error Expired();
    error WrongCommitment();
    error WrongDepositField();
    error UnknownAsset();
    error AssetAlreadyRegistered();
    error MpcSignalMismatch();
    error MpcProofInvalid();
    error NotCrossAsset();
    error SupplyUnderflow();
    error ReserveBroken();
    error InsufficientBalance();
    error UnauthorizedSolver();
    error WrongQuote();
    error WrongIntent();
    error WrongFillReceipt();
    error WrongDestDomain();
    error WrongDestRecipient();
    error WrongMaxFee();
    error WrongFinality();
    error UnsupportedDomain();
    error SolverSigInvalid();
    error SameAssetSwap();
    error UnderDelivered();

    constructor(
        address admin,
        address _nullifierRegistry,
        uint256 _poolId,
        uint256 _chainId,
        uint32 _treeDepth,
        IPoseidon2 _poseidon2
    ) IncrementalMerkleTree(_treeDepth, _poseidon2) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
        poolId = _poolId;
        chainId = _chainId;
        nullifierRegistry = INullifierRegistry(_nullifierRegistry);
    }

    // ============================================================
    // Deposit — note mint bound to a CCTP message (deposit_note_mint circuit)
    // Deposit pub signals (14): [0] commitment [1] operationType [2] sourceDomain
    // [3] destinationDomain [4] cctpNonceHash [5] burnTxHashHash [6] amount6dp
    // [7] amount7dp [8] assetIdHash [9] recipientPool [10] encryptedNotePayloadHash
    // [11] policyIdHash [12] poolId [13] chainId
    // ============================================================
    function receiveDeposit(
        uint32 sourceDomain,
        bytes32 cctpNonce,
        address token,
        uint256 amount,
        uint256 commitment,
        uint256 encryptedNotePayloadHash,
        uint256 policyId,
        Groth16Proof calldata proof,
        uint256[14] calldata pub
    ) external whenNotPaused onlyRole(REGISTRAR_ROLE) returns (uint32) {
        if (amount == 0) revert BadAmount();
        if (depositUsed[cctpNonce]) revert DuplicateDeposit();

        // [0] commitment output must equal the leaf we are inserting.
        if (pub[0] != commitment) revert WrongCommitment();
        // [1] operation type must be DEPOSIT_NOTE_MINT.
        if (int256(pub[1]) != OP_DEPOSIT_NOTE_MINT) revert WrongOperation();
        // [2] source domain, [7] minted 7dp amount must match the args.
        if (pub[2] != sourceDomain) revert WrongDepositField();
        if (pub[7] != amount) revert WrongDepositField();
        // [5] burn-tx hash must be bound (non-zero).
        if (pub[5] == 0) revert WrongDepositField();
        // [6] amount6dp positive and consistent: amount6dp*10 >= amount7dp.
        if (pub[6] == 0 || pub[6] * 10 < amount) revert WrongDepositField();
        // [4] cctp nonce, [10] encrypted-note-payload, [11] policy id (reduced to field).
        if (_hashToField(cctpNonce) != pub[4]) revert WrongDepositField();
        if (_hashToFieldU(encryptedNotePayloadHash) != pub[10]) revert WrongDepositField();
        if (_hashToFieldU(policyId) != pub[11]) revert WrongDepositField();
        // [8] asset id = hash(token), [9] recipient pool = hash(this).
        if (_addressHash(token) != pub[8]) revert WrongDepositField();
        if (_addressHash(address(this)) != pub[9]) revert WrongDepositField();
        // [12] poolId, [13] chainId must match this pool's domain.
        if (pub[12] != poolId || pub[13] != chainId) revert WrongDomain();

        // Verify the DepositNoteMint Groth16 proof.
        if (!depositVerifier.verifyProof(proof.a, proof.b, proof.c, pub)) {
            revert ProofInvalid();
        }

        // insert leaf, compute new root on-chain (O(log n))
        uint32 leafIndex = _insert(commitment);
        depositUsed[cctpNonce] = true;

        // per-asset supply (signal[8] IS the field asset id; asset must be registered)
        _adjustNoteSupply(pub[8], int256(amount));

        emit Deposit(sourceDomain, cctpNonce, pub[8], amount, commitment, leafIndex, getRoot());
        return leafIndex;
    }

    // ============================================================
    // Withdraw (withdraw_public circuit, operationType = WITHDRAW)
    // Withdraw pub signals (18): [0] nullifierHash [1] operationType [2] withdrawnValue
    // [3] recipientHash [4] relayerFee [5] deadline [6] stateRoot [7] associationRoot
    // [8] poolId [9] chainId ... [17] assetId
    // ============================================================
    function withdraw(
        address to,
        Groth16Proof calldata proof,
        uint256[18] calldata pub
    ) external whenNotPaused {
        int256 opType = int256(pub[1]);
        bytes32 nullifierHash = bytes32(pub[0]);
        uint256 withdrawnValue = pub[2];
        uint256 recipientHash = pub[3];
        uint256 relayerFee = pub[4];
        uint256 deadline = pub[5];
        uint256 stateRoot = pub[6];
        uint256 assetId = pub[17];

        if (opType != OP_WITHDRAW_PUBLIC) revert WrongOperation();
        if (withdrawnValue == 0 || relayerFee > withdrawnValue) revert BadAmount();
        // deadline must not be expired.
        if (block.number > deadline) revert Expired();
        // recipient binding: proof's recipientHash must equal hash(to).
        if (recipientHash != _addressHash(to)) revert WrongRecipient();
        // bind pool/chain domain + ASP root.
        _checkDomainCompliance(pub[7], pub[8], pub[9]);
        // state root must be known.
        if (!isKnownRoot(stateRoot)) revert UnknownRoot();

        if (!withdrawVerifier.verifyProof(proof.a, proof.b, proof.c, pub)) {
            revert ProofInvalid();
        }

        // spend nullifier once (reverts on double-spend)
        nullifierRegistry.spend(nullifierHash);

        // release net in the note's asset; fee stays in the pool.
        uint256 net = withdrawnValue - relayerFee;
        address token = _getAssetToken(assetId);
        if (IERC20(token).balanceOf(address(this)) < net) revert InsufficientBalance();
        IERC20(token).safeTransfer(to, net);
        _adjustNoteSupply(assetId, -int256(withdrawnValue));

        emit Withdraw(to, uint256(nullifierHash), net, relayerFee);
    }

    // ============================================================
    // Private transfer (private_transfer circuit)
    // pub signals (9): [0] nullifierHash [1] outputCommitment [2] feePublic
    // [3] stateRoot [4] associationRoot [5] poolId [6] chainId [7] inAsset [8] outAsset
    // ============================================================
    function privateTransferSettle(
        Groth16Proof calldata proof,
        uint256[9] calldata pub
    ) external whenNotPaused onlyRole(REGISTRAR_ROLE) {
        bytes32 nullifierHash = bytes32(pub[0]);
        uint256 outputCommitment = pub[1];
        uint256 stateRoot = pub[3];

        // ASP allowlist envelope (same as deposit/withdraw).
        if (pub[4] != associationRoot) revert WrongAssociation();
        if (pub[5] != poolId || pub[6] != chainId) revert WrongDomain();
        if (!isKnownRoot(stateRoot)) revert UnknownRoot();

        if (!transferVerifier.verifyProof(proof.a, proof.b, proof.c, pub)) {
            revert ProofInvalid();
        }

        nullifierRegistry.spend(nullifierHash);

        uint32 leafIndex = _insert(outputCommitment);
        emit Transfer(uint256(nullifierHash), outputCommitment, leafIndex, getRoot());
    }

    // ============================================================
    // RFQ settle (Path A: solver-fronted proof-of-fill) — shares the withdraw
    // circuit with operationType = RFQ_SETTLEMENT. The solver already delivered
    // output funds off-chain; this reimburses the solver from the pool after
    // verifying the user's note proof + the solver's ed25519 signature over the
    // quote, and binding quote/intent/fill hashes into the proof.
    // ============================================================
    event RfqSettled(bytes32 indexed quoteHash, address toSolver, uint256 nullifierHash, uint256 credit);

    function rfqSettle(
        address toSolver,
        bytes32 quoteHash,
        bytes32 intentHash,
        bytes32 fillReceiptHash,
        bytes32 solverPubkey,
        bytes calldata solverSig,
        Groth16Proof calldata proof,
        uint256[18] calldata pub
    ) external whenNotPaused {
        // solver key must be registered.
        if (!authorizedSolver[solverPubkey]) revert UnauthorizedSolver();
        // solver signed this exact quote.
        if (!ed25519Verifier.verify(solverPubkey, abi.encodePacked(quoteHash), solverSig)) {
            revert SolverSigInvalid();
        }

        if (int256(pub[1]) != OP_RFQ_SETTLEMENT) revert WrongOperation();
        uint256 credit = pub[2];
        uint256 relayerFee = pub[4];
        if (credit == 0 || relayerFee > credit) revert BadAmount();
        if (block.number > pub[5]) revert Expired();
        // full RFQ-term binding.
        if (_hashToField(quoteHash) != pub[10]) revert WrongQuote();
        if (_hashToField(intentHash) != pub[11]) revert WrongIntent();
        if (_hashToField(fillReceiptHash) != pub[12]) revert WrongFillReceipt();
        _checkDomainCompliance(pub[7], pub[8], pub[9]);
        if (!isKnownRoot(pub[6])) revert UnknownRoot();

        if (!withdrawVerifier.verifyProof(proof.a, proof.b, proof.c, pub)) {
            revert ProofInvalid();
        }

        nullifierRegistry.spend(bytes32(pub[0]));

        // reimburse the solver from the pool in the note's asset.
        address token = _getAssetToken(pub[17]);
        if (IERC20(token).balanceOf(address(this)) < credit) revert InsufficientBalance();
        IERC20(token).safeTransfer(toSolver, credit);
        _adjustNoteSupply(pub[17], -int256(credit));

        emit RfqSettled(quoteHash, toSolver, pub[0], credit);
    }

    // ============================================================
    // Withdraw via CCTP — burn pool USDC outbound to another chain.
    // Shares the withdraw circuit with operationType = WITHDRAW_CCTP; destination
    // bindings (domain/recipient/maxFee/finality) are proof-bound so a relayer
    // cannot mutate the outbound terms.
    // ============================================================
    event CctpExit(uint32 indexed destinationDomain, address to, uint256 nullifierHash, uint256 amount);

    function withdrawCctp(
        address to,
        bytes32 destinationRecipient,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        Groth16Proof calldata proof,
        uint256[18] calldata pub
    ) external whenNotPaused returns (uint256) {
        uint256 amount = pub[2];
        if (amount == 0) revert BadAmount();
        if (int256(pub[1]) != OP_WITHDRAW_CCTP) revert WrongOperation();
        // CCTP exit is USDC-only: note asset must be the registered USDC asset.
        if (pub[17] != _addressHash(usdcToken)) revert UnknownAsset();
        if (block.number > pub[5]) revert Expired();
        if (uint32(pub[13]) != cctpOutboundDomain) revert UnsupportedDomain();
        // destination bindings.
        if (pub[13] != uint256(cctpOutboundDomain)) revert WrongDestDomain();
        if (pub[14] != uint256(destinationRecipient)) revert WrongDestRecipient();
        if (pub[15] != maxFee) revert WrongMaxFee();
        if (pub[16] != uint256(minFinalityThreshold)) revert WrongFinality();
        _checkDomainCompliance(pub[7], pub[8], pub[9]);
        if (!isKnownRoot(pub[6])) revert UnknownRoot();

        if (!withdrawVerifier.verifyProof(proof.a, proof.b, proof.c, pub)) {
            revert ProofInvalid();
        }

        nullifierRegistry.spend(bytes32(pub[0]));

        // burn pool USDC outbound via CCTP.
        uint256 pullAmount = amount + maxFee;
        IERC20(usdcToken).forceApprove(address(tokenMessenger), pullAmount);
        tokenMessenger.depositForBurn(
            amount,
            cctpOutboundDomain,
            destinationRecipient,
            usdcToken,
            bytes32(0), // anyone can complete on the destination chain
            maxFee,
            minFinalityThreshold
        );
        _adjustNoteSupply(pub[17], -int256(amount));

        emit CctpExit(cctpOutboundDomain, to, pub[0], amount);
        return amount;
    }

    // ============================================================
    // RFQ solver registry + CCTP config
    // ============================================================
    function setAuthorizedSolver(bytes32 solverPubkey, bool allowed) external onlyRole(ADMIN_ROLE) {
        authorizedSolver[solverPubkey] = allowed;
    }

    function isAuthorizedSolver(bytes32 solverPubkey) external view returns (bool) {
        return authorizedSolver[solverPubkey];
    }

    function setCctpConfig(address _tokenMessenger, address _usdc, uint32 _outboundDomain)
        external onlyRole(ADMIN_ROLE)
    {
        tokenMessenger = ITokenMessenger(_tokenMessenger);
        usdcToken = _usdc;
        cctpOutboundDomain = _outboundDomain;
    }

    // ============================================================
    // MPC settle — same-asset committee match (mpc_settlement circuit)
    // pub signals (12): [0] nullA [1] nullB [2] outCommA [3] outCommB [4] stateRoot
    // [5] associationRoot [6] batchHash [7] poolId [8] chainId [9] matchedAmount7dp
    // [10] deadline [11] (assetId)
    // ============================================================
    function mpcSettle(
        bytes32 batchHash,
        bytes32[] calldata signerPubkeys,
        bytes[] calldata signatures,
        Groth16Proof calldata proof,
        uint256[12] calldata pub
    ) external whenNotPaused {
        // committee threshold over DISTINCT registered signers.
        CommitteeLib.verifyThreshold(_committee, ed25519Verifier, batchHash, signerPubkeys, signatures);

        // ZK proof mandatory (fail-closed).
        if (!mpcVerifier.verifyProof(proof.a, proof.b, proof.c, pub)) {
            revert MpcProofInvalid();
        }

        // [4] stateRoot must be known.
        if (!isKnownRoot(pub[4])) revert UnknownRoot();
        // [5] associationRoot must equal canonical ASP root (fail-closed if unset).
        if (associationRoot == 0 || pub[5] != associationRoot) revert WrongAssociation();
        // [6] batchHash field element must match hashToField(batchHash).
        if (pub[6] != _hashToField(batchHash)) revert MpcSignalMismatch();
        // [7][8] domain.
        if (pub[7] != poolId || pub[8] != chainId) revert WrongDomain();
        // [10] deadline not in the past.
        if (block.number > pub[10]) revert Expired();

        // spend both nullifiers atomically.
        nullifierRegistry.spend(bytes32(pub[0]));
        nullifierRegistry.spend(bytes32(pub[1]));

        // append BOTH output commitments on-chain.
        _insert(pub[2]);
        _insert(pub[3]);

        emit MpcSettled(batchHash, pub[0], pub[1], pub[2], pub[3], getRoot());
    }

    // ============================================================
    // MPC settle priced — cross-asset committee match (mpc_priced_settlement)
    // pub signals (20): [0] nullA [1] nullB [2] outCommA [3] outCommB [4] stateRoot
    // [5] associationRoot [6] batchHash [7] poolId [8] chainId [9] deadline
    // [10] inAssetA [11] outAssetA [12] inAssetB [13] outAssetB [14] matchedAmountA
    // [15] matchedAmountB [16] priceScaled [17] priceScale [18] minOutputA [19] minOutputB
    // ============================================================
    function mpcSettlePriced(
        bytes32 batchHash,
        bytes32[] calldata signerPubkeys,
        bytes[] calldata signatures,
        Groth16Proof calldata proof,
        uint256[20] calldata pub
    ) external whenNotPaused {
        CommitteeLib.verifyThreshold(_committee, ed25519Verifier, batchHash, signerPubkeys, signatures);

        if (!mpcPricedVerifier.verifyProof(proof.a, proof.b, proof.c, pub)) {
            revert MpcProofInvalid();
        }

        if (!isKnownRoot(pub[4])) revert UnknownRoot();
        if (associationRoot == 0 || pub[5] != associationRoot) revert WrongAssociation();
        if (pub[6] != _hashToField(batchHash)) revert MpcSignalMismatch();
        if (pub[7] != poolId || pub[8] != chainId) revert WrongDomain();
        if (block.number > pub[9]) revert Expired();
        // cross-asset: input assets must differ (in-circuit also enforced).
        if (pub[10] == pub[12]) revert NotCrossAsset();

        nullifierRegistry.spend(bytes32(pub[0]));
        nullifierRegistry.spend(bytes32(pub[1]));

        _insert(pub[2]);
        _insert(pub[3]);

        emit MpcSettled(batchHash, pub[0], pub[1], pub[2], pub[3], getRoot());
    }

    // ============================================================
    // Asset registry
    // ============================================================
    function registerAsset(uint256 assetId, address token) external onlyRole(ADMIN_ROLE) {
        if (assetToken[assetId] != address(0)) revert AssetAlreadyRegistered();
        assetToken[assetId] = token;
        noteSupplyOf[assetId] = 0;
        emit AssetRegistered(assetId, token);
    }

    function getAssetToken(uint256 assetId) external view returns (address) {
        return _getAssetToken(assetId);
    }

    function noteSupply(uint256 assetId) external view returns (int256) {
        return noteSupplyOf[assetId];
    }

    function vaultBalance(uint256 assetId) public view returns (uint256) {
        return IERC20(_getAssetToken(assetId)).balanceOf(address(this));
    }

    function proofOfReserves(uint256 assetId) external view returns (int256 supply, uint256 balance) {
        return (noteSupplyOf[assetId], vaultBalance(assetId));
    }

    // ============================================================
    // Association root
    // ============================================================
    function setAssociationRoot(uint256 root) external onlyRole(ADMIN_ROLE) {
        associationRoot = root;
        emit AssociationRootSet(root);
    }

    function getAssociationRoot() external view returns (uint256) {
        return associationRoot;
    }

    // ============================================================
    // Committee management
    // ============================================================
    function setCommittee(bytes32[] calldata pubkeys) external onlyRole(ADMIN_ROLE) {
        delete _committee;
        for (uint256 i = 0; i < pubkeys.length; i++) {
            _committee.push(pubkeys[i]);
        }
        emit CommitteeSet(pubkeys.length);
    }

    function getCommittee() external view returns (bytes32[] memory) {
        return _committee;
    }

    function setEd25519Verifier(address v) external onlyRole(ADMIN_ROLE) {
        ed25519Verifier = IEd25519Verifier(v);
    }

    // ============================================================
    // Verifier setters
    // ============================================================
    function setWithdrawVerifier(address v) external onlyRole(ADMIN_ROLE) {
        withdrawVerifier = IWithdrawVerifier(v);
    }

    function setTransferVerifier(address v) external onlyRole(ADMIN_ROLE) {
        transferVerifier = ITransferVerifier(v);
    }

    function setDepositVerifier(address v) external onlyRole(ADMIN_ROLE) {
        depositVerifier = IDepositVerifier(v);
    }

    function setMpcVerifier(address v) external onlyRole(ADMIN_ROLE) {
        mpcVerifier = IMpcSettlementVerifier(v);
    }

    function setMpcPricedVerifier(address v) external onlyRole(ADMIN_ROLE) {
        mpcPricedVerifier = IMpcPricedSettlementVerifier(v);
    }

    // ============================================================
    // Admin
    // ============================================================
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ============================================================
    // Stream escrow integration
    // ============================================================
    error UnauthorizedStreamContract();

    event StreamContractSet(address indexed streamContract, bool allowed);

    function setAuthorizedStreamContract(address streamContract, bool allowed) external onlyRole(ADMIN_ROLE) {
        authorizedStreamContract[streamContract] = allowed;
        emit StreamContractSet(streamContract, allowed);
    }

    /**
     * @notice Insert a channel note into the shared tree, adjusting the asset's
     *         note supply by `supplyDelta`. Callable only by an authorized
     *         StreamEscrow. The stream_open/stream_settle circuits enforce value
     *         conservation, so the escrow is trusted only to pass a supply delta
     *         consistent with those proofs (e.g. open: -cap once the reserved
     *         amount leaves the note set; settle/reclaim: +cap when it re-enters).
     *         The pool still enforces its own reserve invariant on every delta.
     * @return leafIndex the inserted leaf's index
     */
    function streamInsert(uint256 assetId, uint256 commitment, int256 supplyDelta)
        external
        whenNotPaused
        returns (uint32 leafIndex)
    {
        if (!authorizedStreamContract[msg.sender]) revert UnauthorizedStreamContract();
        if (supplyDelta != 0) _adjustNoteSupply(assetId, supplyDelta);
        leafIndex = _insert(commitment);
    }

    // ============================================================
    // Internal helpers
    // ============================================================
    function _getAssetToken(uint256 assetId) internal view returns (address) {
        address t = assetToken[assetId];
        if (t == address(0)) revert UnknownAsset();
        return t;
    }

    function _adjustNoteSupply(uint256 assetId, int256 delta) internal {
        // asset must be registered (fail-closed).
        if (assetToken[assetId] == address(0)) revert UnknownAsset();
        int256 next = noteSupplyOf[assetId] + delta;
        if (next < 0) revert SupplyUnderflow();
        // reserve invariant: note_supply must not exceed vault balance.
        if (uint256(next) > vaultBalance(assetId)) revert ReserveBroken();
        noteSupplyOf[assetId] = next;
    }

    function _checkDomainCompliance(uint256 assocIn, uint256 poolIn, uint256 chainIn) internal view {
        if (poolIn != poolId || chainIn != chainId) revert WrongDomain();
        if (assocIn != associationRoot) revert WrongAssociation();
    }

    /// @dev sha256(x) reduced to a 248-bit field element (top 31 bytes), matching
    ///      the Soroban `hash_to_field = int(sha256(..)[:31])`.
    function _hashToField(bytes32 h) internal pure returns (uint256) {
        return uint256(sha256(abi.encodePacked(h))) >> 8;
    }

    function _hashToFieldU(uint256 h) internal pure returns (uint256) {
        return uint256(sha256(abi.encodePacked(bytes32(h)))) >> 8;
    }

    /// @dev recipient/asset binding hash: sha256(addr) reduced to a field element.
    ///      The off-chain witness builder MUST use the same convention.
    function _addressHash(address a) internal pure returns (uint256) {
        return uint256(sha256(abi.encodePacked(a))) >> 8;
    }
}
