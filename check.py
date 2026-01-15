from funasr import AutoModel
import argparse
import json
import os
from pathlib import Path

# ==============================================================================
# 1. CẤU HÌNH / MODEL / RUNNER (CLI-FRIENDLY)
# ==============================================================================
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

    root = Path(__file__).resolve().parent
    return {
        "model": str(
            root
            / "models/iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
        ),
        "vad_model": str(root / "models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"),
        "punc_model": str(
            root / "models/iic/punc_ct-transformer_cn-en-common-vocab471067-large"
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
    # Bắt buộc phải có punc_model để tránh lỗi UnboundLocalError khi dùng VAD
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
        sentence_timestamp=True,  # Bắt buộc True để lấy timestamp từng từ
        return_raw_text=False,
        hotword=hotword,
        hotword_weight=hotword_weight,
        disable_punc=disable_punc,
        disable_itn=disable_itn,
    )

# ==============================================================================
# 2. XỬ LÝ OUTPUT VÀ TẠO SRT (LOGIC MỚI: CẮT CÂU DÀI)
# ==============================================================================

def _to_srt_time(ms: int) -> str:
    """Chuyển ms sang định dạng SRT 00:00:00,000"""
    if ms < 0: ms = 0
    s, ms = divmod(int(ms), 1000)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"

def split_long_sentence_by_timestamp(text, timestamps, max_chars=30):
    """
    Hàm quan trọng: Băm nhỏ câu dài dựa trên timestamp từng từ.
    - text: nội dung câu
    - timestamps: list [[start, end], [start, end]...] tương ứng từng chữ
    - max_chars: độ dài tối đa mong muốn của 1 dòng sub
    """
    if not timestamps or len(text) != len(timestamps):
        # Fallback nếu dữ liệu không khớp
        return [{'text': text, 'start': timestamps[0][0], 'end': timestamps[-1][1]}] if timestamps else []

    sub_segments = []
    current_text = ""
    current_start = timestamps[0][0]
    last_end = timestamps[0][1]

    for char, ts in zip(text, timestamps):
        current_text += char
        last_end = ts[1]
        
        # Logic cắt: Nếu dài quá max_chars HOẶC gặp dấu ngắt câu mạnh
        if len(current_text) > max_chars or char in "。！？":
            sub_segments.append({
                'text': current_text,
                'start': current_start,
                'end': last_end
            })
            # Reset cho dòng mới (lấy start của chữ tiếp theo nếu có, ko thì dùng end hiện tại)
            # Lưu ý: ở đây đơn giản hóa là dùng end hiện tại làm mốc tham chiếu gần đúng
            current_start = last_end 
            current_text = ""
            
    # Xử lý phần dư
    if current_text:
        # Cập nhật start thực tế cho phần dư (lấy từ timestamps nếu được logic phức tạp hơn)
        # Ở đây ta chấp nhận start nối tiếp
        sub_segments.append({
            'text': current_text,
            'start': current_start, # Start này hơi lệch nếu dùng logic đơn giản, nhưng an toàn
            'end': last_end
        })
        
    # Fix lại start time cho chính xác dựa trên timestamp thực tế (Refinement)
    # (Để code ngắn gọn, tôi dùng logic đơn giản ở trên, nhưng chuẩn nhất là map index lại)
    return sub_segments


def generate_srt_advanced(result, max_chars_per_line=40):
    cues = []
    index = 1
    
    # Xử lý kết quả trả về (list hoặc dict)
    items = result if isinstance(result, list) else [result]
    
    for item in items:
        if 'sentence_info' not in item: continue
        
        for sentence in item['sentence_info']:
            text = sentence.get('text', '')
            timestamp_arr = sentence.get('timestamp', []) # Word-level timestamps
            
            # Nếu có timestamp từng từ, ta dùng logic cắt câu thông minh
            if timestamp_arr and len(timestamp_arr) == len(text):
                # Tự chia nhỏ câu
                current_chunk = ""
                chunk_start = timestamp_arr[0][0]
                chunk_end = timestamp_arr[0][1]
                
                for i, (char, ts) in enumerate(zip(text, timestamp_arr)):
                    current_chunk += char
                    chunk_end = ts[1]
                    
                    # Điều kiện ngắt dòng: Dài quá quy định HOẶC gặp dấu câu chốt
                    is_punctuation = char in "，。！？；：,.!?;:"
                    is_too_long = len(current_chunk) >= max_chars_per_line
                    is_last_char = (i == len(text) - 1)
                    
                    if (is_too_long and is_punctuation) or is_last_char or (is_too_long and " " in current_chunk):
                         cues.append(f"{index}\n{_to_srt_time(chunk_start)} --> {_to_srt_time(chunk_end)}\n{current_chunk.strip()}\n")
                         index += 1
                         current_chunk = ""
                         if not is_last_char:
                             chunk_start = timestamp_arr[i+1][0] # Start của chữ kế tiếp
            
            # Fallback: Nếu không khớp timestamp, dùng sentence gốc
            else:
                 start = sentence['start']
                 end = sentence['end']
                 cues.append(f"{index}\n{_to_srt_time(start)} --> {_to_srt_time(end)}\n{text}\n")
                 index += 1
                 
    return "\n".join(cues)

def generate_srt_original(result):
    """
    Xuất SRT "gốc": mỗi sentence 1 cue, giữ nguyên start/end từ FunASR
    (không cắt câu, không chỉnh timestamp).
    """
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
            cues.append(
                f"{index}\n{_to_srt_time(start)} --> {_to_srt_time(end)}\n{text}\n"
            )
            index += 1

    return "\n".join(cues)

def main():
    paths = _default_model_paths()

    parser = argparse.ArgumentParser(description="Run FunASR and export SRT.")
    parser.add_argument(
        "--audio",
        default=os.environ.get(
            "AUDIO_PATH",
            r"D:\0_code\3.Full-pipeline\fun-asr\Hệ thống muộn_fixed.16k.mono.wav",
        ),
        help="Path to audio file",
    )
    parser.add_argument("--out-dir", default="outpt_srt", help="Output directory")
    parser.add_argument(
        "--max-chars-per-line", type=int, default=30, help="SRT line split length"
    )

    parser.add_argument("--device", default=os.environ.get("DEVICE", "cuda"))
    parser.add_argument("--ncpu", type=int, default=int(os.environ.get("NCPU", "4")))
    parser.add_argument("--batch-size-s", type=int, default=300)

    parser.add_argument("--hotword", default="魔搭")
    parser.add_argument("--hotword-weight", type=float, default=1.0)
    parser.add_argument("--disable-punc", action="store_true", default=False)
    parser.add_argument("--disable-itn", action="store_true", default=False)

    parser.add_argument("--model", default=os.environ.get("FUNASR_MODEL", paths["model"]))
    parser.add_argument(
        "--vad-model", default=os.environ.get("FUNASR_VAD_MODEL", paths["vad_model"])
    )
    parser.add_argument(
        "--punc-model", default=os.environ.get("FUNASR_PUNC_MODEL", paths["punc_model"])
    )

    parser.add_argument("--max-single-segment-time", type=int, default=30000)
    parser.add_argument("--max-end-silence-time", type=int, default=400)

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

    srt_content = generate_srt_advanced(res, max_chars_per_line=args.max_chars_per_line)
    srt_path = out_dir / f"{base}.funasr.srt"
    srt_path.write_text(srt_content, encoding="utf-8")

    if args.write_orig_srt:
        orig_srt_content = generate_srt_original(res)
        (out_dir / f"{base}.funasr.orig.srt").write_text(
            orig_srt_content, encoding="utf-8"
        )

    if args.print_srt_path:
        print(str(srt_path))
    else:
        print("Done!")


if __name__ == "__main__":
    main()
