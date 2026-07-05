// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "./PoseidonDeployer.sol";
import "./mocks/MockVerifiers.sol";
import "./mocks/MockERC20.sol";
import "../src/ShieldedPool.sol";
import "../src/StreamEscrow.sol";
import "../src/NullifierRegistry.sol";
import "../src/interfaces/IVerifiers.sol";

/**
 * @title StreamEscrowTest
 * @notice Contract-logic + adversarial tests for the Shade Streams escrow, using
 *         mock verifiers so the open/settle/reclaim state machine, mutual
 *         exclusion, channel-param binding, and timing are tested independent of
 *         Groth16 (real proofs are exercised by the proving test + the on-chain
 *         lifecycle test). Covers the design's named invariants that live at the
 *         contract layer.
 */
contract StreamEscrowTest is PoseidonDeployer {
    ShieldedPool pool;
    StreamEscrow escrow;
    NullifierRegistry nullReg;
    MockVerifier mockVerifier;
    MockERC20 usdc;

    address admin = address(0xA11CE);
    uint256 constant POOL_ID = 1;
    uint256 constant CHAIN_ID = 42;
    uint256 constant ASSOC_ROOT = 0xA550C;
    uint256 constant CHALLENGE_WINDOW = 100;
    uint256 USDC_ASSET;

    function setUp() public {
        vm.startPrank(admin);
        IPoseidon2 poseidon2 = deployPoseidon2();
        nullReg = new NullifierRegistry(admin);
        pool = new ShieldedPool(admin, address(nullReg), POOL_ID, CHAIN_ID, 12, poseidon2);
        escrow = new StreamEscrow(admin, address(pool), address(nullReg), CHALLENGE_WINDOW);

        // both the pool and the escrow may spend nullifiers; the escrow may insert notes.
        nullReg.setAuthorizedSpender(address(pool), true);
        nullReg.setAuthorizedSpender(address(escrow), true);
        pool.setAuthorizedStreamContract(address(escrow), true);

        mockVerifier = new MockVerifier();
        pool.setDepositVerifier(address(mockVerifier));
        escrow.setOpenVerifier(address(mockVerifier));
        escrow.setSettleVerifier(address(mockVerifier));

        usdc = new MockERC20();
        USDC_ASSET = uint256(sha256(abi.encodePacked(address(usdc)))) >> 8;
        pool.registerAsset(USDC_ASSET, address(usdc));
        pool.setAssociationRoot(ASSOC_ROOT);
        usdc.mint(address(pool), 1_000_000);
        vm.stopPrank();
    }

    function _hashToField(bytes32 h) internal pure returns (uint256) {
        return uint256(sha256(abi.encodePacked(h))) >> 8;
    }

    function _emptyProof() internal pure returns (Groth16Proof memory p) {}

    // seed note supply so opening a channel (which decrements supply by cap) doesn't underflow.
    function _seedSupply(uint256 amount) internal returns (uint256 stateRoot) {
        return _seedSupplySalted(amount, 0x5EED);
    }

    // salted variant: distinct CCTP nonce + commitment per call, so multiple
    // channels can each seed supply without tripping DuplicateDeposit.
    function _seedSupplySalted(uint256 amount, uint256 salt) internal returns (uint256 stateRoot) {
        bytes32 nonce = bytes32(salt);
        uint256[14] memory pub;
        pub[0] = 123123123123123123123 + salt; // commitment (valid field element, distinct)
        pub[1] = 4; pub[2] = 3; pub[4] = _hashToField(nonce); pub[5] = 1;
        pub[6] = amount / 10 + 1; pub[7] = amount;
        pub[8] = uint256(sha256(abi.encodePacked(address(usdc)))) >> 8;
        pub[9] = uint256(sha256(abi.encodePacked(address(pool)))) >> 8;
        pub[10] = _hashToField(bytes32(uint256(0xE0))); pub[11] = _hashToField(bytes32(uint256(0xF0)));
        pub[12] = POOL_ID; pub[13] = CHAIN_ID;
        vm.prank(admin);
        pool.receiveDeposit(3, nonce, address(usdc), amount, pub[0], 0xE0, 0xF0, _emptyProof(), pub);
        return pool.getRoot();
    }

    uint256 constant CHANNEL_ID = 777;
    uint256 constant PAYER_AX = 0xA1;
    uint256 constant PAYER_AY = 0xA2;
    uint256 constant CAP = 600;
    uint256 EXPIRY;

    function _openPub(uint256 stateRoot) internal returns (uint256[13] memory pub) {
        EXPIRY = block.number + 1000;
        pub[0] = uint256(0xBEEF01); // inputNullifierHash
        pub[1] = 111222333; // changeCommitment (valid field element)
        pub[2] = 444555666; // reclaimCommitment
        pub[3] = stateRoot;
        pub[4] = ASSOC_ROOT;
        pub[5] = POOL_ID;
        pub[6] = CHAIN_ID;
        pub[7] = CHANNEL_ID;
        pub[8] = PAYER_AX;
        pub[9] = PAYER_AY;
        pub[10] = CAP;
        pub[11] = EXPIRY;
        pub[12] = USDC_ASSET;
    }

    function _settlePub(uint256 cumulative) internal view returns (uint256[11] memory pub) {
        pub[0] = 777888999; // payeeCommitment
        pub[1] = 101112131; // refundCommitment
        pub[2] = ASSOC_ROOT;
        pub[3] = POOL_ID;
        pub[4] = CHAIN_ID;
        pub[5] = CHANNEL_ID;
        pub[6] = PAYER_AX;
        pub[7] = PAYER_AY;
        pub[8] = CAP;
        pub[9] = cumulative;
        pub[10] = USDC_ASSET;
    }

    // ---- OPEN ----
    function test_open_records_channel_and_spends_input_nullifier() public {
        uint256 stateRoot = _seedSupply(1000);
        uint256[13] memory pub = _openPub(stateRoot);
        uint256 leavesBefore = pool.getLeafCount();

        escrow.open(_emptyProof(), pub);

        StreamEscrow.Channel memory ch = escrow.getChannel(CHANNEL_ID);
        assertTrue(ch.opened, "channel opened");
        assertEq(ch.cap, CAP, "cap recorded");
        assertEq(ch.payerAx, PAYER_AX, "payerAx recorded");
        assertTrue(nullReg.isSpent(bytes32(uint256(0xBEEF01))), "input nullifier spent");
        assertEq(pool.getLeafCount(), leavesBefore + 1, "change note inserted");
        assertEq(uint256(int256(pool.noteSupply(USDC_ASSET))), 1000 - CAP, "supply dropped by cap");
    }

    function test_open_duplicate_channel_reverts() public {
        uint256 stateRoot = _seedSupply(2000);
        uint256[13] memory pub = _openPub(stateRoot);
        escrow.open(_emptyProof(), pub);
        pub[0] = uint256(0xBEEF02); // different nullifier so we reach the dup check
        vm.expectRevert(StreamEscrow.ChannelAlreadyOpen.selector);
        escrow.open(_emptyProof(), pub);
    }

    function test_open_wrong_domain_reverts() public {
        uint256 stateRoot = _seedSupply(1000);
        uint256[13] memory pub = _openPub(stateRoot);
        pub[5] = 999; // wrong poolId
        vm.expectRevert(StreamEscrow.WrongDomain.selector);
        escrow.open(_emptyProof(), pub);
    }

    function test_open_wrong_association_reverts() public {
        uint256 stateRoot = _seedSupply(1000);
        uint256[13] memory pub = _openPub(stateRoot);
        pub[4] = 0xBAD;
        vm.expectRevert(StreamEscrow.WrongAssociation.selector);
        escrow.open(_emptyProof(), pub);
    }

    function test_open_unknown_root_reverts() public {
        uint256[13] memory pub = _openPub(0xDEAD);
        vm.expectRevert(StreamEscrow.UnknownRoot.selector);
        escrow.open(_emptyProof(), pub);
    }

    function test_open_invalid_proof_reverts() public {
        uint256 stateRoot = _seedSupply(1000);
        uint256[13] memory pub = _openPub(stateRoot);
        mockVerifier.setResult(false);
        vm.expectRevert(StreamEscrow.ProofInvalid.selector);
        escrow.open(_emptyProof(), pub);
    }

    // ---- SETTLE ----
    function _openChannel() internal {
        uint256 stateRoot = _seedSupply(1000);
        escrow.open(_emptyProof(), _openPub(stateRoot));
    }

    function test_settle_mints_payee_and_refund() public {
        _openChannel();
        uint256[11] memory pub = _settlePub(350);
        uint256 leavesBefore = pool.getLeafCount();

        escrow.settle(_emptyProof(), pub);

        StreamEscrow.Channel memory ch = escrow.getChannel(CHANNEL_ID);
        assertTrue(ch.consumed, "channel consumed");
        assertEq(pool.getLeafCount(), leavesBefore + 2, "payee + refund notes inserted");
        // supply: 1000 - cap(600) after open = 400; settle adds cap back = 1000.
        assertEq(uint256(int256(pool.noteSupply(USDC_ASSET))), 1000, "supply restored after settle");
    }

    function test_settle_double_reverts() public {
        _openChannel();
        escrow.settle(_emptyProof(), _settlePub(350));
        vm.expectRevert(StreamEscrow.ChannelConsumed.selector);
        escrow.settle(_emptyProof(), _settlePub(350));
    }

    function test_settle_unopened_channel_reverts() public {
        vm.expectRevert(StreamEscrow.ChannelNotOpen.selector);
        escrow.settle(_emptyProof(), _settlePub(350));
    }

    function test_settle_param_mismatch_reverts() public {
        _openChannel();
        uint256[11] memory pub = _settlePub(350);
        pub[8] = 999; // cap doesn't match the channel
        vm.expectRevert(StreamEscrow.ChannelParamMismatch.selector);
        escrow.settle(_emptyProof(), pub);
    }

    function test_settle_wrong_payer_key_reverts() public {
        _openChannel();
        uint256[11] memory pub = _settlePub(350);
        pub[6] = 0xBAD; // payerAx doesn't match
        vm.expectRevert(StreamEscrow.ChannelParamMismatch.selector);
        escrow.settle(_emptyProof(), pub);
    }

    function test_settle_invalid_proof_reverts() public {
        _openChannel();
        mockVerifier.setResult(false);
        vm.expectRevert(StreamEscrow.ProofInvalid.selector);
        escrow.settle(_emptyProof(), _settlePub(350));
    }

    // ---- RECLAIM ----
    function test_reclaim_after_timeout_returns_cap() public {
        _openChannel();
        uint256 leavesBefore = pool.getLeafCount();
        // advance past expiry + challengeWindow
        vm.roll(EXPIRY + CHALLENGE_WINDOW + 1);
        escrow.reclaim(CHANNEL_ID);

        StreamEscrow.Channel memory ch = escrow.getChannel(CHANNEL_ID);
        assertTrue(ch.consumed, "channel consumed by reclaim");
        assertEq(pool.getLeafCount(), leavesBefore + 1, "reclaim note inserted");
        assertEq(uint256(int256(pool.noteSupply(USDC_ASSET))), 1000, "supply restored after reclaim");
    }

    function test_reclaim_before_timeout_reverts() public {
        _openChannel();
        vm.roll(EXPIRY + 1); // past expiry but within the challenge window
        vm.expectRevert(StreamEscrow.NotYetReclaimable.selector);
        escrow.reclaim(CHANNEL_ID);
    }

    function test_settle_after_reclaim_reverts() public {
        _openChannel();
        vm.roll(EXPIRY + CHALLENGE_WINDOW + 1);
        escrow.reclaim(CHANNEL_ID);
        // a late settle after reclaim must fail (channel already consumed)
        vm.expectRevert(StreamEscrow.ChannelConsumed.selector);
        escrow.settle(_emptyProof(), _settlePub(350));
    }

    function test_reclaim_after_settle_reverts() public {
        _openChannel();
        escrow.settle(_emptyProof(), _settlePub(350));
        vm.roll(EXPIRY + CHALLENGE_WINDOW + 1);
        vm.expectRevert(StreamEscrow.ChannelConsumed.selector);
        escrow.reclaim(CHANNEL_ID);
    }

    // ---- invariant #5: channelized note's nullifier can't be reused ----
    function test_input_nullifier_cannot_be_reused_elsewhere() public {
        _openChannel();
        // the input note's nullifier (0xBEEF01) was spent at open; trying to spend
        // it again (e.g. a normal withdraw) must revert at the shared registry.
        vm.prank(address(pool));
        vm.expectRevert(abi.encodeWithSelector(NullifierRegistry.NullifierAlreadySpent.selector, bytes32(uint256(0xBEEF01))));
        nullReg.spend(bytes32(uint256(0xBEEF01)));
    }

    // ---- unauthorized streamInsert ----
    function test_unauthorized_stream_insert_reverts() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(ShieldedPool.UnauthorizedStreamContract.selector);
        pool.streamInsert(USDC_ASSET, 123, 0);
    }

    // ---- settleBatch (Phase 5: the streaming relayer batches closes) ----

    // open a channel with a distinct id + input nullifier + payee/refund commitments.
    function _openChannelN(uint256 cid, uint256 nullifier) internal {
        uint256 stateRoot = _seedSupplySalted(1000, 0x70000 + cid);
        uint256[13] memory pub;
        EXPIRY = block.number + 1000;
        pub[0] = nullifier;
        pub[1] = 100000 + cid; // change commitment (distinct)
        pub[2] = 200000 + cid; // reclaim commitment
        pub[3] = stateRoot;
        pub[4] = ASSOC_ROOT;
        pub[5] = POOL_ID;
        pub[6] = CHAIN_ID;
        pub[7] = cid;
        pub[8] = PAYER_AX;
        pub[9] = PAYER_AY;
        pub[10] = CAP;
        pub[11] = EXPIRY;
        pub[12] = USDC_ASSET;
        escrow.open(_emptyProof(), pub);
    }

    function _settlePubN(uint256 cid, uint256 cumulative) internal view returns (uint256[11] memory pub) {
        pub[0] = 300000 + cid; // payee commitment (distinct per channel)
        pub[1] = 400000 + cid; // refund commitment
        pub[2] = ASSOC_ROOT;
        pub[3] = POOL_ID;
        pub[4] = CHAIN_ID;
        pub[5] = cid;
        pub[6] = PAYER_AX;
        pub[7] = PAYER_AY;
        pub[8] = CAP;
        pub[9] = cumulative;
        pub[10] = USDC_ASSET;
    }

    function test_settleBatch_settles_all_channels() public {
        _openChannelN(1001, 0xB1);
        _openChannelN(1002, 0xB2);
        _openChannelN(1003, 0xB3);

        Groth16Proof[] memory proofs = new Groth16Proof[](3);
        uint256[11][] memory pubs = new uint256[11][](3);
        pubs[0] = _settlePubN(1001, 100);
        pubs[1] = _settlePubN(1002, 200);
        pubs[2] = _settlePubN(1003, 300);

        uint256 leavesBefore = pool.getLeafCount();
        escrow.settleBatch(proofs, pubs);

        assertTrue(escrow.getChannel(1001).consumed, "1001 consumed");
        assertTrue(escrow.getChannel(1002).consumed, "1002 consumed");
        assertTrue(escrow.getChannel(1003).consumed, "1003 consumed");
        assertEq(pool.getLeafCount(), leavesBefore + 6, "2 notes per channel x 3");
    }

    function test_settleBatch_cheaper_than_individual() public {
        // open 2 channels for the individual path, measure gas, snapshot-revert,
        // then settle the SAME 2 via batch and compare. Same starting state both ways.
        _openChannelN(2001, 0xC1);
        _openChannelN(2002, 0xC2);

        uint256[11] memory p1 = _settlePubN(2001, 100);
        uint256[11] memory p2 = _settlePubN(2002, 200);

        uint256 snap = vm.snapshotState();

        uint256 g0 = gasleft();
        escrow.settle(_emptyProof(), p1);
        escrow.settle(_emptyProof(), p2);
        uint256 individualGas = g0 - gasleft();

        vm.revertToState(snap);

        Groth16Proof[] memory proofs = new Groth16Proof[](2);
        uint256[11][] memory pubs = new uint256[11][](2);
        pubs[0] = p1;
        pubs[1] = p2;

        uint256 g1 = gasleft();
        escrow.settleBatch(proofs, pubs);
        uint256 batchGas = g1 - gasleft();

        assertLt(batchGas, individualGas, "batch settle must be cheaper than individual settles");
        emit log_named_uint("individual gas", individualGas);
        emit log_named_uint("batch gas", batchGas);
    }

    function test_settleBatch_reverts_atomically_on_bad_member() public {
        _openChannelN(3001, 0xD1);
        // second channel not opened -> its settle reverts -> whole batch reverts.
        Groth16Proof[] memory proofs = new Groth16Proof[](2);
        uint256[11][] memory pubs = new uint256[11][](2);
        pubs[0] = _settlePubN(3001, 100);
        pubs[1] = _settlePubN(9999, 100); // unopened channel

        vm.expectRevert(StreamEscrow.ChannelNotOpen.selector);
        escrow.settleBatch(proofs, pubs);

        // the first channel must NOT be consumed (atomic revert).
        assertFalse(escrow.getChannel(3001).consumed, "atomic: 3001 not consumed after revert");
    }

    function test_settleBatch_length_mismatch_reverts() public {
        Groth16Proof[] memory proofs = new Groth16Proof[](2);
        uint256[11][] memory pubs = new uint256[11][](1);
        vm.expectRevert(bytes("length mismatch"));
        escrow.settleBatch(proofs, pubs);
    }
}
