#!/bin/bash
# Runs the app with the fake devices (lib/fake/): `homey app run` on a copy
# of the app in a folder of its own, whose .homeyignore lets lib/fake/ in.
# The app folder itself is not changed, so no build made from it, publish
# among them, has the fake devices. The copy holds what git knows: tracked
# files and new ones, as they are now, without those git leaves out
# (.gitignore, .git/info/exclude). It is deleted when the run ends.
#
#   dev/run-with-fakes.sh [options for homey app run, for example --remote]
#
# Never use --skip-build, here or with `homey app run` or `homey app install`
# in the app folder: the Homey CLI then packs the folder as it is, without
# .homeyignore, so lib/fake/ and the folders it leaves out (progress/, docs/)
# go to Homey too. This script refuses it.
#
# The app then runs on Homey as with `homey app run`. lib/fakeDevices.js
# also needs DEBUG=1, which `homey app run` sets in Docker; with --remote it
# is assumed (not tried): the log says "fake devices on" when it is set.
set -euo pipefail

for arg in "$@"; do
  case "$arg" in
    --skip-build|--skip-build=*|--skipBuild|--skipBuild=*) echo "--skip-build is never used: it packs lib/fake/, progress/ and docs/" >&2; exit 2 ;;
  esac
done

app=$(cd "$(dirname "$0")/.." && pwd)
copy=$(mktemp -d "${TMPDIR:-/tmp}/sg-leddim-fakes.XXXXXX")
trap 'rm -rf "$copy"' EXIT
trap 'exit 130' INT TERM

cd "$app"
git ls-files -z --cached --others --exclude-standard \
  | while IFS= read -r -d '' file; do [ -e "$file" ] && printf '%s\0' "$file"; done \
  | tar --null -T - -cf - | tar -xf - -C "$copy"

grep -v -x 'lib/fake/' "$copy/.homeyignore" > "$copy/.homeyignore.new"
mv "$copy/.homeyignore.new" "$copy/.homeyignore"
[ -f "$copy/lib/fake/index.js" ] || { echo "lib/fake/index.js is missing in the copy" >&2; exit 1; }

echo "Running the app with fake devices from $copy"
cd "$copy"
homey app run "$@"
