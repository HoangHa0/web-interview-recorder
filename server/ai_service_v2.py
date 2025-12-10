"""
AI Analysis Service with Queue Integration
- Unified speech-to-text + analysis + emotion + pace in single API call
- Queue-based processing with 15s throttling
- Auto-retry with 70s delay
"""
import os
import time
import json
import re
import google.generativeai as genai
from dotenv import load_dotenv
import logging

from tenacity import (
    retry, 
    stop_after_attempt, 
    stop_after_delay,
    wait_random_exponential,
    retry_if_exception_type
)
from google.api_core.exceptions import ResourceExhausted, ServiceUnavailable, InternalServerError

from server.job_queue import analysis_queue

# Configuration
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()
api_key = os.getenv("GOOGLE_API_KEY")

if not api_key:
    logger.error("❌ GOOGLE_API_KEY not found in .env file")
else:
    genai.configure(api_key=api_key)


def clean_json_string(text):
    """Clean JSON string by removing markdown code blocks"""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-z]*\n", "", cleaned, flags=re.MULTILINE)
        cleaned = re.sub(r"\n```$", "", cleaned, flags=re.MULTILINE)
    return cleaned.strip()


# --- UNIFIED AI ANALYSIS WITH BASIC RETRY (Let queue handle auto-retry logic) ---
@retry(
    retry=retry_if_exception_type((
        ResourceExhausted,
        ServiceUnavailable,
        InternalServerError,
        json.JSONDecodeError,
        ConnectionError,
        OSError
    )),
    wait=wait_random_exponential(multiplier=2, min=4, max=64), 
    stop=stop_after_attempt(1),  # Only 1 attempt, let queue handle retries with 70s delay
    reraise=True 
)
def analyze_video_with_gemini(video_path: str, question_text: str, duration_seconds: int = 0) -> dict:
    """
    Unified API call: ONE request gets transcript + score + emotion + pace.
    
    Returns dict with transcript, match_score, feedback, emotion, emotion_score, pace_wpm, pace_label.
    """
    logger.info(f"[AI] Starting unified analysis for: {os.path.basename(video_path)}")
    
    raw_response = ""
    
    try:
        # STEP 1: UPLOAD VIDEO
        logger.info(f"[AI] Uploading video...")
        video_file = genai.upload_file(path=video_path)
        
        while video_file.state.name == "PROCESSING":
            time.sleep(1)
            video_file = genai.get_file(video_file.name)
        
        if video_file.state.name == "FAILED":
            raise ResourceExhausted("Google API failed to process video file")
        
        # STEP 2: SEND UNIFIED PROMPT
        logger.info("[AI] Analyzing (Transcript + Score + Emotion)...")
        
        model = genai.GenerativeModel("gemini-2.5-flash")
        
        prompt_text = f"""CRITICAL: You are a TRANSCRIBER ONLY. Your ONLY job is to transcribe audio word-for-word.
You MUST NEVER hallucinate, invent, guess, or generate text that is NOT in the audio.

### STEP 0: AUDIO CONTENT DETECTION (DO THIS FIRST)
Before you do anything else, analyze the audio:
- Is there clear human speech in the audio? (NOT just background noise, music, static, or silence)
- Can you hear the candidate SPEAKING WORDS?

If NO clear speech detected → Return EXACTLY: {{"transcript": "", "match_score": 0, "feedback": "No audible speech.", "emotion": "silent", "emotion_score": 0}}
STOP. Return this NOW. Do NOT continue to Step 1.

### STEP 1: TRANSCRIBE ONLY WHAT YOU HEAR (Anti-Hallucination Protocol)
If speech is detected, transcribe word-for-word.
- Write ONLY the words you hear in the audio.
- NEVER add context, explanation, elaboration, or complete sentences.
- NEVER try to "improve" or "fix" what you hear.
- If the audio is unclear, write only the parts you can clearly understand.
- If the candidate says "Subset", write ONLY "Subset" - NOT "Subset is a part of data..."
- If the audio is 0-2 seconds long, transcribe only those few words (if any).
- Remove filler words like: "uh", "um",...
- Preserve Vietnamese diacritics/proper nouns exactly as spoken.

FORBIDDEN:
❌ Do NOT generate full sentences from keywords.
❌ Do NOT complete thoughts that weren't finished.
❌ Do NOT add examples that weren't mentioned.
❌ Do NOT explain what the candidate meant - transcribe what they said.

EXAMPLE OF INCORRECT BEHAVIOR (DO NOT DO THIS):
Audio: (1 second of background noise, unclear voice says "Kinh tế")
WRONG: "Dạ em chào anh, em là Hạnh. Em tốt nghiệp ngành Kinh tế..." (This is HALLUCINATION)
CORRECT: "" (empty if you can't hear anything)

### STEP 2: MATCH SCORE (0-100)
How well addresses: "{question_text}"
* CRITERIA:
    * Score STRICTLY. Do not be generous.
    * 90-100: Exceptional, deep, structured, shows critical thinking and specific examples.
    * 75-89: Correct but "shallow", generic, lacks specific examples, or phrasing is slightly unprofessional.
    * < 75: Irrelevant, incorrect, extremely short (e.g., one word), or fails to address all parts of the question.

### STEP 3: AI Feedback: string (2-3 sentences).
* PERSPECTIVE: Write this for the HIRING MANAGER, not the candidate.
* DO NOT use phrases like "To improve", "You should", or "The candidate should".
* EVALUATE:
    1. Depth of thought & Technical mindset (Is the answer too surface-level for a Data professional?).
    2. Clarity & Structure (Is the answer logical and professional?).
    3. Completeness (Did they address the "Why", "How", and all parts of the prompt?).
* CRITIQUE: If the answer is generic (e.g., "because it's sensitive") without explaining the implications/policy, note that it lacks depth.


### STEP 4: EMOTION
One label: neutral, happy, stressed, confident, nervous, angry, calm, thoughtful, rushed, uncertain

### JSON RESPONSE (REQUIRED):
{{"transcript": "<words only>", "match_score": <0-100>, "feedback": "<2-3 AI Feedback sentences>", "emotion": "<label>", "emotion_score": <0-100>}}
"""
        
        response = model.generate_content([video_file, prompt_text])
        raw_response = response.text
        logger.info(f"[AI] Response: {raw_response[:400]}")
        
        # STEP 3: PARSE JSON
        json_text = clean_json_string(raw_response)
        ai_data = json.loads(json_text)
        
        # Extract fields
        transcript = ai_data.get("transcript", "").strip()
        match_score = max(0, min(100, int(ai_data.get("match_score", 0))))
        feedback = ai_data.get("feedback", "No feedback.")
        emotion = ai_data.get("emotion", "neutral").lower()
        emotion_score = max(0, min(100, int(ai_data.get("emotion_score", 0))))
        
        # STEP 4: CALCULATE PACE
        words = transcript.split() if transcript else []
        word_count = len(words)
        
        if duration_seconds and duration_seconds > 0:
            actual_duration = max(1, int(duration_seconds))
        else:
            actual_duration = max(1, int((word_count / 140.0) * 60.0)) if word_count > 0 else 1
        
        wpm = int((word_count / actual_duration) * 60) if actual_duration > 0 else 0
        pace_label = "slow" if wpm < 90 else ("normal" if wpm <= 150 else "fast")
        
        logger.info(f"[AI] ✅ {wpm}WPM, {emotion}, score={match_score}")
        
        # Cleanup
        try:
            video_file.delete()
        except:
            pass
        
        return {
            "transcript": transcript,
            "match_score": match_score,
            "feedback": feedback,
            "emotion": emotion,
            "emotion_score": emotion_score,
            "pace_wpm": wpm,
            "pace_label": pace_label,
            "duration_seconds": actual_duration,
            "raw_response": raw_response
        }
        
    except json.JSONDecodeError as e:
        logger.error(f"[AI] JSON error: {raw_response[:400]}")
        raise
    except Exception as e:
        logger.error(f"[AI] Failed: {e}")
        raise


def process_job_from_queue(job):
    """Process job from queue: Upload video, analyze, save results."""
    try:
        logger.info(f"[Queue] Processing: {job.job_id}")
        analysis_queue.mark_processing(job)
        
        # Get duration from meta.json
        duration_seconds = 0
        try:
            metadata_path = os.path.join(job.folder, 'meta.json')
            if os.path.exists(metadata_path):
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                str_idx = str(job.question_index)
                if str_idx in metadata.get('receivedQuestions', {}):
                    duration_seconds = metadata['receivedQuestions'][str_idx].get('durationSeconds', 0) or 0
        except Exception as e:
            logger.warning(f"[Queue] Could not read duration: {e}")
        
        # Call Gemini API
        result = analyze_video_with_gemini(
            video_path=job.video_path,
            question_text=job.question_text,
            duration_seconds=duration_seconds
        )
        
        # UPDATE meta.json
        try:
            metadata_path = os.path.join(job.folder, 'meta.json')
            if os.path.exists(metadata_path):
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                
                str_idx = str(job.question_index)
                if str_idx in metadata.get('receivedQuestions', {}):
                    metadata['receivedQuestions'][str_idx].update({
                        'status': 'done',
                        'ai_done': True,
                        'transcript_text': result['transcript'],
                        'ai_match_score': result['match_score'],
                        'ai_feedback': result['feedback'],
                        'emotion': result['emotion'],
                        'emotion_score': result['emotion_score'],
                        'pace_wpm': result['pace_wpm'],
                        'pace_label': result['pace_label']
                    })
                
                with open(metadata_path, 'w', encoding='utf-8') as f:
                    json.dump(metadata, f, indent=4, ensure_ascii=False)
                logger.info(f"[Queue] ✅ meta.json updated for Q{job.question_index + 1}")
                
                # --- NEW: CREATE Q_TRANSCRIPT.TXT FILE ---
                try:
                    q_num = job.question_index + 1
                    transcript_file_path = os.path.join(job.folder, f'Q{q_num}_transcript.txt')
                    
                    # Format transcript file content
                    transcript_content = f"""--- Q{q_num} ---
Question: {job.question_text}
Match Score: {result['match_score']}/100
Feedback: {result['feedback']}
--- Transcript ---
{result['transcript']}
"""
                    
                    with open(transcript_file_path, 'w', encoding='utf-8') as f:
                        f.write(transcript_content)
                    
                    logger.info(f"[Queue] ✅ Q{q_num}_transcript.txt created")
                except Exception as e:
                    logger.error(f"[Queue] Error creating transcript file: {e}")
        except Exception as e:
            logger.error(f"[Queue] Error updating meta.json: {e}")
        
        # UPDATE FIRESTORE
        try:
            if job.token and job.token != "session_token_placeholder":
                from server.api.firebase_setup import get_firestore_client
                db = get_firestore_client()
                
                if db:
                    session_ref = db.collection("sessions").document(job.token)
                    session_doc = session_ref.get()
                    
                    if not session_doc.exists:
                        logger.warning(f"[Queue] Session {job.token} doesn't exist, skipping Firestore")
                    else:
                        session_ref.update({
                            f'q{job.question_index + 1}_ai_status': 'done',
                            f'q{job.question_index + 1}_ai_transcript': result['transcript'],
                            f'q{job.question_index + 1}_ai_score': result['match_score'],
                            f'q{job.question_index + 1}_ai_feedback': result['feedback'],
                            f'q{job.question_index + 1}_emotion': result['emotion'],
                            f'q{job.question_index + 1}_emotion_score': result['emotion_score'],
                            f'q{job.question_index + 1}_pace_wpm': result['pace_wpm'],
                            f'q{job.question_index + 1}_pace_label': result['pace_label']
                        })
                        logger.info(f"[Queue] ✅ Firestore updated for Q{job.question_index + 1}")
        except Exception as e:
            logger.warning(f"[Queue] Firestore error (token={job.token}): {e}")
        
        analysis_queue.mark_success(job, result)
        logger.info(f"✅ [Queue] Job {job.job_id} SUCCESS")
        
    except Exception as e:
        error_msg = str(e)
        logger.error(f"❌ [Queue] Job {job.job_id} FAILED: {error_msg}")
        analysis_queue.mark_failed(job, error_msg)


def safe_process_interview_answer(video_path, question_index, output_folder, 
                                  question_text, token, db):
    """Legacy: Direct processing without queue."""
    try:
        logger.info(f"[Legacy] Processing Q{question_index + 1} directly")
        
        # Get duration
        duration_seconds = 0
        try:
            metadata_path = os.path.join(output_folder, 'meta.json')
            if os.path.exists(metadata_path):
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                str_idx = str(question_index)
                if str_idx in metadata.get('receivedQuestions', {}):
                    duration_seconds = metadata['receivedQuestions'][str_idx].get('durationSeconds', 0) or 0
        except Exception as e:
            logger.warning(f"[Legacy] Could not read duration: {e}")
        
        # Analyze
        result = analyze_video_with_gemini(
            video_path=video_path,
            question_text=question_text,
            duration_seconds=duration_seconds
        )
        
        # Update meta.json
        metadata_path = os.path.join(output_folder, 'meta.json')
        if os.path.exists(metadata_path):
            with open(metadata_path, 'r', encoding='utf-8') as f:
                metadata = json.load(f)
            
            str_idx = str(question_index)
            if str_idx in metadata.get('receivedQuestions', {}):
                metadata['receivedQuestions'][str_idx].update({
                    'status': 'done',
                    'ai_done': True,
                    'transcript_text': result['transcript'],
                    'ai_match_score': result['match_score'],
                    'ai_feedback': result['feedback'],
                    'emotion': result['emotion'],
                    'emotion_score': result['emotion_score'],
                    'pace_wpm': result['pace_wpm'],
                    'pace_label': result['pace_label']
                })
            
            with open(metadata_path, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=4, ensure_ascii=False)
            
            # --- NEW: CREATE Q_TRANSCRIPT.TXT FILE ---
            try:
                q_num = question_index + 1
                transcript_file_path = os.path.join(output_folder, f'Q{q_num}_transcript.txt')
                
                # Format transcript file content
                transcript_content = f"""--- Q{q_num} ---
Question: {question_text}
Match Score: {result['match_score']}/100
Feedback: {result['feedback']}
--- Transcript ---
{result['transcript']}
"""
                
                with open(transcript_file_path, 'w', encoding='utf-8') as f:
                    f.write(transcript_content)
                
                logger.info(f"[Legacy] ✅ Q{q_num}_transcript.txt created")
            except Exception as e:
                logger.error(f"[Legacy] Error creating transcript file: {e}")
        
        # Update Firestore
        if db and token and token != "session_token_placeholder":
            try:
                session_doc = db.collection("sessions").document(token).get()
                if session_doc.exists:
                    db.collection("sessions").document(token).update({
                        f'q{question_index + 1}_ai_status': 'done',
                        f'q{question_index + 1}_ai_transcript': result['transcript'],
                        f'q{question_index + 1}_ai_score': result['match_score'],
                        f'q{question_index + 1}_ai_feedback': result['feedback'],
                        f'q{question_index + 1}_emotion': result['emotion'],
                        f'q{question_index + 1}_emotion_score': result['emotion_score'],
                        f'q{question_index + 1}_pace_wpm': result['pace_wpm'],
                        f'q{question_index + 1}_pace_label': result['pace_label']
                    })
            except Exception as e:
                logger.warning(f"[Legacy] Firestore error: {e}")
        
        logger.info(f"✅ [Legacy] Q{question_index + 1} SUCCESS")
        
    except Exception as e:
        error_msg = str(e)
        logger.error(f"❌ [Legacy] Q{question_index + 1} FAILED: {error_msg}")
        
        # Write error to meta.json
        try:
            metadata_path = os.path.join(output_folder, 'meta.json')
            if os.path.exists(metadata_path):
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                
                str_idx = str(question_index)
                if str_idx in metadata.get('receivedQuestions', {}):
                    metadata['receivedQuestions'][str_idx].update({
                        'status': 'ai_error',
                        'ai_done': False,
                        'transcript_text': f'AI Analysis Failed: {error_msg[:100]}',
                        'debug_error': error_msg
                    })
                
                with open(metadata_path, 'w', encoding='utf-8') as f:
                    json.dump(metadata, f, indent=4, ensure_ascii=False)
        except Exception as write_err:
            logger.error(f"[Legacy] meta.json write error: {write_err}")
        
        # Update Firestore with error
        if db and token and token != "session_token_placeholder":
            try:
                session_doc = db.collection("sessions").document(token).get()
                if session_doc.exists:
                    db.collection("sessions").document(token).update({
                        f'q{question_index + 1}_ai_status': 'error',
                        f'q{question_index + 1}_ai_transcript': f'AI Analysis Failed: {error_msg[:100]}',
                        f'q{question_index + 1}_ai_debug': error_msg[:1000]
                    })
            except Exception as e:
                logger.warning(f"[Legacy] Firestore error on failure: {e}")
