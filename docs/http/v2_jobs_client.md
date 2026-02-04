## V2 Jobs API (client guide)

V2 cung cấp cơ chế **async job / poll / download artifacts** để tránh giữ kết nối HTTP lâu (dễ timeout/abort) khi chạy Demucs/ASR.

Base URL: `http://localhost:<PORT>`

Các endpoint:
- `POST /v2/jobs` tạo job (trả `202 Accepted` ngay)
- `GET /v2/jobs/:id` xem trạng thái + danh sách artifacts đã sẵn sàng
- `GET /v2/jobs/:id/artifacts/:name` tải artifact theo tên file (khi đã `ready`)

> V2 vẫn dùng **cùng SerialQueue concurrency=1** với V1, nên throughput không đổi; chỉ khác là client không cần giữ request mở lâu.

---

## Auth

Nếu `REQUIRE_AUTH=true` (mặc định), mọi endpoint `/v2/*` yêu cầu header:
- `Authorization: Bearer <BEARER_TOKEN>`

Lỗi auth:
- `401 unauthorized`: thiếu Bearer token
- `403 forbidden`: token sai

---

## Job model

### State

- `queued`: job đã được tạo và đang chờ tới lượt chạy trong queue
- `running`: đang chạy
- `succeeded`: chạy xong thành công
- `failed`: chạy xong nhưng lỗi

### Phase (tiến độ theo stage)

`phase` là “tiến độ” dạng stage, một trong:
- `queued`
- `asr_convert` (ffmpeg convert sang WAV mono 16k)
- `asr` (python ASR)
- `demucs` (python demucs)
- `zip_demucs` (zip stems)
- `zip_result` (zip bundle tổng hợp)
- `done`
- `error`

### Queue field

Trong response có `queue: { pending, running }` là **global engine queue** (cho cả V1 + V2), không phải per-job.

### Artifacts

`GET /v2/jobs/:id` trả về `artifacts` (map), mỗi artifact có:
- `ready: boolean`
- `url` (chỉ có khi `ready=true`)
- `bytes` (optional)

Keys (đúng theo code):
- `srt` → `output.srt`
- `vocals` → `vocals.mp3`
- `no_vocals` → `no_vocals.mp3`
- `demucs_zip` → `demucs.zip`
- `result_zip` → `result.zip` (chỉ khi `type=asr-demucs`)

Tên file thường gặp:
- `output.srt` (job `asr` hoặc `asr-demucs`; sẵn ngay sau ASR)
- `vocals.mp3`, `no_vocals.mp3` (job `demucs` hoặc `asr-demucs`)
- `demucs.zip` (job `demucs` hoặc `asr-demucs`)
- `result.zip` (chỉ job `asr-demucs`; sẵn khi ASR + Demucs xong)

---

## TTL + restart

- Job metadata được lưu xuống disk: `TMP_DIR/jobs-v2/<jobId>/job.json`
- Artifacts nằm trong `TMP_DIR/jobs-v2/<jobId>/`
- Sau khi job kết thúc, server set `expiresAt = now + JOB_TTL_SECONDS` và sẽ dọn job/artifacts khi quá hạn.
- Nếu server restart khi job đang `queued/running`, job đó sẽ bị đánh dấu `failed` với thông báo “Job interrupted by server restart…”.

---

## Error format (JSON)

Mọi lỗi đều theo format:

```json
{
  "status": "error",
  "error": {
    "code": "…",
    "message": "…",
    "details": {}
  }
}
```

Các `code` thường gặp:
- `bad_request` (400)
- `bad_audio` (400)
- `unauthorized` (401)
- `forbidden` (403)
- `not_found` (404)
- `engine_error` (500)
- `internal_error` (500)

---

## 1) POST /v2/jobs (create job)

### Chọn loại job

Truyền `type` bằng query hoặc body field (multipart/form-data hoặc JSON):
- `asr`
- `demucs`
- `asr-demucs` (**default** nếu không truyền hoặc truyền các alias: `demucs-asr`, `asr+demucs`, `demucsasr`)

### Query params (VAD)

Optional:
- `vadMaxSingleSegmentMs`: số nguyên dương
- `vadMaxEndSilenceMs`: số nguyên dương

### Input audio (3 cách)

1) Multipart upload (khuyến nghị)
- `Content-Type: multipart/form-data`
- Field file: `audio`
- Có thể truyền thêm field text: `type=asr|demucs|asr-demucs` (hoặc dùng query `?type=...`)

2) JSON `audioPath`
- `Content-Type: application/json`
- Body: `{ "audioPath": "D:/path/to/file.mp3" }` (path tồn tại trên máy chạy server)

3) JSON `audioUrl`
- `Content-Type: application/json`
- Body: `{ "audioUrl": "https://..." }`

### Ví dụ (multipart)

```bash
curl -s -X POST "http://localhost:3000/v2/jobs?type=asr-demucs" \
  -H "Authorization: Bearer <TOKEN>" \
  -F "audio=@D:/path/to/input.mp3"
```

### Ví dụ (JSON audioUrl)

```bash
curl -s -X POST "http://localhost:3000/v2/jobs?type=asr" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"audioUrl":"https://example.com/input.mp3"}'
```

### Response

- Status: `202 Accepted`
- Headers:
  - `x-request-id: <uuid>`
  - `x-job-id: <jobId>`
- Body:

```json
{
  "status": "ok",
  "data": {
    "jobId": "…",
    "statusUrl": "/v2/jobs/<jobId>",
    "job": {
      "id": "…",
      "type": "asr-demucs",
      "state": "queued",
      "phase": "queued",
      "createdAt": "2026-02-04T00:00:00.000Z",
      "queue": { "pending": 0, "running": 1 },
      "artifacts": {}
    }
  }
}
```

> `statusUrl` và các `artifact.url` là **relative path**; client tự prefix host (vd `http://localhost:3000`).

> Lưu ý: các field như `startedAt`, `finishedAt`, `expiresAt`, `error` chỉ xuất hiện khi đã có giá trị (khi chưa có thì server sẽ omit khỏi JSON).

---

## 2) GET /v2/jobs/:id (poll status)

```bash
curl -s "http://localhost:3000/v2/jobs/<JOB_ID>" \
  -H "Authorization: Bearer <TOKEN>"
```

Ví dụ response (khi ASR xong nhưng Demucs đang chạy):

```json
{
  "status": "ok",
  "data": {
    "id": "…",
    "type": "asr-demucs",
    "state": "running",
    "phase": "demucs",
    "createdAt": "…",
    "startedAt": "…",
    "queue": { "pending": 0, "running": 1 },
    "artifacts": {
      "srt": {
        "name": "output.srt",
        "ready": true,
        "bytes": 12345,
        "url": "/v2/jobs/<JOB_ID>/artifacts/output.srt"
      }
    },
    "error": null
  }
}
```

---

## 3) GET /v2/jobs/:id/artifacts/:name (download)

Khi một artifact có `ready=true`, tải bằng URL trả về trong `GET /v2/jobs/:id`.

Headers:
- Response có `x-job-id: <jobId>`
- Response là file download (server dùng `res.download(...)`, kèm `Content-Disposition` theo tên file)

Ví dụ tải SRT sớm:

```bash
curl -L -o output.srt "http://localhost:3000/v2/jobs/<JOB_ID>/artifacts/output.srt" \
  -H "Authorization: Bearer <TOKEN>"
```

Ví dụ tải bundle đầy đủ (khi `state=succeeded`):

```bash
curl -L -o result.zip "http://localhost:3000/v2/jobs/<JOB_ID>/artifacts/result.zip" \
  -H "Authorization: Bearer <TOKEN>"
```

---

## Flow mẫu: `type=asr-demucs` (ASR trước, Demucs sau)

1) `POST /v2/jobs?type=asr-demucs` → nhận `jobId`
2) Poll `GET /v2/jobs/:id` tới khi thấy `artifacts.srt.ready=true`
3) Tải `output.srt` ngay:
   - `GET /v2/jobs/:id/artifacts/output.srt`
4) Tiếp tục poll tới khi `state=succeeded`
5) Tải kết quả:
   - riêng lẻ: `vocals.mp3`, `no_vocals.mp3` hoặc `demucs.zip`
   - bundle tổng: `result.zip`
