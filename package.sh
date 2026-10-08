#!/usr/bin/env bash
# Crée l'archive à envoyer sur addons.mozilla.org : dist/resend-<version>.zip
set -euo pipefail
cd "$(dirname "$0")"

FILES=(manifest.json devtools.html devtools.js panel.html panel.js panel.css icons)

version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' manifest.json)
[ -n "$version" ] || { echo "Version introuvable dans manifest.json" >&2; exit 1; }

out="dist/resend-$version.zip"
mkdir -p dist
rm -f "$out"
zip -q -r -X "$out" "${FILES[@]}"

echo "Archive créée : $out"
unzip -l "$out"
