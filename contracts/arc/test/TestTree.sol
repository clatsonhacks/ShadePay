// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../src/IncrementalMerkleTree.sol";

/// @dev Concrete wrapper exposing the abstract IncrementalMerkleTree for tests.
contract TestTree is IncrementalMerkleTree {
    constructor(uint32 _levels, IPoseidon2 _poseidon2) IncrementalMerkleTree(_levels, _poseidon2) {}

    function insert(uint256 leaf) external returns (uint32) {
        return _insert(leaf);
    }
}
