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

1. run the server on Node 18 (needs checking: the server uses plain `node:` modules, `fetch` and three runtime
   dependencies, none of which obviously needs more than 18 – **not yet verified**, nothing was run on Node 18), or
2. build a newer Node for Android ourselves (large, slow, not started).

Option 1 is the plan. First step: run the server and the test suite on Node 18.20.4 on this PC and fix what breaks
(keeping Node 22 working). Then lower `engines` for the Android build only.

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

1. Server on Node 18 (see above) – a test run on this PC.
2. Install the missing SDK parts (cmdline-tools, NDK, CMake) and pick a JDK for Gradle.
3. Android project in `android/`: Gradle wrapper, `app` module, manifest, `MainActivity` (WebView, immersive mode,
   file picker for ROMs, back button), `NodeService`, JNI start of nodejs-mobile.
4. Packaging script: copy `server/ shared/ web/` and production `node_modules` into the app's assets.
5. Debug APK over adb to the phone; then signing and a release build.
