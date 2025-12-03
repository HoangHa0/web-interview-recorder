import os
import time
import json
import re  # Thêm thư viện regex để xử lý chuỗi
import google.generativeai as genai
from dotenv import load_dotenv
import logging

from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

# Cấu hình log
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 1. Load Config
load_dotenv()
api_key = os.getenv("GOOGLE_API_KEY")

if not api_key:
    print("❌ Error: GOOGLE_API_KEY not found in .env file")
else:
    genai.configure(api_key=api_key)

def clean_json_string(text):
    """
    Hàm phụ trợ: Làm sạch chuỗi JSON trả về từ AI.
    Loại bỏ markdown code blocks (```json ... ```) nếu có.
    """
    cleaned = text.strip()
    # Nếu bắt đầu bằng ```json hoặc ``` thì xóa dòng đầu và dòng cuối
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-z]*\n", "", cleaned, flags=re.MULTILINE)
        cleaned = re.sub(r"\n```$", "", cleaned, flags=re.MULTILINE)
    return cleaned.strip()

# --- 2. THÊM DECORATOR @retry NGAY TRÊN HÀM NÀY ---
@retry(
    stop=stop_after_attempt(3),      # Thử tối đa 3 lần
    wait=wait_exponential(multiplier=1, min=2, max=10), # Chờ tăng dần: 4s -> 8s -> 10s
    reraise=True                     # Nếu thất bại cả 3 lần, ném lỗi ra ngoài để ghi log
)

def process_interview_answer(video_path, question_index, output_folder, question_text, token, db):
    """
    Background Task:
    1. Upload Video to Gemini.
    2. Request Analysis (Transcript + Score + Feedback).
    3. Save to meta.json for Frontend.
    """
    print(f"🔄 [AI] Starting processing for Q{question_index + 1}...")

    try:
        # --- STEP 1: UPLOAD VIDEO TO GEMINI ---
        print(f"☁️ [AI] Uploading video: {os.path.basename(video_path)}")
        
        video_file = genai.upload_file(path=video_path)
        
        # Wait for processing
        while video_file.state.name == "PROCESSING":
            time.sleep(2)
            video_file = genai.get_file(video_file.name)

        if video_file.state.name == "FAILED":
            raise ValueError("Google AI failed to process this video file.")

        # --- STEP 2: SEND PROMPT ---
        print("🤖 [AI] Analyzing content (Transcript + Match Score + Feedback)...")
        
        # SỬ DỤNG MODEL BẠN MUỐN: gemini-2.5-flash
        model = genai.GenerativeModel("gemini-2.5-flash")
        
        # Prompt yêu cầu trả về JSON string
        prompt_text = f"""
        You are an expert Interview Recruiter.
        The candidate is answering the question: "{question_text}".

        Analyze the video audio and return a valid JSON object (Do not add any other text outside the JSON).
        The JSON must have exactly these 3 fields:
        
        1. "transcript": Transcribe the speech to text accurately. Remove excessive filler words. If the speaker says Vietnamese proper nouns (e.g., names of people or company names), preserve the original Vietnamese diacritics exactly as spoken. For example, “Phùng Khánh Linh” must be transcribed exactly with correct accents.
        2. "match_score": An integer (0-100). How well does the answer address the question "{question_text}"?
        3. "feedback": As an expert Interview Recruiter, provide a short, objective, constructive comment (2–3 sentences) evaluating the interviewee’s answer strictly from the interviewer’s perspective without offering any suggestions or guidance for interviewee's improvement.

        Format example:
        {{
            "transcript": "Hello I am...",
            "match_score": 85,
            "feedback": "Good answer but..."
        }}
        """
        
        # Call API
        response = model.generate_content([video_file, prompt_text])
        raw_text = response.text
        
        # --- XỬ LÝ KẾT QUẢ ---
        try:
            # Làm sạch chuỗi (phòng trường hợp AI trả về markdown)
            json_text = clean_json_string(raw_text)
            ai_data = json.loads(json_text)
            
            # Lấy dữ liệu
            transcript_text = ai_data.get("transcript", "")
            match_score = ai_data.get("match_score", 0)
            feedback = ai_data.get("feedback", "No feedback.")
            
        except json.JSONDecodeError:
            print(f"⚠️ [AI Warning] Could not parse JSON. Raw text: {raw_text}")
            # Rất quan trọng: BẠN PHẢI RAISE LỖI NÀY ĐỂ TENACITY THỬ LẠI
            raise Exception("AI failed to return valid JSON.")

        # Clean up cloud file
        try:
            video_file.delete()
        except:
            pass

        # --- STEP 3: SAVE TRANSCRIPT TO FILE (Backup) ---
        question_label = f"Q{question_index + 1}"
        transcript_filename = f"{question_label}_transcript.txt"
        transcript_path = os.path.join(output_folder, transcript_filename)
        
        # Ghi nội dung vào file txt backup
        content_to_write = (
            f"--- {question_label} ---\n"
            f"Question: {question_text}\n"
            f"Match Score: {match_score}/100\n"
            f"Feedback: {feedback}\n"
            f"--- Transcript ---\n{transcript_text}\n"
        )
        
        with open(transcript_path, "w", encoding="utf-8") as f:
            f.write(content_to_write)
            
        print(f"✅ [AI] Transcript saved to: {transcript_filename}")

        # --- STEP 4: UPDATE METADATA (Cập nhật UI) ---
        metadata_path = os.path.join(output_folder, 'meta.json')
        if os.path.exists(metadata_path):
            try:
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
            except UnicodeDecodeError as ude:
                print(f"[AI] meta.json UTF-8 decode failed: {ude}. Trying cp1252 fallback with replacement.")
                try:
                    with open(metadata_path, 'r', encoding='cp1252', errors='replace') as f:
                        content = f.read()
                    metadata = json.loads(content)
                except Exception as e2:
                    print(f"[AI] meta.json parse after fallback failed: {e2}. Using empty metadata object.")
                    metadata = {"receivedQuestions": {}, "videoSizeTotalMB": 0}
            
            # Cập nhật vào đúng vị trí câu hỏi
            if str(question_index) in metadata['receivedQuestions']:
                metadata['receivedQuestions'][str(question_index)].update({
                    'status': 'uploaded_transcribed',
                    'transcriptFile': transcript_filename,
                    
                    # CẬP NHẬT UI: Transcript, Score, Feedback
                    'transcript_text': transcript_text,
                    'ai_match_score': match_score,   # Điểm số (0-100)
                    'ai_feedback': feedback,         # Lời nhận xét
                    
                    'ai_done': True
                })
            
            try:
                with open(metadata_path, 'w', encoding='utf-8') as f:
                    json.dump(metadata, f, indent=4, ensure_ascii=False)
            except Exception as write_err:
                print(f"[AI] Failed to write meta.json (utf-8): {write_err}. Trying cp1252 fallback.")
                try:
                    with open(metadata_path, 'w', encoding='cp1252', errors='replace') as f:
                        json.dump(metadata, f, indent=4)
                except Exception:
                    print("[AI] Final fallback failed while writing meta.json. Metadata not persisted to disk.")

        # Update Firestore (Optional)
        if db:
             db.collection("sessions").document(token).update({
                f'q{question_index+1}_ai_status': 'done',
                f'q{question_index+1}_transcript': transcript_text,
                f'q{question_index+1}_score': match_score
            })
            
        print(f"🎉 [AI] Successfully processed Q{question_index + 1}")
        return True

    # --- THÊM ĐOẠN NÀY VÀO CUỐI HÀM ---
    except Exception as e:
        print(f"⚠️ [AI Process Error] An error occurred in the main process: {e}")
        # Quan trọng: Ném lỗi ra để @retry bắt được và thử lại
        raise e

def safe_process_interview_answer(video_path, question_index, output_folder, question_text, token, db):
    """
    Hàm Wrapper: Gọi hàm AI có Retry.
    Chỉ bắt lỗi và ghi vào meta.json sau khi Tenacity đã thất bại 3 lần.
    """
    try:
        # Gọi hàm AI chính
        process_interview_answer(video_path, question_index, output_folder, question_text, token, db)
        
    except Exception as e:
        # Lỗi này chỉ xảy ra khi Tenacity đã thử lại 3 lần và thất bại hoàn toàn
        # Bây giờ, khối Error Handling của bạn sẽ chạy
        print(f"❌ [AI FINAL FAILURE] Q{question_index + 1} failed after 3 attempts: {e}")
        
        # --- BẮT ĐẦU KHỐI GHI LỖI CUỐI CÙNG CỦA BẠN VÀO meta.json ---
        try:
            metadata_path = os.path.join(output_folder, 'meta.json')
            if os.path.exists(metadata_path):
                # Đọc metadata
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)

                # Cập nhật status thành lỗi
                str_idx = str(question_index)
                if str_idx in metadata.get('receivedQuestions', {}):
                    metadata['receivedQuestions'][str_idx]['status'] = 'ai_error'
                    metadata['receivedQuestions'][str_idx]['ai_done'] = False
                    metadata['receivedQuestions'][str_idx]['transcript_text'] = f"AI Analysis Failed: {e}" # Ghi rõ lỗi
                
                # Ghi file lại
                with open(metadata_path, 'w', encoding='utf-8') as f:
                    json.dump(metadata, f, indent=4, ensure_ascii=False)
                    
        except Exception as write_err:
            # Bắt lỗi ghi lỗi và bỏ qua
            print(f"Critial: Could not write error status to meta.json: {write_err}")
        