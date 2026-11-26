# Permanent Whisper assets (Phase E)

These assets live outside `/tmp` so a reboot or temp cleanup cannot silently
remove transcription capability. `/tmp/opencode/whisper.cpp/...` remains a
legacy fallback only.

## Installed assets and locally computed SHA-256

| Asset | Install path | SHA-256 (computed locally with `sha256sum`) |
| --- | --- | --- |
| whisper.cpp CLI (static ggml/whisper link) | `$HOME/.local/share/ugc-media/whisper/whisper-cli` | `3370f6ff3efcfa2dba1c9d2be8ec8b832d66229b0cdb97e30aabf655c5b6549a` |
| English-only tiny model | `$HOME/.local/share/ugc-media/whisper/ggml-tiny.en.bin` | `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f` |
| Multilingual tiny model | `$HOME/.local/share/ugc-media/whisper/ggml-tiny.bin` | `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21` |
| CC0 German speech sample | `$HOME/.local/share/ugc-media/whisper/samples/de-deutschland-cc0.flac` | `67b4da08f358b21af6a38146584b30283079961082c33f480c04acda633ea5b7` |
| CC0 English speech sample | `$HOME/.local/share/ugc-media/whisper/samples/en-test-sentence-cc0.wav` | `f005448d195eaca414c6dc227e8bce87a23b0a8fffdba70e7d321920a69b6eaf` |

The models were copied from the pre-existing local build at
`/tmp/opencode/whisper.cpp`; their hashes match the originals byte-for-byte.
The first CLI copy was dynamically linked against `libwhisper.so.1` and
`libggml.so.1`; when those temporary build artifacts disappeared, the CLI was
rebuilt from the pinned source at commit
`c1a24047871444999b79f5e8612828f45881ae12` (2026-11-24) with
`-DBUILD_SHARED_LIBS=OFF` and installed in the same permanent path. It now
depends only on ordinary system libraries (`libgomp`, `libstdc++`, `libm`,
`libgcc_s`, `libc`) and reports `whisper.cpp version: 1.9.6-dev`.

## Upstream URLs and pins

* Source repository: https://github.com/ggerganov/whisper.cpp
* Source commit used for the local binary:
  https://github.com/ggerganov/whisper.cpp/tree/c1a24047871444999b79f5e8612828f45881ae12
* Model repository: https://huggingface.co/ggerganov/whisper.cpp
  (resolved repo commit at download time: `5359861c739e955e79d9a303bcbc70fb988958b1`)
* English model URL: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin
* Multilingual model URL: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
* German sample (Wikimedia Commons, CC0):
  https://commons.wikimedia.org/wiki/File:DE-Deutschland-sentence-ACER-Travelmate-5744Z-internal-mic.flac
  and https://upload.wikimedia.org/wikipedia/commons/a/af/DE-Deutschland-sentence-ACER-Travelmate-5744Z-internal-mic.flac
* English sample (Wikimedia Commons, CC0):
  https://commons.wikimedia.org/wiki/File:LL-Q1860_(eng)-Foobarista2-this_is_a_test_sentence.wav
  and https://upload.wikimedia.org/wikipedia/commons/9/95/LL-Q1860_%28eng%29-Foobarista2-this_is_a_test_sentence.wav

The Hugging Face model table prints a 40-character `SHA` column; that is a
repository blob identifier, **not** a SHA-256. Every SHA-256 above was computed
locally from the installed bytes. For `ggml-tiny.bin` the locally computed
SHA-256 also matches the upstream `x-linked-etag` header returned by Hugging
Face for this file.

## Licenses

* whisper.cpp source and CLI: MIT License
  (https://github.com/ggerganov/whisper.cpp/blob/master/LICENSE, "Copyright (c)
  2023-2026 The ggml authors").
* `ggml-tiny.en.bin` and `ggml-tiny.bin`: the Hugging Face repository card
  declares `license: mit`; these are converted OpenAI Whisper weights
  (https://huggingface.co/ggerganov/whisper.cpp/raw/main/README.md).
* German and English samples: CC0 1.0 public-domain dedication (German author
  MartinThoma; English author Foobarista2 on Wikimedia Commons), no attribution
  required (https://creativecommons.org/publicdomain/zero/1.0/deed.en).

## Verification commands

```sh
sha256sum "$HOME/.local/share/ugc-media/whisper/whisper-cli" \
  "$HOME/.local/share/ugc-media/whisper/ggml-tiny.en.bin" \
  "$HOME/.local/share/ugc-media/whisper/ggml-tiny.bin" \
  "$HOME/.local/share/ugc-media/whisper/samples/de-deutschland-cc0.flac" \
  "$HOME/.local/share/ugc-media/whisper/samples/en-test-sentence-cc0.wav"
"$HOME/.local/share/ugc-media/whisper/whisper-cli" --version
bash scripts/services.sh doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify(r.checks.media,null,2))})'
npm run verify:media
```

## Non-secret environment variable lines

`dotenv` does not expand `$HOME`; substitute the absolute home path for the
current user. These are the exact lines to add to `.env` and (with a portable
example home path) `.env.example`:

```dotenv
WHISPER_BIN="/home/kaishinglo/.local/share/ugc-media/whisper/whisper-cli"
WHISPER_MODEL="/home/kaishinglo/.local/share/ugc-media/whisper/ggml-tiny.en.bin"
WHISPER_MODEL_MULTILINGUAL="/home/kaishinglo/.local/share/ugc-media/whisper/ggml-tiny.bin"
WHISPER_SAMPLE="/home/kaishinglo/.local/share/ugc-media/whisper/samples/en-test-sentence-cc0.wav"
WHISPER_SAMPLE_DE="/home/kaishinglo/.local/share/ugc-media/whisper/samples/de-deutschland-cc0.flac"
WHISPER_TIMEOUT_MS=300000
WHISPER_THREADS=1
WHISPER_THREADS_MAX=2
FFMPEG_TIMEOUT_MS=180000
```
