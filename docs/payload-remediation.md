# Image payload policy (HEX-193)

The standalone agent-box image excludes the bundled proprietary Claude Code
executable, `@photon-ai/whatsapp-business` 0.1.1, Google Chrome for Testing,
Playwright's static FFmpeg, and the 14 unverified proprietary font payloads in
`@nous-research/ui` 0.18.2. GSAP 3.15.0 remains under its proprietary-permissive
terms; its package README/metadata and separately labelled linked terms are in
the additive `hex195-provenance-join/prior-disposition` evidence.

The Docker build sanitizes an intermediate filesystem, then copies it into a
`FROM scratch` final stage. A deletion in a later inherited layer would still
redistribute the original bytes. Do not publish the `assembled` stage or its
build cache. The runtime stage restores the base runtime environment explicitly;
the runtime user, workdir, volumes, entrypoint, command and healthcheck remain
explicit. The two baseline notice files and all historical evidence remain
conservative: prior inventory/source-lock rows are not claims of current image
membership or closed source obligations.

## Runtime behavior

- **Fonts:** all five families use `system-ui`/the existing generic fallback.
  Font faces are removed in source and built CSS, and every copy matching the
  14 font hashes is removed, including renamed Vite assets. Layout/typography
  may differ. The existing Debian DejaVu and Noto packages remain available.
- **Browser:** `AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium` selects Debian
  Chromium. Browser downloads are disabled during package installation.
  Playwright's FFmpeg executable slot links to `/usr/bin/ffmpeg`; Debian's
  dynamic GPL-enabled FFmpeg replaces the private-recipe static binary.
  Debian copyright/source-package disclosures remain applicable. Browser
  screenshots and video capture must be smoke-tested on the built image.
- **Photon:** the no-grant package is absent. The MIT Spectrum wrapper exports
  an explicit disabled provider so aggregator imports still load, while using
  WhatsApp Business throws a clear error. The supported Photon iMessage path
  continues to import Spectrum core and its iMessage provider.
- **Claude:** no proprietary executable is included or automatically downloaded.
  An operator who needs the SDK outside supported memory-provider configuration
  can install Claude Code using Anthropic's official instructions at
  <https://code.claude.com/docs/en/setup>, as the `hermes` user, into the
  persistent `/home/agent/.local/bin/claude`. Alternatively set
  `AGENT_BOX_CLAUDE_CLI` to an operator-installed executable. The image launcher
  forwards arguments and otherwise exits 127 with an installation message.
  Supported agent-box memory providers remain `openai` and `anthropic`; this
  does not introduce a supported `claude-code` memory-provider option.

## Verification and evidence

`build/payload-policy.json` records the denied font/native/package hashes from
verified evidence and npm lock integrity. `build/verify_payloads.py --root /`
checks regular filesystem files and compressed archives without changing them.
After building, save the final image locally and run:

```sh
python3 apps/agent-box-hermes/build/verify_payloads.py --docker-save image.tar
```

This checks every layer, including files hidden by later whiteouts and nested
wheel/npm archives, XZ/BZip2 archives, and extensionless tar cache blobs.
Recognized Zstandard/7-Zip/RAR containers fail closed for explicit inspection.
Image absence checks are required in addition to application
unit tests. Record the exact Git head, image digest, package inventory, browser
and FFmpeg smoke checks, Photon imports and configuration comparison. Historical
HEX-195 evidence applies to source `2a74043` / image `3819c040…`; it does not
certify this remediation head. Native/static/build-source residuals remain known
limitations in `docs/third-party/NOTICE-STATUS.md`.

Rollback is a normal revert of the remediation commits on the feature branch.
No runtime data migration is involved. Rollback would restore the excluded
payloads and therefore must not be treated as redistribution clearance.

## Configuration and Debian lock evidence

`docs/third-party/hex198-build-inputs/base-config.json` records the pinned
Hermes image config. The scratch stage retains its environment values except
for the already-established agent home/profile overrides and the documented
browser/Claude path changes. It retains the upstream revision label, root user,
and `/opt/data` volume. The standalone image continues to set `/home/agent` as
workdir, `/init` as entrypoint, empty command, port 8443, its own healthcheck and
two additional data volumes. The base has no custom shell or stop signal;
its ArgsEscaped flag is Windows-specific and is not copied into this Linux
scratch image. The upstream revision label identifies Hermes, not this repo's
head; build evidence must record the standalone Git head separately.

Chromium adds 20 Debian artifacts (131 total locked additions/upgrades,
553 final packages) without modifying the existing 111 lock rows. The retained
supplement records the package/source names, signed-index stanza evidence and
downloaded hashes/sizes. The image additionally copies the installed Debian
copyright text for all 20 new packages and FFmpeg into `debian-replacements/`
with a build-generated hash and source-identity manifest. This includes
`libopenh264-8` from source `openh264 2.6.0+dfsg-2`.

Opi additionally reported no declared license for `@photon-ai/slack 0.2.0`.
That evidence is retained in `hex198-build-inputs/photon-chain.json`; Slack is
outside the accepted exclusions and is not silently removed or treated as an
accepted/closed residual by this change. It remains an unresolved disposition
finding for later release review. No publication is authorized here.
