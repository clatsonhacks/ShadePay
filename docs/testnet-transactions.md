# Shade Protocol — Testnet Transaction Log

E2E testnet runs: **2026-06-30** (Phases 1–5) · **2026-07-01** (Phase 6: MPC+RFQ)  
Networks: **Arbitrum Sepolia** + **Stellar Testnet**  
Latest git commit: `3506689`

Pool (2026-06-30): `CCSC4FB3ZL6TV7FEMRK3QUF5LALTSI5NQFCBH4Q2VMCQMSTQK6HP2XFQ`  
Pool (2026-07-01, with ZK enforcement): `CDX2H5E4WIQY6QRBRHWOEXYTYOM2J2OFEKQWHKXKL4ASNHJNPI2MXKKJ`  
MPC Verifier: `CCOXS44BQHBDO6NHCUUY3TBVSHVHZB2NKEWCZWQIKBHKLN4YQAEVJUD6`

---

## 1. CCTP Inbound — Arbitrum Sepolia → Stellar

Burn USDC on Arbitrum, Circle attests, mint and forward to the shielded pool on Stellar.

| Step | Chain | Transaction |
|------|-------|-------------|
| USDC burn | Arbitrum Sepolia | [`0xce52182a6cf9bf8591bccce19c60ba7cd5e3c4c6cb823338756a6d8e6cdab49f`](https://sepolia.arbiscan.io/tx/0xce52182a6cf9bf8591bccce19c60ba7cd5e3c4c6cb823338756a6d8e6cdab49f) |
| mint_and_forward | Stellar Testnet | [`c83dadf4591759ff15139ea5188f1e9460415745707875750231325550b01c87`](https://stellar.expert/explorer/testnet/tx/c83dadf4591759ff15139ea5188f1e9460415745707875750231325550b01c87) |
| receive_cctp_deposit | Stellar Testnet | [`78e6379df98bae91898db0a60e0cfd3383677aea741be373923b2a3e7018c367`](https://stellar.expert/explorer/testnet/tx/78e6379df98bae91898db0a60e0cfd3383677aea741be373923b2a3e7018c367) |

Commitment inserted at leaf 1, root `6091a238c163443761...`

---

## 2. ZK Withdraw — Groth16 proof, k=3 anonymity set

Deposit real note + 2 decoy notes into pool, prove ownership of one without revealing which, withdraw net of relayer fee.

| Step | Chain | Transaction |
|------|-------|-------------|
| CCTP fund pool (burn) | Arbitrum Sepolia | `0xe6246ea1234b...` |
| on-chain withdraw | Stellar Testnet | [`d3b0224a42e5f4407648b566abe4151d372f5dfd4b160480a0b33e554d70b0ed`](https://stellar.expert/explorer/testnet/tx/d3b0224a42e5f4407648b566abe4151d372f5dfd4b160480a0b33e554d70b0ed) |

- Anonymity set: k=3 (1 real note + 2 decoy commitments), pool leaf count 5
- Note value: 5,000,000 (7dp) = 0.50 USDC
- Relayer fee: 100,000 (7dp) = 0.01 USDC
- Net received by user: +4,900,000 (7dp) = 0.49 USDC
- Double-spend attempt: rejected (`WasmVm, InvalidAction` — nullifier already spent)

---

## 3. Private Transfer — hidden-amount shielded transfer

Fund input note via CCTP, prove a transfer to an output note with amount hidden; settle on-chain spending the input nullifier and inserting the output commitment.

| Step | Chain | Transaction |
|------|-------|-------------|
| private_transfer_settle | Stellar Testnet | [`72ec7c9df0cdfa9dcdd06989b0c890ab640a9883285f21d044e9c53935b3a937`](https://stellar.expert/explorer/testnet/tx/72ec7c9df0cdfa9dcdd06989b0c890ab640a9883285f21d044e9c53935b3a937) |

- Public fee: 200,000 (7dp) = 0.02 USDC; input/output amounts NOT in public signals
- Double-spend attempt: rejected (input nullifier spent)

---

## 4. RFQ — Path A: private note → proof-of-fill → Arbitrum USDC payout

User submits encrypted intent; solver checks real Arbitrum inventory, signs a quote, fills on Arbitrum first, then settles on Stellar spending the pool note.

| Step | Chain | Transaction |
|------|-------|-------------|
| CCTP fund pool (burn) | Arbitrum Sepolia | `0xcef7accb53ca...` |
| Arbitrum fill to user | Arbitrum Sepolia | [`0x08347ed9b7347d185294b42733149b4c1ec3e17dc887e9b204c26a2434dc8d39`](https://sepolia.arbiscan.io/tx/0x08347ed9b7347d185294b42733149b4c1ec3e17dc887e9b204c26a2434dc8d39) |
| rfq_settle (nullifier + solver credit) | Stellar Testnet | [`b8f84c20d5877bc7fed19837caf93eff11402f1e85faa38b6d86fc5a7a6b0a2b`](https://stellar.expert/explorer/testnet/tx/b8f84c20d5877bc7fed19837caf93eff11402f1e85faa38b6d86fc5a7a6b0a2b) |

- Note value: 5,000,000 (7dp) = 0.50 USDC
- Fee: 50 bps → solver fill: 497,500 (6dp) = 0.4975 USDC to user on Arbitrum
- Pool balance change: 55,092,200 → 50,092,200 (−5,000,000 7dp credited to solver)
- Negative controls passed: `WrongQuote` (#14) on quote-swap attack, `UnauthorizedSolver` (#23) on rogue key

---

## 5. CCTP Outbound — proof-bound Stellar burn → Arbitrum

User proves note ownership with destination/fee/threshold bound into the Groth16 proof; pool burns USDC via CCTP to the user's Arbitrum address.

| Step | Chain | Transaction |
|------|-------|-------------|
| withdraw_cctp burn | Stellar Testnet | [`380b2c219e85e403dc3c47cd04076f275f39998e915018f697509790216c6de2`](https://stellar.expert/explorer/testnet/tx/380b2c219e85e403dc3c47cd04076f275f39998e915018f697509790216c6de2) |
| Circle attestation | — | `pending_confirmations` at time of run |

- Destination: Arbitrum Sepolia, recipient `0xE488bb2bd58E9C425F525293856FAA529f7b1db3`
- Redirect attack rejected: `WrongDestRecipient` (#18) — proof binds original recipient
- Note nullifier spent within `withdraw_cctp` (double-spend reverts)

---

---

## 6. MPC + RFQ Integration — private committee matching + ZK-enforced settlement

Date: **2026-07-01**  
Git commits: `36d9a0b` (Phase C: witness builder + relayer), `6525031` (verifier deploy + pool upgrade)

### 6a. Infrastructure deployment (Stellar Testnet)

New pool wasm includes: `upgrade()` admin entrypoint, `set_mpc_verifier()`, and updated `mpc_settle()` that requires a Groth16 BLS12-381 proof alongside committee Ed25519 signatures.

| Step | Chain | Transaction |
|------|-------|-------------|
| Upload `proof_verifiers.wasm` (mpc_settlement VK) | Stellar Testnet | [`1831c0878e45576d615e9cc4f1a5be977d5195430eb1061cec3a634590a5a281`](https://stellar.expert/explorer/testnet/tx/1831c0878e45576d615e9cc4f1a5be977d5195430eb1061cec3a634590a5a281) |
| Deploy MPC verifier contract → `CCOXS44B…` | Stellar Testnet | [`ba045e2ce0b2cf4d936c52548c1e33d8ab780adce53b07b4ca24733d7d53c689`](https://stellar.expert/explorer/testnet/tx/ba045e2ce0b2cf4d936c52548c1e33d8ab780adce53b07b4ca24733d7d53c689) |
| Upload new `shielded_pool.wasm` | Stellar Testnet | [`06c52ea9db50d51257cc3b08d077f64f6e386fdb566d960c4e0a8c789b01bb4f`](https://stellar.expert/explorer/testnet/tx/06c52ea9db50d51257cc3b08d077f64f6e386fdb566d960c4e0a8c789b01bb4f) |
| Deploy new ShieldedPool → `CDX2H5E4…` | Stellar Testnet | [`13a379063854369b53b24df4615ef5be426acc6edc84d4c8bd99fffddc197c28`](https://stellar.expert/explorer/testnet/tx/13a379063854369b53b24df4615ef5be426acc6edc84d4c8bd99fffddc197c28) |
| `nullreg.set_authorized_spender(pool)` | Stellar Testnet | [`e99d4a63f468ccdac07701a35f63a1a5a4b706120d61d32f3626120f9e634102`](https://stellar.expert/explorer/testnet/tx/e99d4a63f468ccdac07701a35f63a1a5a4b706120d61d32f3626120f9e634102) |
| `pool.set_cctp_messenger(TMM)` | Stellar Testnet | [`d8ef3767a14c484c27b207158a7f9f386bdd196fa15084bd0c96eaa7887bc7e1`](https://stellar.expert/explorer/testnet/tx/d8ef3767a14c484c27b207158a7f9f386bdd196fa15084bd0c96eaa7887bc7e1) |
| `pool.set_transfer_verifier(V)` | Stellar Testnet | [`ef63d286a784686d224676fdc710b89de488adc0071e3e402abb5ae7148cc072`](https://stellar.expert/explorer/testnet/tx/ef63d286a784686d224676fdc710b89de488adc0071e3e402abb5ae7148cc072) |
| `pool.set_deposit_verifier(V)` | Stellar Testnet | [`c704871f7ae20d3403a1c35e15ca8d915c83b2b8572cee57c1c862fe51ed32ba`](https://stellar.expert/explorer/testnet/tx/c704871f7ae20d3403a1c35e15ca8d915c83b2b8572cee57c1c862fe51ed32ba) |
| `pool.set_mpc_verifier(CCOXS44B…)` — ZK proof enforcement live | Stellar Testnet | [`3a7512100fbde55545870216fc940c04ba7647b385aa79aa4ec470a554f6d432`](https://stellar.expert/explorer/testnet/tx/3a7512100fbde55545870216fc940c04ba7647b385aa79aa4ec470a554f6d432) |

### 6b. MPC private matching session

3-of-3 committee ran locally (ephemeral keys); amounts Shamir 2-of-3 secret-shared and X25519-encrypted to each node — no single node sees the matched amount.

| Field | Value |
|-------|-------|
| Session | `session-1782889751449` |
| Intent A | `e57ed8d5-c23f-4a13-baca-38acd7bd8523` — sell 500 USDC:Stellar for XLM:Stellar |
| Intent B | `c21400ce-46d9-45fb-a410-8b2d97b7e641` — sell 500 XLM:Stellar for USDC:Stellar |
| Matched amount | `50,000,000` (7dp) = 500 USDC |
| Batch ID | `e6efb7aa-3894-4a09-bf32-6f03a5d6c0f5` |
| batchHash (SHA-256) | `43a9ab0a2e6868dcca9eea936add388035c5fc91caf95eb33c9b3eef5a48bb01` |
| Committee signatures | 3 of 3 nodes signed; `verifySignedBatch()` → PASS (local + server) |

### 6c. Settlement gate

On-chain `mpc_settle()` now requires both:
1. **Committee multi-sig**: Ed25519 signatures from ≥ 2-of-3 nodes over `batchHash`
2. **Groth16 proof** (BLS12-381, `mpc_settlement` circuit): proves both input notes are genuine Merkle leaves, ASP-compliant labels, domain-separated nullifiers, output commitments, and value conservation — verified by `CCOXS44B…`

The ZK relayer path (Phase C) generates the proof automatically when `circuits/mpc_settlement/build/` artifacts are present. Without the proof, `mpc_settle()` reverts with `MpcProofInvalid` (#26).

---

## Contract addresses (Stellar Testnet)

### Active (2026-07-01)

| Contract | Address |
|----------|---------|
| ShieldedPool | [`CDX2H5E4WIQY6QRBRHWOEXYTYOM2J2OFEKQWHKXKL4ASNHJNPI2MXKKJ`](https://stellar.expert/explorer/testnet/contract/CDX2H5E4WIQY6QRBRHWOEXYTYOM2J2OFEKQWHKXKL4ASNHJNPI2MXKKJ) |
| MPC Verifier (mpc_settlement BLS12-381) | [`CCOXS44BQHBDO6NHCUUY3TBVSHVHZB2NKEWCZWQIKBHKLN4YQAEVJUD6`](https://stellar.expert/explorer/testnet/contract/CCOXS44BQHBDO6NHCUUY3TBVSHVHZB2NKEWCZWQIKBHKLN4YQAEVJUD6) |
| NullifierRegistry | `CBAKCITRZLJZFQC4ISSYH5UESYFUYBFRANVM5VPDA6OH3VDTSLQ2IH67` |
| VerifierWithdraw | `CBMRSDKMUKHH3UBHYMMVST2PY4STQS42WRY5IEQJWFW3HEXCHVPHZLUS` |
| VerifierTransfer | `CAZHGOFBYWHRRE2UWDMDWJKFPK6WZ47LAQXCJ7MVAYRCOYNQ5BHD5SAG` |
| VerifierDepositNoteMint | `CBURZBYMSG4I4SC56LIRS3I3HBKEZCRDTTD2QEO2LUNK3YETTMW4PE7M` |
| CCTP Forwarder | `CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ` |
| CCTP MessageTransmitter | `CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY` |
| USDC SAC | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

### Superseded (2026-06-30)

| Contract | Address |
|----------|---------|
| ShieldedPool (pre-ZK, no upgrade fn) | `CCSC4FB3ZL6TV7FEMRK3QUF5LALTSI5NQFCBH4Q2VMCQMSTQK6HP2XFQ` |

---

## Arc Testnet — StreamPay base rail (2026-07-05)

**Live run of `npm run streampay-demo:arc`** — real native-USDC per-second
streaming on Arc testnet (chainId 5042002). All 10 steps executed end-to-end,
value-conservation invariant asserted from on-chain events:
`payee_paid + payer_refund == deposit (0.005 USDC)`.

**Deployed contract:** [`StreamPay 0x469305823f9796f973363F48a508a47309B2D92c`](https://testnet.arcscan.app/address/0x469305823f9796f973363F48a508a47309B2D92c)

**Parties (three distinct addresses):**
| Role  | Address | Explorer |
|-------|---------|----------|
| Payer (agent, faucet-funded)  | `0x20D3688967b8d93050C1a1062d7aE6567d691796` | [arcscan](https://testnet.arcscan.app/address/0x20D3688967b8d93050C1a1062d7aE6567d691796) |
| Payee (service, fresh keypair) | `0xdAE126fb68B1ee0569B53a022c9Be4D224089970` | [arcscan](https://testnet.arcscan.app/address/0xdAE126fb68B1ee0569B53a022c9Be4D224089970) |
| Escrow (StreamPay contract)   | `0x469305823f9796f973363F48a508a47309B2D92c` | [arcscan](https://testnet.arcscan.app/address/0x469305823f9796f973363F48a508a47309B2D92c) |

**Stream config:** `streamId = 0x1cade4015be7914215d22105153e1e7bf28b22ef15b085ff8c182009f00077f5`, `rate = 0.0001 USDC / sec`, `cap = 0.005 USDC`.

**Transactions (in order of the streaming lifecycle):**

| Step | Action | Amount / effect | Tx hash |
|------|--------|-----------------|---------|
| 1 | Deploy `StreamPay.sol` | new contract on Arc | [`0x86ae9139…`](https://testnet.arcscan.app/tx/0x86ae9139505a673fe0526d19355c5bcd64dd2717d642f797e4418c69a2c5b76d) |
| 2 | Bootstrap payee (native transfer) | 0.01 USDC to payee for gas | [`0xdce24030…`](https://testnet.arcscan.app/tx/0xdce2403062366fd8fc4fdb213c2ad0df591381a36d0a0edd0a3dd6748be7f163) |
| 3 | **OPEN** — payer funds escrow | 0.005 USDC locked as `msg.value` | [`0x8ec9165f…`](https://testnet.arcscan.app/tx/0x8ec9165f7c8c2ff701e35dfb19fed2db315b9369b12f28483790dbd7a9634412) |
| 4 | **WITHDRAW** — mid-stream pull | 0.0011 USDC to payee (`Withdrawn` event) | [`0xf1eb8d0f…`](https://testnet.arcscan.app/tx/0xf1eb8d0f8dbdb583c03ccfafe2ef69d9d611a220e4641885ff382c7cc4fb1e89) |
| 5 | **PAUSE** — freeze accrual | meter at 0.0016 USDC, no accrual for 4s | [`0x8070d5f9…`](https://testnet.arcscan.app/tx/0x8070d5f938e8c97ee44176e4bf57ef1f53b2182be9f86b1a27d21b2585fef849) |
| 6 | **RESUME** — restart accrual | meter resumes; +0.0005 USDC over next 4s | [`0x90037365…`](https://testnet.arcscan.app/tx/0x9003736530439cc13a76c9eb6bf9d4123eb7bd548ade015a6f9667b1f93423f0) |
| 7 | **STOP** — pay net + refund tail | payee +0.0013 USDC, payer refunded 0.0026 USDC (`Stopped` event) | [`0x8ebc27ad…`](https://testnet.arcscan.app/tx/0x8ebc27ad2771e8e94f8829216cdc3facfcdf9c0631c1b89516110cb1bf17ee5b) |

**Invariant (checked from events on step 7):**
- payee paid across the run: `0.0011 (withdraw) + 0.0013 (stop) = 0.0024 USDC`
- payer refunded: `0.0026 USDC`
- sum: `0.005 USDC` == deposited cap ✓
- escrow contract balance after stop: `0` ✓ (fully drained)

All 7 tx hashes are live on [testnet.arcscan.app](https://testnet.arcscan.app).
This is real native USDC (Arc's gas token, 18-dec) moving on every step — not
a mock representation.
