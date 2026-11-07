// What an analysis (lib/psbt/analyze.js) says once keys have checked it.
// analyze() reads a PSBT's claims; only deriving a key proves one. Pure:
// tested under Node.
//
//   applyPlan(a, plan)  plan from planKeys(): changes `a`, adding warnings:
//     an output is the wallet's only if a key proved it;
//     a claim a key refuted is a red warning (it pays someone else);
//     a claim no loaded key can check is amber, and counts as sent;
//     so is multisig change these inputs can't prove (`unproved`, see
//     multisig.js), which says why, and what to do about Electrum;
//     an output of ours at a path the wallet may never scan (`stray`, see
//     sign.js) is amber with the path, and counts as sent;
//     an output of ours past where wallets scan (`far`, see sign.js) stays
//     the wallet's, with a note giving its index;
//     when the keys can sign nothing, the first warning says why, which
//     otherwise only the input rows do.
//   flagSignatures(a, plan)  red warnings for bad signatures in the PSBT.
//
// SPDX-License-Identifier: GPL-3.0-or-later

const XPUBS_HINT = "In Electrum on a computer, tick \"For hardware device; include xpubs\" in the transaction's " +
  "export menu, and show its code again.";

export function applyPlan(a, plan) {
  for (const o of a.outputs) {
    const p = plan.outputs[o.index];
    const claimed = o.mine;
    o.mine = p.ours;
    o.unchecked = false;
    o.unverified = false;
    o.checkedPath = p.path;
    if (p.ours && p.stray) {
      o.mine = false;
      o.stray = p.path;
      a.warnings.unshift({ level: "warn", text: `Output ${o.index + 1} is yours, but ${p.path ? `at ${p.path}` : "in another key"}: ` +
        `the wallet may not see it (${p.stray}). It is counted as sent.` });
      continue;
    }
    if (p.ours) {
      o.role = p.role || "mine";
      o.far = p.far;
      if (p.far !== null) {
        a.warnings.unshift({ level: "warn", text: `Output ${o.index + 1} comes back to you at index ${p.far}: ` +
          "your wallet finds this coin only if it looks that far ahead (gap limit)." });
      }
    } else if (p.problem) {
      a.warnings.unshift({ level: "danger", text: `Output ${o.index + 1} claims to be your change, but its key ` +
        `doesn't derive from these keys (${p.problem}): it pays someone else.` });
    } else if (p.unproved) {
      o.unverified = true;
      a.warnings.unshift({ level: "warn", text: `Output ${o.index + 1} claims to be your change, but that can't be proved: ` +
        `${p.unproved}. It is counted as sent.${p.noXpubs ? " " + XPUBS_HINT : ""}` });
    } else if (claimed) {
      o.unverified = true;
      a.warnings.unshift({ level: "warn", text: `Output ${o.index + 1} claims to be your change, but none of the keys ` +
        "loaded can check that: it is counted as sent. Load the key it belongs to." });
    }
    for (const odd of p.oddities || []) a.warnings.push({ level: "warn", text: `Output ${o.index + 1}: ${odd}` });
  }
  a.toSelf = a.outputs.filter((o) => o.mine).reduce((s, o) => s + o.amount, 0);
  a.sent = a.totalOut === null ? null : a.totalOut - a.toSelf;
  for (const i of plan.inputs) {
    for (const odd of i.oddities || []) a.warnings.push({ level: "warn", text: `Input ${i.index + 1}: ${odd}` });
  }
  const why = nothingToSign(plan);
  if (why) a.warnings.unshift({ level: "warn", text: why });
  return flagSignatures(a, plan);
}

// Why the keys can sign nothing here, or null: the inputs left, by reason.
function nothingToSign(plan) {
  const left = plan.inputs.filter((i) => !i.final && !i.signed);
  if (plan.signable || !left.length) return null;
  const reasons = new Map();
  for (const i of left) reasons.set(i.reason, [...(reasons.get(i.reason) || []), i.index + 1]);
  const parts = [...reasons].map(([reason, n]) => `${n.length > 1 ? "inputs" : "input"} ${n.join(", ")}: ${reason}`);
  return `Nothing here can be signed with these keys. ${parts.join("; ").replace(/^i/, "I")}.`;
}

// Signatures that came with the PSBT and don't hold: true with or without keys.
export function flagSignatures(a, plan) {
  for (const i of plan.inputs) {
    if (i.badSignature) {
      a.warnings.unshift({ level: "danger", text: `Input ${i.index + 1}: the signature in this PSBT is not valid for this ` +
        "transaction (or isn't SIGHASH_ALL): it doesn't count." });
    }
  }
  return a;
}
