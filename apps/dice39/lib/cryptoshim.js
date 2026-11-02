// dice39's core code was written for the browser and calls WebCrypto:
// crypto.subtle.digest('SHA-256', ...) and crypto.getRandomValues(...).
// Give it exactly those two, backed by zerogap's native SHA-256 and
// health-checked hardware RNG, so the extracted code runs unmodified.

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
