# tvOS and visionOS input adapters

The plugin uses the same owned CoreSimulator device set and run permission as
its iOS tools. These helpers do not launch an app, install software, contact a
network endpoint, read credentials, or inject code into the guest app process.
They accept a UUID, resolve it only in the specified device set, require a booted
device, and serialize input with the existing per-device keyboard lock.

- `remote.m`: tvOS DTUHID messages to the fixed guest service
  `com.apple.coredevice.feature.remote.hid.digitizer`. Protocol reference:
  [facebook/idb](https://github.com/facebook/idb/tree/1de1629a8e5e9838d841689e122d0bd0085a92b6),
  MIT; license included in `THIRD-PARTY-LICENSES.txt`. Only bounded keyboard,
  consumer-button and keyboard-sequence payloads are accepted. A guest barrier
  reply confirms the final release; transport failure is not reported as success.
- `trackpad.m`: native Siri Remote continuous contacts through SimulatorKit's
  `IndigoHIDMessageForTrackpadMoveEvent` and `SimDeviceLegacyHIDClient`, dedicated
  target `0x16`. Began/changed/ended masks follow the same pinned MIT idb reference
  above. No Apple binaries are bundled. Opening a TV view prepares its connection;
  only active contacts hold the existing keyboard lock. The Node worker owns the
  helper's stdin; EOF, malformed input, SIGTERM, or 750 ms without an active-contact
  update releases the finger and closes the helper. Contacts are capped at 20 s
  and 2000 samples. Idle connections wait on stdin without polling the simulator.
  Every sample uses the existing viewer origin, capability and run-permission
  checks. Ownership/platform is established on opening; subsequent samples must
  match the live gesture ID instead of rediscovering the device per frame.
  The stage coalesces only pending absolute positions, lifts after 100 ms without
  wheel events, and ends on blur, hidden page, stream loss or page exit. Clicks and
  keys wait for finger release. OS wheel acceleration/momentum and inferred
  finger-up mean this is not an exact hardware timing/feel replica. Game-specific
  remote gesture behavior remains unverified.
- `spatial.m`: single-hand Paloma selection messages through Xcode's existing
  `SimDeviceLegacyHIDClient`. Layout inspected from the installed Xcode 27
  VisionDeviceKitExtension; no Apple library or executable is redistributed.
  The current camera pose is read from the fixed guest `com.apple.vhmdd` service.
  Image coordinates become a 90-degree horizontal-FOV ray, transformed by that
  pose. Only the left pinch/contact is pressed; the right hand remains released.
  The helper releases before and after each selection and waits for completion.
- The helpers load system CoreSimulator and SimulatorKit from the selected Xcode,
  following the existing keyboard helper. Rebuild all helpers with `sh build.sh`;
  outputs are arm64, macOS 15 minimum, ad-hoc signed and signature-verified.
- Protocol compatibility was exercised on macOS 27.0.1, Xcode 27,
  CoreSimulator 1174.9.2, tvOS 27 and visionOS 27. Older/newer combinations are
  unverified. These are private Apple protocols and may change; missing service,
  missing symbols or invalid camera pose fails the operation. Treat an uncertain
  delivery as unknown and observe before retrying.

## Scope and verification

Apple TV has a rectangular stream and remote navigation; Vision Pro has a
rectangular stream, single-hand tap/hold and keyboard. OCR is available on both;
accessibility trees and IDs are not. iOS touch gestures, orientation, fold posture,
status-bar override and heal are not offered on these platforms. Spatial dragging,
hand tracking, two-hand interaction and camera movement are not implemented.

Disposable devices under `/tmp` were used; the user's plugin devices and default
Xcode set were not touched. Native simulator apps were built, installed and
launched for both platforms. TV remote selection changed an app counter, and keyboard events reached a focused text field.
The tvOS runtime rejects simctl pasteboard access; auto typing therefore uses
US-keyboard events and rejects unsupported text before clearing a field. Vision left,
center and right buttons were selected and a coordinate-reporting app confirmed
ray projection against screenshot coordinates. Agent screenshots and OCR were
exercised on both. The local browser preview displayed both live streams; its
TV remote and Vision canvas click reached the test apps. Vision keyboard and
clipboard paste also reached a focused field. The controller was inspected at
desktop and 320/390-pixel widths, including the dark CSS theme (forced in the
test page without changing host appearance). Current-camera-pose reading is implemented; moved-camera and
immersive-app coverage remains unverified.

On 2026-10-23, the actual controller and compiled trackpad helper were exercised
against a 30-item native SwiftUI tvOS list in the disposable device set. From
focus 0, a 55 CSS-px downward gesture reached item 1; a 220 CSS-px gesture reached
item 4 (500 ms and 150 ms input sequences), and an upward gesture returned to
item 2. All 50 contact API responses confirmed delivery. Page exit released the
contact; native EOF, malformed input, SIGTERM and the idle deadline each exited
and allowed the next remote key to acquire the lock. The test used browser input
through the real controller/API/native stack, not direct App focus assignment.

This is not stable/Beta Cindy package acceptance. Installing the final `.cindy`
and exercising its host preview on a supported production or Beta Cindy remains
required before release.

Input follow-up: the stage bounds its existing key/click/paste queue to 16
outstanding operations. Blur, hidden page, stream loss, page exit, queue overflow
and uncertain input discard unsent operations; nothing is replayed on returning.
The remote and spatial helpers handle SIGTERM/SIGINT by ending an interruptible
hold, sending release, waiting for delivery and exiting unsuccessfully. Their
existing Node command timeout now requests SIGTERM; other commands retain
SIGKILL. Cancellation remains unknown even when the release is confirmed.
Rectangular zoom uses the same simctl screen geometry as Agent observations,
including UI density, instead of an unavailable phone definition.
