## V2 Batches API (client guide)

Batch là cơ chế chạy **nhiều item (tối đa 10)** theo policy **stage-first**:
1) chạy ASR cho **tất cả** items (item nào xong ASR thì `output.srt` ready ngay)
2) sau đó chạy Demucs cho **tất cả** items

Các endpoint:
- `POST /v2/batches` tạo batch (trả `202 Accepted` ngay)
- `GET /v2/batches/:id` poll status tổng + per-item status/artifacts
- `GET /v2/batches/:id/items/:idx/artifacts/:name` tải artifact theo tên file
- `POST /v2/batches/:id/cancel` yêu cầu huỷ batch (best-effort)

Base URL: `http://localhost:<PORT>`

---

## Auth

Nếu `REQUIRE_AUTH=true`, cần:
- `Authorization: Bearer <BEARER_TOKEN>`

---

## Options

Server hiện hỗ trợ:

```json
{
  "policy": "stage-first",
  "tasks": { "asr": true, "demucs": true },
  "vadMaxSingleSegmentMs": 8000,
  "vadMaxEndSilenceMs": 50
}
```

- `policy`: hiện chỉ có `"stage-first"` (ASR all → Demucs all)
- `tasks.asr`: bật/tắt ASR stage
- `tasks.demucs`: bật/tắt Demucs stage
- VAD params: optional

Ngoài ra có thể override VAD bằng query:
- `?vadMaxSingleSegmentMs=...&vadMaxEndSilenceMs=...`

---

## Input items (tối đa 10)

Mỗi item là 1 trong:

- Upload:
  - `{ "kind": "upload", "fileIndex": 0 }`
- Local path (trên máy chạy server):
  - `{ "kind": "audioPath", "audioPath": "D:/path/to/file.mp3" }`
- URL:
  - `{ "kind": "audioUrl", "audioUrl": "https://..." }`

---

## 1) POST /v2/batches (create batch)

### A) Multipart (khuyến nghị, hỗ trợ upload + url/path mix)

- `Content-Type: multipart/form-data`
- Files: `audio` (0..10 files)
- Field text:
  - `items`: JSON array (len 1..10)
  - `options`: JSON object (optional)

Ví dụ:

```bash
curl -s -X POST "http://localhost:3000/v2/batches" \
  -H "Authorization: Bearer <TOKEN>" \
  -F "audio=@D:/a.mp3" \
  -F "audio=@D:/b.mp3" \
  -F "items=[{\"kind\":\"upload\",\"fileIndex\":0},{\"kind\":\"upload\",\"fileIndex\":1},{\"kind\":\"audioUrl\",\"audioUrl\":\"https://example.com/c.mp3\"}]" \
  -F "options={\"policy\":\"stage-first\",\"tasks\":{\"asr\":true,\"demucs\":true}}"
```

### B) JSON (chỉ audioPath/audioUrl)

```bash
curl -s -X POST "http://localhost:3000/v2/batches" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "items":[
      {"kind":"audioPath","audioPath":"D:/a.mp3"},
      {"kind":"audioUrl","audioUrl":"https://example.com/b.mp3"}
    ],
    "options":{"policy":"stage-first","tasks":{"asr":true,"demucs":true}}
  }'
```

### Response

- `202 Accepted`
- Header: `x-batch-id: <batchId>`
- Body:

```json
{
  "status": "ok",
  "data": {
    "batchId": "…",
    "statusUrl": "/v2/batches/<batchId>"
  }
}
```

---

## 2) GET /v2/batches/:id (poll status)

```bash
curl -s "http://localhost:3000/v2/batches/<BATCH_ID>" \
  -H "Authorization: Bearer <TOKEN>"
```

Response shape (rút gọn):
- `state`: `queued | running | succeeded | failed | canceled`
- `phase`: `validate | asr | demucs | done | error`
- `counts`: tổng hợp theo item state
- `items[]`: mỗi item có `state`, `phase`, `artifacts` (ready/url)

Ví dụ (khi ASR xong item 0, còn item khác đang chạy):

```json
{
  "status": "ok",
  "data": {
    "id": "…",
    "state": "running",
    "phase": "asr",
    "counts": { "total": 3, "queued": 2, "running": 1, "succeeded": 0, "failed": 0, "canceled": 0 },
    "items": [
      {
        "idx": 0,
        "state": "queued",
        "phase": "queued",
        "artifacts": {
          "srt": { "name": "output.srt", "ready": true, "url": "/v2/batches/<BATCH_ID>/items/0/artifacts/output.srt" }
        }
      }
    ]
  }
}
```

---

## 3) Download artifacts

Tải theo URL trong `GET /v2/batches/:id` (relative path), hoặc theo pattern:

- `GET /v2/batches/:id/items/:idx/artifacts/:name`

Ví dụ tải SRT của item 0:

```bash
curl -L -o item0.srt "http://localhost:3000/v2/batches/<BATCH_ID>/items/0/artifacts/output.srt" \
  -H "Authorization: Bearer <TOKEN>"
```

Tên file thường gặp:
- `output.srt` (sẵn sau ASR)
- `vocals.mp3`, `no_vocals.mp3`
- `demucs.zip`
- `result.zip` (chỉ khi `tasks.asr=true` và `tasks.demucs=true`)

---

## 4) Cancel (best-effort)

```bash
curl -s -X POST "http://localhost:3000/v2/batches/<BATCH_ID>/cancel" \
  -H "Authorization: Bearer <TOKEN>"
```

Lưu ý:
- Items chưa chạy sẽ bị mark `canceled` và bị skip.
- Item đang chạy có thể không dừng ngay (tuỳ step), batch sẽ dừng ở “điểm an toàn” sau đó.

---

## TTL + restart

- Metadata batch được lưu xuống disk: `TMP_DIR/batches/<batchId>/batch.json`
- Artifacts của từng item nằm trong: `TMP_DIR/batches/<batchId>/items/<idx>/`
- Sau khi batch kết thúc, server set `expiresAt = now + JOB_TTL_SECONDS` và sẽ dọn khi quá hạn.
- Nếu server restart khi batch đang `queued/running`, batch sẽ bị mark `failed` (interrupted).

