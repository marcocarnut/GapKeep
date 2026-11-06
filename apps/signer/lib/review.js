// What an analysis (lib/psbt/analyze.js) says once keys have checked it.
// analyze() reads a PSBT's claims; only deriving a key proves one. Pure:
// tested under Node.
//
//   applyPlan(a, plan)  plan from planKeys(): changes `a`, adding warnings:
//     an output is the wallet's only if a key proved it;
//     a claim a key refuted is a red warning (it pays someone else);
//     a claim no loaded key can check is amber, and counts as sent.
//
// SPDX-License-Identifier: GPL-3.0-or-later

export function applyPlan(a, plan) {
  for (const o of a.outputs) {
    const p = plan.outputs[o.index];
    const claimed = o.mine;
    o.mine = p.ours;
    o.unchecked = false;
    o.unverified = false;
    o.checkedPath = p.path;
    if (p.ours) {
      o.role = p.role || "mine";
    } else if (p.problem) {
      a.warnings.unshift({ level: "danger", text: `Output ${o.index + 1} claims to be your change, but its key ` +
        `doesn't derive from these keys (${p.problem}): it pays someone else.` });
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
    if (i.badSignature) {
      a.warnings.unshift({ level: "danger", text: `Input ${i.index + 1}: the signature in this PSBT is not valid for this ` +
        "transaction (or isn't SIGHASH_ALL): it doesn't count." });
    }
  }
  return a;
}
