// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "./PoseidonDeployer.sol";
import "./TestTree.sol";
import "../src/IncrementalMerkleTree.sol";

/**
 * @title IncrementalMerkleTreeTest
 * @notice Tests the O(log n) frontier tree that replaces the Stellar O(n) rebuild.
 *         Verifies zero-subtree precomputation, insertion, root history, and
 *         capacity — the same behavior the circuit's MerkleProof relies on.
 */
contract IncrementalMerkleTreeTest is PoseidonDeployer {
    IPoseidon2 poseidon2;

    // z1 = poseidon(0,0), z2 = poseidon(z1,z1) — from circomlibjs
    uint256 constant Z1 = 14744269619966411208579211824598458697587494354926760081771325075741142829156;
    uint256 constant Z2 = 7423237065226347324353380772367382631490014989348495481811164164159255474657;

    function setUp() public {
        poseidon2 = deployPoseidon2();
    }

    function test_zeros_precomputed_correctly() public {
        TestTree tree = new TestTree(12, poseidon2);
        assertEq(tree.zeros(0), 0, "zeros[0] != 0");
        assertEq(tree.zeros(1), Z1, "zeros[1] != poseidon(0,0)");
        assertEq(tree.zeros(2), Z2, "zeros[2] != poseidon(z1,z1)");
    }

    function test_empty_root_is_known() public {
        TestTree tree = new TestTree(12, poseidon2);
        uint256 root = tree.getRoot();
        assertTrue(tree.isKnownRoot(root), "empty root not known");
        assertEq(tree.getLeafCount(), 0, "empty tree leaf count != 0");
    }

    function test_insert_changes_root() public {
        TestTree tree = new TestTree(12, poseidon2);
        uint256 rootBefore = tree.getRoot();
        uint32 idx = tree.insert(uint256(123456));
        assertEq(idx, 0, "first leaf index != 0");
        uint256 rootAfter = tree.getRoot();
        assertTrue(rootBefore != rootAfter, "root did not change on insert");
        assertEq(tree.getLeafCount(), 1, "leaf count != 1");
        assertTrue(tree.isKnownRoot(rootAfter), "new root not known");
        assertTrue(tree.isKnownRoot(rootBefore), "old root should still be known");
    }

    function test_multiple_inserts_increment_index() public {
        TestTree tree = new TestTree(12, poseidon2);
        assertEq(tree.insert(uint256(1)), 0);
        assertEq(tree.insert(uint256(2)), 1);
        assertEq(tree.insert(uint256(3)), 2);
        assertEq(tree.getLeafCount(), 3, "leaf count != 3");
    }

    function test_leaf_must_be_in_field() public {
        TestTree tree = new TestTree(12, poseidon2);
        uint256 tooBig = 21888242871839275222246405745257275088548364400416034343698204186575808495617; // == field
        vm.expectRevert("leaf >= field");
        tree.insert(tooBig);
    }

    function test_small_tree_capacity() public {
        // depth 2 => capacity 4
        TestTree tree = new TestTree(2, poseidon2);
        tree.insert(uint256(1));
        tree.insert(uint256(2));
        tree.insert(uint256(3));
        tree.insert(uint256(4));
        assertEq(tree.getLeafCount(), 4, "should hold 4 leaves");
        vm.expectRevert(IncrementalMerkleTree.MerkleTreeFull.selector);
        tree.insert(uint256(5));
    }

    function test_unknown_root_rejected() public {
        TestTree tree = new TestTree(12, poseidon2);
        assertFalse(tree.isKnownRoot(uint256(0xdeadbeef)), "forged root should be unknown");
        assertFalse(tree.isKnownRoot(0), "zero root should be unknown");
    }
}
