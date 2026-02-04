## Server HTTP (nội bộ)

Server Express cung cấp 3 API chính:
- ASR (audio -> SRT)
- Demucs tách vocal
- Demucs + ASR (trả về zip gồm SRT + stems)

Ngoài ra có **V2 Jobs API** (async job / poll / download artifacts) để tránh vấn đề timeout khi chạy lâu.

Lưu ý:
- **V1** (`/v1/*`) chạy **sync** và bị **queue tuần tự (concurrency=1)** cho tất cả endpoints.
- **V2** (`/v2/jobs*`) tạo job và chạy nền (vẫn dùng **cùng queue serial**, nên throughput giống V1, nhưng không giữ HTTP connection lâu).

---

## Base URL

- Local: `http://localhost:<PORT>`
- Khi deploy sau reverse proxy có thể là HTTPS, nhưng API/paths không đổi.

---

## Auth

Mặc định các endpoint dưới `/v1/*` yêu cầu header:
- `Authorization: Bearer <BEARER_TOKEN>`

Cấu hình:
- `REQUIRE_AUTH=true|false` (mặc định `true`)
- Nếu `REQUIRE_AUTH=true` mà thiếu `BEARER_TOKEN` thì server sẽ không khởi động.

Lỗi auth:
- `401 unauthorized`: thiếu Bearer token
- `403 forbidden`: token sai

---

## Request ID

Middleware dùng `x-request-id` để trace:
- Nếu client gửi `x-request-id` thì server reuse.
- Nếu không, server tự tạo UUID.
- Response **luôn** có header `x-request-id`.

RequestId này cũng được dùng để đặt tên file upload và thư mục output tạm.

---

## Queue / Concurrency

Server dùng `SerialQueue` (concurrency=1):
- Tại một thời điểm chỉ chạy **1** request (ASR/Demucs/Demucs-ASR) trong “engine”.
- Request đến sau sẽ **xếp hàng** và chờ.

Do đó thời gian response = thời gian chờ queue + thời gian xử lý.

---

## V2 Jobs (async)

Mục tiêu của V2:
- Tránh `Request aborted` do client/proxy timeout khi job chạy lâu.
- Cho phép lấy kết quả theo từng phần (ví dụ `output.srt` sẵn trước khi Demucs xong).

Đặc điểm:
- Job metadata được lưu xuống disk tại `TMP_DIR/jobs-v2/<jobId>/job.json`, nên **restart server vẫn GET được job cũ** (miễn chưa bị dọn theo TTL).
- Artifacts được lưu ở `TMP_DIR/jobs-v2/<jobId>/` và tự dọn theo TTL (`JOB_TTL_SECONDS`, default 6h) sau khi job hoàn tất.
- Job đang `queued/running` mà server restart thì job đó sẽ được đánh dấu `failed` (vì queue không resume).

Endpoints:
- `POST /v2/jobs` (tạo job, trả `202 Accepted`)
- `GET /v2/jobs/:id` (xem trạng thái + artifacts ready/pending)
- `GET /v2/jobs/:id/artifacts/:name` (download artifact khi ready)

### POST /v2/jobs

- Auth: Bearer (tuỳ `REQUIRE_AUTH`)
- Input audio: multipart `audio` hoặc JSON `audioPath`/`audioUrl` (giống V1)
- Chọn loại job bằng `type` (query hoặc multipart field):
  - `asr`
  - `demucs`
  - `asr-demucs` (mặc định; chạy **ASR trước**, rồi Demucs sau, rồi zip `result.zip`)
- Query params (giống V1 ASR):
  - `vadMaxSingleSegmentMs`, `vadMaxEndSilenceMs`

Response:
- `202 Accepted`
- Header: `x-job-id`
- Body có `statusUrl` để poll.

Ví dụ:
```bash
curl -s -X POST "http://localhost:3000/v2/jobs?type=asr-demucs" \
  -H "Authorization: Bearer <TOKEN>" \
  -F "audio=@D:/path/to/input.mp3"
```

### GET /v2/jobs/:id

Trả về:
- `state`: `queued | running | succeeded | failed`
- `phase`: `asr_convert | asr | demucs | zip_* | done | error`
- `artifacts`: map các artifact, mỗi cái có `ready` và `url` nếu đã sẵn

Ví dụ:
```bash
curl -s "http://localhost:3000/v2/jobs/<JOB_ID>" \
  -H "Authorization: Bearer <TOKEN>"
```

### Download artifacts

Khi artifact `ready=true`, bạn tải bằng:
- `GET /v2/jobs/:id/artifacts/:name`

Các tên file thường gặp:
- `output.srt` (job `asr` hoặc `asr-demucs`; sẵn ngay sau ASR)
- `vocals.mp3`, `no_vocals.mp3` (job `demucs` hoặc `asr-demucs`)
- `demucs.zip` (job `demucs` hoặc `asr-demucs`)
- `result.zip` (chỉ job `asr-demucs`, sẵn khi cả ASR + Demucs xong)

Ví dụ tải SRT trước:
```bash
curl -L -o output.srt "http://localhost:3000/v2/jobs/<JOB_ID>/artifacts/output.srt" \
  -H "Authorization: Bearer <TOKEN>"
```

## Input audio (áp dụng cho `/v1/*` và `/v2/jobs`)

Server nhận audio theo 1 trong 3 cách (ưu tiên theo thứ tự):

1) **Upload multipart**
- `Content-Type: multipart/form-data`
- Field bắt buộc: `audio` (file)

2) **JSON: audioPath**
- `Content-Type: application/json`
- Body: `{ "audioPath": "D:/path/to/file.mp3" }` (path tồn tại trên máy chạy server)

3) **JSON: audioUrl**
- `Content-Type: application/json`
- Body: `{ "audioUrl": "https://..." }`
- Server sẽ `fetch()` và lưu tạm vào `TMP_DIR/uploads/` trước khi xử lý.

Nếu không có audio theo các cách trên:
- `400 bad_request`: `Missing audio (multipart field 'audio' or JSON audioPath or JSON audioUrl)`

Giới hạn body JSON:
- Server parse JSON với limit `2mb` (chỉ ảnh hưởng request `Content-Type: application/json`).

---

## Error format (JSON)

Mọi lỗi trả về JSON theo format:

```json
{
  "status": "error",
  "error": {
    "code": "bad_request",
    "message": "…",
    "details": {}
  }
}
```

Một số `code` thường gặp:
- `bad_request` (400): thiếu input / query param sai
- `bad_audio` (400): ffmpeg/demucs không xử lý được audio
- `engine_error` (500): python ASR worker fail
- `internal_error` (500): lỗi không xác định

---

## API

### 1) Healthcheck

- `GET /health`
- Auth: không
- Response: `200 OK`

Response mẫu:
```json
{ "status": "ok" }
```

Ví dụ:
```bash
curl -s "http://localhost:3000/health"
```

---

### 2) ASR: audio -> SRT

- `POST /v1/asr`
- Auth: Bearer (tuỳ `REQUIRE_AUTH`)
- Input audio: multipart `audio` hoặc JSON `audioPath`/`audioUrl`
- Query params:
  - `format`: `json` (mặc định) | `srt`
  - `vadMaxSingleSegmentMs`: số nguyên dương (optional)
  - `vadMaxEndSilenceMs`: số nguyên dương (optional)

> Nếu `vadMaxSingleSegmentMs` hoặc `vadMaxEndSilenceMs` không phải số nguyên dương -> `400 bad_request`.

#### Quy trình xử lý (tiền/hậu xử lý)

1) Resolve input audio:
   - upload -> dùng file đã upload
   - audioUrl -> download về `TMP_DIR/uploads/...`
   - audioPath -> dùng trực tiếp file trên disk (không copy)
2) Convert audio sang WAV mono 16k bằng ffmpeg:
   - `-ac 1 -ar 16000 -c:a pcm_s16le`
   - Nếu fail -> `400 bad_audio` (`Failed to convert input audio to wav mono 16k`)
3) Chạy FunASR qua python worker (preload model):
   - Output là file SRT trong thư mục tạm
   - Nếu python fail -> `500 engine_error` (`ASR engine failed`)
4) Trả về SRT (json hoặc file)
5) Cleanup:
   - Xoá toàn bộ thư mục tạm `TMP_DIR/out/<requestId>/`
   - Nếu input là upload/audioUrl: xoá file audio tạm tương ứng
   - Nếu input là `audioPath`: không xoá file gốc

#### Response

**A) `format=json` (mặc định)**
- `200 OK`
- Header: `x-request-id: <id>`
- Body:
```json
{ "status": "ok", "data": { "srt": "..." } }
```

Ví dụ (multipart):
```bash
curl -s -X POST "http://localhost:3000/v1/asr" \
  -H "Authorization: Bearer <TOKEN>" \
  -F "audio=@D:/path/to/input.mp3"
```

Ví dụ (audioUrl):
```bash
curl -s -X POST "http://localhost:3000/v1/asr" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"audioUrl":"https://example.com/input.mp3"}'
```

**B) `format=srt`**
- `200 OK`
- Header:
  - `content-type: text/plain; charset=utf-8`
  - `content-disposition: attachment; filename="output.srt"`
  - `x-request-id: <id>`
- Body: file `.srt` (có BOM UTF-8 ở đầu file)

Ví dụ:
```bash
curl -L -o output.srt "http://localhost:3000/v1/asr?format=srt" \
  -H "Authorization: Bearer <TOKEN>" \
  -F "audio=@D:/path/to/input.mp3"
```

#### Default VAD (nếu không truyền query)

Python runner dùng mặc định:
- `vadMaxSingleSegmentMs = 8000`
- `vadMaxEndSilenceMs = 50`

---

### 3) Demucs: tách vocals/no-vocals

- `POST /v1/demucs`
- Auth: Bearer (tuỳ `REQUIRE_AUTH`)
- Input audio: multipart `audio` hoặc JSON `audioPath`/`audioUrl`
- Response: download file zip `demucs.zip`
  - Bên trong gồm:
    - `vocals.mp3`
    - `no_vocals.mp3`

#### Quy trình xử lý

1) Resolve input audio (tương tự `/v1/asr`)
2) Chạy Demucs bằng python: `python -m demucs.separate ...`
   - Model: `htdemucs_ft`
   - Two-stems: `vocals`
   - Output mp3 với bitrate `DEMUCS_MP3_BITRATE` và jobs `DEMUCS_JOBS`
   - Nếu fail -> `400 bad_audio` (`Demucs failed to process input audio`)
3) Zip kết quả (python zip) -> trả về download
4) Cleanup thư mục tạm và audio tạm (nếu có)

Ví dụ:
```bash
curl -L -o demucs.zip "http://localhost:3000/v1/demucs" \
  -H "Authorization: Bearer <TOKEN>" \
  -F "audio=@D:/path/to/input.mp3"
```

Lưu ý timeout:
- Demucs/ASR có thể chạy vài phút. Nếu client hoặc reverse proxy có timeout thấp, request có thể bị ngắt giữa chừng.
- Khi đó server có thể log `client_aborted` / `Request aborted` và client sẽ không nhận được file zip.

---

### 4) Demucs + ASR: trả về zip tổng hợp

- `POST /v1/demucs-asr`
- Auth: Bearer (tuỳ `REQUIRE_AUTH`)
- Input audio: multipart `audio` hoặc JSON `audioPath`/`audioUrl`
- Query params:
  - `format`: `zip` (mặc định) | `json` (không khuyến nghị; chỉ trả JSON “tối thiểu”)
  - `vadMaxSingleSegmentMs`: số nguyên dương (optional)
  - `vadMaxEndSilenceMs`: số nguyên dương (optional)

#### Quy trình xử lý

1) Resolve input audio
2) Chạy Demucs (tách stems)
3) Chạy ASR trên **audio gốc** (không phải vocals), gồm bước convert WAV mono 16k như `/v1/asr`
4) Đóng gói `result.zip` gồm:
   - `output.srt`
   - `vocals.mp3`
   - `no_vocals.mp3`
5) Trả response + cleanup

#### Response

**A) `format=zip` (mặc định)**
- `200 OK` download `result.zip`

Ví dụ:
```bash
curl -L -o result.zip "http://localhost:3000/v1/demucs-asr" \
  -H "Authorization: Bearer <TOKEN>" \
  -F "audio=@D:/path/to/input.mp3"
```

Lưu ý timeout:
- Endpoint này chạy sync và có thể mất > 5 phút (tuỳ độ dài audio + GPU/CPU). Nếu client/proxy timeout, response download sẽ bị abort.
- Nếu deploy sau reverse proxy (nginx/traefik/cloudflare), cần tăng timeout tương ứng (vd `proxy_read_timeout`, `client_body_timeout`, ...).

**B) `format=json`**
- `200 OK`
- Body:
```json
{ "status": "ok", "data": { "downloadName": "result.zip" } }
```

Lưu ý: mode này **không trả file zip** và file tạm sẽ bị cleanup sau khi response xong (nên không dùng để “lấy link tải”).

---

## Thư mục tạm / artifacts

Mặc định `TMP_DIR=tmp`:
- Upload/download tạm: `TMP_DIR/uploads/`
- Output xử lý theo requestId: `TMP_DIR/out/<x-request-id>/`

Server sẽ cleanup `TMP_DIR/out/<id>/` sau mỗi request.

---

## Env vars liên quan

Trong `.env`:
- `PORT` (default `3000`)
- `BEARER_TOKEN`
- `REQUIRE_AUTH` (default `true`)
- `PYTHON_BIN` (tuỳ chọn; nếu không set sẽ dùng `./.venv/.../python`)
- `FFMPEG_BIN` (default `ffmpeg`)
- `CHECK_PY` (default `python/funasr_runner.py`)
- `TMP_DIR` (default `tmp`)
- `DEMUCS_MP3_BITRATE` (default `256`)
- `DEMUCS_JOBS` (default `2`)
- `JOB_TTL_SECONDS` (default `21600` = 6 giờ; TTL cleanup cho V2 job artifacts)

Trong python runner (ảnh hưởng output SRT):
- `SRT_MERGE_ENABLED` (default `false`)
- `SRT_MERGE_MAX_WORDS` (default `15`)
- `SRT_MERGE_STRIP_MIDDLE_PUNCT` (default `true`)
- `DEVICE` (default `cuda`)
- `NCPU` (default `8`)
- `FUNASR_MODELS_DIR`, `FUNASR_MODEL`, `FUNASR_VAD_MODEL`, `FUNASR_PUNC_MODEL` (tuỳ chọn)
