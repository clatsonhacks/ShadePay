// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @dev Poseidon(2) hasher interface. The implementation MUST be byte-compatible
 *      with circomlib's Poseidon over BN254 (the same hash used in the circuits'
 *      `MerkleProof` template and in off-chain witness generation), otherwise
 *      on-chain roots will not match in-circuit roots.
 *
 *      Generated from circomlibjs `poseidon_gencontract.js` (see
 *      scripts/gen-poseidon-contract.ts).
 */
interface IPoseidon2 {
    function poseidon(uint256[2] calldata input) external pure returns (uint256);
}

/**
 * @title IncrementalMerkleTree
 * @notice O(log n) frontier-based (Tornado-Cash `MerkleTreeWithHistory` style)
 *         fixed-depth incremental Merkle tree, replacing the O(n)-per-insert
 *         rebuild in `contracts/stellar/shielded_pool::append_leaf`.
 *
 * Compatibility: the Stellar `lean_imt` used at fixed depth with zero-padding is
 * mathematically identical to a Tornado zero-tree — empty leaves are the field
 * element 0, and empty subtrees are Poseidon(0,0), Poseidon(z1,z1), ... So this
 * frontier tree produces the SAME roots as the circuit's `MerkleProof(depth)`
 * inclusion check, as long as the injected Poseidon(2) matches circomlib's BN254
 * Poseidon and zero-value is 0.
 *
 * Root history: like Tornado, we keep a rolling window of recent roots so a proof
 * built against a slightly-stale root still verifies (`isKnownRoot`). The Stellar
 * contract kept an unbounded `KnownRoot` set; here we keep a bounded ring plus a
 * permanent mapping for auditability parity.
 */
abstract contract IncrementalMerkleTree {
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint32 public immutable levels;
    IPoseidon2 public immutable poseidon2;

    // frontier: filledSubtrees[i] is the hash of the last-completed left subtree
    // at level i on the current insertion path.
    mapping(uint256 => uint256) public filledSubtrees;
    // precomputed zero-subtree hashes: zeros(i) = Poseidon(zeros(i-1), zeros(i-1))
    mapping(uint256 => uint256) public zeros;

    uint32 public nextLeafIndex;

    // rolling root history (Tornado ROOT_HISTORY_SIZE pattern)
    uint32 public constant ROOT_HISTORY_SIZE = 30;
    mapping(uint256 => uint256) public roots; // ringIndex => root
    uint32 public currentRootIndex;

    // permanent known-root set (parity with Stellar's unbounded KnownRoot map),
    // so a proof against ANY historical root still passes `isKnownRoot`.
    mapping(uint256 => bool) public knownRoots;

    error MerkleTreeFull();
    error IndexOutOfBounds();

    /**
     * @param _levels tree depth (12 in the Shade circuits)
     * @param _poseidon2 the Poseidon(2) hasher (circomlib BN254-compatible)
     */
    constructor(uint32 _levels, IPoseidon2 _poseidon2) {
        require(_levels > 0 && _levels < 32, "bad levels");
        levels = _levels;
        poseidon2 = _poseidon2;

        // zeros[0] = 0 (empty leaf), zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
        uint256 current = 0;
        zeros[0] = 0;
        filledSubtrees[0] = 0;
        for (uint32 i = 1; i < _levels; i++) {
            current = _hashLeftRight(current, current);
            zeros[i] = current;
            filledSubtrees[i] = current;
        }

        // initial (empty) root = Poseidon over the top zero-subtrees
        uint256 initialRoot = _hashLeftRight(current, current);
        roots[0] = initialRoot;
        knownRoots[initialRoot] = true;
    }

    function _hashLeftRight(uint256 left, uint256 right) internal view returns (uint256) {
        return poseidon2.poseidon([left, right]);
    }

    /**
     * @notice Insert a leaf, recomputing only the path to the root (O(log n)).
     * @dev Mirrors Tornado `_insert`. Returns the new leaf index.
     */
    function _insert(uint256 leaf) internal returns (uint32 index) {
        require(leaf < SNARK_SCALAR_FIELD, "leaf >= field");
        uint32 _nextIndex = nextLeafIndex;
        if (_nextIndex == uint32(1) << levels) revert MerkleTreeFull();

        uint32 currentIndex = _nextIndex;
        uint256 currentHash = leaf;
        uint256 left;
        uint256 right;

        for (uint32 i = 0; i < levels; i++) {
            if (currentIndex % 2 == 0) {
                left = currentHash;
                right = zeros[i];
                filledSubtrees[i] = currentHash;
            } else {
                left = filledSubtrees[i];
                right = currentHash;
            }
            currentHash = _hashLeftRight(left, right);
            currentIndex /= 2;
        }

        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        roots[newRootIndex] = currentHash;
        knownRoots[currentHash] = true;

        nextLeafIndex = _nextIndex + 1;
        return _nextIndex;
    }

    /// @notice Current tree root.
    function getRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }

    /// @notice Number of leaves inserted.
    function getLeafCount() public view returns (uint32) {
        return nextLeafIndex;
    }

    /**
     * @notice Whether `root` was ever a valid root of this tree.
     * @dev Uses the permanent known-root map (parity with Stellar's KnownRoot).
     */
    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        return knownRoots[root];
    }
}
