// dice39's core code was written for the browser and calls WebCrypto:
// crypto.subtle.digest('SHA-256', ...) and crypto.getRandomValues(...).
// Give it exactly those two, backed by GapKeep's native SHA-256 and
// health-checked hardware RNG, so the extracted code runs unmodified.

import * as gkcrypto from "gk:crypto";

globalThis.crypto = {
  getRandomValues: (array) => gkcrypto.getRandomValues(array),
  subtle: {
    digest: async (algorithm, data) => {
      const name = typeof algorithm === "string" ? algorithm : algorithm && algorithm.name;
      if (name !== "SHA-256") throw new Error("only SHA-256 is available, not " + name);
      return gkcrypto.sha256(data).buffer;
    },
  },
};
