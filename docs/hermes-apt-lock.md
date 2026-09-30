# Debian package lock for agent-box-hermes

The image adds Debian packages on top of the digest-pinned Hermes base
(`nousresearch/hermes-agent:v2026.8.18@sha256:22e37bb4…ccf6`, Debian 13.4
trixie amd64). The lock in `apps/agent-box-hermes/build/apt-*` fixes every byte
that layer changes and records what the base already contains.

## Which bytes are fixed by what

| Packages | Count | Bytes fixed by |
|---|---|---|
| Inherited and unchanged | 422 | Hermes base image digest |
| Inherited, upgraded by our layer | 10 | `apt-packages.lock` (snapshot URL + SHA256 + size) |
| Added by our layer | 121 | `apt-packages.lock` (snapshot URL + SHA256 + size) |
| Final image | 553 | `apt-final-inventory.tsv`, enforced after install |

`apt-inherited.tsv` lists all 432 base packages with their source package and
source version. Its `bytes` column is `base-digest` or `replaced-by-lock:<version>`.
`artifact_ref` shows where the same version is published. That is either the
rolling mirror pool path with its SHA256, or, for the 42 versions the mirror has
superseded, the snapshot.debian.org path with SHA1 and first_seen. These refs are
provenance only; the installed bytes come from the base digest. The base does
not match its commented `20260505T000000Z` snapshot, because some inherited
versions were first seen on 20260731.

## Snapshot sources

`apt-snapshot.sources` points only at immutable snapshot.debian.org timestamps:

- `debian/20260929T202609Z` for trixie and trixie-updates.
- `debian-security/20260929T215738Z` for trixie-security.

These are the InRelease files the HEX-184 resolution build used, with the same
Date and size. Two checks authenticate the indices:

- apt verifies the signatures with the base's `debian-archive-keyring.pgp`.
- `apt-release.sha256` pins the exact InRelease bytes.

The Valid-Until check is disabled because snapshot Release files expire. The
signature and byte pins still apply.

## Installer

`apt-install-locked.sh [PACKAGE...]` runs as root in the base stage. With no
arguments it uses `apt-requested.list`, and any arguments must equal that list.
It runs these steps in order and stops on the first failure:

1. Requires an amd64 system whose dpkg inventory equals `apt-inherited.tsv`, which catches base drift.
2. Runs `apt-get update` against the snapshot sources only, through
   `Dir::Etc::SourceParts`. The image's own `/etc/apt` files are not modified.
3. Requires exactly the pinned InRelease files and bytes.
4. Simulates the install. It refuses the plan if any package, version,
   architecture or upgraded-from version differs from `apt-packages.lock`,
   or if the plan removes anything.
5. Downloads each locked artifact over HTTPS from its snapshot URL, checks size
   and SHA256, and places it in apt's archive cache.
6. Installs with `--no-download`, so apt cannot fetch anything unlisted. apt
   checks the cached files against the signed indices a second time.
7. Purges `sudo` and `openssh-server`, preserving the extraction strip boundary.
   The pinned base ships neither package, so this is currently a no-op.
8. Requires the final dpkg inventory to equal `apt-final-inventory.tsv` and
   both purged packages to be absent. Then it clears the apt lists and cache.

The Dockerfile invokes the installer below. Its restricted build context allows
`apps/agent-box-hermes/build/apt-*`, with credential exclusions applied last:

```dockerfile
COPY apps/agent-box-hermes/build/apt-* /opt/build/apt/
RUN test "$TARGETARCH" = amd64 \
 && /opt/build/apt/apt-install-locked.sh \
    sway grim wtype wl-clipboard foot xwayland dbus at-spi2-core \
    fonts-dejavu-core fonts-noto-color-emoji wayvnc novnc websockify nginx openssl python3-yaml chromium \
 && rm -rf /opt/build/apt /var/lib/apt/lists/* /etc/s6-overlay/s6-rc.d /etc/cont-init.d \
 && usermod -u 1000 -d /home/agent hermes && groupmod -g 1000 hermes \
 && install -d -o hermes -g hermes /home/agent
```

## LAN validation (HEX-186, 2026-09-30)

The validation ran on drone (linux/amd64, Docker 29.5.2, buildx v0.29.1). It
built the historical 111-artifact `build/apt-*` closure before the Chromium
augmentation. Its input hashes do not certify this changed head.
The build was `--no-cache --pull --platform linux/amd64` and used the integration
snippet above without Chromium or the unrelated cleanup, on the pinned Hermes base:

- The helper printed `111 locked packages installed; inventory verified`. The
  image ID was `sha256:c831f6b0…00c3`.
- That image's dpkg inventory equalled the then-current `apt-final-inventory.tsv`
  and the 533-package inventory of the HEX-184 resolution image `sha256:55422e9b…521c`.
- The `/etc/apt` sources are byte-identical to the base's, and `sudo` and
  `openssh-server` are absent.
- Real apt refused all four negative checks:

  | Check | Result |
  |---|---|
  | libcap2 SHA256 tampered | "SHA256 differs from lock" |
  | nginx version drifted | "apt plan differs" |
  | Rolling deb.debian.org sources | "release files other than apt-release.sha256" |
  | Sorted request order (seatd missing) | "apt plan differs" |

## Changing the package set

Nothing upgrades or downgrades silently. A new package, a new snapshot or a new
base digest changes the plan or the base inventory, and the installer refuses it.
To relock:

1. Run a resolution build and collect the evidence as described in
   `docs/hermes-dependency-evidence.md`.
2. Fetch the chosen snapshot's InRelease and `main/binary-amd64/Packages.xz`
   files.
3. Run:

   ```sh
   python3 apps/agent-box-hermes/build/apt_lock.py \
     --evidence <hex184-evidence-dir> --snapshot <dir-with-InRelease-and-Packages.xz>
   ```

   The generator fails unless every changed artifact matches exactly one
   snapshot stanza by filename, SHA256 and size. If the package set changed,
   update `REQUESTED` in `apt_lock.py` first.
4. Review the diff and rebuild.

`apps/agent-box-hermes/test/apt_lock_test.py` checks that the lock files are
consistent with each other. It also runs the installer against stubbed
apt/dpkg/curl to exercise each refusal path.

## Chromium remediation augmentation (HEX-193)

HEX-198 adds 20 artifacts (121 additions and 10 upgrades total), producing a
553-package final inventory. The original 111 lock rows remain unchanged.
`apt_lock.py` verifies the retained Chromium augmentation against the supplied
snapshot indices and the recorded final inventory when regenerating the lock.
The retained input scope and checksums are in `third-party/hex198-build-inputs/`.
Earlier build-validation paragraphs describe the historical 111-artifact head;
final changed-head LAN/CI build evidence is required for this augmentation.
