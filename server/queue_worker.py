"""
Queue Worker Service
- Processes jobs from analysis_queue in background
- Respects 15s throttling between jobs
- Handles auto-retry logic
"""
import asyncio
import logging
import time
from threading import Thread, Event

from server.job_queue import analysis_queue, JobStatus
from server.ai_service_v2 import process_job_from_queue

logger = logging.getLogger(__name__)


class QueueWorker:
    """Background worker that processes jobs from the queue"""
    
    def __init__(self):
        self.running = False
        self.worker_thread = None
        self.stop_event = Event()
    
    def start(self):
        """Start the background worker thread"""
        if self.running:
            logger.warning("[Queue Worker] Already running")
            return
        
        self.running = True
        self.stop_event.clear()
        self.worker_thread = Thread(target=self._worker_loop, daemon=True)
        self.worker_thread.start()
        logger.info("[Queue Worker] Started")
    
    def stop(self):
        """Stop the background worker thread"""
        if not self.running:
            return
        
        self.running = False
        self.stop_event.set()
        if self.worker_thread:
            self.worker_thread.join(timeout=5)
        logger.info("[Queue Worker] Stopped")
    
    def _worker_loop(self):
        """
        Main worker loop.
        Continuously processes jobs from queue, respecting throttling.
        """
        logger.info("[Queue Worker] Worker loop started")
        
        while self.running and not self.stop_event.is_set():
            try:
                # Check if we should process next job
                if analysis_queue.should_process_next():
                    job = analysis_queue.get_next_job()
                    
                    if job:
                        logger.info(f"[Queue Worker] Processing: {job.job_id}")
                        
                        # Update timing
                        analysis_queue.last_job_time = time.time()
                        analysis_queue.processing = True
                        
                        try:
                            # Process the job (this may take a while)
                            process_job_from_queue(job)
                        except Exception as e:
                            logger.error(f"[Queue Worker] Unhandled error processing {job.job_id}: {e}")
                        finally:
                            analysis_queue.processing = False
                
                # Sleep briefly before checking queue again
                time.sleep(1)
                
            except Exception as e:
                logger.error(f"[Queue Worker] Unexpected error in worker loop: {e}")
                time.sleep(5)  # Back off on error


# Global worker instance
queue_worker = QueueWorker()
