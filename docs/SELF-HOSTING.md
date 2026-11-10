# Static hosting

The built `dist/` directory is the complete browser application. Hosting serves
assets; microphone capture, synthesis, encryption, receipt processing and
clipboard handling run on the device. There is no message relay, account server
or signaling backend in ToneSeal.

For local use, run `npm run serve`. The development server binds only to
127.0.0.1 and sends the browser policies needed for the app. Phones visiting a
remote host require HTTPS. Opening `index.html` through `file://` is unsupported.

Any static host can serve the output while preserving relative paths. Serve
JavaScript modules with a JavaScript MIME type, WebAssembly as `application/wasm`
and WOFF2 fonts as `font/woff2`. Keep engine archives and their notices together.

A suitable Content-Security-Policy is:

```text
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

Allow `microphone=(self)` in Permissions-Policy. Explicit clipboard operations
also need browser support, user activation and permission where required.
Camera and geolocation are unused. `Referrer-Policy: no-referrer` and
`X-Content-Type-Options: nosniff` are appropriate. The app does not require a
service worker, third-party scripts, analytics or remote font services.

An unlisted path is a discoverability measure, not access control. A browser
running assets supplied by a host depends on that host's integrity. This is
separate from peer fingerprint comparison over the audio channel.

## Renderer boundary

Build JotTune Synth separately and provide its prepared `web/` bundle through
`--synth-root`, `JOTTUNE_SYNTH_ROOT` or `--assets`. The default adjacent checkout
is `../jottune-synth`. The builder validates the engine registry and file
checksums, compiles ToneSeal's receiver, and assembles the static output locally.
It never fetches a renderer or contacts a hosting API.

The dependency includes its browser runtime support and archived engine files.
These are generated release inputs, not a second copy of the synth source.
Their original licenses and toolchain notices are copied into `dist/`.
Newer prepared bundles also require the upstream `tl-document.mjs` helper,
imported by the worker, policy and authoring modules. The builder includes that
dependency unchanged and refuses an incomplete bundle. Older headerless-renderer
bundles remain buildable; rebuild with a current bundle to gain portable document
validation and metadata-preserving diagnostic exports.
