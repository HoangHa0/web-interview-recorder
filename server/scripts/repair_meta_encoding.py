#!/usr/bin/env python3
"""
Repair metadata files in uploads/ by re-reading meta.json using fallbacks and re-saving as UTF-8.

Usage:
  python repair_meta_encoding.py

This script is useful when uploads/meta.json files were written with a platform-specific
encoding (e.g., cp1252 on Windows) and produce decoding errors when read as UTF-8.
"""
import os
import json

BASE = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'uploads')

def repair_one(path):
    meta_path = os.path.join(path, 'meta.json')
    if not os.path.exists(meta_path):
        return False
    try:
        with open(meta_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        # nothing to do
        return True
    except Exception as e:
        print(f"Reading as UTF-8 failed for {meta_path}: {e}")
        # Try cp1252 fallback and rewrite as utf-8
        try:
            with open(meta_path, 'r', encoding='cp1252', errors='replace') as f:
                content = f.read()
            data = json.loads(content)
        except Exception as e2:
            print(f"Failed to parse even after cp1252 fallback: {e2}")
            return False

        try:
            with open(meta_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=4, ensure_ascii=False)
            print(f"Rewrote {meta_path} as UTF-8 successfully.")
            return True
        except Exception as e3:
            print(f"Failed to rewrite {meta_path}: {e3}")
            return False

def main():
    if not os.path.isdir(BASE):
        print('No uploads directory found, nothing to repair.')
        return
    folders = [d for d in os.listdir(BASE) if os.path.isdir(os.path.join(BASE, d))]
    for f in folders:
        folder_path = os.path.join(BASE, f)
        print('Checking', folder_path)
        repair_one(folder_path)

if __name__ == '__main__':
    main()
