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
//     multisig change that isn't the inputs' wallet (`notWallet`) is red;
//     an output of ours at a path the wallet may never scan (`stray`, see
//     sign.js) is amber with the path, and counts as sent;
//     an output of ours past where wallets scan (`far`, see sign.js) stays
//     the wallet's, with a note giving its index;
//     when the keys can sign nothing, the first warning says why, which
//     otherwise only the input rows do.
//   flagSignatures(a, plan)  red warnings for bad signatures in the PSBT.
//
// The warnings are Messages (text.js): English, translated by the app.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { t, plural, numbers } from "./text.js";

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
      const n = o.index + 1;
      a.warnings.unshift({ level: "warn", text: p.path
        ? t("Output {n} is yours, but at {path}: the wallet may not see it ({why}). It is counted as sent.",
          { n, path: p.path, why: p.stray })
        : t("Output {n} is yours, but in another key: the wallet may not see it ({why}). It is counted as sent.",
          { n, why: p.stray }) });
      continue;
    }
    if (p.ours) {
      o.role = p.role || "mine";
      o.far = p.far;
      if (p.far !== null) {
        a.warnings.unshift({ level: "warn", text: t("Output {n} comes back to you at index {index}: your wallet " +
          "finds this coin only if it looks that far ahead (gap limit).", { n: o.index + 1, index: p.far }) });
      }
    } else if (p.notWallet) {
      a.warnings.unshift({ level: "danger", text: t("Output {n} claims to be your change, but it is not the " +
        "wallet the inputs are ({why}): it may pay someone else.", { n: o.index + 1, why: p.problem }) });
    } else if (p.problem) {
      a.warnings.unshift({ level: "danger", text: t("Output {n} claims to be your change, but its key " +
        "doesn't derive from these keys ({why}): it pays someone else.", { n: o.index + 1, why: p.problem }) });
    } else if (p.unproved) {
      o.unverified = true;
      a.warnings.unshift({ level: "warn", text: p.noXpubs
        ? t("Output {n} claims to be your change, but that can't be proved: {why}. It is counted as sent. In " +
          "Electrum on a computer, tick \"For hardware device; include xpubs\" in the transaction's export menu, " +
          "and show its code again.", { n: o.index + 1, why: p.unproved })
        : t("Output {n} claims to be your change, but that can't be proved: {why}. It is counted as sent.",
          { n: o.index + 1, why: p.unproved }) });
    } else if (claimed) {
      o.unverified = true;
      a.warnings.unshift({ level: "warn", text: t("Output {n} claims to be your change, but none of the keys " +
        "loaded can check that: it is counted as sent. Load the key it belongs to.", { n: o.index + 1 }) });
    }
    for (const odd of p.oddities || []) {
      a.warnings.push({ level: "warn", text: t("Output {n}: {oddity}", { n: o.index + 1, oddity: odd }) });
    }
  }
  a.toSelf = a.outputs.filter((o) => o.mine).reduce((s, o) => s + o.amount, 0);
  a.sent = a.totalOut === null ? null : a.totalOut - a.toSelf;
  for (const i of plan.inputs) {
    for (const odd of i.oddities || []) {
      a.warnings.push({ level: "warn", text: t("Input {n}: {oddity}", { n: i.index + 1, oddity: odd }) });
    }
  }
  const why = nothingToSign(plan);
  if (why) a.warnings.unshift({ level: "warn", text: why });
  return flagSignatures(a, plan);
}

// Why the keys can sign nothing here, or null: the inputs left, by reason.
function nothingToSign(plan) {
  const left = plan.inputs.filter((i) => !i.final && !i.signed);
  if (plan.signable || !left.length) return null;
  const reasons = new Map();   // by their English (Messages are objects)
  for (const i of left) {
    const k = String(i.reason);
    reasons.set(k, reasons.get(k) || { reason: i.reason, inputs: [] });
    reasons.get(k).inputs.push(i.index + 1);
  }
  const parts = [...reasons.values()].map(({ reason, inputs }, j) => j === 0
    ? plural(inputs.length, "Input {list}: {reason}", "Inputs {list}: {reason}", { list: numbers(inputs), reason })
    : plural(inputs.length, "input {list}: {reason}", "inputs {list}: {reason}", { list: numbers(inputs), reason }));
  const all = parts.slice(1).reduce((list, part) => t("{list}; {reason}", { list, reason: part }), parts[0]);
  return t("Nothing here can be signed with these keys. {reasons}.", { reasons: all });
}

// Signatures that came with the PSBT and don't hold: true with or without keys.
export function flagSignatures(a, plan) {
  for (const i of plan.inputs) {
    if (i.badSignature) {
      a.warnings.unshift({ level: "danger", text: t("Input {n}: the signature in this PSBT is not valid for this " +
        "transaction (or isn't SIGHASH_ALL): it doesn't count.", { n: i.index + 1 }) });
    }
  }
  return a;
}
