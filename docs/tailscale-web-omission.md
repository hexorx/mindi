# Tailscale web-client omission (HEX-315)

Both Tailscale v1.102.4 binaries use the upstream build tags
`ts_kube,ts_package_container,ts_omit_webclient`. Source archive, Go toolchain,
module locks and the x/crypto security check remain pinned. Version suffix:
`1.102.4-hex315`.

## Feature impact

Upstream `cmd/tailscale/cli/web.go` is excluded by `!ts_omit_webclient`.
`tailscale web` is unavailable, including login/read-only/CGI modes and its
default localhost:8088 listener. `ipn/ipnlocal/web_client_stub.go` replaces
the daemon web implementation, disabling the management UI on tailnet port
5252. `tailscale set --webclient=false` remains accepted: that flag is
unconditionally registered in pinned `cmd/tailscale/cli/set.go`.

The runtime already forces that preference off on every start. Private Serve
on 443 proxies to the authenticated desktop origin on 8443 independently of
the omitted management UI. Enrollment, state reuse, status, IP queries,
private Serve and logout are unaffected by the tag's source selection.
P7 tailscale-smoke.sh exercises CLI/Serve paths and a Headscale peer; it never
uses `tailscale web`. P8 adapter/API acceptance uses the agent-box API and
desktop/memory services, not the Tailscale management UI. These are source
findings; rerun LAN smoke gates on the new candidate for runtime acceptance.

## Build guard and final-image evidence

`build/verify_tailscale_no_web.sh` requires the exact omission tags in both
binaries and rejects the prebuilt web module or web package symbols. It checks
Go's selected package/embed listing and requires the specific unknown-command
failure from `tailscale web`; an unrelated daemon failure does not pass.
Tool errors fail the build.

Retain the guard's complete LAN build output. Extract both final image
binaries without modifying the image and run the guard against them in the
same pinned source/toolchain environment. Record binary SHA256s, commands,
exit statuses, source revision, and final OCI index/platform/config digests.
Unit tests of the guard are not evidence of absence in the final image.

## Companion follow-through

Create a new companion directory; preserve the old evidence and candidate.
Recompute R1/R2 from the actual new binary module selections: omission can
remove Go dependencies as well as web assets. Omit R3 from the new set and
remove its coverage references. Keep the accepted FreeType FTL text/credit
where the component remains and retain unchanged R4/R5 unless verified inputs
actually change. Update R6 for the new digest and omission proof, preserving
bounded signer and Go-source disclosures. Generate R7 over only the final
companion files, excluding itself. Devi must independently review the new R7
hash and image digest; earlier verdicts do not transfer.

## Rollback

Preserve the previous unpublished candidate. Revert merged code through a
reviewed PR. Any rollback candidate needs its own qualification; restoring
web assets restores the unresolved notice obligation. No deployment or
publication is performed by this patch.
