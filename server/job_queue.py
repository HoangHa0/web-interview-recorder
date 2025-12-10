"""
Job Queue System for AI Analysis
- Implements rate limiting: 1 job per 15 seconds (4 jobs/minute, safe for 5 req/min quota)
- Handles auto-retry: 1 attempt after 70s delay if job fails
- Handles manual retry: User can manually retry, goes to back of queue
"""
import asyncio
import time
import logging
from typing import Dict, List, Optional, Callable
from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

class JobStatus(Enum):
    """Job lifecycle states"""
    PENDING = "pending"           # Waiting in queue
    PROCESSING = "processing"     # Currently running
    SUCCESS = "success"           # Completed successfully
    FAILED = "failed"             # Failed (no auto-retry left)
    RETRY_SCHEDULED = "retry_scheduled"  # Waiting for auto-retry delay
    MANUAL_RETRY_PENDING = "manual_retry_pending"  # User clicked retry, waiting in queue

@dataclass
class JobRetryInfo:
    """Tracks retry attempts for a job"""
    auto_retry_attempt: int = 0  # 0 or 1 (max 1 auto-retry)
    auto_retry_scheduled_at: Optional[datetime] = None  # When auto-retry should run
    last_error: str = ""

@dataclass
class AnalysisJob:
    """
    Represents a single AI analysis job.
    One job = one question video from one candidate.
    """
    job_id: str  # Unique identifier (e.g., "session_token:q_index")
    token: str  # Session token
    folder: str  # Upload folder name
    question_index: int  # 0-based question index
    question_text: str  # Question text for AI prompt
    video_path: str  # Path to video file
    
    # Metadata
    created_at: datetime = field(default_factory=datetime.now)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    status: JobStatus = JobStatus.PENDING
    
    # Retry tracking
    retry_info: JobRetryInfo = field(default_factory=JobRetryInfo)
    
    # Result storage
    result: Optional[Dict] = None
    error_message: str = ""
    
    # Frontend tracking
    is_manual_retry: bool = False  # True if user manually triggered retry
    
    def __hash__(self):
        return hash(self.job_id)
    
    def __eq__(self, other):
        if isinstance(other, AnalysisJob):
            return self.job_id == other.job_id
        return False


class AnalysisQueue:
    """
    Queue for AI analysis jobs with rate limiting.
    
    Key features:
    - Max 1 job per 15 seconds (4 jobs/min, safe under 5 req/min quota)
    - Auto-retry: 1 retry after 70s delay if job fails
    - Manual retry: User can manually retry, job goes to back of queue
    - Tracks job status for frontend
    """
    
    # Configuration
    JOB_PROCESSING_INTERVAL = 15  # seconds between job processing
    AUTO_RETRY_DELAY = 70  # seconds to wait before auto-retry
    
    def __init__(self):
        self.queue: List[AnalysisJob] = []  # FIFO queue
        self.jobs_dict: Dict[str, AnalysisJob] = {}  # job_id -> job mapping for quick lookup
        self.last_job_time = 0  # Timestamp of when last job started processing
        self.processing = False  # Currently processing a job
        self.current_job: Optional[AnalysisJob] = None  # Job being processed
        self.workers_started = False
        
    def add_job(self, token: str, folder: str, question_index: int, 
                question_text: str, video_path: str, is_manual_retry: bool = False) -> str:
        """
        Add a new job to queue.
        
        Returns:
            job_id: Unique identifier for this job
        """
        job_id = f"{token}:q{question_index}"
        
        # If this is a retry of an existing job, update the existing job
        if job_id in self.jobs_dict:
            existing_job = self.jobs_dict[job_id]
            
            if is_manual_retry:
                # User clicked manual retry button
                # Move to back of queue with updated status
                if existing_job in self.queue:
                    self.queue.remove(existing_job)
                
                existing_job.status = JobStatus.MANUAL_RETRY_PENDING
                existing_job.is_manual_retry = True
                self.queue.append(existing_job)
                logger.info(f"[Queue] Manual retry for {job_id}, position: {len(self.queue)}")
            else:
                # Auto-retry after failure
                existing_job.retry_info.auto_retry_attempt += 1
                existing_job.status = JobStatus.RETRY_SCHEDULED
                existing_job.retry_info.auto_retry_scheduled_at = datetime.now() + timedelta(seconds=self.AUTO_RETRY_DELAY)
                existing_job.is_manual_retry = False
                # Don't add back to queue yet - will be added when delay expires
                logger.info(f"[Queue] Auto-retry scheduled for {job_id} at {existing_job.retry_info.auto_retry_scheduled_at}")
            
            return job_id
        
        # Create new job
        job = AnalysisJob(
            job_id=job_id,
            token=token,
            folder=folder,
            question_index=question_index,
            question_text=question_text,
            video_path=video_path,
            is_manual_retry=is_manual_retry
        )
        
        self.jobs_dict[job_id] = job
        self.queue.append(job)
        logger.info(f"[Queue] Added job {job_id}, queue size: {len(self.queue)}")
        
        return job_id
    
    def get_job(self, job_id: str) -> Optional[AnalysisJob]:
        """Get job by ID to check status"""
        return self.jobs_dict.get(job_id)
    
    def mark_processing(self, job: AnalysisJob):
        """Mark job as currently processing"""
        job.status = JobStatus.PROCESSING
        job.started_at = datetime.now()
        self.current_job = job
    
    def mark_success(self, job: AnalysisJob, result: Dict):
        """Mark job as successfully completed"""
        job.status = JobStatus.SUCCESS
        job.result = result
        job.completed_at = datetime.now()
        self.current_job = None
        logger.info(f"[Queue] Job {job.job_id} completed successfully")
    
    def mark_failed(self, job: AnalysisJob, error: str):
        """
        Mark job as failed.
        If auto-retry available, schedule retry. Otherwise mark as failed.
        """
        job.error_message = error
        
        # Check if auto-retry is available
        if job.retry_info.auto_retry_attempt == 0:
            # Schedule auto-retry
            job.status = JobStatus.RETRY_SCHEDULED
            job.retry_info.auto_retry_attempt += 1
            job.retry_info.auto_retry_scheduled_at = datetime.now() + timedelta(seconds=self.AUTO_RETRY_DELAY)
            job.retry_info.last_error = error
            logger.info(f"[Queue] Job {job.job_id} failed, auto-retry scheduled for {job.retry_info.auto_retry_scheduled_at}")
            self.current_job = None
            return
        
        # No auto-retry left, mark as failed
        job.status = JobStatus.FAILED
        job.completed_at = datetime.now()
        self.current_job = None
        logger.info(f"[Queue] Job {job.job_id} failed permanently: {error}")
    
    def should_process_next(self) -> bool:
        """Check if enough time has passed to process next job"""
        if self.processing or not self.queue:
            return False
        
        now = time.time()
        return (now - self.last_job_time) >= self.JOB_PROCESSING_INTERVAL
    
    def get_next_job(self) -> Optional[AnalysisJob]:
        """
        Get next job to process, respecting timing rules.
        - Check queue for jobs ready to process
        - For jobs in RETRY_SCHEDULED state, only return if delay has passed
        """
        # First, check if any RETRY_SCHEDULED jobs are now ready
        now = datetime.now()
        for i, job in enumerate(self.queue):
            if job.status == JobStatus.RETRY_SCHEDULED:
                if job.retry_info.auto_retry_scheduled_at and now >= job.retry_info.auto_retry_scheduled_at:
                    # This job's retry delay has expired, move it to front
                    job.status = JobStatus.PENDING
                    self.queue.pop(i)
                    self.queue.insert(0, job)
                    logger.info(f"[Queue] Job {job.job_id} retry delay expired, moving to front of queue")
                    break
        
        # Return first job in queue (should be PENDING status)
        if self.queue and self.queue[0].status in [JobStatus.PENDING, JobStatus.MANUAL_RETRY_PENDING]:
            return self.queue.pop(0)
        
        return None
    
    def get_queue_status(self) -> Dict:
        """Get current queue status for monitoring/debugging"""
        return {
            "queue_size": len(self.queue),
            "current_job": self.current_job.job_id if self.current_job else None,
            "processing": self.processing,
            "last_job_time": self.last_job_time,
            "jobs": [
                {
                    "job_id": job.job_id,
                    "status": job.status.value,
                    "created_at": job.created_at.isoformat(),
                    "is_manual_retry": job.is_manual_retry
                }
                for job in self.queue
            ]
        }


# Global queue instance
analysis_queue = AnalysisQueue()


async def wait_for_job_completion(job_id: str, timeout: int = 300) -> Optional[Dict]:
    """
    Wait for a specific job to complete (for polling from frontend).
    
    Args:
        job_id: Job identifier
        timeout: Max seconds to wait
    
    Returns:
        Job result if successful, None if failed or timed out
    """
    start_time = time.time()
    
    while time.time() - start_time < timeout:
        job = analysis_queue.get_job(job_id)
        
        if not job:
            return None
        
        if job.status == JobStatus.SUCCESS:
            return job.result
        
        if job.status == JobStatus.FAILED:
            return None
        
        # Still processing or in queue, wait and retry
        await asyncio.sleep(1)
    
    # Timeout
    return None
