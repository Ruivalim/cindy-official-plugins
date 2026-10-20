# Baguette Simulator

[简体中文](README.zh-CN.md)

Opt-in Apple Silicon iOS simulator integration using bundled Baguette 0.2.0.
Requires macOS 15.0+, Apple Silicon, Cindy 0.1.83+, full Xcode and an installed iOS runtime. No first-run dependency download. Packaging collects nine portable USDZ model assets from the hash-pinned official release via `binary-dependencies.json`; the native executables remain tracked and macOS-only.

Use only when the user explicitly selects Baguette. Run `environment` and `devices`, reuse a suitable logged-in device, then `boot` if needed. Build the App with the project’s normal Xcode workflow; use `install_app` and `launch_app` for its already-built Simulator `.app`. `launch_app` opens the current session’s sidebar by default. Check `viewer.previewOpened`; a running process does not prove a visible preview. Reopen an existing device with `open_viewer` after changing sessions.

The controller provides **Recover view** (restart the viewer only) and **Release keys** (key-up events only). Neither operation restarts the simulator or app. Agent recovery uses `press` with `button=release-input`. Unicode paste replaces the simulator clipboard; browser Copy replaces the Mac clipboard. Observe the focused field before input and inspect the result afterwards. Keyboard delivery acknowledgements are not App completion acknowledgements.

Devices live under `~/Library/Application Support/BaguetteCindy/devices`, screenshots under its sibling `screenshots`. No default/Cindy embedded device access or automatic device erasure. Reinstalling the same bundle ID normally preserves App data, but App migrations/logout/server session expiry still govern authentication. Concurrent agents must not interleave operations on one device.

`heal` explicitly restarts SpringBoard and terminates running apps: require user acceptance of that effect. Try releasing stuck keys first. `shutdown` stops the selected simulator but retains its data. `close_viewer` stops streaming, not the simulator.

## User controls

Open **Plugins → Baguette** to view actual private-device states, start or shut down a device, open its viewer, or stop all Baguette devices. Turning off **Allow simulators to run** first persists the restriction, then shuts down devices and stops the viewer. Failed shutdown remains visible; tools cannot restart a device while the switch is off. Turning it back on never boots a device. Data and login storage are preserved.

The viewer header includes **Shut down device** and **50%–200% view size**. App pinch gestures remain Option-drag or Ctrl-wheel, separate from view size. In a Chromium-based viewer (for example a Cindy preview), real two-finger touch also pinches; committed text from an IME or soft keyboard is sent through the same Unicode paste path as before (Safari behaviour is unchanged). The idle setting defaults to 15 minutes, with 30 minutes, 1 hour and manual-only options. Device input and actual tool operations renew use; streamed frames, status polling and watching a picture do not. A device shutdown terminates its apps and connections. All private devices share this inactivity clock; changing the idle setting starts a new period.

The sidebar preview also provides **Switch**, **Add device**, and **Edit name**. Adding selects a model and a compatible installed iOS runtime; the new device stays shut down until you switch to it. Renaming preserves apps and data. Changing model or runtime creates a separate device, keeping the original. Switching confirms the previous device is shut down before booting the target and shows progress in the same preview. Other running private devices must be stopped first.

The plugin remembers the last app it successfully launched on each device in `runtime-settings.json.apps.json`. When switching from a running device, it can install that app's simulator bundle on the target and launch it; system apps are launched by bundle ID. App data, logins and credentials are never copied. Without an app record, the target opens its home screen. If the source is already off, the recorded app must already exist on the target. Incompatible apps or failed startup are reported with the actual device state; switching does not promise identical content or login state.

Runtime preferences are stored beside the private device set in `runtime-settings.json`, shared by local users of that set. The worker attempts shutdown on normal exit, but forced termination can interrupt it. Use the settings run switch **before** disabling the plugin in Cindy, and verify the displayed device states. A closed/disconnected preview is never proof of shutdown.

## Security and limitations

The Node Worker runs with local user permissions. Executable paths and command shapes are fixed; there is no arbitrary shell tool. The controller listens only on 127.0.0.1; clipboard/control requests require a matching Origin, random capability and an opened private device. No account tokens are extracted or copied into Cindy storage. Screenshot analysis may send images to the configured model. Actions inside apps can have external side effects and remain subject to the task’s authorization.

The viewer’s optional location map requests reach OpenStreetMap through the fixed-endpoint Node proxy; see VENDOR-REVIEW.md. The farm page uses local font fallbacks without remote font requests. These features do not synchronize simulator accounts. No background dependency installation occurs.

Known upstream limitation: stream disconnects can SIGABRT on iOS 27. The supervisor restarts at most five times per minute; the independent controller remains available for manual recovery. This is mitigation, not a native crash fix. Worker disable/exit or one hour of tool inactivity stops the controller too; recovery after Worker exit requires Cindy to start it again. Cross-session device data persists, but a browser tab is session-scoped.

## Build and verification

Run `sh native/build.sh` on an Apple Silicon Mac with Xcode. This compiles the included Objective-C source and ad-hoc signs the helper. No dependency download. Baguette and HingeControl are rebuilt from v0.2.0 with `vendor-native.patch`; use `sh native/build-baguette.sh <verified-source-archive>` to reproduce the build. The release build uses Swift `-Osize`, strips symbols and ad-hoc signs the host executable to keep tracked binary content below the repository limit. The patch preserves the private device set for screen enumeration and hinge control, reads actual guest hinge angles, and matches renamed devices to their original model.

Run the repository contracts and `.tests/baguette-simulator.test.mjs`. Review VENDOR-REVIEW.md, THIRD-PARTY-LICENSES.txt and the proposal [#119](https://github.com/makecindy/cindy-official-plugins/issues/119). Initial provisioning is an empty targeted audience, not all users. Final package installation in eligible Cindy must be recorded separately from direct Node/native tests.

The optional location panel sends search text and requested map tiles to OpenStreetMap through the Node Worker (fixed nominatim.openstreetmap.org and tile.openstreetmap.org HTTPS endpoints). Browser requests remain same-origin; redirects and arbitrary upstream URLs are rejected. No account credentials are forwarded.

The viewer proxy requires a capability session for HTTP and WebSocket access. The controller exchanges its fragment token for an HttpOnly session cookie. This is not a sandbox against processes with the same macOS user permissions or direct access to the upstream Baguette listener.

## iPhone Duo and Xcode compatibility

Ordinary devices retain the Xcode 26/27 paths. iPhone Duo requires the selected Xcode 27.1 and an installed iOS 27.1 runtime. The upstream viewer includes the Duo 3D model, inner/outer displays, pose buttons and hinge slider; changing the pose changes the simulated device and foreground app layout. The model is read from Xcode, not downloaded by this plugin. The plugin uses the selected Xcode; it does not install, switch or downgrade Xcode automatically. Clipboard writes prefer CoreDevice and fall back to private-set simctl on older or unsupported environments.

Duo preview, closed/open poses, touch and Unicode input were exercised on iOS 27.1 in Cindy 0.1.93 Beta. Xcode 26 integration remains unverified; See VERIFICATION.json for the exact boundary.

If settings cannot be read, device status and shutdown remain available while startup and settings edits stay blocked. Restore the settings file before enabling operation. Device switching may replace an existing target app with the same bundleId when the source app bundle is installed; source app data and login credentials are not copied.
