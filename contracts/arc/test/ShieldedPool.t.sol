// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "./PoseidonDeployer.sol";
import "./mocks/MockVerifiers.sol";
import "./mocks/MockERC20.sol";
import "../src/ShieldedPool.sol";
import "../src/NullifierRegistry.sol";
import "../src/interfaces/IVerifiers.sol";

/**
 * @title ShieldedPoolTest
 * @notice Functional + adversarial tests for the EVM port of the Shade shielded
 *         pool, mirroring the Stellar `shielded_pool/src/tests.rs` matrix and the
 *         A1-A17 adversarial scenarios in docs/TESTNET_E2E.md. Uses mock verifiers
 *         so the binding/security logic is tested independent of Groth16 (real
 *         proof verification is covered by npm run circuits:test:arc).
 */
contract ShieldedPoolTest is PoseidonDeployer {
    ShieldedPool pool;
    NullifierRegistry nullReg;
    MockVerifier mockVerifier;
    MockEd25519 mockEd25519;
    MockERC20 usdc;
    MockERC20 xlm;

    address admin = address(0xA11CE);
    address user = address(0xE5E5);
    address relayer = address(0xC0FFEE);

    uint256 constant POOL_ID = 1;
    uint256 constant CHAIN_ID = 42;
    uint32 constant DEPTH = 12;

    // field-element asset ids = sha256(token) >> 8 (matches @shade/assets derivation);
    // computed in setUp once tokens are deployed.
    uint256 USDC_ASSET;
    uint256 XLM_ASSET;

    uint256 constant ASSOC_ROOT = 0xA550C;

    function setUp() public {
        vm.startPrank(admin);
        IPoseidon2 poseidon2 = deployPoseidon2();

        nullReg = new NullifierRegistry(admin);
        pool = new ShieldedPool(admin, address(nullReg), POOL_ID, CHAIN_ID, DEPTH, poseidon2);
        nullReg.setAuthorizedSpender(address(pool), true);

        mockVerifier = new MockVerifier();
        mockEd25519 = new MockEd25519();

        pool.setWithdrawVerifier(address(mockVerifier));
        pool.setTransferVerifier(address(mockVerifier));
        pool.setDepositVerifier(address(mockVerifier));
        pool.setMpcVerifier(address(mockVerifier));
        pool.setMpcPricedVerifier(address(mockVerifier));
        pool.setEd25519Verifier(address(mockEd25519));

        usdc = new MockERC20();
        xlm = new MockERC20();
        USDC_ASSET = _assetHash(address(usdc));
        XLM_ASSET = _assetHash(address(xlm));
        pool.registerAsset(USDC_ASSET, address(usdc));
        pool.registerAsset(XLM_ASSET, address(xlm));

        pool.setAssociationRoot(ASSOC_ROOT);

        // fund the pool so withdrawals can pay out
        usdc.mint(address(pool), 1_000_000);
        xlm.mint(address(pool), 1_000_000);
        vm.stopPrank();
    }

    // ---- helpers ----
    function _emptyProof() internal pure returns (Groth16Proof memory p) {
        // zeroed proof; mock verifier ignores it
    }

    function _assetHash(address a) internal pure returns (uint256) {
        return uint256(sha256(abi.encodePacked(a))) >> 8;
    }

    function _recipientHash(address a) internal pure returns (uint256) {
        return uint256(sha256(abi.encodePacked(a))) >> 8;
    }

    function _hashToField(bytes32 h) internal pure returns (uint256) {
        return uint256(sha256(abi.encodePacked(h))) >> 8;
    }

    // build valid deposit public signals
    function _depositPub(bytes32 cctpNonce, uint256 amount, uint256 commitment)
        internal view returns (uint256[14] memory pub)
    {
        pub[0] = commitment;
        pub[1] = 4; // OP_DEPOSIT_NOTE_MINT
        pub[2] = 3; // source domain
        pub[3] = 27; // destination domain (arbitrary here; not checked on EVM path)
        pub[4] = _hashToField(cctpNonce);
        pub[5] = uint256(0xB0);  // burn tx hash (non-zero)
        pub[6] = amount / 10 + 1; // amount6dp: *10 >= amount7dp
        pub[7] = amount;
        pub[8] = _assetHash(address(usdc));
        pub[9] = _assetHash(address(pool));
        pub[10] = _hashToField(bytes32(uint256(0xE0)));
        pub[11] = _hashToField(bytes32(uint256(0xF0)));
        pub[12] = POOL_ID;
        pub[13] = CHAIN_ID;
    }

    // ============================================================
    // FUNCTIONAL — Deposit
    // ============================================================
    function test_deposit_mints_note_and_updates_root() public {
        bytes32 nonce = bytes32(uint256(1));
        uint256 commitment = 999888777;
        uint256[14] memory pub = _depositPub(nonce, 1000, commitment);
        uint256 encHash = 0xE0;
        uint256 policyId = 0xF0;

        uint256 rootBefore = pool.getRoot();
        vm.prank(admin);
        uint32 idx = pool.receiveDeposit(3, nonce, address(usdc), 1000, commitment, encHash, policyId, _emptyProof(), pub);

        assertEq(idx, 0, "first leaf index");
        assertEq(pool.getLeafCount(), 1, "leaf count");
        assertTrue(pool.getRoot() != rootBefore, "root updated");
        assertEq(pool.noteSupply(USDC_ASSET), 1000, "note supply");
    }

    function test_deposit_duplicate_nonce_reverts() public {
        bytes32 nonce = bytes32(uint256(1));
        uint256[14] memory pub = _depositPub(nonce, 1000, 555);
        vm.prank(admin);
        pool.receiveDeposit(3, nonce, address(usdc), 1000, 555, 0xE0, 0xF0, _emptyProof(), pub);
        vm.prank(admin);
        vm.expectRevert(ShieldedPool.DuplicateDeposit.selector);
        pool.receiveDeposit(3, nonce, address(usdc), 1000, 555, 0xE0, 0xF0, _emptyProof(), pub);
    }

    function test_deposit_wrong_commitment_reverts() public {
        bytes32 nonce = bytes32(uint256(2));
        uint256[14] memory pub = _depositPub(nonce, 1000, 555);
        pub[0] = 444; // mismatch vs commitment arg 555
        vm.prank(admin);
        vm.expectRevert(ShieldedPool.WrongCommitment.selector);
        pool.receiveDeposit(3, nonce, address(usdc), 1000, 555, 0xE0, 0xF0, _emptyProof(), pub);
    }

    function test_deposit_wrong_domain_reverts() public {
        bytes32 nonce = bytes32(uint256(3));
        uint256[14] memory pub = _depositPub(nonce, 1000, 555);
        pub[12] = 999; // wrong poolId
        vm.prank(admin);
        vm.expectRevert(ShieldedPool.WrongDomain.selector);
        pool.receiveDeposit(3, nonce, address(usdc), 1000, 555, 0xE0, 0xF0, _emptyProof(), pub);
    }

    function test_deposit_invalid_proof_reverts() public {
        bytes32 nonce = bytes32(uint256(4));
        uint256[14] memory pub = _depositPub(nonce, 1000, 555);
        mockVerifier.setResult(false);
        vm.prank(admin);
        vm.expectRevert(ShieldedPool.ProofInvalid.selector);
        pool.receiveDeposit(3, nonce, address(usdc), 1000, 555, 0xE0, 0xF0, _emptyProof(), pub);
    }

    function test_deposit_non_registrar_reverts() public {
        bytes32 nonce = bytes32(uint256(5));
        uint256[14] memory pub = _depositPub(nonce, 1000, 555);
        vm.prank(user);
        vm.expectRevert(); // AccessControl
        pool.receiveDeposit(3, nonce, address(usdc), 1000, 555, 0xE0, 0xF0, _emptyProof(), pub);
    }

    // ============================================================
    // FUNCTIONAL — Withdraw
    // ============================================================
    function _seedKnownRootViaDeposit() internal returns (uint256 stateRoot) {
        bytes32 nonce = bytes32(uint256(0x5EED));
        uint256[14] memory pub = _depositPub(nonce, 5000, 123123);
        vm.prank(admin);
        pool.receiveDeposit(3, nonce, address(usdc), 5000, 123123, 0xE0, 0xF0, _emptyProof(), pub);
        return pool.getRoot();
    }

    function _withdrawPub(address to, uint256 withdrawnValue, uint256 fee, uint256 stateRoot)
        internal view returns (uint256[18] memory pub)
    {
        pub[0] = uint256(0xA1A1); // nullifierHash
        pub[1] = 1; // OP_WITHDRAW_PUBLIC
        pub[2] = withdrawnValue;
        pub[3] = _recipientHash(to);
        pub[4] = fee;
        pub[5] = block.number + 100; // deadline
        pub[6] = stateRoot;
        pub[7] = ASSOC_ROOT;
        pub[8] = POOL_ID;
        pub[9] = CHAIN_ID;
        pub[17] = USDC_ASSET;
    }

    function test_withdraw_pays_out_and_spends_nullifier() public {
        uint256 stateRoot = _seedKnownRootViaDeposit();
        uint256[18] memory pub = _withdrawPub(user, 1000, 50, stateRoot);

        uint256 balBefore = usdc.balanceOf(user);
        vm.prank(relayer);
        pool.withdraw(user, _emptyProof(), pub);

        assertEq(usdc.balanceOf(user) - balBefore, 950, "net payout = value - fee");
        assertTrue(nullReg.isSpent(bytes32(uint256(0xA1A1))), "nullifier spent");
    }

    function test_withdraw_double_spend_reverts() public {
        uint256 stateRoot = _seedKnownRootViaDeposit();
        uint256[18] memory pub = _withdrawPub(user, 1000, 50, stateRoot);
        vm.prank(relayer);
        pool.withdraw(user, _emptyProof(), pub);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(NullifierRegistry.NullifierAlreadySpent.selector, bytes32(uint256(0xA1A1))));
        pool.withdraw(user, _emptyProof(), pub);
    }

    function test_withdraw_wrong_recipient_reverts() public {
        uint256 stateRoot = _seedKnownRootViaDeposit();
        uint256[18] memory pub = _withdrawPub(user, 1000, 50, stateRoot);
        // submit with a DIFFERENT recipient than the proof binds
        vm.prank(relayer);
        vm.expectRevert(ShieldedPool.WrongRecipient.selector);
        pool.withdraw(relayer, _emptyProof(), pub);
    }

    function test_withdraw_unknown_root_reverts() public {
        uint256[18] memory pub = _withdrawPub(user, 1000, 50, 0xDEAD);
        vm.prank(relayer);
        vm.expectRevert(ShieldedPool.UnknownRoot.selector);
        pool.withdraw(user, _emptyProof(), pub);
    }

    function test_withdraw_wrong_association_reverts() public {
        uint256 stateRoot = _seedKnownRootViaDeposit();
        uint256[18] memory pub = _withdrawPub(user, 1000, 50, stateRoot);
        pub[7] = 0xBAD; // wrong association root
        vm.prank(relayer);
        vm.expectRevert(ShieldedPool.WrongAssociation.selector);
        pool.withdraw(user, _emptyProof(), pub);
    }

    function test_withdraw_expired_reverts() public {
        uint256 stateRoot = _seedKnownRootViaDeposit();
        uint256[18] memory pub = _withdrawPub(user, 1000, 50, stateRoot);
        pub[5] = block.number; // deadline == now; advance 1 block
        vm.roll(block.number + 1);
        vm.prank(relayer);
        vm.expectRevert(ShieldedPool.Expired.selector);
        pool.withdraw(user, _emptyProof(), pub);
    }

    function test_withdraw_wrong_operation_reverts() public {
        uint256 stateRoot = _seedKnownRootViaDeposit();
        uint256[18] memory pub = _withdrawPub(user, 1000, 50, stateRoot);
        pub[1] = 2; // not OP_WITHDRAW_PUBLIC
        vm.prank(relayer);
        vm.expectRevert(ShieldedPool.WrongOperation.selector);
        pool.withdraw(user, _emptyProof(), pub);
    }

    function test_withdraw_invalid_proof_reverts() public {
        uint256 stateRoot = _seedKnownRootViaDeposit();
        uint256[18] memory pub = _withdrawPub(user, 1000, 50, stateRoot);
        mockVerifier.setResult(false);
        vm.prank(relayer);
        vm.expectRevert(ShieldedPool.ProofInvalid.selector);
        pool.withdraw(user, _emptyProof(), pub);
    }

    // ============================================================
    // FUNCTIONAL — Private transfer
    // ============================================================
    function _transferPub(uint256 outputCommitment, uint256 stateRoot)
        internal view returns (uint256[9] memory pub)
    {
        pub[0] = uint256(0xB2B2); // nullifierHash
        pub[1] = outputCommitment;
        pub[2] = 10; // fee
        pub[3] = stateRoot;
        pub[4] = ASSOC_ROOT;
        pub[5] = POOL_ID;
        pub[6] = CHAIN_ID;
        pub[7] = USDC_ASSET;
        pub[8] = USDC_ASSET;
    }

    function test_private_transfer_spends_and_inserts() public {
        uint256 stateRoot = _seedKnownRootViaDeposit();
        uint256[9] memory pub = _transferPub(0xC0FFEE17, stateRoot);
        uint256 leavesBefore = pool.getLeafCount();
        vm.prank(admin);
        pool.privateTransferSettle(_emptyProof(), pub);
        assertEq(pool.getLeafCount(), leavesBefore + 1, "output note inserted");
        assertTrue(nullReg.isSpent(bytes32(uint256(0xB2B2))), "input nullifier spent");
    }

    function test_private_transfer_wrong_association_reverts() public {
        uint256 stateRoot = _seedKnownRootViaDeposit();
        uint256[9] memory pub = _transferPub(0xC0FFEE17, stateRoot);
        pub[4] = 0xBAD;
        vm.prank(admin);
        vm.expectRevert(ShieldedPool.WrongAssociation.selector);
        pool.privateTransferSettle(_emptyProof(), pub);
    }

    function test_private_transfer_unknown_root_reverts() public {
        uint256[9] memory pub = _transferPub(0xC0FFEE17, 0xDEAD);
        vm.prank(admin);
        vm.expectRevert(ShieldedPool.UnknownRoot.selector);
        pool.privateTransferSettle(_emptyProof(), pub);
    }

    // ============================================================
    // FUNCTIONAL — MPC settle (same-asset)
    // ============================================================
    function _committee3() internal returns (bytes32[] memory pks) {
        pks = new bytes32[](3);
        pks[0] = bytes32(uint256(0xC1));
        pks[1] = bytes32(uint256(0xC2));
        pks[2] = bytes32(uint256(0xC3));
        vm.prank(admin);
        pool.setCommittee(pks);
    }

    function _mpcPub(bytes32 batchHash, uint256 stateRoot) internal view returns (uint256[12] memory pub) {
        pub[0] = uint256(0xA1); // nullA
        pub[1] = uint256(0xB1); // nullB
        pub[2] = 0xC0A;  // outCommA
        pub[3] = 0xC0B;  // outCommB
        pub[4] = stateRoot;
        pub[5] = ASSOC_ROOT;
        pub[6] = _hashToField(batchHash);
        pub[7] = POOL_ID;
        pub[8] = CHAIN_ID;
        pub[9] = 100; // matched amount
        pub[10] = block.number + 100; // deadline
        pub[11] = USDC_ASSET;
    }

    function test_mpc_settle_spends_both_and_inserts_both() public {
        _committee3();
        uint256 stateRoot = _seedKnownRootViaDeposit();
        bytes32 batchHash = bytes32(uint256(0xBA7C4));
        uint256[12] memory pub = _mpcPub(batchHash, stateRoot);

        (bytes32[] memory signers, bytes[] memory sigs) = _twoSigners();
        uint256 leavesBefore = pool.getLeafCount();
        vm.prank(relayer);
        pool.mpcSettle(batchHash, signers, sigs, _emptyProof(), pub);

        assertEq(pool.getLeafCount(), leavesBefore + 2, "both output notes inserted");
        assertTrue(nullReg.isSpent(bytes32(uint256(0xA1))), "nullA spent");
        assertTrue(nullReg.isSpent(bytes32(uint256(0xB1))), "nullB spent");
    }

    function _twoSigners() internal pure returns (bytes32[] memory signers, bytes[] memory sigs) {
        // threshold for n=3 is ceil(6/3)=2
        signers = new bytes32[](2);
        signers[0] = bytes32(uint256(0xC1));
        signers[1] = bytes32(uint256(0xC2));
        sigs = new bytes[](2);
        sigs[0] = hex"00";
        sigs[1] = hex"00";
    }

    function test_mpc_settle_below_threshold_reverts() public {
        _committee3();
        uint256 stateRoot = _seedKnownRootViaDeposit();
        bytes32 batchHash = bytes32(uint256(0xBA7C4));
        uint256[12] memory pub = _mpcPub(batchHash, stateRoot);

        // only 1 signer (< threshold 2)
        bytes32[] memory signers = new bytes32[](1);
        signers[0] = bytes32(uint256(0xC1));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = hex"00";

        vm.prank(relayer);
        vm.expectRevert(CommitteeLib.MpcThreshold.selector);
        pool.mpcSettle(batchHash, signers, sigs, _emptyProof(), pub);
    }

    function test_mpc_settle_duplicate_signer_reverts() public {
        _committee3();
        uint256 stateRoot = _seedKnownRootViaDeposit();
        bytes32 batchHash = bytes32(uint256(0xBA7C4));
        uint256[12] memory pub = _mpcPub(batchHash, stateRoot);

        bytes32[] memory signers = new bytes32[](2);
        signers[0] = bytes32(uint256(0xC1));
        signers[1] = bytes32(uint256(0xC1)); // duplicate
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = hex"00";
        sigs[1] = hex"00";

        vm.prank(relayer);
        vm.expectRevert(CommitteeLib.MpcDuplicateSigner.selector);
        pool.mpcSettle(batchHash, signers, sigs, _emptyProof(), pub);
    }

    function test_mpc_settle_unknown_signer_reverts() public {
        _committee3();
        uint256 stateRoot = _seedKnownRootViaDeposit();
        bytes32 batchHash = bytes32(uint256(0xBA7C4));
        uint256[12] memory pub = _mpcPub(batchHash, stateRoot);

        bytes32[] memory signers = new bytes32[](2);
        signers[0] = bytes32(uint256(0xC1));
        signers[1] = bytes32(uint256(0xDEAD)); // not registered
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = hex"00";
        sigs[1] = hex"00";

        vm.prank(relayer);
        vm.expectRevert(CommitteeLib.MpcUnknownSigner.selector);
        pool.mpcSettle(batchHash, signers, sigs, _emptyProof(), pub);
    }

    function test_mpc_settle_wrong_batch_hash_reverts() public {
        _committee3();
        uint256 stateRoot = _seedKnownRootViaDeposit();
        bytes32 batchHash = bytes32(uint256(0xBA7C4));
        uint256[12] memory pub = _mpcPub(batchHash, stateRoot);
        pub[6] = 0xBAD; // batch hash field mismatch

        (bytes32[] memory signers, bytes[] memory sigs) = _twoSigners();
        vm.prank(relayer);
        vm.expectRevert(ShieldedPool.MpcSignalMismatch.selector);
        pool.mpcSettle(batchHash, signers, sigs, _emptyProof(), pub);
    }

    function test_mpc_settle_invalid_proof_reverts() public {
        _committee3();
        uint256 stateRoot = _seedKnownRootViaDeposit();
        bytes32 batchHash = bytes32(uint256(0xBA7C4));
        uint256[12] memory pub = _mpcPub(batchHash, stateRoot);
        mockVerifier.setResult(false);

        (bytes32[] memory signers, bytes[] memory sigs) = _twoSigners();
        vm.prank(relayer);
        vm.expectRevert(ShieldedPool.MpcProofInvalid.selector);
        pool.mpcSettle(batchHash, signers, sigs, _emptyProof(), pub);
    }

    function test_mpc_settle_wrong_association_reverts() public {
        _committee3();
        uint256 stateRoot = _seedKnownRootViaDeposit();
        bytes32 batchHash = bytes32(uint256(0xBA7C4));
        uint256[12] memory pub = _mpcPub(batchHash, stateRoot);
        pub[5] = 0xBAD; // wrong association root

        (bytes32[] memory signers, bytes[] memory sigs) = _twoSigners();
        vm.prank(relayer);
        vm.expectRevert(ShieldedPool.WrongAssociation.selector);
        pool.mpcSettle(batchHash, signers, sigs, _emptyProof(), pub);
    }

    // ============================================================
    // Asset registry / reserves
    // ============================================================
    function test_register_duplicate_asset_reverts() public {
        vm.prank(admin);
        vm.expectRevert(ShieldedPool.AssetAlreadyRegistered.selector);
        pool.registerAsset(USDC_ASSET, address(usdc));
    }

    function test_unknown_asset_deposit_reverts() public {
        // asset hash that maps to no registered asset
        bytes32 nonce = bytes32(uint256(0xAA));
        uint256[14] memory pub = _depositPub(nonce, 1000, 555);
        pub[8] = 0xDEAD99; // unregistered asset id, but token-hash check happens first
        // token hash check: _assetHash(usdc) != pub[8] => WrongDepositField
        vm.prank(admin);
        vm.expectRevert(ShieldedPool.WrongDepositField.selector);
        pool.receiveDeposit(3, nonce, address(usdc), 1000, 555, 0xE0, 0xF0, _emptyProof(), pub);
    }

    function test_proof_of_reserves() public {
        _seedKnownRootViaDeposit(); // deposits 5000 USDC note
        (int256 supply, uint256 bal) = pool.proofOfReserves(USDC_ASSET);
        assertEq(supply, 5000, "note supply");
        assertEq(bal, 1_000_000 + 0, "vault balance"); // pool was pre-funded 1M
    }

    // ============================================================
    // Pause
    // ============================================================
    function test_paused_blocks_withdraw() public {
        uint256 stateRoot = _seedKnownRootViaDeposit();
        uint256[18] memory pub = _withdrawPub(user, 1000, 50, stateRoot);
        vm.prank(admin);
        pool.pause();
        vm.prank(relayer);
        vm.expectRevert(); // EnforcedPause
        pool.withdraw(user, _emptyProof(), pub);
    }
}
