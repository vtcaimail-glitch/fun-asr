from funasr import AutoModel
import argparse
import json
import os
from pathlib import Path


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
    cues = []
    index = 1

    items = result if isinstance(result, list) else [result]
    for item in items:
        if "sentence_info" not in item:
            continue
        for sentence in item["sentence_info"]:
            text = sentence.get("text", "")
            start = sentence.get("start", 0)
            end = sentence.get("end", 0)
            cues.append(f"{index}\n{_to_srt_time(start)} --> {_to_srt_time(end)}\n{text}\n")
            index += 1

    return "\n".join(cues)


def main():
    paths = _default_model_paths()

    parser = argparse.ArgumentParser(description="Run FunASR and export SRT.")
    parser.add_argument(
        "--audio",
        default=os.environ.get("AUDIO_PATH", ""),
        help="Path to audio file",
    )
    parser.add_argument("--out-dir", default="outpt_srt", help="Output directory")

    parser.add_argument("--device", default=os.environ.get("DEVICE", "cuda"))
    parser.add_argument("--ncpu", type=int, default=int(os.environ.get("NCPU", "4")))
    parser.add_argument("--batch-size-s", type=int, default=600)

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
        model_path=args.model,
        vad_model_path=args.vad_model,
        punc_model_path=args.punc_model,
        max_single_segment_time=args.max_single_segment_time,
        max_end_silence_time=args.max_end_silence_time,
    )

    if args.write_json:
        (out_dir / f"{base}.funasr.json").write_text(
            json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    srt_content = generate_srt_original(res)
    srt_path = out_dir / f"{base}.funasr.srt"
    srt_path.write_text(srt_content, encoding="utf-8")

    if args.write_orig_srt:
        orig_srt_content = generate_srt_original(res)
        (out_dir / f"{base}.funasr.orig.srt").write_text(orig_srt_content, encoding="utf-8")

    if args.print_srt_path:
        print(str(srt_path))
    else:
        print("Done!")


if __name__ == "__main__":
    main()
