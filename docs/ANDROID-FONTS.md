# Downloaded TTF/OTF fonts

The Android font picker uses Storage Access Framework. `FontStore` copies the selected stream into the app's private files directory. It retains no source URI, source filename or filesystem path. Removing a registered font deletes only that private copy. App data clearing/uninstallation removes the registry; its source font is unaffected.

Each standalone TTF/OTF has a SHA-256 content ID. Duplicate bytes reuse the existing entry. Names, localized aliases, weight and slant come from the font's SFNT tables, rather than its filename. The registry allows 64 fonts, 16 MiB per font and 128 MiB total. Imports check the SFNT signature, bounded/nonoverlapping table directory, required outline/metrics tables, head/maxp/loca/cmap/name structures, Unicode names, CFF header and weight bounds. TTC collections and WOFF/WOFF2 imports are currently unsupported. Structural validation does not replace the browser/CanvasKit decoder's font parsing; rejected renderer faces use Studio's existing fallback behavior.

Writes use a synced temporary file and an atomic move inside the private directory. Listing and reading revalidate copies and their SHA-256; damaged copies are excluded from the catalog and never supplied to a renderer. Corrupt entries still count toward the private storage budget. No user document or global font configuration is changed.

`FontStore.snapshot()` returns `{revision, faces}` with renderer metadata only. The revision is a digest of the sorted content IDs plus the metadata parser version. `read(id, revision)` rejects stale catalogs and unsafe IDs. Native `fontList`, `fontImport`, `fontDelete` and `fontRead` expose this store to the host; `fontRead` returns an opaque `/document/<UUID>` resource and release token. The JS provider fetches that exact relative resource, disables redirects, streams at most 16 MiB and always attempts native `release`. Font reads are serialized so parallel renderer requests consume at most one token in the native document/font pool. There is no font-byte/base64 JavaScript-interface payload.

`android-fonts.mjs` installs a `HostFontProvider` using `window.rhwpStudio.fonts.setProvider`. After a successful import/delete, the host calls the returned provider's `refresh()`. Upstream Studio resolves the selected actual style/face, invalidates document font resources and reads real SFNT bytes. CanvasKit instantiates those bytes through `Typeface.MakeFreeTypeFaceFromData` / `FontMgr.FromData`; Canvas2D prepares a private `FontFace` alias through `HostCanvasFontSession` and uses it for both drawing and supplemental WASM text measurements. This is renderer registration, beyond a font dropdown entry. SVG rendering is not covered by this provider path.

## Validation

Run the pure JVM checks using installed redistributable fonts (or equivalent supplied TTF regular/bold and CFF OTF fixtures):

```sh
source /workspace/.cloud-setup/env.sh
mkdir -p /tmp/hwpxxx-font-jvm
javac -d /tmp/hwpxxx-font-jvm app/src/main/java/kr/offline/hwp/FontStore.java tests/FontStoreTest.java
java -cp /tmp/hwpxxx-font-jvm kr.offline.hwp.FontStoreTest \
  /usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf \
  /usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf \
  /usr/share/fonts/opentype/urw-base35/NimbusSans-Regular.otf \
  app/src/main/assets/fonts/NotoSansKR-Regular.ttf
node --test tests/android-fonts.test.mjs
```

The JVM suite covers real TTF/OTF metadata and bytes, persistence, duplicates, delete, stale revisions, corrupt copies, traversal/symlinks, malformed font structures/Unicode, interrupted/oversized input and count/total storage limits. The provider suite covers byte streams, metadata validation, redirect/path rejection, native release after errors, aborts, stale queued reads and three simultaneous face requests.

With Python Playwright, Chromium, Node, prepared patched Studio dependencies and its matching `pkg` WASM:

```sh
python tests/android-font-renderer.py --studio-root /path/to/patched/rhwp-studio
```

The source harness creates a temporary local Vite server without modifying Studio. It initializes the real WASM bridge and real Canvas2D/CanvasKit renderer modules, supplies installed Liberation Sans regular/bold TTF, Nimbus Sans CFF OTF and the app's bundled Korean TTF bytes through the Android opaque-resource provider, compares Canvas2D pixels/width to independent FontFace loads, checks different CanvasKit regular/bold output, and verifies import/delete generation cleanup and token release. It does not demonstrate Android SAF/device behavior, DeX hardware, Samsung IME or the complete production editor. Those require separate host/build/device checks.

## Importing a whole folder

`Android · 글꼴` → **폴더에서 가져오기** opens the system folder picker and imports every `.ttf`/`.otf` in the chosen folder and its subfolders (breadth first; at most 200 folders and 256 font files are looked at, dot-names are skipped). It is a one-time bulk import, not a link: the read grant is used for that call only and nothing is watched afterwards. Each file passes through the same `FontStore.importFont` validation and limits as a single import. Files that cannot be read or are not valid fonts are counted and skipped, bytes that are already stored are left as they are, and reaching the store limit (64 fonts or 128 MiB) stops the run without undoing what was imported. The dialog reports how many were added, already present, skipped, and whether the limit was reached.
