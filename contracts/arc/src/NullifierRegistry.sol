// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title NullifierRegistry
 * @notice Port of `contracts/stellar/nullifier_registry/src/lib.rs` to Solidity/EVM.
 *
 * Tracks spent nullifiers to prevent double-spends. Only contracts explicitly
 * added to the authorized-spender allowlist (e.g. ShieldedPool, StreamEscrow)
 * may call `spend`. Random accounts can never spend a nullifier.
 *
 * Behavior mirrors the Soroban original exactly:
 *   - `spend(nullifier)` reverts if the nullifier was already spent
 *   - `spend(nullifier)` reverts if `msg.sender` is not an authorized spender
 *   - `spend(nullifier)` reverts if the registry is paused
 *   - A nullifier can be spent exactly once, ever
 */
contract NullifierRegistry is AccessControl, Pausable {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// nullifier => spent
    mapping(bytes32 => bool) private _spent;

    /// spender address => authorized
    mapping(address => bool) private _authorized;

    event NullifierSpent(address indexed spender, bytes32 indexed nullifier);
    event AuthorizedSpenderSet(address indexed spender, bool allowed);

    error AlreadyInitialized();
    error UnauthorizedSpender(address spender);
    error NullifierAlreadySpent(bytes32 nullifier);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    /**
     * @notice Admin grants/revokes a contract the right to spend nullifiers.
     * @dev Mirrors Stellar `set_authorized_spender`.
     */
    function setAuthorizedSpender(address spender, bool allowed) external onlyRole(ADMIN_ROLE) {
        _authorized[spender] = allowed;
        emit AuthorizedSpenderSet(spender, allowed);
    }

    function isAuthorized(address spender) external view returns (bool) {
        return _authorized[spender];
    }

    /**
     * @notice Spend a nullifier exactly once.
     * @dev Mirrors Stellar `spend`. Only an authorized spender contract may call.
     *      Reverts on double-spend or unauthorized caller or when paused.
     * @return true on success (always, since failures revert)
     */
    function spend(bytes32 nullifier) external whenNotPaused returns (bool) {
        if (!_authorized[msg.sender]) {
            revert UnauthorizedSpender(msg.sender);
        }
        if (_spent[nullifier]) {
            revert NullifierAlreadySpent(nullifier);
        }
        _spent[nullifier] = true;
        emit NullifierSpent(msg.sender, nullifier);
        return true;
    }

    function isSpent(bytes32 nullifier) external view returns (bool) {
        return _spent[nullifier];
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}
