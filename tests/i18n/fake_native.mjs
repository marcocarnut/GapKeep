// A stand-in for "zg:i18n-native" (src/runtime/i18n.cpp), for running
// src/runtime/i18n.js under Node (run_node.mjs). The catalogs are taken as
// they are: checking them is the runtime's (and tools/i18n.py's) job.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, existsSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url);
export const config = { app: "launcher", utcOffset: 0 };
let current = { language: "en", decimal: ".", group: ",", keyboard: "us" };
let set = { decimal: undefined, group: undefined };

function catalog(app, tag) {
  if (tag === "en" || tag === "qps") return null;
  const tags = tag.includes("-") ? [tag.split("-")[0], tag] : [tag];
  let out = null;
  for (const t of tags) {
    const url = new URL(`apps/${app}/lang/${t}.json`, ROOT);
    if (!existsSync(url)) continue;
    out ??= Object.create(null);
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(url, "utf8")).messages)) if (v) out[k] = v;
  }
  return out;
}

function resolve() {
  const comma = current.language === "pt" || current.language.startsWith("pt-");
  let d = set.decimal ?? (comma ? "," : ".");
  let g = set.group ?? (comma ? "." : ",");
  if (d === g) {
    if (set.decimal !== undefined) g = d === "." ? "," : ".";
    else d = g === "." ? "," : ".";
  }
  current.decimal = d;
  current.group = g;
}

export const state = () => ({ ...current });
export const messages = () => catalog(config.app, current.language);
export const systemMessages = () => catalog("launcher", current.language);
export const languages = () => [{ tag: "en", name: "English" }, { tag: "pt-BR", name: "Português (Brasil)" }];
export const keyboards = () => ["us"];
export const utcOffset = () => config.utcOffset;
export function setLanguage(tag) {
  if (!["en", "qps", "pt-BR"].includes(tag)) throw new RangeError(`no language "${tag}"`);
  current.language = tag;
  resolve();
}
export function setMarks(decimal, group) {
  const ok = (m, g) => m === undefined || m === null || m === "." || m === "," || (g && m === "");
  if (!ok(decimal, false) || !ok(group, true) || (decimal != null && decimal === group)) throw new RangeError("setMarks");
  set = { decimal: decimal ?? undefined, group: group ?? undefined };
  resolve();
}
export function setKeyboard(layout) {
  if (layout !== "us") throw new RangeError("setKeyboard");
}
