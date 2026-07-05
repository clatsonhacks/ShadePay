// Human-readable ABI fragments for contracts/arc/src/ShieldedPool.sol's
// settlement entrypoints and read views actually used by the API/relayer.
// Kept minimal and hand-matched to the Solidity signatures rather than
// generated from the full compiler artifact, so this file is the single
// place to update if a function signature changes.

export const SHIELDED_POOL_ABI = [
  // ---- settlement paths ----
  "function receiveDeposit(uint32 sourceDomain, bytes32 cctpNonce, address token, uint256 amount, uint256 commitment, uint256 encryptedNotePayloadHash, uint256 policyId, tuple(uint256[2] a, uint256[2][2] b, uint256[2] c) proof, uint256[14] pub) returns (uint32)",
  "function withdraw(address to, tuple(uint256[2] a, uint256[2][2] b, uint256[2] c) proof, uint256[18] pub)",
  "function privateTransferSettle(tuple(uint256[2] a, uint256[2][2] b, uint256[2] c) proof, uint256[9] pub)",
  "function rfqSettle(address toSolver, bytes32 quoteHash, bytes32 intentHash, bytes32 fillReceiptHash, bytes32 solverPubkey, bytes solverSig, tuple(uint256[2] a, uint256[2][2] b, uint256[2] c) proof, uint256[18] pub)",
  "function withdrawCctp(address to, bytes32 destinationRecipient, uint256 maxFee, uint32 minFinalityThreshold, tuple(uint256[2] a, uint256[2][2] b, uint256[2] c) proof, uint256[18] pub) returns (uint256)",
  "function mpcSettle(bytes32 batchHash, bytes32[] signerPubkeys, bytes[] signatures, tuple(uint256[2] a, uint256[2][2] b, uint256[2] c) proof, uint256[12] pub)",
  "function mpcSettlePriced(bytes32 batchHash, bytes32[] signerPubkeys, bytes[] signatures, tuple(uint256[2] a, uint256[2][2] b, uint256[2] c) proof, uint256[20] pub)",

  // ---- admin / config (used by deploy + operator scripts, not end-user flows) ----
  "function registerAsset(uint256 assetId, address token)",
  "function setAssociationRoot(uint256 root)",
  "function setCommittee(bytes32[] pubkeys)",
  "function setAuthorizedSolver(bytes32 solverPubkey, bool allowed)",
  "function setCctpConfig(address tokenMessenger, address usdc, uint32 outboundDomain)",
  "function setWithdrawVerifier(address v)",
  "function setTransferVerifier(address v)",
  "function setDepositVerifier(address v)",
  "function setMpcVerifier(address v)",
  "function setMpcPricedVerifier(address v)",
  "function setEd25519Verifier(address v)",

  // ---- read views ----
  "function getRoot() view returns (uint256)",
  "function getLeafCount() view returns (uint32)",
  "function isKnownRoot(uint256 root) view returns (bool)",
  "function getAssociationRoot() view returns (uint256)",
  "function getCommittee() view returns (bytes32[])",
  "function getAssetToken(uint256 assetId) view returns (address)",
  "function noteSupply(uint256 assetId) view returns (int256)",
  "function vaultBalance(uint256 assetId) view returns (uint256)",
  "function isAuthorizedSolver(bytes32 solverPubkey) view returns (bool)",

  // ---- events (for indexers / receipt lookups) ----
  "event Deposit(uint32 indexed sourceDomain, bytes32 cctpNonce, uint256 assetId, uint256 amount, uint256 commitment, uint32 leafIndex, uint256 newRoot)",
  "event Withdraw(address indexed to, uint256 nullifierHash, uint256 net, uint256 relayerFee)",
  "event Transfer(uint256 nullifierHash, uint256 outputCommitment, uint32 leafIndex, uint256 newRoot)",
  "event MpcSettled(bytes32 indexed batchHash, uint256 nullifierA, uint256 nullifierB, uint256 outputCommitmentA, uint256 outputCommitmentB, uint256 newRoot)",
  "event RfqSettled(bytes32 indexed quoteHash, address toSolver, uint256 nullifierHash, uint256 credit)",
  "event CctpExit(uint32 indexed destinationDomain, address to, uint256 nullifierHash, uint256 amount)",
] as const;

export const NULLIFIER_REGISTRY_ABI = [
  "function isSpent(bytes32 nullifier) view returns (bool)",
  "function isAuthorized(address spender) view returns (bool)",
] as const;
