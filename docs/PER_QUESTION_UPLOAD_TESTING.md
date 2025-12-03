Per-question upload + retry testing

This short guide explains how to manually test the per-question upload + exponential backoff and manual retry functionality implemented in the client and the server.

Client-side behavior tested:
- Stop recording question i -> client uploads immediately with multipart/form-data to /api/upload-one
- client will attempt a maximum of 3 automatic uploads using exponential backoff (2s base)
- while retrying the UI shows a 'retry' state and attempt number
- if automatic retries fail, the UI shows a manual "Retry Upload" button (allowing the candidate to try again)

Server-side AI processing behavior tested:
- After upload is accepted, server runs AI processing in background.
- Server retries AI processing with tenacity (3 attempts) and exponential backoff.
- If AI processing eventually fails, meta.json will be updated for that question with status 'ai_error'.
 - Server-side AI processing can be retried by the server logic, but the UI does not expose a manual "Retry AI Analysis" button; AI runs in background and does not block the flow.

Manual test steps (local dev):
1. Start backend server (FastAPI/uvicorn) and frontend dev server (Vite) so both run locally.
2. In the frontend (interviewee flow):
   - Start a session and record a question.
   - Immediately stop recording to set the status to "stopped".
   - Click Upload — if the server is reachable the upload will succeed.
3. To test retry behavior quickly:
   - Temporarily shut down or block the backend server (or simulate a 5xx response).
   - Attempt an upload for a question — the client should display retry messages and attempt up to 3 times with exponential backoff before showing manual "Retry Upload".
4. Manual retry (upload):
   - When automatic retries fail, click the "Retry Upload" button; the client will start attempting again.
5. Manual retry (AI processing):
   - AI processing runs in the background and the UI does not expose a retry button for AI. If AI processing fails, the server marks the question with `ai_error` in `meta.json`.
   - Server operators could re-run AI processing manually on the backend or via API, but we purposely don't expose this in the interview UI.

Notes:
- The client polls the server-side meta.json short-term (~12 polls / ~36s) after upload to update the "AI processing" indicator. If polling finishes with no successful AI result, the UI surfaces an error and provides manual retry.

Expected statuses through the flow: permission → recording → stopped → uploading → (retry → failed | success → done)

If anything behaves differently, check browser console and server logs for the endpoint responses and meta.json content.
