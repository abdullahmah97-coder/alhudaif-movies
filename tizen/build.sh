#!/bin/sh
# Builds the unsigned Samsung TV package (HudaifFlix.wgt). Sign it in Tizen Studio
# with a Samsung certificate before installing it on a TV or submitting it to the store.
set -e
cd "$(dirname "$0")"
rm -rf build && mkdir build
cp config.xml icon.png build/ && cp ../index.html build/index.html
(cd build && zip -qr ../HudaifFlix.wgt .)
echo "Built tizen/HudaifFlix.wgt (unsigned)"
