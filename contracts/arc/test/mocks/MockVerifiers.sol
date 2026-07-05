// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../../src/interfaces/IVerifiers.sol";
import "../../src/CommitteeRegistry.sol";

/**
 * @dev Mock verifiers for testing ShieldedPool's binding/security logic
 *      independent of real Groth16 verification. The REAL proof verification is
 *      exercised separately by the circuit spike (npm run circuits:test:arc),
 *      which checks a genuine snarkjs proof against the generated Verifier.sol.
 *
 *      `setResult(false)` lets tests simulate an invalid proof (fail-closed paths).
 */
contract MockVerifier {
    bool public result = true;

    function setResult(bool r) external {
        result = r;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[9] calldata)
        external view returns (bool) { return result; }
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[18] calldata)
        external view returns (bool) { return result; }
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[14] calldata)
        external view returns (bool) { return result; }
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[12] calldata)
        external view returns (bool) { return result; }
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[20] calldata)
        external view returns (bool) { return result; }
}

/// @dev Mock ed25519 verifier — returns configurable result (real ed25519 lib is
///      vendored for production; committee THRESHOLD logic is tested here).
contract MockEd25519 is IEd25519Verifier {
    bool public result = true;

    function setResult(bool r) external {
        result = r;
    }

    function verify(bytes32, bytes memory, bytes memory) external view returns (bool) {
        return result;
    }
}
