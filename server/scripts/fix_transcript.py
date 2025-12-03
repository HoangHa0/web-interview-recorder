#!/usr/bin/env python3
"""
Fix transcript.txt by filling missing question text from Firestore `sessions/{token}` -> `questionsSelected`.

Usage:
  python fix_transcript.py --token F381FD23 --folder 20_11_2025_00_28_jane_doe

This will update `server/uploads/<folder>/transcript.txt` in-place, but it writes a backup
`transcript.txt.bak` before modifying.
"""
import argparse
import os
import re
from api.firebase_setup import get_firestore_client

BASE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'uploads')


def load_questions_from_firestore(token):
    db = get_firestore_client()
    if not db:
        raise RuntimeError('Firestore client not available')
    doc = db.collection('sessions').document(token).get()
    if not doc.exists:
        raise RuntimeError(f'Session document {token} not found in Firestore')
    data = doc.to_dict()
    qs = data.get('questionsSelected') or data.get('metadata_initial', {}).get('questionsSelected')
    if not isinstance(qs, list):
        return []
    # Normalize entries to strings
    out = []
    for item in qs:
        if isinstance(item, dict):
            out.append(item.get('text') or item.get('question') or '')
        else:
            out.append(str(item))
    return out


def fix_transcript(folder, token):
    folder_path = os.path.join(BASE_DIR, folder)
    transcript_path = os.path.join(folder_path, 'transcript.txt')
    if not os.path.exists(transcript_path):
        raise FileNotFoundError(f'Transcript not found: {transcript_path}')

    questions = load_questions_from_firestore(token)

    # Backup
    backup_path = transcript_path + '.bak'
    if not os.path.exists(backup_path):
        os.rename(transcript_path, backup_path)
    else:
        # rotate: keep existing backup
        os.remove(transcript_path)

    pattern = re.compile(r'^(Q(\d+)):\s*(.*?)\s*\|\s*Answer:\s*(.*)$')

    with open(backup_path, 'r', encoding='utf-8') as fin, open(transcript_path, 'w', encoding='utf-8') as fout:
        for line in fin:
            line = line.rstrip('\n')
            m = pattern.match(line)
            if m:
                qlabel = m.group(1)
                qnum = int(m.group(2))
                qtext = m.group(3).strip()
                answer = m.group(4).strip()

                if not qtext or qtext in ('[Question text unavailable]', '\u00a0'):
                    replacement = ''
                    if 0 <= qnum - 1 < len(questions):
                        replacement = questions[qnum - 1]
                    else:
                        replacement = '[Question text unavailable]'
                    new_line = f"{qlabel}: {replacement} | Answer: {answer}"
                    fout.write(new_line + '\n')
                else:
                    fout.write(line + '\n')
            else:
                # Try to handle older multi-line entries: just copy
                fout.write(line + '\n')

    print(f'Fixed transcript written to: {transcript_path} (backup at {backup_path})')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--token', required=True)
    p.add_argument('--folder', required=True)
    args = p.parse_args()
    fix_transcript(args.folder, args.token)


if __name__ == '__main__':
    main()
