# Web Interview Recorder (Per-Question Upload)

_Final Project for Computer Networks_

This project implements a web-based interview system, focusing on client-server communication, API design, and network reliability via a per-question upload mechanism with exponential backoff.

The system is designed with two distinct user interfaces:

- **Interviewee (Candidate)**: Records and submits video responses per question using a secure token.  
- **Interviewer (Admin)**: Manages sessions, views submissions, and accesses AI-driven analysis (STT, Emotion) and human review forms.

---

## 🚀 Architecture and Technology Stack

| Component              | Technology           | Rationale                                                                       |
|------------------------|----------------------|---------------------------------------------------------------------------------|
| Frontend (Client)      | React + Tailwind CSS | Dynamic state management and modern, responsive UI design.                      |
| Backend (Server)       | Python (FastAPI)     | High performance, great for API development, unified stack for AI/ML features.  |
| Database               | Firestore (Firebase) | Persistent storage for user accounts, tokens, and the question bank.            |
| Deployment             | Vercel/Netlify (Client), Heroku/Fly.io (Server) | Free public hosting, HTTPS for camera/mic access (mandatory). |

---

## 🌐 API Contract (Network Requirements)

All API calls are secured via a unique session token and must handle network errors robustly.

| Method | Endpoint            | Description                                                       | Mandatory Project Requirement           |
|--------|---------------------|-------------------------------------------------------------------|-----------------------------------------|
| POST   | `/api/verify-token` | Validates the Interviewee's token and name.                      | Yes (Token validation)                  |
| POST   | `/api/session/start`| Initiates the session and creates the unique server folder (`DD_MM_YYYY_HH_mm_ten_user/`). | Yes (Session Start)                     |
| POST   | `/api/upload-one`   | Uploads the recorded video and metadata for a single question. Must use `multipart/form-data`. | **CRITICAL: Per-Question Upload**       |
| POST   | `/api/session/finish`| Closes the session and finalizes the `meta.json` file.          | Yes (Session Finish)                    |

---

## 📦 File Storage Structure

All videos and metadata are stored on the server file system in a time-zone specific folder:

- Base path:  
  `"[SERVER_STORAGE]/DD_MM_YYYY_HH_mm_ten_user/"`  
  (Timezone: `Asia/Bangkok`)

Contents inside each session folder:

- `Q1.webm`, `Q2.webm`, ... — Video files (per question).
- `meta.json` — Session metadata (user, questions, timestamps).
- `transcript.txt` (Bonus) — Speech-to-Text output.
- `analysis.json` (Advanced) — AI review scores (emotion, confidence, content).

---

## 🛡️ Network Reliability, Statuses and Retry Policy

Both client and server include retry/backoff logic but for different responsibilities:

- Client (per-question upload):
  - Policy: maximum **3 automatic attempts** to upload a single recorded question.
  - Mechanism: **exponential backoff** on the client side. Current base delay in the UI is **2s** and the pattern is base * 2^(attempt - 1).
  - If automatic retries are exhausted, the UI surfaces a **manual Retry** button so the interviewee can re-trigger upload.

 - Server (AI processing):
  - AI processing is intentionally run in the background and the interview flow does not block on it.

Clear statuses exposed in the UI (mapped to states used by the client/server):

- permission — camera/microphone access status (pending, granted, denied)
- recording — actively recording a question
- stopped — recording stopped and ready to upload
- uploading — file is being uploaded to `/api/upload-one`
- retry — UI is retrying upload (exponential backoff)
- failed — automatic retries failed (manual Retry available)
- done/success — upload succeeded; server background AI processing may be running

These statuses ensure per-question behavior: stop recording -> upload immediately; the interviewee can only move to the next question after a successful upload (and the UI indicates the upload+AI processing status). Manual Retry buttons are available for both upload failures.

---

## 🛠️ Getting Started (Run Instructions)

> _To be completed in Week 3 after backend/frontend implementation._
