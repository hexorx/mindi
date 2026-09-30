#!/usr/bin/python3
# HEX-192 in-image probe. Runs inside the final image with --network none --read-only.
# Writes only under the output dir. Stdlib only. No mutation of the image filesystem.
import base64, hashlib, json, os, re, struct, subprocess, sys

W = sys.argv[1]
os.makedirs(W, exist_ok=True)
SKIP = {"/proc", "/sys", "/dev", "/w", "/tmp", "/run"}

TARGETS = [
    ("@fastify/busboy", "3.1.1", 1808), ("@novnc/novnc", "1.6.0", 1835), ("@types/brace-expansion", "1.1.0", 1968),
    ("@types/node", "20.17.47", 1974), ("acorn", "8.8.1", 2009), ("acorn-bigint", "1.0.0", 2010),
    ("acorn-class-fields", "1.0.0", 2011), ("acorn-dynamic-import", "4.0.0", 2012), ("acorn-export-ns-from", "0.2.0", 2013),
    ("acorn-globals", "6.0.0", 2014), ("acorn-import-assertions", "1.8.0", 2015), ("acorn-import-meta", "1.1.0", 2016),
    ("acorn-jsx", "5.3.1", 2017), ("acorn-loose", "8.3.0", 2019), ("acorn-node", "2.0.1", 2020),
    ("acorn-numeric-separator", "0.3.4", 2021), ("acorn-private-class-elements", "1.0.0", 2022),
    ("acorn-private-methods", "1.0.0", 2023), ("acorn-static-class-features", "1.0.0", 2024), ("acorn-walk", "8.2.0", 2025),
    ("balanced-match", "2.0.0", 2140), ("beep-boop", "1.2.3", 2156), ("binary-search", "1.3.6", 2161),
    ("brace-expansion", "2.0.1", 2182), ("cjs-module-lexer", "1.2.3", 2239), ("corepack", "0.24.0", 2298),
    ("minimatch", "9.0.3", 3069), ("undici", "7.3.0", 3846), ("undici-types", "7.3.0", 3848), ("xtend", "4.0.2", 4075),
]
TNAMES = {t[0] for t in TARGETS}


def sha256f(p, algo="sha256"):
    h = hashlib.new(algo)
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def run(cmd, timeout=120, env=None):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return {"cmd": cmd, "rc": r.returncode, "stdout": r.stdout[-20000:], "stderr": r.stderr[-6000:]}
    except Exception as e:
        return {"cmd": cmd, "error": repr(e)}


def dump(name, obj):
    with open(os.path.join(W, name), "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True)


# ---------------------------------------------------------------- dpkg maps
owner, md5 = {}, {}
for fn in os.listdir("/var/lib/dpkg/info"):
    full = "/var/lib/dpkg/info/" + fn
    if fn.endswith(".list"):
        for line in open(full, errors="replace"):
            p = line.rstrip("\n")
            if p and p != "/.":
                owner.setdefault(p, []).append(fn[:-5])
    elif fn.endswith(".md5sums"):
        for line in open(full, errors="replace"):
            parts = line.rstrip("\n").split("  ", 1)
            if len(parts) == 2:
                md5["/" + parts[1]] = (parts[0], fn[:-8])


def dpkg_info(p):
    rp = os.path.realpath(p)
    d = {"owner_path": owner.get(p), "owner_realpath": owner.get(rp) if rp != p else None}
    m = md5.get(p) or md5.get(rp)
    if m and os.path.isfile(rp):
        actual = sha256f(rp, "md5")
        d.update(md5sums_pkg=m[1], md5sums_expected=m[0], md5_actual=actual, md5_match=(actual == m[0]))
    return d


def elf_info(p):
    try:
        with open(p, "rb") as f:
            data = f.read(1 << 16)
            if data[:4] != b"\x7fELF":
                return {"elf": False}
            f.seek(0)
            data = f.read()
    except Exception as e:
        return {"error": repr(e)}
    e_phoff, = struct.unpack_from("<Q", data, 0x20)
    e_phentsize, e_phnum = struct.unpack_from("<HH", data, 0x36)
    interp, dyn = None, None
    loads = []
    for i in range(e_phnum):
        o = e_phoff + i * e_phentsize
        p_type, p_flags, p_off, p_vaddr, p_paddr, p_filesz = struct.unpack_from("<IIQQQQ", data, o)
        if p_type == 3:
            interp = data[p_off:p_off + p_filesz].rstrip(b"\0").decode()
        elif p_type == 2:
            dyn = (p_off, p_filesz)
        elif p_type == 1:
            loads.append((p_vaddr, p_off, p_filesz))
    needed, strtab, strsz, needed_off = [], None, None, []
    if dyn:
        off, sz = dyn
        for j in range(0, sz, 16):
            tag, val = struct.unpack_from("<qQ", data, off + j)
            if tag == 0:
                break
            if tag == 1:
                needed_off.append(val)
            elif tag == 5:
                strtab = val
    if strtab is not None:
        for va, po, fs in loads:
            if va <= strtab < va + fs:
                base = po + (strtab - va)
                for v in needed_off:
                    end = data.index(b"\0", base + v)
                    needed.append(data[base + v:end].decode())
    etype, = struct.unpack_from("<H", data, 0x10)
    return {"elf": True, "e_type": {2: "EXEC", 3: "DYN"}.get(etype, etype), "interp": interp,
            "needed": needed, "statically_linked": interp is None and not needed}


def strings_hits(p, patterns):
    out = {}
    try:
        data = open(p, "rb").read()
    except Exception as e:
        return {"error": repr(e)}
    for pat in patterns:
        ms = re.findall(pat, data)
        out[pat.decode()] = {"count": len(ms), "samples": sorted({m.decode("latin-1") for m in ms})[:8]}
    return out


# ---------------------------------------------------------------- walk once
pkgjsons, elf_candidates, bundled_claude = [], [], []
walked = 0
for root, dirs, files in os.walk("/", followlinks=False):
    if root in SKIP:
        dirs[:] = []
        continue
    dirs[:] = [d for d in dirs if os.path.join(root, d) not in SKIP]
    for fn in files:
        walked += 1
        p = os.path.join(root, fn)
        if fn == "package.json":
            pkgjsons.append(p)
        low = fn.lower()
        if ("ffmpeg" in low or low in ("chrome", "chrome-headless-shell", "headless_shell", "chromium", "chromium-browser")
                or low.startswith("docker")) and os.path.isfile(p) and not os.path.islink(p):
            elf_candidates.append(p)
        if fn == "claude" and "_bundled" in root:
            bundled_claude.append(p)

# ---------------------------------------------------------------- 1. docker
dock = {"path": "/usr/bin/docker"}
p = "/usr/bin/docker"
dock["realpath"] = os.path.realpath(p)
dock["exists"] = os.path.exists(p)
if dock["exists"]:
    dock.update(size=os.path.getsize(p), sha256=sha256f(p), md5=sha256f(p, "md5"), sha1=sha256f(p, "sha1"),
                elf=elf_info(p), dpkg=dpkg_info(p))
dock["dpkg_S"] = run(["dpkg", "-S", "/usr/bin/docker"])
dock["dpkg_query"] = run(["dpkg-query", "-W", "-f",
                          "${Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\t${db:Status-Abbrev}\t${Built-Using}\t${Static-Built-Using}\n",
                          "docker-cli"])
dock["dpkg_verify_docker_cli"] = run(["dpkg", "--verify", "docker-cli"])
dock["docker_cli_md5sums_usr_bin_docker"] = [l.rstrip() for l in open("/var/lib/dpkg/info/docker-cli.md5sums") if l.rstrip().endswith("usr/bin/docker")] if os.path.exists("/var/lib/dpkg/info/docker-cli.md5sums") else None
dock["docker_version"] = run(["/usr/bin/docker", "--version"], timeout=20)
dock["other_docker_named_files"] = []
for c in sorted(elf_candidates):
    if os.path.basename(c).lower().startswith("docker") and c != p:
        dock["other_docker_named_files"].append({"path": c, "sha256": sha256f(c), "size": os.path.getsize(c), "dpkg": dpkg_info(c)})
dock["which_all"] = run(["sh", "-c", "for d in $(echo $PATH | tr : ' '); do [ -e $d/docker ] && ls -l $d/docker; done; echo PATH=$PATH"])
dump("docker.json", dock)

# ---------------------------------------------------------------- 2. npm
locks = {}


def find_lock(pkgdir):
    """Walk up to find a lockfile that has an entry for this installed dir."""
    cur = pkgdir
    while True:
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent
        for cand in (os.path.join(cur, "package-lock.json"), os.path.join(cur, "node_modules", ".package-lock.json"),
                     os.path.join(cur, "npm-shrinkwrap.json")):
            if os.path.isfile(cand):
                if cand not in locks:
                    try:
                        locks[cand] = json.load(open(cand)).get("packages", {})
                    except Exception:
                        locks[cand] = {}
                key = os.path.relpath(pkgdir, cur)
                e = locks[cand].get(key)
                if e is not None:
                    return {"lockfile": cand, "key": key, "version": e.get("version"), "resolved": e.get("resolved"),
                            "integrity": e.get("integrity"), "link": e.get("link"), "dev": e.get("dev")}


def dir_manifest(d):
    lines = []
    for r, ds, fs in os.walk(d):
        ds.sort()
        for f in sorted(fs):
            fp = os.path.join(r, f)
            if os.path.islink(fp):
                lines.append("link:%s  %s" % (os.readlink(fp), os.path.relpath(fp, d)))
            elif os.path.isfile(fp):
                lines.append("%s  %s" % (sha256f(fp), os.path.relpath(fp, d)))
    return hashlib.sha256("\n".join(lines).encode()).hexdigest(), len(lines)


found = {}
for pj in pkgjsons:
    try:
        j = json.load(open(pj))
    except Exception:
        continue
    if not isinstance(j, dict) or j.get("name") not in TNAMES:
        continue
    d = os.path.dirname(pj)
    rec = {"package_json": pj, "realpath": os.path.realpath(pj), "name": j.get("name"), "version": j.get("version"),
           "license": j.get("license"), "package_json_sha256": sha256f(pj), "dpkg": dpkg_info(pj),
           "dir_is_symlink": os.path.islink(d), "lock": find_lock(d),
           "in_node_modules": "/node_modules/" in pj}
    if rec["lock"] is None:
        up = os.path.dirname(d)
        while up != "/" and os.path.basename(os.path.dirname(up)) not in ("node_modules",) and not os.path.basename(os.path.dirname(up)).startswith("@"):
            up = os.path.dirname(up)
        cpj = os.path.join(up, "package.json")
        if up != "/" and os.path.isfile(cpj):
            cj = json.load(open(cpj))
            rec["containing_package"] = {"dir": up, "name": cj.get("name"), "version": cj.get("version"),
                                         "package_json_sha256": sha256f(cpj), "lock": find_lock(up)}
    mh, n = dir_manifest(d)
    rec.update(dir_manifest_sha256=mh, dir_file_count=n)
    found.setdefault(j["name"], []).append(rec)

npm_rows = []
for name, ver, idx in TARGETS:
    inst = found.get(name, [])
    exact = [r for r in inst if r["version"] == ver]
    npm_rows.append({"baseline_row_index": idx, "name": name, "version": ver,
                     "status": "present_exact" if exact else ("present_other_version_only" if inst else "absent_from_final_filesystem"),
                     "exact_instances": exact, "other_version_instances": [r for r in inst if r["version"] != ver]})

# Debian package metadata for owners
owners = sorted({o for r in npm_rows for i in r["exact_instances"] for o in (i["dpkg"].get("owner_path") or i["dpkg"].get("owner_realpath") or [])})
deb_meta = run(["dpkg-query", "-W", "-f", "${Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\t${db:Status-Abbrev}\n"] + owners) if owners else None
verify = {o: run(["dpkg", "--verify", o]) for o in owners}
dump("npm-30.json", {"walked_files": walked, "package_json_scanned": len(pkgjsons), "rows": npm_rows,
                     "owner_packages": deb_meta, "owner_dpkg_verify": verify})

# ---------------------------------------------------------------- 3a. ffmpeg
ff = []
for c in sorted(elf_candidates):
    if "ffmpeg" not in os.path.basename(c).lower():
        continue
    ei = elf_info(c)
    if not ei.get("elf"):
        continue
    r = {"path": c, "size": os.path.getsize(c), "sha256": sha256f(c), "elf": ei, "dpkg": dpkg_info(c),
         "version": run([c, "-hide_banner", "-version"], timeout=30),
         "buildconf": run([c, "-hide_banner", "-buildconf"], timeout=30),
         "license": run([c, "-hide_banner", "-L"], timeout=30)}
    txt = (r["version"].get("stdout") or "") + (r["buildconf"].get("stdout") or "")
    flags = sorted(set(re.findall(r"--(?:enable|disable)-[A-Za-z0-9_-]+", txt)))
    r["configure_flags"] = flags
    r["gpl"] = "--enable-gpl" in flags
    r["version3"] = "--enable-version3" in flags
    r["nonfree"] = "--enable-nonfree" in flags
    if not flags:
        r["strings"] = strings_hits(c, [rb"--enable-(?:gpl|nonfree|version3|libx264|libx265|libvpx)[^\x00 ]{0,20}",
                                        rb"ffmpeg version [^\x00]{0,80}", rb"configuration: [^\x00]{0,400}",
                                        rb"GCC: \([^\x00]{0,80}"])
    ff.append(r)
pw = {}
for base in ("/opt/hermes/.playwright", "/root/.cache/ms-playwright"):
    if os.path.isdir(base):
        pw[base] = {e: sorted(os.listdir(os.path.join(base, e))) if os.path.isdir(os.path.join(base, e)) else "file"
                    for e in sorted(os.listdir(base))}
browsers_json = []
for pj in pkgjsons:
    if pj.endswith("/playwright-core/package.json"):
        d = os.path.dirname(pj)
        bj = os.path.join(d, "browsers.json")
        v = json.load(open(pj)).get("version")
        rec = {"playwright_core": d, "version": v}
        if os.path.isfile(bj):
            rec["browsers_json"] = json.load(open(bj)); rec["browsers_json_sha256"] = sha256f(bj)
        reg = os.path.join(d, "lib/server/registry/index.js")
        if os.path.isfile(reg):
            src = open(reg, errors="replace").read()
            rec["registry_index_sha256"] = sha256f(reg)
            rec["download_hosts"] = sorted(set(re.findall(r"https://[a-z0-9.\-]+(?:/[A-Za-z0-9_\-./%{}$]*)?", src)))[:40]
            rec["ffmpeg_paths"] = sorted(set(re.findall(r"builds/ffmpeg/[^'\"`]+", src)))
            rec["chromium_paths"] = sorted(set(re.findall(r"(?:builds/chromium|chrome-for-testing-public|builds/cft)[^'\"`]*", src)))[:30]
        browsers_json.append(rec)
dpkg_ffmpeg = run(["dpkg-query", "-W", "-f", "${Package}\t${Version}\t${source:Package}\t${db:Status-Abbrev}\n", "ffmpeg", "libavcodec61"])
dump("ffmpeg.json", {"binaries": ff, "playwright_dirs": pw, "playwright_core": browsers_json, "dpkg_ffmpeg": dpkg_ffmpeg})

# ---------------------------------------------------------------- 3b. chrome
ch = []
for c in sorted(elf_candidates):
    b = os.path.basename(c).lower()
    if b not in ("chrome", "chrome-headless-shell", "headless_shell", "chromium", "chromium-browser"):
        continue
    ei = elf_info(c)
    if not ei.get("elf"):
        continue
    d = os.path.dirname(c)
    r = {"path": c, "size": os.path.getsize(c), "sha256": sha256f(c), "elf": {k: ei[k] for k in ("e_type", "interp", "statically_linked")},
         "needed_count": len(ei.get("needed", [])), "dpkg": dpkg_info(c), "dir_listing": sorted(os.listdir(d)),
         "version": run([c, "--version"], timeout=30, env={"HOME": "/tmp", "PATH": "/usr/bin:/bin"}),
         "strings": strings_hits(c, [rb"Google Chrome for Testing", rb"Chrome for Testing", rb"Google Chrome\x00",
                                     rb"Chromium\x00", rb"chrome-headless-shell", rb"Chromium Authors"])}
    for extra in ("ABOUT", "LICENSE.headless_shell", "LICENSE", "chrome-headless-shell.version", "headless_command_resources.pak"):
        fp = os.path.join(d, extra)
        if os.path.isfile(fp):
            r.setdefault("sidecar_files", {})[extra] = {"sha256": sha256f(fp), "size": os.path.getsize(fp),
                                                       "head": open(fp, "rb").read(600).decode("latin-1") if extra.startswith(("ABOUT", "LICENSE")) else None}
    ch.append(r)
dpkg_chrom = run(["sh", "-c", "dpkg-query -W -f '${Package}\\t${Version}\\t${db:Status-Abbrev}\\n' 'chromium*' 'google-chrome*' 2>&1; true"])
dump("chrome.json", {"binaries": ch, "dpkg_chromium_or_google_chrome": dpkg_chrom})

# ---------------------------------------------------------------- 3c. bundled claude
cl = []
for c in sorted(bundled_claude):
    sp = os.path.dirname(os.path.dirname(c))  # .../claude_agent_sdk
    site = os.path.dirname(sp)
    r = {"path": c, "size": os.path.getsize(c), "sha256": sha256f(c), "mode": oct(os.stat(c).st_mode & 0o7777),
         "elf": elf_info(c), "dpkg": dpkg_info(c),
         "strings": strings_hits(c, [rb"Bun v[0-9.]+", rb"bun build --compile", rb"@anthropic-ai/claude-code", rb"Claude Code [0-9]+\.[0-9]+\.[0-9]+",
                                     rb"\x00[0-9]+\.[0-9]+\.[0-9]+ \(Claude Code\)", rb"Copyright[^\x00]{0,60}Anthropic"]),
         "version": run([c, "--version"], timeout=30, env={"HOME": "/tmp", "PATH": "/usr/bin:/bin", "DISABLE_AUTOUPDATER": "1"})}
    # wheel RECORD
    for dn in os.listdir(site):
        if dn.startswith("claude_agent_sdk-") and dn.endswith(".dist-info"):
            di = os.path.join(site, dn)
            r["dist_info"] = di
            meta = open(os.path.join(di, "METADATA"), errors="replace").read()
            r["metadata_head"] = "\n".join(l for l in meta.splitlines()[:40] if re.match(r"^(Name|Version|License|License-Expression|License-File|Classifier: License|Home-page|Project-URL|Author)", l))
            for l in open(os.path.join(di, "RECORD"), errors="replace"):
                if "_bundled/claude," in l:
                    rel, h, sz = l.rstrip("\n").rsplit(",", 2)
                    want = h.split("=", 1)[1]
                    got = base64.urlsafe_b64encode(bytes.fromhex(r["sha256"])).decode().rstrip("=")
                    r["record"] = {"line": l.strip(), "record_matches_file": want == got and str(r["size"]) == sz}
            for lf in sorted(os.listdir(di)):
                if "LICEN" in lf.upper() and os.path.isfile(os.path.join(di, lf)):
                    r.setdefault("dist_info_license_files", {})[lf] = sha256f(os.path.join(di, lf))
            lic_dir = os.path.join(di, "licenses")
            if os.path.isdir(lic_dir):
                for root2, _, fs2 in os.walk(lic_dir):
                    for f2 in fs2:
                        r.setdefault("dist_info_license_files", {})[os.path.relpath(os.path.join(root2, f2), di)] = sha256f(os.path.join(root2, f2))
    # SDK code that resolves/executes the bundled binary
    refs = []
    for root2, _, fs2 in os.walk(sp):
        for f2 in fs2:
            if f2.endswith(".py"):
                fp = os.path.join(root2, f2)
                for n, line in enumerate(open(fp, errors="replace"), 1):
                    if re.search(r"_bundled|_find_cli|find_cli|cli_path|anyio\.open_process|open_process|subprocess|which\(\"claude|\"claude\"", line):
                        refs.append("%s:%d: %s" % (os.path.relpath(fp, site), n, line.rstrip()[:220]))
    r["sdk_code_refs"] = refs
    # runtime callers outside the SDK package
    callers = []
    for base in ("/opt", "/usr/local/lib", "/app", "/etc/s6-overlay"):
        if not os.path.isdir(base):
            continue
        for root2, dirs2, fs2 in os.walk(base):
            dirs2[:] = [x for x in dirs2 if x not in ("claude_agent_sdk", "node_modules", ".playwright", "__pycache__")]
            for f2 in fs2:
                if f2.endswith((".py", ".sh", ".toml", ".yaml", ".yml", ".json")) or base == "/etc/s6-overlay":
                    fp = os.path.join(root2, f2)
                    if not os.path.isfile(fp) or os.path.getsize(fp) > 5 << 20:
                        continue
                    try:
                        for n, line in enumerate(open(fp, errors="replace"), 1):
                            if "claude_agent_sdk" in line:
                                callers.append("%s:%d: %s" % (fp, n, line.rstrip()[:220]))
                    except Exception:
                        pass
    r["runtime_callers"] = sorted(set(callers))
    cl.append(r)
dump("claude.json", {"bundled": cl})
print("probe done walked=%d pkgjson=%d elf_candidates=%d claude=%d" % (walked, len(pkgjsons), len(elf_candidates), len(bundled_claude)))
