// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/IncrementalMerkleTree.sol";

/**
 * @title PoseidonDeployer
 * @dev Test helper that deploys the circomlibjs-generated Poseidon(2) contract
 *      (raw creation bytecode in test/poseidon2.bin) so on-chain hashing matches
 *      circomlib's BN254 Poseidon exactly. Uses Foundry cheatcodes to read the
 *      bytecode file and CREATE the contract.
 */
contract PoseidonDeployer is Test {
    function deployPoseidon2() internal returns (IPoseidon2) {
        string memory hexStr = vm.readFile("test/poseidon2.bin");
        bytes memory code = vm.parseBytes(hexStr);
        address addr;
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "poseidon deploy failed");
        return IPoseidon2(addr);
    }
}
