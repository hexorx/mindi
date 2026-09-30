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
  screenshots and video capture must be smoke-tested on the built image. The
  base's sole `playwright-core` 1.62.1 library is preserved from its npx cache
  at `/opt/agent-box/playwright-core` before cache cleanup. No `agent-browser`
  package exists in the pinned base; this change does not add one or claim
  that Hermes' separate browser-tool integration was previously available.
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
the final config observed in HEX-198 has `ArgsEscaped: true`. That field is
Windows-specific, but it must not be reported absent from this Linux image. The upstream revision label identifies Hermes, not this repo's
head; build evidence must record the standalone Git head separately.

Chromium adds 20 Debian artifacts (131 total locked additions/upgrades,
553 final packages) without modifying the existing 111 lock rows. The retained
supplement records the package/source names, signed-index stanza evidence and
downloaded hashes/sizes. The image additionally copies the installed Debian
copyright text for all 20 new packages and FFmpeg into `debian-replacements/`
with a build-generated hash and source-identity manifest. This includes
`libopenh264-8` from source `openh264 2.6.0+dfsg-2`.

Mindi's HEX-206 disposition accepts exclusion of `@photon-ai/slack 0.2.0`
(no license grant); it is no longer an open residual. The sanitizer asserts
`@spectrum-ts/slack 8.0.0` and the known import layout, rejects other executable
importers, excludes the Photon package, and exports a disabled Slack provider.
Using it throws: `Slack via Photon is disabled in this image: @photon-ai/slack is not distributed (no license grant).`
Photon Slack send/receive is unavailable. iMessage, Telegram and Hermes' Python
`/api/platforms/slack/events` route remain unchanged.

The build-generated `payload-remediation.json` records Slack as excluded.
Final inventory/SBOM collection must use the sanitized final image and omit
Slack from distributed components; historical inventories and
`hex198-build-inputs/photon-chain.json` remain unchanged evidence. Refreshed
exact-head LAN build, inventory/SBOM and independent review are still required.
No publication is authorized.

## Dated evidence status — 2026-09-30

HEX-198 built remediation head `d37d1e9bce1ed8e30ce31a3a9f8ad4287c349448`
as image `sha256:72e6ed46632973b999d8ae487eaac1f652bde94575deb3b9a9d9db64c8e42290`;
HEX-199 records scoped independent approval. Preserve the raw configuration
comparison FAIL and its intentional PATH-difference explanation. Those completed
checks do not cover the subsequent Slack exclusion. HEX-207 supplies the next
exact-head LAN evidence. The final notice/source overlay and full acceptance
remain outstanding; see `final-inventory-reconciliation.md`.

## Editable finder CI repair (HEX-206)

Desktop CI run 36699649263 / job 109835832230 at `418803c` rejected the
base-image setuptools editable finder because six namespace search-path strings
contain `@photon-ai/slack`. Inspection of the digest-verified source layer found
no Photon Slack import in that finder. The sanitizer now recognizes only its
exact installed path and full SHA-256, reports it as validated metadata, and
continues to reject all other unexpected references before changing files.
See [the actual-finder fixture and extraction provenance](../apps/agent-box-hermes/test/fixtures/README.md).
Changed finder bytes require fresh inspection; there is no general exemption
for editable finders or Python files. The stale namespace paths remain harmless
references to the excluded directories. Final-image absence and real supported
imports still require coordinator validation on the resulting PR head.
