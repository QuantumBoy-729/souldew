# souldew for Android (work in progress)

Goal: one app (APK) that plays Game Boy, Game Boy Color and GBA games with souldew's live tracking and SoulLink sync,
with the game filling the screen, on-screen touch controls and the other controls in an overlay. No Termux, no browser.

The UI already does this on a touch screen (`web/lib/platform.mjs` `IS_TOUCH`, `.touch-play` in `web/styles.css`, the
on-screen pad in `web/player.html`). What is missing is the app around it.

## Shape

```
APK
├─ MainActivity      full-screen WebView (immersive, landscape-friendly), loads http://127.0.0.1:<port>/
├─ NodeService       foreground service that starts the souldew server (server/index.mjs) inside the app
└─ assets/souldew/   server/, shared/, web/, node_modules (engine.io, socket.io, mqtt, htm) – no tools/, no Electron
```

- The emulator is the browser one (EmulatorJS cores, WebAssembly) inside the WebView – no native cores on Android.
- Data lives in the app's private storage (`SLS_DATA_DIR`), ROMs are added through the system file picker
  (copied into the library), like "Add files" in the desktop app.
- RetroArch is not used (tried on the `android-retroarch` branch: separate app, no in-app controls).

## The Node question

souldew's server needs Node ≥ 22.15 (`package.json` engines). The runtime that can live inside an APK is
[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile): its newest release is **Node 18.20.4**
(`nodejs-mobile-v18.20.4-android.zip`: `libnode.so` per ABI plus headers). So either

1. run the server on Node 18, or
2. build a newer Node for Android ourselves (large, slow, not started).

Option 1 is the plan, and it holds up. Checked on this PC with a real Node 18.20.4 (Windows):

- `server/index.mjs` starts, and the status, library, live, native and 3DS routes, `/`, `/player.html` and the
  page modules all answer.
- The suite (`node --test test/*.test.mjs`, 625 tests): 597 pass. The 21 that don't are not app code:
  - 18 test files don't load: 14 import `registerHooks` from `node:module` and 4 import `crc32` from `node:zlib`
    (Node 22 features in the test code – the app code already falls back when `zlib.crc32` is missing). Those files
    were not run on Node 18 at all.
  - 2 tests use the Node 22 form of `mock.timers`.
  - `discoverRoots` fails on this Windows PC on Node 22 as well.
- Two things only look like problems on Node 18 and need a flag in tests, not in the app: there is no global
  `crypto` (`web/lib/sync.mjs` and `invitecode.mjs` are browser modules the tests load in Node; the WebView has it,
  as long as the page is a secure context – `http://127.0.0.1` is) and `fetch` to `localhost` doesn't fall back to
  IPv4 (the app's WebView will use `http://127.0.0.1:<port>` directly).

So the Android build can bundle the server as it is. `engines` (>=22.15) is only a declaration; the bundled Node is 18.

What the Android build leaves out: the Java randomizer (no JRE), the native fast player and 3DS player
(`tools/native`, `tools/ctr`), the Electron shell, the self-updater. Those routes already fall back or hide themselves
when their tools are missing.

## Tooling on this PC (checked)

| Piece | State |
|---|---|
| Android SDK | `ANDROID_HOME` set, platform 36, build-tools 35 and 36, platform-tools (adb) |
| Command-line tools / sdkmanager | missing |
| NDK + CMake | missing – needed for the small JNI bridge that starts `libnode.so` |
| Gradle | not on PATH; the Android project brings its own wrapper |
| Java | Temurin 25 – check which Gradle / Android Gradle Plugin versions accept it (17 or 21 is the safe choice) |
| Device | none connected over adb yet |

## Steps

1. ~~Server on Node 18~~ – done, see above (the 18 test files that didn't load could still be made to run there).
2. Install the missing SDK parts (cmdline-tools, NDK, CMake) and pick a JDK for Gradle.
3. Android project in `android/`: Gradle wrapper, `app` module, manifest, `MainActivity` (WebView, immersive mode,
   file picker for ROMs, back button), `NodeService`, JNI start of nodejs-mobile.
4. Packaging script: copy `server/ shared/ web/` and production `node_modules` into the app's assets.
5. Debug APK over adb to the phone; then signing and a release build.
