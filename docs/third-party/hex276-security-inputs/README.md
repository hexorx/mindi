# HEX-276 Tailscale crypto remediation

The candidate 62b47bf7 embeds x/crypto v0.54.0 in tailscaled. GO-2026-6303,
GO-2026-6354 and GO-2026-6355 require v0.55.0 / v0.56.0. The latest upstream
Tailscale v1.102.5 go.mod still pins v0.54.0 (captured alongside this record),
so a release tag bump would not repair these findings.

Build the existing v1.102.4 source from the SHA256-verified release tarball with
Go 1.26.8 (digest-pinned builder). The replacement go.mod/go.sum were resolved
using `go get golang.org/x/crypto@v0.56.0`; Go also raises x/mod, x/net,
x/telemetry, x/text and x/tools to satisfy the module graph. Both commands are
built with CGO disabled, upstream container tags, readonly modules and trimpath.
The custom version suffix identifies this downstream build. No runtime
Tailscale configuration changes are made.

Source: https://github.com/tailscale/tailscale/tree/v1.102.4
Archive SHA256: 784b023e825e1cca7b146ac6a7aff08b179d60d10839b51019f315dab426c871
Go builder index: sha256:a688600ca24f8a4d3ca77f95b0dd40704a9fc787c826660eb7ba0b641b8b175d
Advisories: https://pkg.go.dev/vuln/GO-2026-6303,
https://pkg.go.dev/vuln/GO-2026-6354, https://pkg.go.dev/vuln/GO-2026-6355.

Retain this source and the exact module closure in the final corresponding-source
companion and regenerate attribution/license reconciliation for the new image.
The previous companion is tied to the previous digest and is not reusable as
final evidence. This change alone does not clear any finding: rebuild the combined
secret/vulnerability remediation once, scan its final digest on a current DB,
and obtain independent review of every disposition.

Rollback: revert this source change before another LAN build; retain existing
archives and volumes. No publication, provider calls or production rollout.
