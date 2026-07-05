// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "./PoseidonDeployer.sol";
import "./mocks/MockVerifiers.sol";
import "./mocks/MockERC20.sol";
import "../src/ShieldedPool.sol";
import "../src/NullifierRegistry.sol";
import "../src/interfaces/IVerifiers.sol";

/// @dev Mock CCTP TokenMessenger that records the last burn.
contract MockTokenMessenger is ITokenMessenger {
    uint256 public lastAmount;
    uint32 public lastDomain;
    bytes32 public lastRecipient;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address,
        bytes32,
        uint256,
        uint32
    ) external {
        lastAmount = amount;
        lastDomain = destinationDomain;
        lastRecipient = mintRecipient;
    }
}

/**
 * @title RfqCctpTest
 * @notice Preserves RFQ and CCTP-exit functionality on Arc (ported from Stellar).
 *         Uses mock verifiers/ed25519/CCTP so binding logic is tested independent
 *         of Groth16 and cross-chain infra.
 */
contract RfqCctpTest is PoseidonDeployer {
    ShieldedPool pool;
    NullifierRegistry nullReg;
    MockVerifier mockVerifier;
    MockEd25519 mockEd25519;
    MockERC20 usdc;
    MockTokenMessenger messenger;

    address admin = address(0xA11CE);
    address solver = address(0x50FBE12);
    address user = address(0xE5E5);

    uint256 constant POOL_ID = 1;
    uint256 constant CHAIN_ID = 42;
    uint32 constant DEPTH = 12;
    uint32 constant ARB_DOMAIN = 3;
    uint256 constant ASSOC_ROOT = 0xA550C;
    bytes32 constant SOLVER_PK = bytes32(uint256(0x50FDEADBEEF));

    uint256 USDC_ASSET;

    function setUp() public {
        vm.startPrank(admin);
        IPoseidon2 poseidon2 = deployPoseidon2();
        nullReg = new NullifierRegistry(admin);
        pool = new ShieldedPool(admin, address(nullReg), POOL_ID, CHAIN_ID, DEPTH, poseidon2);
        nullReg.setAuthorizedSpender(address(pool), true);

        mockVerifier = new MockVerifier();
        mockEd25519 = new MockEd25519();
        messenger = new MockTokenMessenger();
        pool.setWithdrawVerifier(address(mockVerifier));
        pool.setDepositVerifier(address(mockVerifier));
        pool.setEd25519Verifier(address(mockEd25519));

        usdc = new MockERC20();
        USDC_ASSET = uint256(sha256(abi.encodePacked(address(usdc)))) >> 8;
        pool.registerAsset(USDC_ASSET, address(usdc));
        pool.setAssociationRoot(ASSOC_ROOT);
        pool.setCctpConfig(address(messenger), address(usdc), ARB_DOMAIN);
        pool.setAuthorizedSolver(SOLVER_PK, true);

        usdc.mint(address(pool), 1_000_000);
        vm.stopPrank();
    }

    function _assetHash(address a) internal pure returns (uint256) {
        return uint256(sha256(abi.encodePacked(a))) >> 8;
    }

    function _hashToField(bytes32 h) internal pure returns (uint256) {
        return uint256(sha256(abi.encodePacked(h))) >> 8;
    }

    // seed a known state root via a deposit
    function _seedRoot() internal returns (uint256) {
        bytes32 nonce = bytes32(uint256(0x5EED));
        uint256[14] memory pub;
        pub[0] = 12321;
        pub[1] = 4;
        pub[2] = 3;
        pub[3] = 27;
        pub[4] = _hashToField(nonce);
        pub[5] = 0xB0;
        pub[6] = 5000 / 10 + 1;
        pub[7] = 5000;
        pub[8] = _assetHash(address(usdc));
        pub[9] = _assetHash(address(pool));
        pub[10] = _hashToField(bytes32(uint256(0xE0)));
        pub[11] = _hashToField(bytes32(uint256(0xF0)));
        pub[12] = POOL_ID;
        pub[13] = CHAIN_ID;
        Groth16Proof memory p;
        vm.prank(admin);
        pool.receiveDeposit(3, nonce, address(usdc), 5000, 12321, 0xE0, 0xF0, p, pub);
        return pool.getRoot();
    }

    function _rfqPub(uint256 stateRoot, bytes32 q, bytes32 i, bytes32 f)
        internal view returns (uint256[18] memory pub)
    {
        pub[0] = uint256(0xF00D1); // nullifier
        pub[1] = 3; // OP_RFQ_SETTLEMENT
        pub[2] = 1000; // credit
        pub[4] = 0; // fee
        pub[5] = block.number + 100;
        pub[6] = stateRoot;
        pub[7] = ASSOC_ROOT;
        pub[8] = POOL_ID;
        pub[9] = CHAIN_ID;
        pub[10] = _hashToField(q);
        pub[11] = _hashToField(i);
        pub[12] = _hashToField(f);
        pub[17] = USDC_ASSET;
    }

    function test_rfq_settle_reimburses_solver() public {
        uint256 root = _seedRoot();
        bytes32 q = bytes32(uint256(0x0117E));
        bytes32 i = bytes32(uint256(0x14E47));
        bytes32 f = bytes32(uint256(0xF111));
        uint256[18] memory pub = _rfqPub(root, q, i, f);
        Groth16Proof memory p;

        uint256 balBefore = usdc.balanceOf(solver);
        vm.prank(admin);
        pool.rfqSettle(solver, q, i, f, SOLVER_PK, hex"00", p, pub);
        assertEq(usdc.balanceOf(solver) - balBefore, 1000, "solver reimbursed credit");
        assertTrue(nullReg.isSpent(bytes32(uint256(0xF00D1))), "user nullifier spent");
    }

    function test_rfq_unauthorized_solver_reverts() public {
        uint256 root = _seedRoot();
        bytes32 q = bytes32(uint256(0x0117E));
        uint256[18] memory pub = _rfqPub(root, q, q, q);
        Groth16Proof memory p;
        vm.prank(admin);
        vm.expectRevert(ShieldedPool.UnauthorizedSolver.selector);
        pool.rfqSettle(solver, q, q, q, bytes32(uint256(0xBAD)), hex"00", p, pub);
    }

    function test_rfq_wrong_quote_binding_reverts() public {
        uint256 root = _seedRoot();
        bytes32 q = bytes32(uint256(0x0117E));
        uint256[18] memory pub = _rfqPub(root, q, q, q);
        pub[10] = 0xBAD; // quote hash mismatch
        Groth16Proof memory p;
        vm.prank(admin);
        vm.expectRevert(ShieldedPool.WrongQuote.selector);
        pool.rfqSettle(solver, q, q, q, SOLVER_PK, hex"00", p, pub);
    }

    function test_rfq_bad_solver_sig_reverts() public {
        uint256 root = _seedRoot();
        bytes32 q = bytes32(uint256(0x0117E));
        uint256[18] memory pub = _rfqPub(root, q, q, q);
        Groth16Proof memory p;
        mockEd25519.setResult(false);
        vm.prank(admin);
        vm.expectRevert(ShieldedPool.SolverSigInvalid.selector);
        pool.rfqSettle(solver, q, q, q, SOLVER_PK, hex"00", p, pub);
    }

    // ---- CCTP exit ----
    function _cctpPub(uint256 stateRoot, bytes32 recipient, uint256 maxFee, uint32 finality)
        internal view returns (uint256[18] memory pub)
    {
        pub[0] = uint256(0xB0BB1E);
        pub[1] = 2; // OP_WITHDRAW_CCTP
        pub[2] = 2000; // amount
        pub[5] = block.number + 100;
        pub[6] = stateRoot;
        pub[7] = ASSOC_ROOT;
        pub[8] = POOL_ID;
        pub[9] = CHAIN_ID;
        pub[13] = uint256(ARB_DOMAIN);
        pub[14] = uint256(recipient);
        pub[15] = maxFee;
        pub[16] = uint256(finality);
        pub[17] = _assetHash(address(usdc));
    }

    function test_cctp_exit_burns_via_messenger() public {
        uint256 root = _seedRoot();
        bytes32 recipient = bytes32(uint256(0xABC0));
        uint256[18] memory pub = _cctpPub(root, recipient, 10, 1000);
        Groth16Proof memory p;

        vm.prank(user);
        pool.withdrawCctp(user, recipient, 10, 1000, p, pub);
        assertEq(messenger.lastAmount(), 2000, "burned amount");
        assertEq(messenger.lastDomain(), ARB_DOMAIN, "dest domain");
        assertEq(messenger.lastRecipient(), recipient, "recipient");
        assertTrue(nullReg.isSpent(bytes32(uint256(0xB0BB1E))), "nullifier spent");
    }

    function test_cctp_wrong_dest_recipient_reverts() public {
        uint256 root = _seedRoot();
        bytes32 recipient = bytes32(uint256(0xABC0));
        uint256[18] memory pub = _cctpPub(root, recipient, 10, 1000);
        Groth16Proof memory p;
        // submit a different recipient than the proof binds
        vm.prank(user);
        vm.expectRevert(ShieldedPool.WrongDestRecipient.selector);
        pool.withdrawCctp(user, bytes32(uint256(0xDEAD)), 10, 1000, p, pub);
    }

    function test_cctp_wrong_operation_reverts() public {
        uint256 root = _seedRoot();
        bytes32 recipient = bytes32(uint256(0xABC0));
        uint256[18] memory pub = _cctpPub(root, recipient, 10, 1000);
        pub[1] = 1; // not OP_WITHDRAW_CCTP
        Groth16Proof memory p;
        vm.prank(user);
        vm.expectRevert(ShieldedPool.WrongOperation.selector);
        pool.withdrawCctp(user, recipient, 10, 1000, p, pub);
    }
}
