// Generic fixed-depth, zero-padded Poseidon(2) Merkle tree — the off-chain
// counterpart to contracts/arc/src/IncrementalMerkleTree.sol's on-chain
// frontier tree. Padding leaves to `2^depth` with the field element 0 and
// hashing pairs bottom-up produces EXACTLY the same root/proofs as the
// on-chain frontier insert (by induction: the empty subtree at level d is
// always `zeros[d] = Poseidon(zeros[d-1], zeros[d-1])`, zeros[0] = 0, which is
// what padding-with-0 naturally reproduces for any unpopulated region).
//
// Depth 12 => capacity 4096, small enough to materialize the whole tree in
// memory for off-chain proof generation (unlike the Rust LeanIMT's sparse
// cache, which optimized for on-chain storage costs that don't apply here).

import { poseidonHash, warmPoseidon, makeSyncHash2 } from "./poseidon.js";

export type MerkleTree = {
  depth: number;
  levels: bigint[][]; // levels[0] = leaves (zero-padded to capacity), levels[depth] = [root]
  root: bigint;
};

export async function buildMerkleTree(leaves: bigint[], depth: number): Promise<MerkleTree> {
  const capacity = 1 << depth;
  if (leaves.length > capacity) {
    throw new Error(`too many leaves: ${leaves.length} > capacity ${capacity} (depth ${depth})`);
  }
  const poseidon = await warmPoseidon();
  const hash2 = makeSyncHash2(poseidon);

  let level: bigint[] = leaves.slice();
  while (level.length < capacity) level.push(0n);

  const levels: bigint[][] = [level];
  for (let d = 0; d < depth; d++) {
    const cur = levels[d];
    const next: bigint[] = new Array(cur.length / 2);
    for (let i = 0; i < cur.length; i += 2) {
      next[i / 2] = hash2(cur[i], cur[i + 1]);
    }
    levels.push(next);
  }
  return { depth, levels, root: levels[depth][0] };
}

export type MerkleProof = {
  leafIndex: number;
  siblings: bigint[]; // length == depth, siblings[i] is the sibling at level i
  root: bigint;
};

export function getMerkleProof(tree: MerkleTree, leafIndex: number): MerkleProof {
  const capacity = 1 << tree.depth;
  if (leafIndex < 0 || leafIndex >= capacity) {
    throw new Error(`leafIndex ${leafIndex} out of range [0, ${capacity})`);
  }
  const siblings: bigint[] = [];
  let idx = leafIndex;
  for (let d = 0; d < tree.depth; d++) {
    const siblingIdx = idx ^ 1;
    siblings.push(tree.levels[d][siblingIdx]);
    idx = idx >> 1;
  }
  return { leafIndex, siblings, root: tree.root };
}

/** Precomputed zero-subtree hashes: zeros[0] = 0, zeros[i] = Poseidon(zeros[i-1], zeros[i-1]). */
export async function computeZeros(depth: number): Promise<bigint[]> {
  const zeros: bigint[] = [0n];
  for (let i = 1; i <= depth; i++) {
    zeros.push(await poseidonHash([zeros[i - 1], zeros[i - 1]]));
  }
  return zeros;
}
