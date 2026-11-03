// store.js - the IDE's simulated SD card, kept in IndexedDB so a reload
// (or closing the browser) keeps the work. One record per file:
// { path: "apps/<id>/<rel>", data: string | Uint8Array, mtime }.
//
// SPDX-License-Identifier: GPL-3.0-or-later

const DB_NAME = "zerogap-ide", DB_VERSION = 1;

function request (r) {
  return new Promise ((resolve, reject) => {
    r.onsuccess = () => resolve (r.result);
    r.onerror = () => reject (r.error);
  });
}

export class Store {
  static async open () {
    const r = indexedDB.open (DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      r.result.createObjectStore ("files", { keyPath: "path" });
      r.result.createObjectStore ("meta");
    };
    const s = new Store ();
    s.db = await request (r);
    return s;
  }

  tx (stores, mode, fn) {
    return new Promise ((resolve, reject) => {
      const t = this.db.transaction (stores, mode);
      const result = fn (t);
      t.oncomplete = () => resolve (result);
      t.onerror = t.onabort = () => reject (t.error);
    });
  }

  // Every file, as a Map of path -> data. (tx() resolves with fn's result,
  // here the request's promise, which has settled by then.)
  async loadAll () {
    const all = await this.tx (["files"], "readonly", (t) => request (t.objectStore ("files").getAll ()));
    return new Map (all.map ((f) => [f.path, f.data]));
  }

  put (path, data) {
    return this.tx (["files"], "readwrite", (t) => {
      t.objectStore ("files").put ({ path, data, mtime: Date.now () });
    });
  }

  // Several changes in one transaction: { put: [[path, data]...], del: [path...] }.
  change ({ put = [], del = [] }) {
    return this.tx (["files"], "readwrite", (t) => {
      const files = t.objectStore ("files");
      for (const p of del) files.delete (p);
      for (const [path, data] of put) files.put ({ path, data, mtime: Date.now () });
    });
  }

  getMeta (key) {
    return this.tx (["meta"], "readonly", (t) => request (t.objectStore ("meta").get (key)));
  }

  setMeta (key, value) {
    return this.tx (["meta"], "readwrite", (t) => { t.objectStore ("meta").put (value, key); });
  }
}
