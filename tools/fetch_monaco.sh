#!/bin/sh
#
# Fetches the pinned Monaco editor (the code editor of VS Code) for the
# browser IDE into sim/web/vendor/monaco/vs. Only the npm tarball is
# downloaded, checked against the integrity hash the npm registry published
# for this version (sha512, hardcoded below, plus its sha1 shasum), and its
# prebuilt "min/vs" folder unpacked. Nothing from it is run here: no npm, no
# install scripts. The IDE then works offline.
#
# The hashes come from https://registry.npmjs.org/monaco-editor (field
# versions["0.57.0"].dist). To upgrade, change VERSION and both hashes from
# there, then check the IDE still loads (Monaco's AMD build, which the IDE
# uses, is deprecated upstream).
#
set -e
cd "$(dirname "$0")/.."
VERSION=0.57.0
URL=https://registry.npmjs.org/monaco-editor/-/monaco-editor-$VERSION.tgz
INTEGRITY=sha512-5BkI9KGoqrNvBGUe15/QlZq3OooZ8WLg1AxTpaqHRCP3HNpzPPZKE2EDz8M7c+VRmCeUw1Brp4cx/PWm3kI/5A==
SHASUM=9889fb51ddc27fe90e6da0e96c237c852adc4654

DEST=sim/web/vendor/monaco
TGZ=sim/web/vendor/monaco-editor-$VERSION.tgz

if [ -f $DEST/VERSION ] && [ "$(cat $DEST/VERSION)" = $VERSION ]; then
	echo "monaco: $VERSION already in $DEST"; exit 0
fi
mkdir -p sim/web/vendor
if [ ! -f $TGZ ]; then
	echo "monaco: downloading monaco-editor $VERSION (about 18 MB)"
	curl -fsSL -o $TGZ.part "$URL"
	mv $TGZ.part $TGZ
fi

# npm's "integrity" is "sha512-" + base64 of the binary digest.
got=sha512-$(openssl dgst -sha512 -binary $TGZ | base64 | tr -d '\n')
gotsha1=$(sha1sum $TGZ | cut -d' ' -f1)
if [ "$got" != "$INTEGRITY" ] || [ "$gotsha1" != "$SHASUM" ]; then
	echo "monaco: checksum mismatch, deleting the download" >&2
	rm -f $TGZ; exit 1
fi

# Unpack only package/min/vs (and the license) into a fresh folder.
rm -rf $DEST $DEST.tmp
mkdir -p $DEST.tmp
tar -xzf $TGZ -C $DEST.tmp --no-same-owner --no-same-permissions \
	package/min/vs package/LICENSE
mkdir -p $DEST
mv $DEST.tmp/package/min/vs $DEST/vs
mv $DEST.tmp/package/LICENSE $DEST/LICENSE
rm -rf $DEST.tmp
echo $VERSION > $DEST/VERSION
echo "monaco: $VERSION unpacked into $DEST"
