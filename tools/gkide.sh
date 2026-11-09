#!/bin/bash
#
# Starts the zerogap browser IDE (docs/IDE.md): builds the WebAssembly
# simulator if needed, fetches the pinned Monaco editor if it is missing,
# copies the example apps where the IDE can fetch them, and serves sim/ on
# 127.0.0.1 with Python's static file server. No server code: the IDE is
# static files, and everything it saves stays in the browser (IndexedDB).
#
#   tools/gkide.sh [port]        (default 8039)
#
# (bash, not sh: emsdk_env.sh needs bash to find its own folder.)
#
set -e
cd "$(dirname "$0")/.."
PORT=${1:-8039}
EXAMPLES="launcher settings hello gallery dice39 qrscan clock totp codex32 signer colorqr"

# 1. The simulator (make is incremental, so this is quick when up to date).
if [ -z "$EMSDK" ] && [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
	. "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1
fi
if command -v emcc >/dev/null 2>&1; then
	# a failed build stops here: an older simulator would look current
	make -s -C sim web
elif [ -f sim/build/web/gksim.js ]; then
	echo "gkide: no emsdk (emcc) found, using the existing sim/build/web/gksim.js" >&2
else
	echo "gkide: needs emsdk to build the simulator (source ~/emsdk/emsdk_env.sh)" >&2
	exit 1
fi

# 2. Monaco (downloaded once, checked against its pinned hash).
[ -f sim/web/vendor/monaco/vs/loader.js ] || tools/fetch_monaco.sh

# 3. The example apps, and an index of their files, for the IDE to seed a
#    new browser profile with. sim/build is not committed.
rm -rf sim/build/web/examples
mkdir -p sim/build/web/examples
for id in $EXAMPLES; do
	cp -r apps/$id sim/build/web/examples/$id
done
python3 -I - sim/build/web/examples $EXAMPLES > sim/build/web/examples.json <<'EOF'
import json, os, sys
root, ids = sys.argv[1], sys.argv[2:]
apps = {}
for app in ids:
    files = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(root, app)):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for f in sorted(filenames):
            if not f.startswith("."):
                files.append(os.path.relpath(os.path.join(dirpath, f), os.path.join(root, app)).replace(os.sep, "/"))
    apps[app] = files
json.dump({"apps": apps}, sys.stdout, indent=1)
EOF

# 4. Serve sim/: the IDE is /web/index.html, and gapkeep.js finds the
#    simulator at ../build/web/gksim.js.
echo "gkide: open http://127.0.0.1:$PORT/web/index.html  (Ctrl+C stops)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory sim
