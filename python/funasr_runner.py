from funasr import AutoModel
import argparse
import json
import os
from pathlib import Path
import sys
import threading
import traceback
from typing import Optional


# ==============================================================================
# 1. CẤU HÌNH / MODEL / RUNNER (CLI-FRIENDLY)
# ==============================================================================
def _find_repo_root(start: Path) -> Path:
    """
    Tìm repo root theo dấu hiệu có thư mục `models/`.
    Fallback: dùng parent của file hiện tại.
    """
    for p in [start, *start.parents]:
        if (p / "models").exists():
            return p
    return start


def _default_model_paths():
    """
    Default theo file gốc (Windows path), nhưng nếu không tồn tại thì fallback
    qua đường dẫn tương đối trong repo.
    """
    win = {
        "model": r"D:\0_code\3.Full-pipeline\fun-asr\models\iic\speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "vad_model": r"D:\0_code\3.Full-pipeline\fun-asr\models\iic\speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "punc_model": r"D:\0_code\3.Full-pipeline\fun-asr\models\iic\punc_ct-transformer_cn-en-common-vocab471067-large",
    }
    if all(Path(v).exists() for v in win.values()):
        return win

    repo_root = _find_repo_root(Path(__file__).resolve().parent)
    return {
        "model": str(
            repo_root
            / "models/iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
        ),
        "vad_model": str(repo_root / "models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"),
        "punc_model": str(
            repo_root / "models/iic/punc_ct-transformer_cn-en-common-vocab471067-large"
        ),
    }


def _resolve_ref_path(path_str: str, *, repo_root: Path, models_dir: Path) -> str:
    """
    Cho phép truyền path tương đối (tham chiếu theo repo root hoặc theo models dir).
    - Absolute path: giữ nguyên.
    - Relative path: thử lần lượt `models_dir/<path>`, rồi `repo_root/<path>`.
    """
    p = Path(path_str)
    if p.is_absolute():
        return str(p)
    cand1 = models_dir / p
    if cand1.exists():
        return str(cand1)
    cand2 = repo_root / p
    return str(cand2)


def build_model(
    *,
    model_path: str,
    vad_model_path: str,
    punc_model_path: str,
    device: str,
    ncpu: int,
    max_single_segment_time: int,
    max_end_silence_time: int,
):
    return AutoModel(
        model=model_path,
        vad_model=vad_model_path,
        punc_model=punc_model_path,
        device=device,
        ncpu=ncpu,
        disable_update=True,
        disable_log=True,
        vad_kwargs={
            "max_single_segment_time": max_single_segment_time,
            "max_end_silence_time": max_end_silence_time,
        },
    )


def run_asr(
    *,
    audio_path: str,
    device: str,
    ncpu: int,
    batch_size_s: int,
    hotword: str,
    hotword_weight: float,
    disable_punc: bool,
    disable_itn: bool,
    model_path: str,
    vad_model_path: str,
    punc_model_path: str,
    max_single_segment_time: int,
    max_end_silence_time: int,
):
    model = build_model(
        model_path=model_path,
        vad_model_path=vad_model_path,
        punc_model_path=punc_model_path,
        device=device,
        ncpu=ncpu,
        max_single_segment_time=max_single_segment_time,
        max_end_silence_time=max_end_silence_time,
    )

    return model.generate(
        input=audio_path,
        batch_size_s=batch_size_s,
        sentence_timestamp=True,
        return_raw_text=False,
        hotword=hotword,
        hotword_weight=hotword_weight,
        disable_punc=disable_punc,
        disable_itn=disable_itn,
    )


# ==============================================================================
# 2. XỬ LÝ OUTPUT VÀ TẠO SRT
# ==============================================================================
def _to_srt_time(ms: int) -> str:
    """Chuyển ms sang định dạng SRT 00:00:00,000"""
    if ms < 0:
        ms = 0
    s, ms = divmod(int(ms), 1000)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def generate_srt_original(result):
    return _render_srt(_build_sentence_cues(result))


def generate_srt_merged(result):
    cues = _build_sentence_cues(result)
    cues = _merge_cues_for_srt(cues, max_words=_get_merge_max_words())
    return _render_srt(cues)


def _is_merge_enabled() -> bool:
    raw = os.environ.get("SRT_MERGE_ENABLED", "").strip().lower()
    if not raw:
        return False
    return raw in {"1", "true", "yes", "y", "on"}


def generate_srt_output(result):
    return generate_srt_merged(result) if _is_merge_enabled() else generate_srt_original(result)


def _get_merge_max_words() -> int:
    raw = os.environ.get("SRT_MERGE_MAX_WORDS", "").strip()
    try:
        value = int(raw)
        if value <= 0:
            return 15
        return value
    except Exception:
        return 15


def _build_sentence_cues(result):
    cues = []
    items = result if isinstance(result, list) else [result]
    for item in items:
        if "sentence_info" not in item:
            continue
        for sentence in item["sentence_info"]:
            cues.append(
                {
                    "start": int(sentence.get("start", 0)),
                    "end": int(sentence.get("end", 0)),
                    "text": str(sentence.get("text", "")),
                }
            )
    return cues


def _render_srt(cues) -> str:
    lines = []
    index = 1
    for cue in cues:
        lines.append(str(index))
        lines.append(f"{_to_srt_time(cue['start'])} --> {_to_srt_time(cue['end'])}")
        lines.append(cue["text"])
        lines.append("")
        index += 1
    return "\n".join(lines).rstrip() + "\n"


_NON_FINAL_JOIN_PUNCT = {",", "，", "、"}
_FINAL_PUNCT = {".", "!", "?", "。", "！", "？"}


def _strip_trailing_join_punct(text: str) -> str:
    if not text:
        return text
    last = text[-1]
    if last in _NON_FINAL_JOIN_PUNCT:
        return text[:-1]
    return text


def _needs_space_between(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a[-1].isspace() or b[0].isspace():
        return False
    # Only add a space for Latin/digit boundaries (avoid messing with CJK).
    return a[-1].isascii() and b[0].isascii() and a[-1].isalnum() and b[0].isalnum()


def _count_words_mixed(text: str) -> int:
    """
    - CJK (Han/Hiragana/Katakana/Hangul): đếm theo ký tự (bỏ whitespace/punct).
    - Latin: đếm theo token whitespace (bỏ token chỉ có dấu).
    """
    cjk = 0
    latin_buf = []

    for ch in text:
        if ch.isspace():
            latin_buf.append(" ")
            continue

        code = ord(ch)
        is_cjk = (
            (0x4E00 <= code <= 0x9FFF)  # CJK Unified Ideographs
            or (0x3400 <= code <= 0x4DBF)  # CJK Extension A
            or (0x3040 <= code <= 0x309F)  # Hiragana
            or (0x30A0 <= code <= 0x30FF)  # Katakana
            or (0xAC00 <= code <= 0xD7AF)  # Hangul Syllables
        )
        if is_cjk:
            cjk += 1
            latin_buf.append(" ")
            continue

        latin_buf.append(ch)

    latin_tokens = 0
    for tok in "".join(latin_buf).split():
        # Count if token contains at least one letter/digit.
        if any(ch.isalnum() for ch in tok):
            latin_tokens += 1

    return cjk + latin_tokens


def _merge_cues_for_srt(cues, *, max_words: int):
    """
    Rule:
    - Merge only when cue[i].text ends with comma-like (,_，、) AND NOT sentence-ending (.?! 。！？)
    - Only merge when next.start == current.end (gap exactly 0ms).
    - When merging, remove the join punctuation at the boundary (e.g. "A," + "B," => "AB,").
    - Do not merge if merged text would exceed max_words (mixed counting).
    """
    if not cues:
        return cues

    out = []
    i = 0
    while i < len(cues):
        cur = dict(cues[i])
        while i + 1 < len(cues):
            nxt = cues[i + 1]

            if int(cur["end"]) != int(nxt["start"]):
                break

            cur_text = str(cur.get("text", ""))
            if not cur_text:
                break

            last = cur_text[-1]
            if last in _FINAL_PUNCT:
                break
            if last not in _NON_FINAL_JOIN_PUNCT:
                break

            left = _strip_trailing_join_punct(cur_text)
            right = str(nxt.get("text", ""))
            join = " " if _needs_space_between(left, right) else ""
            merged_text = f"{left}{join}{right}"

            if _count_words_mixed(merged_text) > max_words:
                break

            cur["text"] = merged_text
            cur["end"] = int(nxt.get("end", cur["end"]))
            i += 1

        out.append(cur)
        i += 1

    return out


def main():
    repo_root = _find_repo_root(Path(__file__).resolve().parent)
    models_dir = Path(os.environ.get("FUNASR_MODELS_DIR", str(repo_root / "models")))
    paths = _default_model_paths()

    parser = argparse.ArgumentParser(description="Run FunASR and export SRT.")
    parser.add_argument(
        "--worker",
        action="store_true",
        default=False,
        help="Run as a persistent stdin/stdout JSONL worker (preload model once).",
    )
    parser.add_argument(
        "--idle-seconds",
        type=int,
        default=300,
        help="Worker auto-exit after N seconds idle (only in --worker mode).",
    )
    parser.add_argument(
        "--audio",
        default=os.environ.get("AUDIO_PATH", ""),
        help="Path to audio file",
    )
    parser.add_argument("--out-dir", default="outpt_srt", help="Output directory")

    parser.add_argument("--device", default=os.environ.get("DEVICE", "cuda"))
    parser.add_argument("--ncpu", type=int, default=int(os.environ.get("NCPU", "8")))
    parser.add_argument("--batch-size-s", type=int, default=1800)

    parser.add_argument("--hotword", default="")
    parser.add_argument("--hotword-weight", type=float, default=1.0)
    parser.add_argument("--disable-punc", action="store_true", default=False)
    parser.add_argument("--disable-itn", action="store_true", default=False)

    parser.add_argument("--model", default=os.environ.get("FUNASR_MODEL", paths["model"]))
    parser.add_argument("--vad-model", default=os.environ.get("FUNASR_VAD_MODEL", paths["vad_model"]))
    parser.add_argument(
        "--punc-model", default=os.environ.get("FUNASR_PUNC_MODEL", paths["punc_model"])
    )

    parser.add_argument("--max-single-segment-time", type=int, default=8000)
    parser.add_argument("--max-end-silence-time", type=int, default=50)

    parser.add_argument(
        "--write-json",
        action="store_true",
        default=False,
        help="Write .funasr.json output (debug)",
    )
    parser.add_argument(
        "--write-orig-srt",
        action="store_true",
        default=False,
        help="Write .funasr.orig.srt output",
    )
    parser.add_argument(
        "--print-srt-path",
        action="store_true",
        default=False,
        help="Print processed SRT path to stdout",
    )

    args = parser.parse_args()

    model_path = _resolve_ref_path(args.model, repo_root=repo_root, models_dir=models_dir)
    vad_model_path = _resolve_ref_path(args.vad_model, repo_root=repo_root, models_dir=models_dir)
    punc_model_path = _resolve_ref_path(args.punc_model, repo_root=repo_root, models_dir=models_dir)

    if args.worker:
        _run_worker(
            args,
            model_path=model_path,
            vad_model_path=vad_model_path,
            punc_model_path=punc_model_path,
        )
        return

    if not args.audio:
        raise SystemExit("Missing --audio (or set AUDIO_PATH)")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    base = Path(args.audio).stem

    res = run_asr(
        audio_path=args.audio,
        device=args.device,
        ncpu=args.ncpu,
        batch_size_s=args.batch_size_s,
        hotword=args.hotword,
        hotword_weight=args.hotword_weight,
        disable_punc=args.disable_punc,
        disable_itn=args.disable_itn,
        model_path=model_path,
        vad_model_path=vad_model_path,
        punc_model_path=punc_model_path,
        max_single_segment_time=args.max_single_segment_time,
        max_end_silence_time=args.max_end_silence_time,
    )

    if args.write_json:
        (out_dir / f"{base}.funasr.json").write_text(
            json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    srt_content = generate_srt_output(res)
    srt_path = out_dir / f"{base}.funasr.srt"
    srt_path.write_text(srt_content, encoding="utf-8")

    if args.write_orig_srt:
        orig_srt_content = _render_srt(_build_sentence_cues(res))
        (out_dir / f"{base}.funasr.orig.srt").write_text(orig_srt_content, encoding="utf-8")

    if args.print_srt_path:
        print(str(srt_path))
    else:
        print("Done!")


class _IdleExit:
    def __init__(self, idle_seconds: int):
        self._idle_seconds = max(1, int(idle_seconds))
        self._lock = threading.Lock()
        self._timer: Optional[threading.Timer] = None

    def start(self) -> None:
        self.touch()

    def touch(self) -> None:
        with self._lock:
            if self._timer:
                self._timer.cancel()
            self._timer = threading.Timer(self._idle_seconds, self._exit_now)
            self._timer.daemon = True
            self._timer.start()

    def stop(self) -> None:
        with self._lock:
            if self._timer:
                self._timer.cancel()
                self._timer = None

    @staticmethod
    def _exit_now() -> None:
        os._exit(0)


def _jsonl_write(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _run_worker(args, *, model_path: str, vad_model_path: str, punc_model_path: str) -> None:
    idle = _IdleExit(args.idle_seconds)
    idle.start()

    model = build_model(
        model_path=model_path,
        vad_model_path=vad_model_path,
        punc_model_path=punc_model_path,
        device=args.device,
        ncpu=args.ncpu,
        max_single_segment_time=args.max_single_segment_time,
        max_end_silence_time=args.max_end_silence_time,
    )

    _jsonl_write(
        {
            "type": "ready",
            "pid": os.getpid(),
            "device": args.device,
            "ncpu": args.ncpu,
            "idleSeconds": args.idle_seconds,
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            # We are about to do work; do not allow idle shutdown mid-job.
            idle.stop()

            req = json.loads(line)
            req_id = req.get("id")
            if req.get("type") == "shutdown":
                _jsonl_write({"type": "shutdown", "id": req_id, "ok": True})
                return

            audio_path = str(req["audioPath"])
            out_dir = str(req["outDir"])

            Path(out_dir).mkdir(parents=True, exist_ok=True)
            base = Path(audio_path).stem
            srt_path = str(Path(out_dir) / f"{base}.funasr.srt")

            res = model.generate(
                input=audio_path,
                batch_size_s=args.batch_size_s,
                sentence_timestamp=True,
                return_raw_text=False,
                hotword=args.hotword,
                hotword_weight=args.hotword_weight,
                disable_punc=args.disable_punc,
                disable_itn=args.disable_itn,
            )

            if req.get("writeJson"):
                Path(out_dir, f"{base}.funasr.json").write_text(
                    json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8"
                )

            srt_content = generate_srt_output(res)
            Path(srt_path).write_text(srt_content, encoding="utf-8")

            _jsonl_write({"type": "result", "id": req_id, "ok": True, "srtPath": srt_path})
        except Exception as e:
            _jsonl_write(
                {
                    "type": "result",
                    "id": req.get("id") if isinstance(req, dict) else None,
                    "ok": False,
                    "error": str(e),
                    "traceback": traceback.format_exc(),
                }
            )
        finally:
            # Restart idle countdown only when we're idle again.
            idle.touch()


if __name__ == "__main__":
    main()
