#!/usr/bin/env bash
# 重启服务：先执行数据库迁移，再启动 Node。
# 用法：./restart.sh                 （默认端口 3000）
#       PORT=3100 ./restart.sh       （指定端口）
#       SKIP_MIGRATE=1 ./restart.sh  （跳过迁移）
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-3000}"
HOST="127.0.0.1"
PID_FILE=".server.pid"
LOG_FILE="server.log"
START_TIMEOUT="${START_TIMEOUT:-30}"
HEALTH_URL="http://$HOST:$PORT/api/health"

pids_on_port() {
  lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

port_in_use() {
  [ -n "$(pids_on_port)" ]
}

run_migrations() {
  if [ "${SKIP_MIGRATE:-0}" = "1" ]; then
    echo "已跳过数据库迁移（SKIP_MIGRATE=1）。"
    return
  fi
  echo "执行数据库迁移..."
  npm run db:migrate
}

stop_old() {
  local pids left
  pids="$(pids_on_port)"
  if [ -z "$pids" ]; then
    echo "端口 $PORT 未被占用。"
    return
  fi

  echo "端口 $PORT 被占用，正在停止旧进程：$(echo "$pids" | tr '\n' ' ')"
  kill $pids 2>/dev/null || true

  for _ in $(seq 1 50); do
    port_in_use || break
    sleep 0.2
  done

  if port_in_use; then
    left="$(pids_on_port)"
    echo "旧进程未退出，强制结束：$(echo "$left" | tr '\n' ' ')"
    kill -9 $left 2>/dev/null || true
    for _ in $(seq 1 25); do
      port_in_use || break
      sleep 0.2
    done
  fi

  if port_in_use; then
    echo "无法释放端口 ${PORT}，退出。" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
  echo "旧进程已停止。"
}

start_new() {
  local pid
  echo "正在启动：node server.js（端口 ${PORT}）"
  : > "$LOG_FILE"
  PORT="$PORT" nohup node server.js >> "$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" > "$PID_FILE"
  disown "$pid" 2>/dev/null || true
  echo "已启动，PID ${pid}，日志：$(pwd)/$LOG_FILE"

  for _ in $(seq 1 $((START_TIMEOUT * 5))); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "进程启动后立即退出。最近日志：" >&2
      tail -n 20 "$LOG_FILE" >&2 || true
      rm -f "$PID_FILE"
      exit 1
    fi
    if curl -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
      echo "重启完成：http://$HOST:$PORT"
      return
    fi
    sleep 0.2
  done

  echo "启动超时（${START_TIMEOUT}s）。最近日志：" >&2
  tail -n 20 "$LOG_FILE" >&2 || true
  exit 1
}

run_migrations
stop_old
start_new
