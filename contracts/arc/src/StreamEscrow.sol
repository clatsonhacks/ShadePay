// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./interfaces/IVerifiers.sol";

interface INullifierRegistryForStream {
    function spend(bytes32 nullifier) external returns (bool);
    function isSpent(bytes32 nullifier) external view returns (bool);
}

interface IShieldedPoolForStream {
    function poolId() external view returns (uint256);
    function chainId() external view returns (uint256);
    function getAssociationRoot() external view returns (uint256);
    function isKnownRoot(uint256 root) external view returns (bool);
    function streamInsert(uint256 assetId, uint256 commitment, int256 supplyDelta) external returns (uint32);
}

/**
 * @title StreamEscrow
 * @notice Shade Streams — the on-chain anchor for unidirectional payment channels
 *         over shielded notes. Three operations mirror the design:
 *
 *  OPEN (1 ZK proof, stream_open circuit): spend the payer's input note N (value
 *    V), reserve `cap` L for the channel, mint a change note (V-L) and record the
 *    channel bound to the payer's EdDSA pubkey + expiry. A "reclaim" note (worth
 *    L) is committed at open and inserted only if the channel times out.
 *
 *  STREAM (0 chain writes): the payer signs monotonic vouchers off-chain
 *    (packages/sdk/src/streams.ts); the payee tracks the highest one. Nothing
 *    on-chain happens.
 *
 *  SETTLE (1 ZK proof, stream_settle circuit): the payee submits the highest
 *    voucher. The proof verifies the payer's EdDSA signature over it, bounds
 *    cumulative <= cap, and mints a payee note (= cumulative) + a payer refund
 *    note (= cap - cumulative). Value conserved.
 *
 *  RECLAIM (no proof): after `expiry + challengeWindow` with no settle, the payer
 *    reclaims the full cap via the reclaim note committed at open.
 *
 * Double-spend / mutual exclusion:
 *  - The input note N's nullifier is spent once via the shared NullifierRegistry
 *    at open (a channelized note can never be reused elsewhere).
 *  - The channel itself is consumed exactly once by EITHER settle OR reclaim,
 *    enforced by the per-channel `consumed` flag (a Poseidon "escrow nullifier"
 *    isn't used here because reclaim has no proof and the EVM can't cheaply
 *    recompute Poseidon(channelId,...) on-chain — the flag is the equivalent
 *    spend-once guarantee).
 *
 * All four note types (change/payee/refund/reclaim) are inserted into the shared
 * ShieldedPool tree via `streamInsert`, so they are ordinary shielded notes the
 * recipients later spend through the normal pool paths (withdraw/transfer).
 */
contract StreamEscrow is AccessControl, Pausable {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    IShieldedPoolForStream public immutable pool;
    INullifierRegistryForStream public immutable nullifierRegistry;
    IStreamOpenVerifier public openVerifier;
    IStreamSettleVerifier public settleVerifier;

    // blocks after `expiry` before the payer may reclaim; a slow payee can still
    // settle right up until reclaim actually happens (settle is only gated by
    // !consumed, giving the payee maximum flexibility).
    uint256 public immutable challengeWindow;

    struct Channel {
        uint256 payerAx;
        uint256 payerAy;
        uint256 cap;
        uint256 expiry;
        uint256 reclaimCommitment;
        uint256 assetId;
        bool opened;
        bool consumed; // set by settle OR reclaim (mutual exclusion)
    }

    mapping(uint256 => Channel) public channels; // channelId => Channel

    event ChannelOpened(uint256 indexed channelId, uint256 cap, uint256 expiry, uint256 changeCommitment);
    event ChannelSettled(uint256 indexed channelId, uint256 cumulative, uint256 payeeCommitment, uint256 refundCommitment);
    event ChannelReclaimed(uint256 indexed channelId, uint256 cap, uint256 reclaimCommitment);

    error ProofInvalid();
    error WrongDomain();
    error WrongAssociation();
    error UnknownRoot();
    error ChannelAlreadyOpen();
    error ChannelNotOpen();
    error ChannelConsumed();
    error ChannelParamMismatch();
    error NotYetReclaimable();

    constructor(
        address admin,
        address _pool,
        address _nullifierRegistry,
        uint256 _challengeWindow
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        pool = IShieldedPoolForStream(_pool);
        nullifierRegistry = INullifierRegistryForStream(_nullifierRegistry);
        challengeWindow = _challengeWindow;
    }

    function setOpenVerifier(address v) external onlyRole(ADMIN_ROLE) {
        openVerifier = IStreamOpenVerifier(v);
    }

    function setSettleVerifier(address v) external onlyRole(ADMIN_ROLE) {
        settleVerifier = IStreamSettleVerifier(v);
    }

    // ============================================================
    // OPEN — stream_open circuit
    // pub (13): [0] inputNullifierHash [1] changeCommitment [2] reclaimCommitment
    // [3] stateRoot [4] associationRoot [5] poolId [6] chainId [7] channelId
    // [8] payerAx [9] payerAy [10] cap [11] expiry [12] assetId
    // ============================================================
    function open(Groth16Proof calldata proof, uint256[13] calldata pub) external whenNotPaused {
        uint256 channelId = pub[7];
        if (channels[channelId].opened) revert ChannelAlreadyOpen();

        // domain + compliance binding
        if (pub[5] != pool.poolId() || pub[6] != pool.chainId()) revert WrongDomain();
        if (pub[4] != pool.getAssociationRoot()) revert WrongAssociation();
        if (!pool.isKnownRoot(pub[3])) revert UnknownRoot();

        if (!openVerifier.verifyProof(proof.a, proof.b, proof.c, pub)) revert ProofInvalid();

        // burn the input note (channelized note can never be reused)
        nullifierRegistry.spend(bytes32(pub[0]));

        uint256 cap = pub[10];
        uint256 assetId = pub[12];

        channels[channelId] = Channel({
            payerAx: pub[8],
            payerAy: pub[9],
            cap: cap,
            expiry: pub[11],
            reclaimCommitment: pub[2],
            assetId: assetId,
            opened: true,
            consumed: false
        });

        // insert the change note (V - cap). The reserved `cap` leaves the note
        // set until settle/reclaim re-mints it, so supply drops by cap now.
        pool.streamInsert(assetId, pub[1], -int256(cap));

        emit ChannelOpened(channelId, cap, pub[11], pub[1]);
    }

    // ============================================================
    // SETTLE — stream_settle circuit
    // pub (11): [0] payeeCommitment [1] refundCommitment [2] associationRoot
    // [3] poolId [4] chainId [5] channelId [6] payerAx [7] payerAy [8] cap
    // [9] cumulative [10] assetId
    // ============================================================
    function settle(Groth16Proof calldata proof, uint256[11] calldata pub) external whenNotPaused {
        uint256 channelId = pub[5];
        Channel storage ch = channels[channelId];
        if (!ch.opened) revert ChannelNotOpen();
        if (ch.consumed) revert ChannelConsumed();

        // the settle proof's channel params must match what open recorded — this
        // is what binds the voucher (verified in-circuit against payerAx/payerAy)
        // and the cap to THIS channel.
        if (pub[6] != ch.payerAx || pub[7] != ch.payerAy || pub[8] != ch.cap || pub[10] != ch.assetId) {
            revert ChannelParamMismatch();
        }

        // domain + compliance binding
        if (pub[3] != pool.poolId() || pub[4] != pool.chainId()) revert WrongDomain();
        if (pub[2] != pool.getAssociationRoot()) revert WrongAssociation();

        if (!settleVerifier.verifyProof(proof.a, proof.b, proof.c, pub)) revert ProofInvalid();

        ch.consumed = true;

        uint256 cumulative = pub[9];
        // re-mint the reserved cap as payee(cumulative) + refund(cap-cumulative).
        pool.streamInsert(ch.assetId, pub[0], int256(cumulative));
        pool.streamInsert(ch.assetId, pub[1], int256(ch.cap - cumulative));

        emit ChannelSettled(channelId, cumulative, pub[0], pub[1]);
    }

    // ============================================================
    // RECLAIM — no proof; the reclaim note was committed at open.
    // ============================================================
    function reclaim(uint256 channelId) external whenNotPaused {
        Channel storage ch = channels[channelId];
        if (!ch.opened) revert ChannelNotOpen();
        if (ch.consumed) revert ChannelConsumed();
        if (block.number <= ch.expiry + challengeWindow) revert NotYetReclaimable();

        ch.consumed = true;

        // re-mint the full reserved cap back to the payer via the pre-committed
        // reclaim note.
        pool.streamInsert(ch.assetId, ch.reclaimCommitment, int256(ch.cap));

        emit ChannelReclaimed(channelId, ch.cap, ch.reclaimCommitment);
    }

    // ---- views ----
    function getChannel(uint256 channelId) external view returns (Channel memory) {
        return channels[channelId];
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}
