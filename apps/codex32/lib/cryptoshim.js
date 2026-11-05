// dice39's code was written for the browser: wordsFromEntropy calls
// crypto.subtle.digest('SHA-256', ...). Give it exactly that, backed by
// zerogap's native SHA-256, so the extracted code runs unmodified (as
// apps/dice39/lib/cryptoshim.js does). Only the app imports this: the
// codex32 module itself needs no crypto.

import * as zgcrypto from "zg:crypto";

globalThis.crypto = {
  getRandomValues: (array) => zgcrypto.getRandomValues(array),
  subtle: {
    digest: async (algorithm, data) => {
      const name = typeof algorithm === "string" ? algorithm : algorithm && algorithm.name;
      if (name !== "SHA-256") throw new Error("only SHA-256 is available, not " + name);
      return zgcrypto.sha256(data).buffer;
    },
  },
};
