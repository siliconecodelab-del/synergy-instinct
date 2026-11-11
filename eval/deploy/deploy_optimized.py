#!/usr/bin/env python3
"""
Deploy optimized prompts and skills to the agent.

Takes optimized skill files and prompt templates from the DsPy optimization
output and applies them to the agent's skills directory. Supports:
  - Dry-run mode (preview changes without applying)
  - Backup of original files before overwriting
  - Rollback to previous version
  - Version tracking

Usage:
    python deploy_optimized.py --skills-dir /path/to/skills --optimized-dir /path/to/optimized --dry-run
    python deploy_optimized.py --skills-dir /path/to/skills --optimized-dir /path/to/optimized
    python deploy_optimized.py --skills-dir /path/to/skills --rollback 2026-11-11T12:00:00
"""
import argparse
import json
import os
import shutil
import hashlib
from datetime import datetime, timezone


def compute_hash(filepath: str) -> str:
    """Compute SHA256 hash of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def backup_file(filepath: str, backup_dir: str) -> str:
    """Back up a file before overwriting. Returns backup path."""
    os.makedirs(backup_dir, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    basename = os.path.basename(filepath)
    backup_path = os.path.join(backup_dir, f"{basename}.{timestamp}.bak")
    if os.path.exists(filepath):
        shutil.copy2(filepath, backup_path)
    return backup_path


def find_optimized_files(optimized_dir: str) -> list:
    """Find all optimized skill/prompt files."""
    files = []
    for root, _, filenames in os.walk(optimized_dir):
        for filename in filenames:
            if filename.endswith(".md") or filename.endswith(".json"):
                full_path = os.path.join(root, filename)
                rel_path = os.path.relpath(full_path, optimized_dir)
                files.append((rel_path, full_path))
    return files


def deploy(skills_dir: str, optimized_dir: str, dry_run: bool = False,
           backup_dir: str = None) -> dict:
    """Deploy optimized files to the skills directory."""
    if backup_dir is None:
        backup_dir = os.path.join(skills_dir, ".backups")

    optimized_files = find_optimized_files(optimized_dir)
    results = {"deployed": [], "skipped": [], "errors": []}

    for rel_path, src_path in optimized_files:
        dst_path = os.path.join(skills_dir, rel_path)

        # Check if file changed
        if os.path.exists(dst_path):
            src_hash = compute_hash(src_path)
            dst_hash = compute_hash(dst_path)
            if src_hash == dst_hash:
                results["skipped"].append({"file": rel_path, "reason": "unchanged"})
                continue

        if dry_run:
            results["deployed"].append({"file": rel_path, "action": "would_update" if os.path.exists(dst_path) else "would_create"})
            continue

        # Back up existing file
        if os.path.exists(dst_path):
            backup_path = backup_file(dst_path, backup_dir)
            results["deployed"].append({"file": rel_path, "action": "updated", "backup": backup_path})
        else:
            os.makedirs(os.path.dirname(dst_path), exist_ok=True)
            results["deployed"].append({"file": rel_path, "action": "created"})

        # Copy optimized file
        try:
            shutil.copy2(src_path, dst_path)
        except Exception as e:
            results["errors"].append({"file": rel_path, "error": str(e)})

    return results


def rollback(skills_dir: str, backup_dir: str, timestamp: str) -> dict:
    """Rollback to a previous backup version."""
    if not os.path.exists(backup_dir):
        return {"error": "No backups found"}

    restored = []
    for filename in os.listdir(backup_dir):
        if f".{timestamp}.bak" in filename:
            # Find original file name
            original_name = filename.split(f".{timestamp}.bak")[0]
            # Find the original path (search in skills_dir)
            for root, _, files in os.walk(skills_dir):
                if original_name in files:
                    src = os.path.join(backup_dir, filename)
                    dst = os.path.join(root, original_name)
                    shutil.copy2(src, dst)
                    restored.append(original_name)
                    break

    return {"restored": restored, "count": len(restored)}


def main():
    parser = argparse.ArgumentParser(description="Deploy optimized prompts/skills")
    parser.add_argument("--skills-dir", required=True, help="Agent skills directory")
    parser.add_argument("--optimized-dir", help="Directory with optimized files")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without applying")
    parser.add_argument("--rollback", help="Rollback to timestamp (YYYYMMDDTHHMMSSZ)")
    parser.add_argument("--backup-dir", help="Backup directory (default: skills_dir/.backups)")
    args = parser.parse_args()

    backup_dir = args.backup_dir or os.path.join(args.skills_dir, ".backups")

    if args.rollback:
        print(f"Rolling back to {args.rollback}...")
        result = rollback(args.skills_dir, backup_dir, args.rollback)
        print(json.dumps(result, indent=2))
        return

    if not args.optimized_dir:
        print("Error: --optimized-dir is required for deploy")
        return

    print(f"{'DRY RUN: ' if args.dry_run else ''}Deploying from {args.optimized_dir} to {args.skills_dir}")
    result = deploy(args.skills_dir, args.optimized_dir, args.dry_run, backup_dir)

    print(f"\nDeployed: {len(result['deployed'])}")
    for d in result["deployed"]:
        print(f"  {'[DRY] ' if args.dry_run else ''}{d['action']}: {d['file']}")
    print(f"Skipped: {len(result['skipped'])}")
    for s in result["skipped"]:
        print(f"  unchanged: {s['file']}")
    if result["errors"]:
        print(f"Errors: {len(result['errors'])}")
        for e in result["errors"]:
            print(f"  ERROR: {e['file']}: {e['error']}")


if __name__ == "__main__":
    main()
PYEOF
echo "Created deploy_optimized.py"