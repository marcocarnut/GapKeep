// camera.js - the IDE's camera bar: what zerogap's (simulated) camera
// films, for apps with ui.Scanner. Kept across reboots: apply() after
// each boot.
//
//   Empty scene   nothing in particular
//   QR code       a code of the text typed; with "one per line", each line
//                 in turn, twice a second (an animated code)
//   Webcam        the computer's camera, 15 frames a second
//   Picture       an image file (any format the browser reads)
//   No camera     as a Pi without one
//
// zerogap decodes the codes itself (the same decoder as on the Pi); the IDE
// only supplies the pictures.
//
// SPDX-License-Identifier: GPL-3.0-or-later

const $ = (id) => document.getElementById (id);

const FRAME_MS = 1000 / 15;
const PART_MS = 500;
// Webcam frames go to zerogap at their own resolution, up to 1920 a side
// (gapkeep.js / synthcam.h), and zerogap makes each frame as the Pi camera
// would: the middle 640x480 pixel for pixel, or the whole picture averaged
// down (the scanner's "field").
const WEBCAM_W = 1920, WEBCAM_H = 1080, MAX_SIDE = 1920;

export class CameraBar {
  // getMachine: () => the running Gapkeep or null; log: (text, isError) => void
  constructor (getMachine, log) {
    this.getMachine = getMachine;
    this.log = log;
    this.mode = localStorage.getItem ("gkide.camera") || "scene";
    if (this.mode === "webcam" || this.mode === "picture") this.mode = "scene";  // ask again
    this.picture = null;        // { data, width, height }
    this.stream = null;         // webcam MediaStream
    this.video = null;
    this.timer = null;
    this.part = 0;

    $("camera-text").value = localStorage.getItem ("gkide.cameraText") || "";
    $("camera-animate").checked = localStorage.getItem ("gkide.cameraAnimate") === "1";
    $("camera-mode").value = this.mode;
    $("camera-mode").onchange = () => this.setMode ($("camera-mode").value);
    $("camera-text").oninput = () => {
      localStorage.setItem ("gkide.cameraText", $("camera-text").value);
      this.fitText ();
      this.apply ();
    };
    $("camera-animate").onchange = () => {
      localStorage.setItem ("gkide.cameraAnimate", $("camera-animate").checked ? "1" : "0");
      this.apply ();
    };
    $("camera-file").onchange = (e) => this.loadPicture (e.target.files[0]);
    this.showControls ();
  }

  fitText () {
    const t = $("camera-text");
    t.rows = Math.min (6, Math.max (1, t.value.split ("\n").length));
  }

  showControls () {
    $("camera-qr").hidden = this.mode !== "qr";
    if (this.mode === "qr") this.fitText ();
    $("camera-info").textContent = "";
  }

  async setMode (mode) {
    if (mode === "picture") {
      $("camera-file").value = "";
      $("camera-file").click ();      // loadPicture() switches the mode
      $("camera-mode").value = this.mode;
      return;
    }
    this.stopWebcam ();
    this.mode = mode;
    localStorage.setItem ("gkide.camera", mode);
    this.showControls ();
    if (mode === "webcam") await this.startWebcam ();
    this.apply ();
  }

  async loadPicture (file) {
    if (!file) return;
    try {
      const bitmap = await createImageBitmap (file);
      // at most 1920 a side, as zerogap's simulated camera takes
      const scale = Math.min (1, 1920 / Math.max (bitmap.width, bitmap.height));
      const w = Math.max (1, Math.round (bitmap.width * scale)), h = Math.max (1, Math.round (bitmap.height * scale));
      const canvas = new OffscreenCanvas (w, h);
      const ctx = canvas.getContext ("2d");
      ctx.drawImage (bitmap, 0, 0, w, h);
      this.picture = { data: ctx.getImageData (0, 0, w, h).data, width: w, height: h };
      this.stopWebcam ();
      this.mode = "picture";
      $("camera-mode").value = "picture";
      this.showControls ();
      $("camera-info").textContent = `${file.name}, ${bitmap.width}x${bitmap.height}`;
      this.apply ();
    } catch (e) {
      this.log (`camera: could not read ${file.name} as a picture (${e.message || e})`, true);
    }
  }

  async startWebcam () {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.log ("camera: this browser gives no access to a webcam here (it needs http://127.0.0.1 or https)", true);
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia ({
        video: { width: { ideal: WEBCAM_W }, height: { ideal: WEBCAM_H }, facingMode: "environment" },
        audio: false,
      });
    } catch (e) {
      this.log (`camera: no webcam (${e.message || e.name})`, true);
      this.stream = null;
      return;
    }
    if (this.mode !== "webcam") {     // changed while the browser asked
      this.stopWebcam ();
      return;
    }
    this.video = document.createElement ("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play ().catch (() => {});
    $("camera-info").textContent = "";
  }

  stopWebcam () {
    if (this.stream) for (const t of this.stream.getTracks ()) t.stop ();
    this.stream = null;
    this.video = null;
  }

  // Tells the machine what the camera sees now, and keeps feeding it
  // (webcam frames, animated codes).
  apply () {
    clearInterval (this.timer);
    this.timer = null;
    const gk = this.getMachine ();
    if (!gk) return;

    switch (this.mode) {
    case "none":
    case "scene":
      gk.camera (this.mode);
      break;
    case "picture":
      if (this.picture) gk.cameraPicture (this.picture.data, this.picture.width, this.picture.height);
      else gk.camera ("scene");
      break;
    case "qr": {
      const text = $("camera-text").value;
      const parts = $("camera-animate").checked ? text.split ("\n").filter ((l) => l !== "") : [text];
      if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
        gk.camera ("scene");
        $("camera-info").textContent = "";
        break;
      }
      const show = () => {
        const i = this.part++ % parts.length;
        const ok = gk.cameraQR (parts[i], this.part > parts.length);   // each part logged once
        $("camera-info").textContent = !ok ? "too long for a QR code"
          : parts.length > 1 ? `part ${i + 1} of ${parts.length}` : "";
      };
      this.part = 0;
      show ();
      if (parts.length > 1) this.timer = setInterval (show, PART_MS);
      break;
    }
    case "webcam": {
      if (!this.video) {
        gk.camera ("scene");
        break;
      }
      let canvas = null, ctx = null;
      this.timer = setInterval (() => {
        const v = this.video;
        if (!v || v.readyState < 2 || !v.videoWidth || this.getMachine () !== gk) return;
        // the webcam's own resolution (scaled down only beyond MAX_SIDE)
        const s = Math.min (1, MAX_SIDE / Math.max (v.videoWidth, v.videoHeight));
        const w = Math.round (v.videoWidth * s), h = Math.round (v.videoHeight * s);
        if (!canvas || canvas.width !== w || canvas.height !== h) {
          canvas = new OffscreenCanvas (w, h);
          ctx = canvas.getContext ("2d", { willReadFrequently: true });
          $("camera-info").textContent = `${v.videoWidth}x${v.videoHeight}`;
        }
        ctx.drawImage (v, 0, 0, w, h);
        gk.cameraPush (ctx.getImageData (0, 0, w, h).data, w, h);
      }, FRAME_MS);
      break;
    }
    }
  }
}
