// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "./PoseidonDeployer.sol";
import "../src/IncrementalMerkleTree.sol";

/**
 * @title Poseidon2Test
 * @notice Verifies the deployed circomlibjs Poseidon(2) matches circomlib's BN254
 *         Poseidon EXACTLY (test vectors computed off-chain via circomlibjs). If
 *         these pass, on-chain Merkle roots will match in-circuit roots.
 */
contract Poseidon2Test is PoseidonDeployer {
    IPoseidon2 poseidon2;

    // reference values from circomlibjs buildPoseidon()
    uint256 constant P_1_2 = 7853200120776062878684798364095072458815029376092732009249414926327459813530;
    uint256 constant P_0_0 = 14744269619966411208579211824598458697587494354926760081771325075741142829156;

    function setUp() public {
        poseidon2 = deployPoseidon2();
    }

    function test_poseidon_1_2_matches_circomlib() public view {
        assertEq(poseidon2.poseidon([uint256(1), uint256(2)]), P_1_2, "poseidon(1,2) mismatch");
    }

    function test_poseidon_0_0_matches_circomlib() public view {
        assertEq(poseidon2.poseidon([uint256(0), uint256(0)]), P_0_0, "poseidon(0,0) mismatch");
    }

    function test_poseidon_deterministic() public view {
        uint256 a = poseidon2.poseidon([uint256(42), uint256(99)]);
        uint256 b = poseidon2.poseidon([uint256(42), uint256(99)]);
        assertEq(a, b, "poseidon not deterministic");
    }
}
