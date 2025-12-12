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
| Deployment             | Vercel (Client), Render (Server) | Free public hosting, HTTPS for camera/mic access (mandatory). |

---

## 📋 System Flow 

### System Flow Overview

**Admin Preparation Phase:**
1. **Admin logs in** with Secret Key (`VITE_ADMIN_AUTH_KEY`)
2. **Admin creates session token** via `/api/interviewer/create-session` endpoint
   - Generates a unique UUID token
   - Associates token with interviewee name
   - Saves to Firestore with status `pending`
   - Returns token + session URL
3. **Admin shares token** with interviewee 

**Interviewee Interview Phase:**
1. **Interviewee enters token + name** → Verifies with `/api/verify-token` endpoint
   - Checks token exists in Firestore with status `pending`
   - Creates session with UUID
2. **Start session** → `/api/session/start` creates folder on server
   - Format: `server/uploads/DD_MM_YYYY_HH_mm_INTERVIEWEE_NAME/`
   - Creates `meta.json` file to track questions
3. **Grant permissions** → Browser requests camera/microphone access
   - Only proceeds after session folder exists on server
4. **For each question (Q1→Q5):**
   - Record video (audio + video stream)
   - Upload immediately via `/api/upload-one` (per-question)
   - Retry with exponential backoff if network fails (2s→4s→8s)
   - **On upload success** → Show "Next Question" button (interviewee can continue)
   - Server starts AI analysis job in background (in parallel)
   - Frontend polls `/api/job-status/{job_id}` every 3 seconds
   - Display results when ready: transcript + match score + emotion + pace
5. **Finish session** → `/api/session/finish` finalizes `meta.json`
   - Marks session as `submitted` in Firestore
   - All Q1-Q5 videos uploaded (AI jobs may still be processing)

**Admin Review Phase:**
1. **Admin accesses review dashboard** → Views all submitted sessions
2. **For each question (Q1→Q5):**
   - Views AI analysis (transcript, match score, emotion, pace, feedback)
   - Reviews candidate's response
   - Rates clarity (1-10) and confidence (1-10)
   - Writes comments/feedback
3. **Submit scores** → `/api/interviewer/submit-review` for each question
   - Sends: token + question_index + clarity + confidence + comment
   - Firestore updates session document
4. **Mark complete** → Session marked as reviewed in Firestore

### System Flow Diagram

```
ADMIN SETUP PHASE:
  1. Admin Login (Secret Key)
         ↓
  2. Create Token (POST /api/interviewer/create-session)
     └─ Generates UUID → Save to Firestore (status: pending)
         ↓
  3. Share Token with Interviewee

INTERVIEWEE INTERVIEW PHASE:
  4. Verify Token (POST /api/verify-token)
         ↓
  5. Start Session (POST /api/session/start)
     └─ Create folder: DD_MM_YYYY_HH_mm_NAME/
         ↓
  6. Grant Permissions (Camera/Microphone)
         ↓
  7. FOR Q1 → Q5:
     ├─ Record Video
     ├─ Upload (POST /api/upload-one)
     │  [Retry: 2s→4s→8s if fail]
     │
     ├─ Upload Success ────→ Show "Next Question" Button
     │                           (Interviewee can continue)
     │
     └─ AI Analysis (Background, in parallel):
        • Transcript (STT)
        • Match score (0-100)
        • AI Feedback
        • Emotion + score
        • Speaking pace
        • Display results when ready
         ↓
  8. Finish Session (POST /api/session/finish)
     └─ All Q1-Q5 uploaded, AI may still process

ADMIN REVIEW PHASE:
  9. Review Dashboard
         ↓
  10. Per-Question Review (Q1→Q5)
      ├─ View AI Analysis
      └─ Submit Scores (POST /api/interviewer/submit-review)
         └─ Clarity (1-10) + Confidence (1-10) + Comments
         ↓
  11. Mark Complete in Firestore
```

---

## 🌐 API Contract (Network Requirements)

All API calls are secured via a unique session token and must handle network errors robustly.

| Method | Endpoint                      | Description                                          | Requirement           |
|--------|-------------------------------|------------------------------------------------------|-----------------------------------------|
| POST   | `/api/verify-token`           | Validates the Interviewee's token and name.         | Token validation                  |
| POST   | `/api/session/start`          | Initiates the session and creates the unique server folder (`DD_MM_YYYY_HH_mm_INTERVIEWEE_NAME/`).  | Session Start                     |
| POST   | `/api/upload-one`             | Uploads the recorded video and metadata for a single question. Must use `multipart/form-data`.       | **Per-Question Upload (CRITICAL)** |
| POST   | `/api/session/finish`         | Closes the session and finalizes the `meta.json` file.     | Session Finish                    |
| GET    | `/api/job-status/{job_id}`    | Poll the status of a queued AI analysis job.              | AI status polling                 |
| GET    | `/api/queue-status`           | Get overall queue status for monitoring.                   | Queue monitoring                  |
| POST   | `/api/retry-processing`       | Manual retry for a failed AI analysis.                     | Manual retry                      |
| POST   | `/api/interviewer/create-session` | Generate a new session token (Admin only).            | Token generation                  |
| POST   | `/api/interviewer/submit-review`  | Submit human review scores for a question.           | Review submission                 |

---

## 📋 Accepted MIME Types

The server strictly validates media types:

| Media Type         | Extension | Status |
|--------------------|-----------|--------|
| `video/webm`       | `.webm`   | ✅ Preferred (VP8 + Opus) |
| `video/ogg`        | `.ogg`    | ✅ Supported (Theora + Vorbis) |

---

## 🔒 Security & Best Practices

- **Token Validation**: Every API request requires a valid session token
- **Firebase Security Rules**: Restrict Firestore access to authenticated users
- **Rate Limiting**: Job Queue implements 15s throttling to prevent quota abuse
- **File Validation**: MIME type checking on upload (video/webm, video/ogg only)
- **Error Handling**: Graceful degradation with user-friendly error messages
- **Camera/Microphone Permission Denial**: If user denies permission, UI displays "Camera & Microphone Access Denied" message and blocks interview flow

---

## ⚠️ HTTPS Requirements

The browser **requires a secure context (HTTPS)** to access camera and microphone hardware via the MediaRecorder API.

**Why HTTPS?**
- Browser security policy: Camera/microphone access only allowed over HTTPS (or localhost for development)
- `navigator.mediaDevices.getUserMedia()` will throw a `NotAllowedError` if called over HTTP

**Development Setup:**
- **Local development**: Use `http://localhost:5173` (browser exception for localhost)
- **Public deployment**: Must deploy frontend on HTTPS (use Vercel, Netlify, etc.)

**Backend:**
- Backend API can run on HTTP in development (`http://localhost:8000`)
- Production: Recommended to use HTTPS for all endpoints

---

## 📦 File Storage & Naming Convention

All session data is stored on the server file system in a time-zone specific folder structure:

**Base Path:**
```
server/uploads/DD_MM_YYYY_HH_mm_INTERVIEWEE_NAME/  (Timezone: Asia/Bangkok)
```

**Contents:**

```
DD_MM_YYYY_HH_mm_INTERVIEWEE_NAME/
├── Q1.webm, Q2.webm, ... Q5.webm               # Video files (per question)
├── Q1_transcript.txt, ... Q5_transcript.txt    # AI transcripts (bonus feature)
└── meta.json                                   # Session metadata
```

**meta.json Structure:**
```json
{
  "status": "complete",
  "videoSizeTotalMB": 45.2,
  "receivedQuestions": {
    "0": {
      "filename": "Q1.webm",
      "status": "done",
      "sizeMB": 9.1,
      "durationSeconds": 45,
      "uploadedAt": "2025-12-10T10:30:15.123Z",
      "transcript_text": "User's spoken response...",
      "ai_match_score": 85,
      "ai_feedback": "Clear and concise answer...",
      "emotion": "confident",
      "emotion_score": 92,
      "pace_wpm": 135,
      "pace_label": "normal"
    },
    "1": { ... },
    "2": { ... },
    "3": { ... },
    "4": { ... }
  }
}
```

**Q_transcript.txt Format (Per-Question File):**
```
--- Q1 ---
Question: [Original question text]
Match Score: [0-100]/100
Feedback: [AI-generated feedback]
--- Transcript ---
[Transcribed speech from video]
```

**File Naming:**
- **Videos**: `Q{index+1}.webm` (e.g., Q1.webm, Q2.webm, ..., Q5.webm)
- **Transcripts**: `Q{index+1}_transcript.txt` (e.g., Q1_transcript.txt)
- **Session Folders**: `DD_MM_YYYY_HH_mm_INTERVIEWEE_NAME`

---

## 🛡️ Network Reliability & Retry Policy

The system implements dual-layer retry logic for robust network communication:

### Client-Side Upload Retry (Per-Question Upload)

**Policy:** Maximum 3 automatic attempts to upload a single recorded question.

**Mechanism:** Exponential backoff on the client side.
- **Base delay:** 2 seconds
- **Formula:** `base_delay × 2^(attempt - 1)`
- **Pattern:**

| Attempt | Calculation | Delay | Total Wait |
|---------|-------------|-------|------------|
| 1       | 2s × 2^0    | 2s    | 2s         |
| 2       | 2s × 2^1    | 4s    | 6s         |
| 3       | 2s × 2^2    | 8s    | 14s        |

**After 3 failed attempts:**
- Automatic retries exhausted
- UI surfaces a manual **"Retry" button**
- Interviewee can re-trigger upload manually
- No further automatic attempts

**Upload Status Lifecycle (UI States):**
- `permission` → Camera/microphone access status (pending, granted, denied)
- `recording` → Actively recording a question
- `stopped` → Recording stopped, ready to upload
- `uploading` → File is being uploaded to `/api/upload-one`
- `retry` → UI is retrying upload with exponential backoff
- `failed` → Automatic retries exhausted, manual "Retry" button available
- `success/done` → Upload succeeded; server background AI processing may still run

### Server-Side AI Processing Retry

**Design:** AI processing is intentionally run in the background and does **not block** the interview flow.

The Job Queue system ensures reliable AI analysis with the following mechanism:

| Stage             | Mechanism                                | Details                                          |
|-------------------|-----------------------------------------|--------------------------------------------------|
| Initial Processing | 1 attempt (no internal retry)            | Fast feedback to client polling                  |
| Failure Detection  | Automatic via queue system               | Triggered by exception or timeout                |
| Auto-Retry Wait   | 70 second delay                         | Allows Gemini API quota to reset                 |
| Auto-Retry Attempt | 1 automatic retry after delay            | Single attempt, no further internal retries      |
| Final Status      | Either `success` or `failed` (permanent) | Manual retry button available if failed          |

**Queue Throttling:**
- **Interval between jobs**: 15 seconds
- **Max throughput**: 4 requests/minute
- **Quota compliance**: Safe under Gemini free tier (5 req/min)

### AI Retry Scenarios

The Job Queue manages two failure scenarios with the following retry flows:

**Scenario 1: Automatic Retry (Rate Limit, Network Error, Server Error)**

Triggered by: HTTP 429 (Gemini quota), 5xx errors (500, 503), or timeout

```
Queue processing → Failure detected
          ↓
   [Queue marks RETRY_SCHEDULED]
          ↓
   Wait 70 seconds (quota reset / recovery period)
          ↓
   Auto-retry: 1 single attempt
          ↓
   Success? ← meta.json + Q_transcript.txt + Firestore ✓
          ↓
   Failed? ← UI shows "Analysis Failed" button
                 ↓
              User clicks "Retry AI Analysis"
                 ↓
           Manual retry job queued (respects 15s throttling)
```

**Scenario 2: Manual Retry (User Triggered)**

```
User sees "Analysis Failed" message
          ↓
   Clicks "Retry AI Analysis" button
          ↓
Frontend POST /api/retry-processing
          ↓
   Job status: MANUAL_RETRY_PENDING
          ↓
   Waits in queue (respects 15s throttling)
          ↓
   Single API call attempt
          ↓
   Success ← meta.json + Q_transcript.txt + Firestore ✓
     │
     └─→ UI displays results
          ↓
   Failed ← Shows error, retry button available again
```

**Error Handling (Implemented):**

| Error Code | Condition                | Client Action          | Server Action           |
|------------|--------------------------|------------------------|-------------------------|
| 401        | Invalid/expired token    | Show error, no retry   | Reject request          |
| 403        | Session expired          | Show error, no retry   | Check session status    |
| 429        | Rate limited (Gemini)    | Retry with backoff     | Schedule 70s auto-retry |
| 500        | Server error             | Retry with backoff     | Log error, resume queue |
| 503        | Service unavailable      | Retry with backoff     | Handle gracefully       |
| timeout    | Network timeout          | Retry with backoff     | Resume processing       |
| denied     | Camera/Microphone denied | Show "Access Denied" message | Prevent interview start |

---

## 🛠️ Installation & Setup

To run the system locally, you need **Python 3.8+**, **Node.js 16+**, **uv** (Python package manager), and valid API credentials for Gemini and Firebase.

### Prerequisites

- **Python 3.8+**: For the FastAPI backend.
- **Node.js 16+** and **npm**: For the React frontend.
- **uv**: Fast Python package manager. Install via [uv documentation](https://docs.astral.sh/uv/).
- **Gemini API Key**: Required for AI analysis (Flash 2.5 model). Get it from [Google AI Studio](https://aistudio.google.com/).
- **Firebase Service Account**: JSON key file for Firestore authentication.
- **HTTPS/Localhost**: The browser requires a secure context to access camera/microphone (mandatory for MediaRecorder).

### Backend Setup (Server)

The backend is built with **FastAPI** and handles:
- Token validation and session management
- Per-question video uploads via multipart/form-data
- Asynchronous AI analysis via Job Queue system (15s throttling, 70s auto-retry)
- Firestore integration for persistent storage

**Installation:**

```bash
# Navigate to server directory
cd server

# Create and activate virtual environment using uv
uv venv
source .venv/bin/activate          # On macOS/Linux
# or
.venv\Scripts\activate             # On Windows

# Install dependencies using uv sync
uv sync

# Create .env file with API credentials
cat > .env << EOF
GOOGLE_API_KEY=your_gemini_api_key_here
FIREBASE_ADMIN_KEY_PATH=./api/firebase-admin-key.json
EOF

# Place your Firebase service account key
# Copy your firebase-admin-key.json to ./server/api/

# Run the server (Default port: 8000)
python main.py
```

**Key Files:**
- `main.py` — FastAPI entry point with queue worker initialization
- `api/router.py` — API endpoints for token verification, uploads, session management
- `api/firebase_setup.py` — Firebase Admin SDK initialization
- `ai_service_v2.py` — Unified AI analysis (transcript + emotion + pace in 1 request)
- `job_queue.py` — Job queue with 15s throttling and 70s auto-retry delay
- `queue_worker.py` — Background worker for processing queued jobs

### Frontend Setup (Client)

The frontend is built with **React + Vite**, using `MediaRecorder` for video capture and Tailwind CSS for styling.

**Installation:**

```bash
# Navigate to client directory
cd client

# Install dependencies
npm install

# Create .env file (optional, if backend is not on localhost:8000)
echo "VITE_API_URL=http://localhost:8000" > .env.local

# Run the development server
npm run dev
```

The frontend will be available at `http://localhost:5173`.

**Key Features:**
- Live camera preview with MediaRecorder API
- Per-question recording with automatic upload after stop
- Real-time upload progress and error handling
- Admin dashboard for token generation and session review
- AI analysis display with emotion, pace, and transcript analysis

---

## 🧠 Bonus Features: AI Analysis & Processing

### Speech-to-Text (Transcription)

The system uses **Google Gemini Flash 2.5** for unified analysis in a single API call per question:

**Input & Output:**
```
Input:  [Video file] + [Question text]
Output: {
  "transcript": "Transcribed speech (Vietnamese supported with diacritics)",
  "match_score": 0-100,
  "feedback": "AI evaluation of response quality",
  "emotion": "confident|nervous|calm|stressed|neutral|...",
  "emotion_score": 0-100,
  "pace_wpm": 85-160,
  "pace_label": "slow|normal|fast"
}
```

**Features:**
- Accurate Vietnamese diacritic preservation
- Automatic silence and filler word filtering
- Context-aware transcription using question text

### AI Analysis Metrics

1. **Match Score (0-100)**
   - Evaluates how well the response addresses the question
   - Considers completeness, relevance, and clarity
   - Used for automated candidate screening

2. **Emotion Detection**
   - Labels: neutral, happy, stressed, confident, nervous, angry, calm, thoughtful, rushed, uncertain
   - Intensity score (0-100): measures emotion strength
   - Useful for soft skills and personality assessment

3. **Speaking Pace (WPM)**
   - **Words Per Minute**: 70-180 typical range
   - **Labels**: slow (<90 WPM), normal (90-150), fast (>150)
   - Indicates confidence, articulation clarity, and natural speech flow

### Frontend Integration

The review interface provides real-time AI feedback:

- **Loading State**: Shows "⏳ AI is analyzing content..." with spinner
- **Success State**: Displays transcript box, emotion card, pace card with metrics
- **Error State**: Shows "⚠️ Analysis Failed" with "Retry AI Analysis" button
- **Auto-Polling**: Refreshes status every 3 seconds while `status = "Processing..."`

The AI analysis results populate `meta.json` automatically and are accessible at `/uploads/{folderName}/` for download via the static file server.

---

### 📝 Admin Submit Human Scores 

**Purpose**: Record interviewer's evaluation scores and comments for each question after reviewing AI analysis.

**Request Body:**
```json
{
  "token": "session_uuid_string",
  "question_index": 0,
  "clarity": 8,
  "confidence": 7,
  "comment": "Good explanation with minor grammar issues. Could be more concise."
}
```

**Field Details:**
| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `token` | string | - | Session token from `/api/interviewer/create-session` |
| `question_index` | integer | 0-4 | Zero-based question index (Q1=0, Q2=1, ..., Q5=4) |
| `clarity` | integer | 1-10 | **Clarity & Structure Score** - How well-organized and understandable the response is |
| `confidence` | integer | 1-10 | **Confidence & Fluency Score** - Speaker's confidence level and articulation smoothness |
| `comment` | string | - | Detailed written feedback (e.g., strengths, areas for improvement, specific suggestions) |

**Response:**
```json
{
  "ok": true
}
```

**When to Submit:**
1. After admin views all AI analysis for a question (transcript, match score, emotion, pace)
2. After rating the response on clarity (1-10) and confidence (1-10)
3. After writing comments/feedback
4. Repeat for each question (Q1→Q2→Q3→Q4→Q5)

**Storage:**
- Scores are saved to Firestore under the session document
- Linked to the corresponding question index and video file
- Used for final interview report generation




