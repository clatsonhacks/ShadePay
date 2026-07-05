// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/ShieldedPool.sol";
import "../src/NullifierRegistry.sol";
import "../src/IncrementalMerkleTree.sol";

/**
 * @title Deploy
 * @notice Deploys and wires the full Shade shielded-pool system on Arc:
 *         Poseidon2 (from circomlibjs bytecode), NullifierRegistry, all five
 *         Groth16 verifiers, and ShieldedPool. Mirrors the Stellar
 *         deploy+init scripts (scripts/deploy-stellar-contracts.ts).
 *
 * Verifier addresses are passed via env so the generated Verifier.sol artifacts
 * can be deployed separately (or set to address(0) and wired later via admin).
 *
 * Env:
 *   PRIVATE_KEY            deployer key
 *   POOL_ID, CHAIN_ID      domain separators
 *   TREE_DEPTH             merkle depth (default 12)
 *   POSEIDON2_BYTECODE     hex creation bytecode from Poseidon2Bytecode.json
 */
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address admin = vm.addr(pk);
        uint256 poolId = vm.envOr("POOL_ID", uint256(1));
        uint256 chainId = vm.envOr("CHAIN_ID", uint256(block.chainid));
        uint32 depth = uint32(vm.envOr("TREE_DEPTH", uint256(12)));

        vm.startBroadcast(pk);

        // 1. deploy Poseidon2 from raw circomlibjs bytecode
        bytes memory poseidonCode = vm.parseBytes(vm.readFile("test/poseidon2.bin"));
        address poseidonAddr;
        assembly {
            poseidonAddr := create(0, add(poseidonCode, 0x20), mload(poseidonCode))
        }
        require(poseidonAddr != address(0), "poseidon deploy failed");

        // 2. nullifier registry
        NullifierRegistry nullReg = new NullifierRegistry(admin);

        // 3. shielded pool
        ShieldedPool pool = new ShieldedPool(
            admin,
            address(nullReg),
            poolId,
            chainId,
            depth,
            IPoseidon2(poseidonAddr)
        );

        // 4. authorize the pool to spend nullifiers
        nullReg.setAuthorizedSpender(address(pool), true);

        vm.stopBroadcast();

        console.log("Poseidon2:        ", poseidonAddr);
        console.log("NullifierRegistry:", address(nullReg));
        console.log("ShieldedPool:     ", address(pool));
        console.log("");
        console.log("Next: deploy the 5 Groth16 verifiers and call pool.set*Verifier(),");
        console.log("      then registerAsset / setAssociationRoot / setCommittee.");
    }
}
