# Offline tokenizer build inputs

The manifest adds two data assets, not new Python dependencies. The URLs and
SHA-256 values come from the exact `tiktoken==0.14.0` wheel constructors
`tiktoken_ext.openai_public.cl100k_base` and `o200k_base`. The build compares the
installed constructors with this manifest before downloading, verifies every
payload SHA-256, and writes the URL's SHA-1 cache filename (a lookup key, not an
integrity check) with mode 0644 under a 0755 image-owned directory.

`/opt/agent-box/tiktoken-cache` is outside all three runtime volume mounts.
`TIKTOKEN_CACHE_DIR` is set both in the final scratch stage and in the filtered
Hindsight child environment. No warm home or memory volume is needed.

Reviewed exact wheels are already hash-pinned in
`apps/agent-box-hermes/build/hindsight-linux-amd64.lock`:

| Distribution | Version | Wheel SHA-256 |
| --- | --- | --- |
| tiktoken | 0.14.0 | 26e60f6a956ee171ab728b37b8439905d7ea1db435c30f9822f291e9861c861d |
| litellm | 1.103.1 | 3b3edc76f222153b46ebf50586009c6c23c9c5205efc2de19630a0561a144d95 |
| hindsight-api-slim | 0.8.3 | 6cc0fe22d91db4f2f387a95131fcc0f12f5c0a2b50e099bbe666b2fdab35e7c6 |

Hindsight's `engine/token_encoding.py` uses `cl100k_base`; LiteLLM's token counter
also uses `o200k_base`. LiteLLM's `litellm_core_utils/get_model_cost_map.py` checks
`LITELLM_LOCAL_MODEL_COST_MAP` case-insensitively for `true` before any remote
fetch and reads its packaged `model_prices_and_context_window_backup.json`.
We set `True` before imports; the map stays bound to the wheel version, so cost
and model metadata updates require a reviewed dependency rebuild.

`tiktoken-LICENSE` and `litellm-LICENSE` are exact license bytes extracted from
those verified wheels. Existing dependency notices remain intact. The manifest,
licenses and this record ship in the image's third-party directory. The final
integrated image inventory and source companion must include the new data files
and this provenance; prior digest-bound evidence does not describe these bytes.

Validation: the image build uses the installed locked wheels, rejects version
or constructor drift, and runs the tokenizer/map probe as uid 1000 with
`RUN --network=none`. The probe checks hashes, round trips Hindsight and both
encodings, compares the loaded cost map with packaged JSON, and fails even if a
network attempt was caught by a dependency. CI additionally boots fresh volumes
with `--network none`, local fixture providers and the normal entrypoint, waits
for health, then exercises the actual child environment and fixture retain.

This covers startup in the default remote-embedding mode using loopback test
providers. Optional local Hugging Face embedding weights still require separate
provisioning; arbitrary model tokenizers are not claimed to work offline.
Production inference still requires its configured provider connectivity.

After the related security and source-label PRs integrate, Opi must run the
fresh LAN-only exact-digest build/runtime qualification and refresh affected
scans, SBOM, provenance and source companion. Keep old candidates and evidence.
Rollback uses the prior source/image reference; no data migration is involved.
