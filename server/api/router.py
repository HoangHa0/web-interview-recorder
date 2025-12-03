import pytz
from unidecode import unidecode
from datetime import datetime
from typing import Dict, Any, List, Optional
from fastapi import APIRouter, HTTPException, status, Form, File, UploadFile, BackgroundTasks
from pydantic import BaseModel, Field
import os # For file system operations
import json # For handling metadata files
import time # For simulating processing time (keep for sync fallbacks)
import asyncio # Use asyncio.sleep in async helpers

from server.api.firebase_setup import get_firestore_client
# 🎯 BƯỚC 1: Mở rộng Import Models
from server.api.models import (
    TokenVerificationRequest,
    InterviewerCreateSessionRequest
)

import uuid # For generating unique IDs

from server.ai_service import safe_process_interview_answer
# --- CONFIGURATION ---
# Mandatory timezone setup for folder naming (Asia/Bangkok)
ASIA_BANGKOK = pytz.timezone('Asia/Bangkok')
# Base directory where all session videos will be stored
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'uploads')

# Initialize the main router for all API endpoints
api_router = APIRouter(
    prefix="/api",
    tags=["API Core", "Network Reliability", "AI Processing"]
)


# --- RESPONSE MODELS ---
class OkResponse(BaseModel):
    ok: bool = True

class SessionFolderResponse(BaseModel):
    ok: bool = True
    folder: str = Field(..., description="The unique server folder name: DD_MM_YYYY_HH_mm_ten_user")
    session_id: str = Field(..., description="The UUID for this specific session.")

class SessionCreationResponse(BaseModel):
    ok: bool = True
    token: str = Field(..., description="Generated session token")
    session_url: str = Field(..., description="URL the interviewer can share to join the session")

class RetryRequest(BaseModel):
    """
    Schema for the AI processing retry request (Manual Retry Button).
    """
    token: str = Field(..., description="Session token used to identify the session.")
    folder: str = Field(..., description="The video storage folder name.")
    questionIndex: int = Field(..., description="The 0-based index of the question to retry.")
    questionText: Optional[str] = Field(None, description="The question text, reused in the AI prompt.")

# --- 1. POST /api/verify-token (MANDATORY SERVER VALIDATION) ---

@api_router.post("/verify-token", response_model=OkResponse, status_code=status.HTTP_200_OK)
async def verify_token(request: TokenVerificationRequest):
    """
    Verifies the existence and validity of the interviewee's token and name in Firestore.
    A valid token must match a 'pending' session document.
    """
    db = get_firestore_client()
    if not db:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database connection error.")

    try:
        token = request.token.strip()
        user_name = request.user_name.strip()
        
        print(f"[verify_token] Looking up token: {token}, user_name: {user_name}")
        session_doc_ref = db.collection("sessions").document(token)
        session_data = session_doc_ref.get()

        if not session_data.exists:
            # Mandatory check: Token not found
            print(f"[verify_token] Token '{token}' not found in Firestore.")
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.")

        session = session_data.to_dict()
        
        if session.get('status') != 'pending':
            # Check if the session is still available
            print(f"[verify_token] Session status is '{session.get('status')}', not 'pending'.")
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Session is already completed or inactive.")
            
        if session.get('interviewee_name').lower() != user_name.lower():
            # Mandatory check: Name must match the record tied to the token
            print(f"[verify_token] Name mismatch: stored='{session.get('interviewee_name')}', provided='{user_name}'")
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token valid, but name mismatch. Check spelling.")

        return OkResponse(ok=True)

    except HTTPException:
        raise
    except Exception as e:
        print(f"Error during token verification: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Server error during verification.")

# --- Helper Function for Folder Naming ---

def sanitize_name_for_filesystem(name: str) -> str:
    """Sanitizes a name into the 'ten_user' part of the folder name."""
    # 1. Transliterate (e.g., convert 'á' to 'a') using unidecode
    sanitized = unidecode(name)
    # 2. Replace spaces with underscores, and convert to lowercase
    sanitized = sanitized.strip().lower().replace(" ", "_")
    # 3. Remove non-alphanumeric characters (keeping only letters, numbers, and underscores)
    sanitized = ''.join(c for c in sanitized if c.isalnum() or c == '_')
    return sanitized

# --- 2. POST /api/session/start (MANDATORY FOLDER CREATION) ---

@api_router.post("/session/start", response_model=SessionFolderResponse, status_code=status.HTTP_200_OK)
async def session_start(request: TokenVerificationRequest):
    """
    Starts the interview session, generates the mandatory folder name (DD_MM_YYYY_HH_mm_ten_user/), 
    and updates the session status in Firestore.
    """
    db = get_firestore_client()
    if not db:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database connection error.")

    token = request.token.strip()
    user_name = request.user_name.strip()
    session_doc_ref = db.collection("sessions").document(token)
    
    # Check if the token is valid, pending, and the name matches
    session_data = session_doc_ref.get()
    if not session_data.exists or session_data.to_dict().get('status') != 'pending' or session_data.to_dict().get('interviewee_name').lower() != user_name.lower():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token validation failed. Cannot start session.")

    # 1. Generate the mandatory folder name components
    now_bangkok = datetime.now(ASIA_BANGKOK)
    # Format: DD_MM_YYYY_HH_mm
    timestamp_str = now_bangkok.strftime("%d_%m_%Y_%H_%M")
    
    sanitized_user_name = sanitize_name_for_filesystem(user_name)
    
    # Construct the folder path: DD_MM_YYYY_HH_mm_ten_user/
    folder_name = f"{timestamp_str}_{sanitized_user_name}" 
    
    # 2. Update the Firestore document
    try:
        session_id = str(uuid.uuid4())
        
        # Initial metadata structure (will be saved as meta.json later)
        initial_metadata_data = {
            "session_id": session_id,
            "userName": user_name,
            "token": token,
            "folderName": folder_name,
            "uploadedAt": now_bangkok.isoformat(), # ISO 8601 timestamp
            "timeZone": str(ASIA_BANGKOK),
            "status": "active",
            "receivedQuestions": {}, # Key=QIndex, Value=filename/status
            "questionsSelected": [] # To be populated by the client
        }
        
        # Update session status, folder name, and store initial metadata
        session_doc_ref.update({
            "status": "active",
            "folder_name": folder_name,
            "start_time": now_bangkok.isoformat(),
            "metadata_initial": initial_metadata_data
        })
        
    except Exception as e:
        print(f"Error updating session status in Firestore: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to finalize session start.")

    # 3. Return the generated folder name (Network requirement)
    # Ensure uploads base directory exists and create the session folder with initial meta.json
    try:
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        full_folder_path = os.path.join(UPLOAD_DIR, folder_name)
        os.makedirs(full_folder_path, exist_ok=True)

        # Prepare initial metadata to be stored locally as meta.json
        metadata_file_path = os.path.join(full_folder_path, 'meta.json')
        file_metadata = initial_metadata_data.copy()
        # Add total size and status fields expected by upload endpoint
        file_metadata['videoSizeTotalMB'] = 0.0
        file_metadata['status'] = 'active'

        with open(metadata_file_path, 'w', encoding='utf-8') as f:
            json.dump(file_metadata, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"Failed to create session folder or write metadata: {e}")
        # Do not block the creation of a session for disk errors, but log them

    return SessionFolderResponse(ok=True, folder=folder_name, session_id=session_id)

# --- 3. POST /api/upload-one (MANDATORY PER-QUESTION UPLOAD) ---

@api_router.post("/upload-one", status_code=status.HTTP_200_OK)
async def upload_one(
    background_tasks: BackgroundTasks,
    token: str = Form(...),
    folder: str = Form(...),
    questionIndex: int = Form(...),
    questionText: str = Form(None), 
    video: UploadFile = File(...)
):
    """
    Handles the mandatory per-question video upload using multipart/form-data.
    Saves the video file and updates the session metadata.
    """
    db = get_firestore_client()
    if not db:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database connection error.")

    # 1. Validate mandatory fields
    if not folder or questionIndex is None or not token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing required form fields (token, folder, index).")

    # 2. Define file paths and name
    full_folder_path = os.path.join(UPLOAD_DIR, folder)
    file_name = f"Q{questionIndex + 1}.webm"
    full_file_path = os.path.join(full_folder_path, file_name)
    
    # 3. Security and integrity checks
    if not os.path.isdir(full_folder_path):
        # This checks if the folder generated by session/start exists
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session folder not found. Start session first.")
    
    if video.content_type not in ["video/webm", "video/ogg"]:
         raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=f"Unsupported file type: {video.content_type}. Only video/webm accepted.")

    # 4. Save the file to the local disk (Network I/O)
    try:
        file_content = await video.read()
        file_size_bytes = len(file_content)
        
        # Save the content to the file path
        with open(full_file_path, "wb") as f:
            f.write(file_content)
            
        print(f"Successfully saved file: {full_file_path}")
        
    except Exception as e:
        print(f"File write error: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to save video file on server.")
       
    # 5. Prepare Data for AI (Logic lấy Text câu hỏi)
    # --- GIỮ NGUYÊN LOGIC CỦA BẠN NHƯNG GỌN GÀNG HƠN ĐỂ LẤY BIẾN question_text ---
    question_label = f"Q{questionIndex + 1}"
    question_text = None

    # Priority 1: Client provided text
    if questionText and str(questionText).strip():
        question_text = str(questionText).strip()
        print(f"[upload-one] Using client-provided text for {question_label}")
    else:
        # Priority 2: Firestore lookup (Giữ nguyên logic cũ của bạn)
        try:
            session_doc = db.collection('sessions').document(token).get()
            if session_doc.exists:
                sdata = session_doc.to_dict()
                qs = sdata.get('questionsSelected') or sdata.get('metadata_initial', {}).get('questionsSelected')
                if isinstance(qs, list) and len(qs) > int(questionIndex):
                    candidate = qs[int(questionIndex)]
                    if isinstance(candidate, dict):
                        question_text = candidate.get('text') or candidate.get('question') or str(candidate)
                    else:
                        question_text = str(candidate)
                    print(f"[upload-one] Found text in Firestore for {question_label}")
        except Exception as e:
            print(f"[upload-one] Firestore lookup error: {e}")

    # Fallback if nothing found
    if not question_text:
        question_text = "Unknown Question"

    # 6. Update Metadata (INITIAL STATUS)
    # Thay vì lưu kết quả ngay, ta lưu trạng thái "Đang xử lý" (Processing)
    metadata_update_status = 'uploaded_processing_ai' # <--- TRẠNG THÁI MỚI
    
    try:
        metadata_file_path = os.path.join(full_folder_path, 'meta.json')
        
        # Load or Init Metadata
        if os.path.exists(metadata_file_path):
            # Try UTF-8 first (the expected format). On Windows, some editors may
            # have written the file with a local code page (cp1252 / 'charmap')
            # which can raise a UnicodeDecodeError. Attempt a graceful fallback
            # — read using 'utf-8' and if that fails, try 'cp1252' and replace
            # invalid characters to avoid crashing the upload path.
            try:
                with open(metadata_file_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
            except UnicodeDecodeError as ude:
                print(f"[upload-one] meta.json UTF-8 decode failed: {ude}. Trying cp1252 fallback with replacement.")
                try:
                    with open(metadata_file_path, 'r', encoding='cp1252', errors='replace') as f:
                        content = f.read()
                    metadata = json.loads(content)
                except Exception as e2:
                    # If parsing still fails, start with a sensible default so we don't block the upload
                    print(f"[upload-one] meta.json parse after fallback failed: {e2}. Using empty metadata object.")
                    metadata = {"receivedQuestions": {}, "videoSizeTotalMB": 0}
        else:
            metadata = {"receivedQuestions": {}, "videoSizeTotalMB": 0}
        
        # Update entry
        metadata['receivedQuestions'][str(questionIndex)] = {
            'filename': file_name,
            'status': metadata_update_status,
            'transcript_text': "Processing...", # Frontend sẽ hiện chữ này trong khi chờ
            'transcriptFile': None,
            'sizeMB': round(file_size_bytes / (1024 * 1024), 2),
            'uploadedAt': datetime.now(pytz.utc).isoformat()
        }
        
        # Recalculate total size
        total_size = sum(item['sizeMB'] for item in metadata['receivedQuestions'].values())
        metadata['videoSizeTotalMB'] = total_size
        
        # Write to disk using UTF-8 and ensure_ascii=False so that unicode is preserved.
        try:
            with open(metadata_file_path, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=4, ensure_ascii=False)
        except Exception as write_err:
            # If writing fails for some reason, log it but continue processing to avoid blocking the upload flow
            print(f"[upload-one] Failed to write meta.json (utf-8): {write_err}")
            # Try a safe fallback write using 'cp1252' with replacements to at least persist something readable on Windows
            try:
                with open(metadata_file_path, 'w', encoding='cp1252', errors='replace') as f:
                    json.dump(metadata, f, indent=4)
                print("[upload-one] Wrote meta.json using cp1252 fallback with replacement.")
            except Exception:
                # Final fallback: we can't do much; the folder exists and the file might be unreadable.
                print("[upload-one] Final fallback failed while writing meta.json. Metadata not persisted to disk.")

        # Update Firestore (Optional - Dashboard Status)
        # db.collection("sessions").document(token).update({
        #    'status': f'q{questionIndex+1}_{metadata_update_status}',
        #    'total_size_mb': total_size
        # })
        
    except Exception as e:
        print(f"Metadata update error: {e}")

    # 7. TRIGGER BACKGROUND TASK (Phần quan trọng nhất)
    # Server trả về OK ngay lập tức, AI chạy ngầm bên dưới
    background_tasks.add_task(
        safe_process_interview_answer,   # Hàm import từ ai_service.py
        video_path=full_file_path,
        question_index=questionIndex,
        output_folder=full_folder_path,
        question_text=question_text, # Biến ta đã xử lý ở bước 5
        token=token,
        db=db
    )

    # 8. Success Response
    return {
        "ok": True, 
        "savedAs": file_name,
        "message": "Upload successful. AI analysis running in background."
    }

# --- 4. POST /api/retry-processing (MANUAL RETRY BUTTON) ---
@api_router.post("/retry-processing", status_code=status.HTTP_200_OK)
async def retry_processing(
    req: RetryRequest, # Sử dụng Pydantic Model đã import
    background_tasks: BackgroundTasks):
    """
    Endpoint dành cho nút 'Retry' ở Frontend.
    Không upload file lại, chỉ chạy lại logic AI trên file đã tồn tại.
    """
    db = get_firestore_client()
    
    # 1. Tái tạo đường dẫn file
    full_folder_path = os.path.join(UPLOAD_DIR, req.folder)
    file_name = f"Q{req.questionIndex + 1}.webm"
    full_file_path = os.path.join(full_folder_path, file_name)

    # 2. Kiểm tra file có tồn tại không
    if not os.path.exists(full_file_path):
        raise HTTPException(status_code=404, detail="Original video file not found. Please re-upload.")

    # 3. Cập nhật lại trạng thái Metadata thành 'processing' để UI hiện spinner
    metadata_path = os.path.join(full_folder_path, 'meta.json')
    try:
        if os.path.exists(metadata_path):
            # Cần xử lý lỗi Unicode Decode như bạn đã làm ở các hàm khác
            try:
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
            except Exception:
                # Dùng logic fallback đơn giản hơn nếu không thể đọc
                print("[Retry] Warning: Metadata read failed. Using empty dict.")
                metadata = {"receivedQuestions": {}, "videoSizeTotalMB": 0}
            
            # Update status
            str_idx = str(req.questionIndex)
            if str_idx in metadata['receivedQuestions']:
                # TRẠNG THÁI MỚI CHO VIỆC RETRY
                metadata['receivedQuestions'][str_idx]['status'] = 'retrying_processing_ai' 
                metadata['receivedQuestions'][str_idx]['transcript_text'] = "Retrying AI analysis..."
                # Xóa kết quả cũ nếu có (để Frontend biết là AI chưa xong)
                metadata['receivedQuestions'][str_idx]['ai_done'] = False
                metadata['receivedQuestions'][str_idx]['ai_match_score'] = 0
                metadata['receivedQuestions'][str_idx]['ai_feedback'] = "Processing..."
            
            # Ghi file với utf-8
            with open(metadata_path, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"[Retry] Warning: Could not update metadata: {e}")

    # 4. Trigger Background Task (Gọi lại hàm AI đã có logic auto-retry)
    q_text = req.questionText
    if not q_text:
        q_text = "Unknown Question (Retry)" # Fallback text

    background_tasks.add_task(
        safe_process_interview_answer, # <--- GỌI HÀM WRAPPER ĐÃ CÓ RETRY VÀ XỬ LÝ LỖI CUỐI CÙNG
        video_path=full_file_path,
        question_index=req.questionIndex,
        output_folder=full_folder_path,
        question_text=q_text,
        token=req.token,
        db=db
    )

    return {"ok": True, "message": "Manual retry initiated."}

# --- 5. POST /api/session/finish ---

@api_router.post("/session/finish", response_model=OkResponse, status_code=status.HTTP_200_OK)
async def session_finish(
    token: str = Form(...),
    folder: str = Form(...),
    questionsCount: int = Form(...),
):
    """
    Closes the session, marks the status as complete in Firestore, and locks the metadata file.
    """
    db = get_firestore_client()
    if not db:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database connection error.")

    try:
        # Update Firestore status
        db.collection("sessions").document(token).update({
            'status': 'complete',
            'questions_answered': questionsCount,
            'end_time': datetime.now(ASIA_BANGKOK).isoformat()
        })
        
        # Update local metadata file to mark the final status (optional but good practice)
        full_folder_path = os.path.join(UPLOAD_DIR, folder)
        metadata_file_path = os.path.join(full_folder_path, 'meta.json')
        
        if os.path.exists(metadata_file_path):
            # Đọc (read - 'r') CẦN THÊM encoding='utf-8'
            with open(metadata_file_path, 'r', encoding='utf-8') as f:
                metadata = json.load(f)
            
            metadata['status'] = 'complete'
            
            # Ghi (write - 'w') CẦN THÊM encoding='utf-8' và ensure_ascii=False
            with open(metadata_file_path, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=4, ensure_ascii=False)
        
        return OkResponse(ok=True)
    except Exception as e:
        print(f"Error finalizing session: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to finalize session.")

# --- 5. POST /api/interviewer/create-session (TOKEN GENERATION) ---

@api_router.post("/interviewer/create-session", response_model=SessionCreationResponse, status_code=status.HTTP_201_CREATED)
async def create_new_session(request: InterviewerCreateSessionRequest):
    """
    Interviewer function to create a new session, generating a unique token and setting 
    the status to 'pending'. This data is used by the Interviewee to log in.
    """
    db = get_firestore_client()
    if not db:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database connection error.")
        
    # Generate a unique, short, human-readable token (e.g., 8 alphanumeric chars)
    # For robust security, UUID4 is better, but a simple 8-digit code can be used for ease of use.
    # We will use the first 8 characters of a UUID for simplicity and uniqueness.
    token = str(uuid.uuid4())[:8].upper()
    now_utc = datetime.utcnow().isoformat()
    
    new_session_data = {
        "interviewee_name": request.interviewee_name.strip(),
        "interviewer_id": request.interviewer_id,
        "status": "pending", # Must be 'pending' for the interviewee to verify
        "created_at": now_utc,
        "token": token,
    }
    
    try:
        # Save the new session using the generated token as the document ID
        db.collection("sessions").document(token).set(new_session_data)
        
        # Construct the URL the interviewer would share
        session_url = f"http://localhost:3000/interviewee?token={token}&name={request.interviewee_name.replace(' ', '%20')}"
        
        return SessionCreationResponse(
            ok=True, 
            token=token, 
            session_url=session_url
        )

    except Exception as e:
        print(f"Error creating session: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to create new interview session.")

# --- Test Endpoint (Existing) ---
@api_router.get("/status")
async def get_api_status():
    """Confirms the API router is active."""
    return {"status": "ok", "service": "Interview Recorder Backend", "version": "1.0"}