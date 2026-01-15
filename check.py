from funasr import AutoModel
import json
from pathlib import Path
import re

# ==============================================================================
# 1. KHỞI TẠO MODEL (FULL PARAMETERS)
# ==============================================================================
# Lưu ý: Bắt buộc phải có punc_model để tránh lỗi UnboundLocalError khi dùng VAD
model = AutoModel(
    # --- Model paths ---
    model=r"D:\0_code\3.Full-pipeline\fun-asr\models\iic\speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    vad_model=r"D:\0_code\3.Full-pipeline\fun-asr\models\iic\speech_fsmn_vad_zh-cn-16k-common-pytorch",
    punc_model=r"D:\0_code\3.Full-pipeline\fun-asr\models\iic\punc_ct-transformer_cn-en-common-vocab471067-large",
    
    # --- System Config ---
    device="cuda",          # "cuda" hoặc "cpu"
    ncpu=4,                 # Số luồng CPU (nếu dùng cpu)
    disable_update=True,    # Không check update mỗi lần chạy
    disable_log=True,       # Tắt log rác
    
    # --- VAD Config (Cấu hình cắt gọt im lặng) ---
    # Đây là chỗ chỉnh để cắt câu tốt hơn ngay từ đầu vào
    vad_kwargs={
        "max_single_segment_time": 30000,  # (ms) Tối đa 1 đoạn audio gửi vào model là 30s
        "max_end_silence_time": 400,       # (ms) Im lặng 400ms là cắt câu luôn (giảm số này để câu ngắn hơn)
    },
)

# ==============================================================================
# 2. CHẠY NHẬN DIỆN (FULL PARAMETERS)
# ==============================================================================
audio_path = r"D:\0_code\3.Full-pipeline\fun-asr\Tập 1.flac"

res = model.generate(
    input=audio_path,
    
    # --- Hiệu năng ---
    batch_size_s=300,       # Lượng audio xử lý 1 lần (càng to càng nhanh nhưng tốn VRAM)
    
    # --- Output Control ---
    sentence_timestamp=True,# Bắt buộc True để lấy timestamp từng từ
    return_raw_text=False,  # False = lấy text đẹp, True = lấy text thô
    
    # --- Text Processing ---
    hotword="魔搭",         # Các từ khóa ưu tiên (cách nhau bằng space)
    hotword_weight=1.0,     # Trọng số hotword
    disable_punc=False,     # True: Không thêm dấu câu (nhưng vẫn phải init model punc ở trên)
    disable_itn=False,      # True: Không chuyển số (giữ nguyên "một trăm" thay vì "100")
)

# ==============================================================================
# 3. XỬ LÝ OUTPUT VÀ TẠO SRT (LOGIC MỚI: CẮT CÂU DÀI)
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

# Xuất file
out_dir = Path("outpt_srt")
out_dir.mkdir(parents=True, exist_ok=True)
base = Path(audio_path).stem

# Lưu JSON gốc để debug
(out_dir / f"{base}.funasr.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")

# Lưu SRT đã xử lý cắt câu
srt_content = generate_srt_advanced(res, max_chars_per_line=30)
(out_dir / f"{base}.funasr.srt").write_text(srt_content, encoding="utf-8")

# Lưu SRT gốc (giữ nguyên timestamp theo sentence_info)
orig_srt_content = generate_srt_original(res)
(out_dir / f"{base}.funasr.orig.srt").write_text(orig_srt_content, encoding="utf-8")

print("Done! Check folder outpt_srt")
