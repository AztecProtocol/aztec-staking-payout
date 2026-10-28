# V6 compatibility evidence

Target: Ethereum mainnet (chain ID 1), Aztec v6 rollup
`0xe37a2663cc9c119ba41572c40fab0bbb23a5402f`, rollup version `2070860440`.

## Source and ABI

The verified source and ABI were retrieved from the [Blockscout contract API](https://eth.blockscout.com/api?module=contract&action=getsourcecode&address=0xe37a2663cc9c119ba41572c40fab0bbb23a5402f).
The returned `ProposeLib.sol`, `ProposedHeaderLib.sol`, `AttestationLib.sol`,
`CoordinationSignatureLib.sol`, `FeeStructs.sol` and `RewardLib.sol` match the
[v6.0.0 source commit](https://github.com/AztecProtocol/aztec-packages/tree/0219f11d8133970df3974fe5ae65e006bf8c193a/l1-contracts/src/core/libraries)
byte for byte. This is a source comparison, not an independent bytecode audit.

- `ProposeArgs` appends `uint256 bucketHint` after `header`. The header's
  `inHash` becomes `inboxRollingHash` without a type change. The resulting
  proposal selector is `0x0a883a99` (v5: `0x72636df9`, v4: `0x85b98fd8`).
- The proposer signature still signs the EIP-712 `AttestationsAndSigners`
  payload with domain `("Aztec Rollup", "1", chainId, rollupAddress)`.
  `bucketHint` is an unsigned inbox lookup aid, not part of this payload.
- The fourth fee-header word is now `protocolFee`, formerly `congestionCost`.
  RewardLib deducts `manaUsed * protocolFee`, then caps the prover payment to
  the remaining fees. The deduction goes to a protocol recipient, not a burn.
- V6 optionally supports a sequencer reward calculator. This runner refuses
  non-default or changing calculators; it does not approximate their
  per-checkpoint rewards. Counter reconciliation, reward-config change
  detection, finalized complete epochs and all beneficiary gates still apply.

## Offline mainnet regression fixtures

`src/fixtures/` contains public `eth_getTransactionByHash` and
`eth_getTransactionReceipt` responses, plus expected historical contract
reads. No RPC URLs or credentials are included.

| Fixture | L1 block | Checkpoint | Transaction |
| --- | --- | --- | --- |
| `v6-mainnet-proposal.json` | 26276085 | 1 | [0xa7a5d431…](https://etherscan.io/tx/0xa7a5d43132ceb50d59e17a00b5d95256d4f83ac7b94a16f5fb0f95f231976e70) |
| `v6-mainnet-fees.json` | 26289960 | 2100 | [0x094dca60…](https://etherscan.io/tx/0x094dca601f039faa3f030f73cf44b4c334714aab07131fe47417d09725a7cc86) |

Expected proposers come from `getProposerAt(header.timestamp)` at each
transaction's L1 block, independently of signature recovery. Fee headers come
from `getFeeHeader(checkpointNumber)` at that same block. The second fixture
has accumulated fees `3836319254827226190`, mana `2098647`, protocol fee `0`
and prover cost `1727190818001`, yielding net sequencer fees
`211555426201881543`. Synthetic tests cover nonzero protocol deductions,
prover caps and underflow rejection.

The tests recover the real proposer/coinbase for both fixtures, exercise direct
and Multicall3 calldata, reject ambiguous/wrong-target batches, and check fee
ABI decoding. Existing v4/v5 regression tests remain intact.

```bash
npm test
npm run typecheck
npm run build
```

Mainnet v6's first populated epoch is 603, not 0. Use separate settlement
histories for each rollup; never carry the v5 epoch cursor into v6.
