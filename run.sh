#!/usr/bin/env bash
# 启动溶图后端(纯 CPU)。打开 http://127.0.0.1:8000/?char=miku
set -e
cd "$(dirname "$0")"
exec /home/boxuan/miniconda3/envs/relight/bin/uvicorn app:app --app-dir backend --host 127.0.0.1 --port 8000
